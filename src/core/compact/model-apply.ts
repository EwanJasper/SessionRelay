// ─────────── L3 应用层：把 model.ts 的纯逻辑接到库上（审计 / 配额 / 回滚）───────────
//
// 分工：model.ts 是**纯函数**（分簇、提示词、解析、证据校验），本文件负责 IO 与账。
// 这样分是因为"抽不出证据就丢弃"这条边界必须能**单独测**（不需要起模型、不需要库）。

import { createHash } from 'node:crypto';
import type { DB } from '../../store/db.js';
import {
  type ClusterItem, type CompressPolicy, type CompressProvider,
  clusterByTopic, buildPrompt, mergeCluster, KEEP_ORIGINAL_ALWAYS,
} from './model.js';

// ── 配额（边界④：落库、重启不重置）──

function hourKey(scope: string, now = Date.now()): string {
  return 'l3:' + scope + ':' + Math.floor(now / 3600_000);
}

/** 本小时已用配额 */
export function quotaUsed(db: DB, scope: string, now = Date.now()): number {
  try {
    const r = db.prepare('SELECT used FROM compress_quota WHERE key = ?').get(hourKey(scope, now)) as { used: number } | undefined;
    return Number(r?.used ?? 0);
  } catch { return 0; }
}

/** 记一次调用（先记后调：崩了也算用掉，宁可少调不可超发） */
export function quotaCharge(db: DB, scope: string, n = 1, now = Date.now()): void {
  try {
    db.prepare('INSERT INTO compress_quota (key, used, updated_at) VALUES (?,?,?)'
      + ' ON CONFLICT(key) DO UPDATE SET used = used + excluded.used, updated_at = excluded.updated_at')
      .run(hourKey(scope, now), n, new Date().toISOString());
  } catch { /* 配额记账失败不许让压缩停摆 —— 但下面的 max_calls_per_round 仍然兜着 */ }
}

// ── 审计（边界③：可审计 + 可回滚）──

export interface CompressLogInput {
  triggeredBy: string; scope: string; model: string; provider: string;
  clustersSeen: number; clustersMerged: number; itemsIn: number; itemsOut: number;
  discarded: number; calls: number; note?: string;
}
export interface CompressDetailInput {
  sessionId?: string | null; lessonId?: number | null;
  mergedText: string; evidenceIds: string[]; originals: unknown;
}

export function writeCompressLog(db: DB, o: CompressLogInput): number {
  const r = db.prepare(`INSERT INTO compress_log
    (triggered_by, scope, model, provider, clusters_seen, clusters_merged, items_in, items_out, discarded, calls, status, note, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,'applied',?,?)`)
    .run(o.triggeredBy, o.scope, o.model, o.provider, o.clustersSeen, o.clustersMerged,
      o.itemsIn, o.itemsOut, o.discarded, o.calls, o.note ?? null, new Date().toISOString());
  return Number(r.lastInsertRowid);
}

export function writeCompressDetail(db: DB, logId: number, d: CompressDetailInput): void {
  db.prepare(`INSERT INTO compress_detail
    (compress_log_id, session_id, lesson_id, merged_text, evidence_ids, originals, created_at)
    VALUES (?,?,?,?,?,?,?)`)
    .run(logId, d.sessionId ?? null, d.lessonId ?? null, d.mergedText,
      JSON.stringify(d.evidenceIds), JSON.stringify(d.originals), new Date().toISOString());
}

/**
 * 把合并结果**写回数据**（1020 · P1：压缩不掉召回）。
 *
 * 设计依据 `docs/1020-外部仓库调研-Akane-MemCore-memory-kit.md` §3-A（memcore 的「结算卡片 + source_id 回读」）：
 *   压缩**不删原文**，只做三件事 ——
 *     ① 追加一条「卡片」条目（带 compressedFrom 指回原文条数）；
 *     ② 给簇里每条原始条目打 `compressed_into: <卡片id>`；
 *     ③ **简报过滤链跳过**带标记的，**检索路径不跳过**。
 *   ⇒ 简报变短了，搜索一条不少。
 *
 * ⚠️ 这是**会改数据**的一步，所以：
 *   · 必须有事务（`BEGIN IMMEDIATE`）—— 中途异常整批回滚，绝不留半截；
 *   · 原文只**加字段**不删不改文本（`KEEP_ORIGINAL_ALWAYS` 的落地形式）；
 *   · 调用方必须**先跑基准记 hit@1**，跑完再跑一次比 —— 掉了就 `--rollback`（见 compress.ts 门禁）。
 *
 * 返回：写入的卡片数与打标记的原文条数。
 */
export function applyCompressionToData(
  db: DB,
  details: Array<{ mergedText: string; evidenceIds: string[]; originals: Array<{ text: string }> }>,
  now = new Date().toISOString(),
): { cards: number; marked: number } {
  let cards = 0, marked = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const d of details) {
      // 卡片的宿主会话：取簇里第一条原文所在的会话（evidenceIds 形如 `sessionId#N`）
      const sid = String(d.evidenceIds[0] ?? '').split('#')[0];
      if (!sid) continue;
      const row = db.prepare('SELECT decisions FROM sessions WHERE id = ?').get(sid) as { decisions?: string } | undefined;
      if (!row || !row.decisions) continue;
      let decs: Array<Record<string, unknown>> = [];
      try { decs = JSON.parse(row.decisions); } catch { continue; }
      if (!Array.isArray(decs)) continue;
      // 卡片 id：稳定（同文本同 id），便于回滚时精确定位
      const cardId = 'c' + createHash('sha1').update(d.mergedText).digest('hex').slice(0, 12);
      const origTexts = new Set(d.originals.map((o) => String(o?.text ?? '')));
      let changed = false;
      for (const dec of decs) {
        if (dec.compressed_into) continue;                       // 已标记过，不重复打
        if (!origTexts.has(String(dec.text ?? ''))) continue;    // 只标本簇的原文
        dec.compressed_into = cardId;
        marked++; changed = true;
      }
      if (!changed) continue;
      decs.push({ text: d.mergedText, at: now, kind: 'compressed', id: cardId,
        compressedFrom: d.originals.length });
      cards++;
      db.prepare('UPDATE sessions SET decisions = ? WHERE id = ?').run(JSON.stringify(decs), sid);
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* 回滚失败也不能掩盖原始错误 */ }
    throw e;
  }
  return { cards, marked };
}

/** 最近几次合并（面板/CLI 用；--json 可直接回滚） */
export function listCompressLogs(db: DB, limit = 20): Array<Record<string, unknown>> {
  try {
    return db.prepare('SELECT * FROM compress_log ORDER BY id DESC LIMIT ?').all(limit) as Array<Record<string, unknown>>;
  } catch { return []; }
}

export function compressDetailOf(db: DB, logId: number): Array<Record<string, unknown>> {
  try { return db.prepare('SELECT * FROM compress_detail WHERE compress_log_id = ? ORDER BY id').all(logId) as Array<Record<string, unknown>>; }
  catch { return []; }
}

// ── 项目库 decisions 线 ──
//
// 边界①「原文永不删」在这里的**具体含义**：被合并吸收的那些条目，其**原文快照**写进
// compress_detail.originals；会话行里的 decisions 列被替换成"合并后的视图"。
// 回滚 = 拿 originals 把 decisions 列写回去（逐字还原，不靠推断）。

export interface ProjectCompressOptions {
  apply?: boolean;
  /** 1020 · P1：把合并结果写回 sessions.decisions（压缩不掉召回）。**默认 false** ——
   *  这是会改数据的一步，必须显式开启，且调用方要先跑基准记 hit@1。 */
  writeBack?: boolean;
  log?: (s: string) => void;
  now?: number;
  provider?: CompressProvider;
}

export interface ProjectCompressResult {
  clustersSeen: number; clustersMerged: number; itemsIn: number; itemsOut: number;
  discarded: number; calls: number; logId: number | null; blocked: string | null;
}

/** 收集够老的 decisions（按会话分组：decisions 是存在会话行上的 JSON 列） */
function collectDecisions(db: DB, projectId: string, p: CompressPolicy, now: number): ClusterItem[] {
  const cutoff = now - p.minAgeDays * 86400_000;
  const rows = db.prepare(`SELECT id, created_at, decisions FROM sessions
    WHERE project_id = ? AND decisions IS NOT NULL AND (origin IS NULL OR origin != 'workflow')`)
    .all(projectId) as Array<{ id: string; created_at: string; decisions: string }>;
  const out: ClusterItem[] = [];
  for (const r of rows) {
    let decs: Array<{ text?: string; at?: string }> = [];
    try { decs = JSON.parse(r.decisions); } catch { continue; }
    if (!Array.isArray(decs)) continue;
    for (const d of decs) {
      if (typeof d?.text !== 'string' || !d.text.trim()) continue;
      const at = d.at ?? r.created_at;
      const t = Date.parse(at);
      if (Number.isFinite(t) && t > cutoff) continue;   // 太新：还在长，压了会丢上下文
      out.push({ id: r.id + '#' + out.length, text: d.text, at });
    }
  }
  return out;
}

export async function compressProject(db: DB, projectId: string, p: CompressPolicy, opts: ProjectCompressOptions = {}): Promise<ProjectCompressResult> {
  const log = opts.log ?? (() => {});
  const now = opts.now ?? Date.now();
  const empty: ProjectCompressResult = { clustersSeen: 0, clustersMerged: 0, itemsIn: 0, itemsOut: 0, discarded: 0, calls: 0, logId: null, blocked: null };
  if (!p.projects) return { ...empty, blocked: '配置里关掉了项目线（compress.projects=false）' };
  const provider = opts.provider;
  if (!provider) return { ...empty, blocked: '没有可用的模型提供方' };

  const all = collectDecisions(db, projectId, p, now);
  const clusters = clusterByTopic(all, p.topicOverlap, p.minCluster);
  log('候选 ' + all.length + ' 条 → ' + clusters.length + ' 个簇（重叠阈值 ' + p.topicOverlap + '，每簇至少 ' + p.minCluster + ' 条）');

  const used = quotaUsed(db, 'project', now);
  let calls = 0, merged = 0, itemsOut = 0, discarded = 0;
  const details: Array<{ clusterKey: string; mergedText: string; evidenceIds: string[]; originals: ClusterItem[] }> = [];

  for (const c of clusters) {
    if (calls >= p.maxCallsPerRound) { log('已达单轮调用上限 ' + p.maxCallsPerRound + '，本轮提前收工（下轮继续）'); break; }
    if (used + calls >= p.maxCallsPerHour) { log('已达每小时调用上限 ' + p.maxCallsPerHour + '，本轮提前收工'); break; }
    calls++;
    try {
      const raw = await provider.complete(buildPrompt(c.items));
      const out = mergeCluster(c.items, raw);
      if (out.merged.length === 0) { log('簇 ' + c.key.slice(0, 8) + '：模型没给出可用合并（丢弃 ' + out.discarded + ' 条），跳过'); discarded += out.discarded; continue; }
      // ── 收益闸门（1020 从 memcore 借鉴：min_saved_ratio / min_utf8_bytes）──
      //   没有这层时，模型合出来的东西**无论省多少都算成功** ⇒ 一堆「合了但没省」
      //   的白花调用被记成成果。判据：整个簇的原文总字节 → 合并后总字节，省够才落地。
      const origBytes = c.items.reduce((s, it) => s + Buffer.byteLength(String(it.text ?? ''), 'utf8'), 0);
      const mergedBytes = out.merged.reduce((s, m) => s + Buffer.byteLength(m.text, 'utf8'), 0);
      const savedRatio = origBytes > 0 ? 1 - mergedBytes / origBytes : 0;
      if (origBytes < p.minUtf8Bytes) {
        log('簇 ' + c.key.slice(0, 8) + '：原簇只有 ' + origBytes + ' 字节（门槛 ' + p.minUtf8Bytes + '），太小不压');
        continue;
      }
      if (savedRatio < p.minSavedRatio) {
        log('簇 ' + c.key.slice(0, 8) + '：合并只省 ' + (savedRatio * 100).toFixed(1) + '%（门槛 ' + (p.minSavedRatio * 100).toFixed(0) + '%），不落地');
        continue;
      }
      for (const m of out.merged) {
        details.push({ clusterKey: c.key, mergedText: m.text, evidenceIds: m.evidenceIds, originals: c.items });
        merged++; itemsOut++;
      }
      discarded += out.discarded;
    } catch (e) {
      log('簇 ' + c.key.slice(0, 8) + ' 调用失败：' + String((e as Error)?.message ?? e).slice(0, 120));
    }
  }

  if (calls > 0) quotaCharge(db, 'project', calls, now);

  let logId: number | null = null;
  // ⚠️ [1017 夜 08:2x 实读源码后订正] 本函数**只写审计表，从不 UPDATE sessions.decisions** ——
  //   原文一个字都没动（合并文本进的是 compress_detail.merged_text）。
  // ⇒ 设计件 §2 承诺的「掉召回整批回滚」在**当前形态下不适用**：没有东西被覆盖，就没有召回可掉；
  //   CLI 的 --rollback 也因此只导出依据、不改库（compress.ts 里注明了原因并留了 TODO）。
  // ⇒ **将来加「写回原文」那一拍时，必须同时补两样**：
  //   ① 事务（现在这段审计写入没有 BEGIN/COMMIT，中途异常会留下半截 log）；
  //   ② 合并前后同快照跑基准、hit@1 掉了整批不写（护栏要护的是「会改数据」的那一步）。
  // 在那之前加护栏 = 为不存在的风险花一次基准时间，却保护不了任何东西。
  if (opts.apply && details.length > 0) {
    logId = writeCompressLog(db, {
      triggeredBy: 'lifecycle', scope: 'decisions', model: p.model, provider: provider.name,
      clustersSeen: clusters.length, clustersMerged: details.length,
      itemsIn: all.length, itemsOut, discarded, calls,
      note: KEEP_ORIGINAL_ALWAYS ? '原文快照已存 compress_detail.originals（回滚依据）' : undefined,
    });
    for (const d of details) {
      writeCompressDetail(db, logId, {
        mergedText: d.mergedText, evidenceIds: d.evidenceIds,
        originals: d.originals.map((x) => ({ id: x.id, text: x.text, at: x.at })),
      });
    }
    log('已写入审计 compress_log#' + logId + '（' + details.length + ' 条合并，原文快照可回滚）');
    // ── 1020 · P1：把合并结果**写回数据**（压缩不掉召回）──
    //   必须显式 opts.writeBack 才做：这是**会改数据**的一步，默认不做。
    //   调用方（CLI）的责任：先跑基准记 hit@1 ⇒ 再 --apply --write-back ⇒ 再跑基准比对。
    if (opts.writeBack) {
      const w = applyCompressionToData(db, details as never, new Date().toISOString());
      log('已写回数据：新增卡片 ' + w.cards + ' 条、标记原文 ' + w.marked + ' 条');
      log('  ⇒ 简报只显示卡片（带 compressed_into 的原文被跳过），检索仍能搜到全部原文');
    }
  } else if (!opts.apply) {
    log('（dry-run：没有写任何东西；加 apply 才落盘）');
  }

  return { clustersSeen: clusters.length, clustersMerged: details.length, itemsIn: all.length, itemsOut, discarded, calls, logId, blocked: null };
}
