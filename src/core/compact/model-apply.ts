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
 * [1021 · 红队 R5：写回这一步修的两个病]
 *   · **跨会话簇只标了首条证据所在会话**：分簇是整个 project 拍平后做的，一个簇的原文常来自好几场；
 *     旧代码只打开 `evidenceIds[0]` 那一场，于是其余会话的原文一条都没标（实测 S1 被标、S2 原样
 *     未动，卡片只落一场）。现在按 id 拆出「会话 → 条目下标」，**逐会话**读/标/写。
 *   · **按 text 匹配**：同文本可能重复（一条够老的进了簇、另一条新的是活条目），旧代码会把那条活的
 *     也标掉 ⇒ 简报里凭空少一条还在用的决策（实测会话内第 2 条误标）。现在按 `id` 定位，
 *     定位后再拿文本**复核**（不一致 = 被外部改过，宁可不标也不标错人）。
 *
 * 返回：卡片数、打标记的原文条数、碰到的会话数、定位不到的原文条数（定位不到必留日志，不静默）。
 */
export interface WriteBackStats {
  cards: number; marked: number; sessions: number; unmatched: number;
}

/** 一张卡片至少要这么多字节才可能承载一条可用信息（≈20 个汉字）。
 *  用途见 compressProject 的**调用前闸门②**：合并后预算比它还小 ⇒ 明显不可能达标。 */
export const MIN_CARD_BYTES = 64;

/** 读一场的 decisions 列。读不出/坏了都**留痕**（容错不许静默），返回 null 让调用方跳过这一场。 */
function readSessionDecisions(
  db: DB, sid: string, log: (s: string) => void,
): Array<Record<string, unknown>> | null {
  const row = db.prepare('SELECT decisions FROM sessions WHERE id = ?').get(sid) as { decisions?: string } | undefined;
  if (!row) { log('写回：会话 ' + sid + ' 已经不存在（原文未动），跳过这一场'); return null; }
  if (!row.decisions) { log('写回：会话 ' + sid + ' 的 decisions 已空（原文未动），跳过这一场'); return null; }
  let decs: unknown;
  try { decs = JSON.parse(row.decisions); } catch (e) {
    log('写回：会话 ' + sid + ' 的 decisions 不是合法 JSON（' + String((e as Error)?.message ?? e).slice(0, 80) + '），跳过这一场');
    return null;
  }
  if (!Array.isArray(decs)) { log('写回：会话 ' + sid + ' 的 decisions 不是数组，跳过这一场'); return null; }
  return decs as Array<Record<string, unknown>>;
}

/** 拆 `sessionId#<下标>`。拆不出（老数据/自定义 id）返回 null，由调用方留痕。 */
function splitItemId(id: string): { sid: string; idx: number } | null {
  const cut = id.lastIndexOf('#');
  if (cut <= 0) return null;
  const tail = id.slice(cut + 1);
  // 只认纯数字下标：`Number('')` 会得到 0、`Number(' 1')` 会得到 1 —— 那会把「拿不准」当成「第 0 条」，
  // 正是"标错人"的经典形状。宁可返回 null 让调用方留痕，也不猜。
  if (!/^\d+$/.test(tail)) return null;
  const idx = Number(tail);
  if (!Number.isSafeInteger(idx) || idx < 0) return null;
  const sid = id.slice(0, cut);
  return sid ? { sid, idx } : null;
}

/** 卡片落哪一场：含原文最多的那一场；并列时优先 `evidenceIds[0]` 所在会话（保持可预期的老行为）。 */
function pickCardHost(plan: Map<string, number[]>, evidenceIds: string[]): string {
  let host = '', best = -1;
  for (const [sid, idxs] of plan) if (idxs.length > best) { best = idxs.length; host = sid; }
  const first = splitItemId(String(evidenceIds[0] ?? ''));
  if (first) {
    const firstCount = plan.get(first.sid);
    if (firstCount && firstCount.length === best) return first.sid;
  }
  return host;
}

export function applyCompressionToData(
  db: DB,
  details: Array<{
    mergedText: string; evidenceIds: string[];
    originals: Array<{ id?: string; text?: string; at?: string | null }>;
  }>,
  now = new Date().toISOString(),
  log: (s: string) => void = () => {},
): WriteBackStats {
  let cards = 0, marked = 0, unmatched = 0;
  const touched = new Set<string>();
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const d of details) {
      // 卡片 id：稳定（同文本同 id），便于回滚时精确定位
      const cardId = 'c' + createHash('sha1').update(d.mergedText).digest('hex').slice(0, 12);

      // ── ① 按 id 拆成「会话 → 条目下标」（簇可能跨多个会话，每个会话都要单独读/写）──
      const plan = new Map<string, number[]>();
      const snapText = new Map<string, string>();   // id → 快照里的原文（只用于定位后复核，不用于查找）
      for (const o of d.originals) {
        const id = String(o?.id ?? '');
        const pos = splitItemId(id);
        if (!pos) {
          unmatched++;
          log('写回：原文 id「' + id.slice(0, 48) + '」不是「会话#下标」形式，定位不到（这一条原文没动）');
          continue;
        }
        const arr = plan.get(pos.sid) ?? [];
        if (!arr.includes(pos.idx)) arr.push(pos.idx);
        plan.set(pos.sid, arr);
        snapText.set(id, String(o?.text ?? ''));
      }
      if (plan.size === 0) continue;

      // ── ② 逐会话标记（原文只加字段）──
      let changed = false;
      const dirty = new Map<string, Array<Record<string, unknown>>>();
      for (const [sid, idxs] of plan) {
        const decs = readSessionDecisions(db, sid, log);
        if (!decs) { unmatched += idxs.length; continue; }
        for (const idx of idxs) {
          const dec = decs[idx];
          if (!dec || typeof dec !== 'object') {
            unmatched++;
            log('写回：会话 ' + sid + ' 的第 ' + idx + ' 条已不存在（decisions 被外部改过），跳过');
            continue;
          }
          const snap = snapText.get(sid + '#' + idx);
          if (snap !== undefined && String(dec.text ?? '') !== snap) {
            // 定位到了但文本变了：说明这一行不是当初那一条。宁可少标，也不误标别人的原文。
            unmatched++;
            log('写回：会话 ' + sid + ' 的第 ' + idx + ' 条文本与快照不一致（被外部改过），跳过');
            continue;
          }
          if (dec.compressed_into) continue;   // 已标记过（同一簇的第二张卡片不重复打）
          dec.compressed_into = cardId;
          marked++; changed = true; touched.add(sid);
          dirty.set(sid, decs);
        }
      }
      if (!changed) continue;

      // ── ③ 卡片只写一次，落在「含原文最多的那一场」（并列时优先 evidenceIds[0] 那场）──
      const hostSid = pickCardHost(plan, d.evidenceIds);
      const hostDecs = dirty.get(hostSid) ?? readSessionDecisions(db, hostSid, log);
      if (!hostDecs) {
        log('写回：卡片「' + String(d.mergedText).slice(0, 24) + '」的宿主会话 ' + hostSid + ' 读不出来，这张卡片没写（已打好的标记保留）');
      } else {
        hostDecs.push({
          text: d.mergedText, at: now, kind: 'compressed', id: cardId,
          // 老字段保持**数字**（面板/文档按"原文条数"读它，别改形状）
          compressedFrom: d.originals.length,
          // R5：这张卡片吸收了哪几场（跨会话簇专用；回滚/核对时能看出卡片的覆盖范围）
          compressedSessions: [...plan.keys()],
        });
        dirty.set(hostSid, hostDecs);
        touched.add(hostSid);
        cards++;
      }

      // ── ④ 本簇碰到的会话逐场写回 ──
      for (const [sid, decs] of dirty) {
        db.prepare('UPDATE sessions SET decisions = ? WHERE id = ?').run(JSON.stringify(decs), sid);
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (rollbackErr) {
      // 回滚失败也不能掩盖原始错误，但也**不许静默**：两条错一起说清楚
      log('写回失败后 ROLLBACK 也失败：' + String((rollbackErr as Error)?.message ?? rollbackErr).slice(0, 120) + '（原始错误照旧向上抛）');
    }
    throw e;
  }
  return { cards, marked, sessions: touched.size, unmatched };
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
  /** [R6] 调用前就被闸门判掉、**没有花调用**的簇数（原来这些簇会白烧一次调用） */
  clustersSkipped: number;
  /** [R6] 花了调用但没落地（模型没给出可用合并 / 省得不够 / 调用失败）的次数 —— 与 calls 对照看空转率 */
  callsWasted: number;
}

/** 收集够老的 decisions（按会话分组：decisions 是存在会话行上的 JSON 列）
 *
 *  `id` 口径 = `sessionId#<该会话 decisions 数组里的下标>`（**1021 · 红队 R5 改的**）。
 *  为什么必须是"会话内下标"而不是全局流水号：簇是**跨会话**的（下面 compressProject 把整个
 *  project 的 decisions 拍平后才分簇），写回那一步要按 id **逐会话精确定位到具体那一行**；
 *  全局流水号只能定位到"第 N 条候选"，回不到某一场的某一行，写回就只能退化成按 text 找 ——
 *  那正是 R5 两个病之一（同文本重复 / 文本被改写时标错或漏标）。
 */
function collectDecisions(
  db: DB, projectId: string, p: CompressPolicy, now: number,
  warn: (s: string) => void = () => {},
): ClusterItem[] {
  const cutoff = now - p.minAgeDays * 86400_000;
  const rows = db.prepare(`SELECT id, created_at, decisions FROM sessions
    WHERE project_id = ? AND decisions IS NOT NULL AND (origin IS NULL OR origin != 'workflow')`)
    .all(projectId) as Array<{ id: string; created_at: string; decisions: string }>;
  const out: ClusterItem[] = [];
  for (const r of rows) {
    let decs: unknown;
    try { decs = JSON.parse(r.decisions); } catch (e) {
      // 容错不许静默：坏 JSON 要留痕，否则"候选为什么少了这几条"没处追
      warn('会话 ' + r.id + ' 的 decisions 不是合法 JSON（' + String((e as Error)?.message ?? e).slice(0, 80) + '），跳过这一场');
      continue;
    }
    if (!Array.isArray(decs)) { warn('会话 ' + r.id + ' 的 decisions 不是数组，跳过这一场'); continue; }
    for (let i = 0; i < decs.length; i++) {
      const d = decs[i] as { text?: unknown; at?: string | null } | null;
      if (!d || typeof d.text !== 'string' || !d.text.trim()) continue;
      const at = d.at ?? r.created_at;
      const t = Date.parse(at);
      if (Number.isFinite(t) && t > cutoff) continue;   // 太新：还在长，压了会丢上下文
      out.push({ id: r.id + '#' + i, text: d.text, at });
    }
  }
  return out;
}

export async function compressProject(db: DB, projectId: string, p: CompressPolicy, opts: ProjectCompressOptions = {}): Promise<ProjectCompressResult> {
  const log = opts.log ?? (() => {});
  const now = opts.now ?? Date.now();
  const empty: ProjectCompressResult = { clustersSeen: 0, clustersMerged: 0, itemsIn: 0, itemsOut: 0, discarded: 0, calls: 0, logId: null, blocked: null, clustersSkipped: 0, callsWasted: 0 };
  if (!p.projects) return { ...empty, blocked: '配置里关掉了项目线（compress.projects=false）' };
  const provider = opts.provider;
  if (!provider) return { ...empty, blocked: '没有可用的模型提供方' };

  const all = collectDecisions(db, projectId, p, now, log);
  const clusters = clusterByTopic(all, p.topicOverlap, p.minCluster);
  log('候选 ' + all.length + ' 条 → ' + clusters.length + ' 个簇（重叠阈值 ' + p.topicOverlap + '，每簇至少 ' + p.minCluster + ' 条）');

  const used = quotaUsed(db, 'project', now);
  let calls = 0, merged = 0, itemsOut = 0, discarded = 0, clustersSkipped = 0, callsWasted = 0;
  const details: Array<{ clusterKey: string; mergedText: string; evidenceIds: string[]; originals: ClusterItem[] }> = [];

  // ── 调用前预算（[R6] 能在本地算的判据，一律判在 `await provider.complete()` 之前）──
  //   病历（docs/1021-红队审计-RT.md · R6）：收益闸门原来排在模型调用**之后** ——
  //   先花一次调用，出来发现"本来就太小 / 省得不够"再丢；那笔调用白烧，还占掉单轮配额，
  //   于是排在前面的小簇把配额吃光，后面**真能落地的大簇**被上面的 `break` 挡在门外。
  //   现在分两级，都在调用前：
  //     ① minUtf8Bytes：原簇字节数只用 c.items 就能算，与模型无关 ⇒ 100% 提前，直接省掉整次调用；
  //     ② minSavedRatio 的**上限预判**：合并后最多允许 origBytes×(1-ratio) 字节；这个预算连一张
  //        最小可用卡片（MIN_CARD_BYTES）都装不下 ⇒ 明显不可能达标。savedRatio 本身要拿到模型
  //        输出才知道，所以**真判据仍留在调用之后**（下方），这一级只是粗筛。
  //   [1021 实测 · 真实库副本（agent1super 主库：510 条候选 / 19 簇；dsh插件记忆库无够老的簇）]
  //     · 闸门①：19 簇里 **12 簇**原簇 < 256B ⇒ 提前判掉 **12 次调用**（19 → 7，省 63%）；
  //       ↳ 这个数字顺带说明**我们的簇本来就太小**：19 簇的原文加起来才 4869 字节（平均 ~256B/簇）。
  //         与 P1（docs/1020）的结论一致 —— L3 压缩对我们主要是**质量收益**（同主题合流、简报更短），
  //         不是体积收益；评级/汇报别拿"省了多少字节"当主指标。
  //     · 闸门②：默认 ratio=0.5 下额外判掉 **0 簇** —— 这是算术事实，不是没做：簇至少 2 条，
  //       最短的一条必然 ≤ sum/2 = 预算，所以"预算装不下一张 64B 卡片"在默认档不会发生；
  //       它只在 min_saved_ratio 调高时才拦得到东西（同一批 7 簇在 ratio=0.9 下判掉 6 簇）。
  //   ⇒ 再按 origBytes 降序处理：单轮配额先花在"收益上限最大"的簇上，不再是分簇顺序的先到先得
  //     （红队 R6 的原话：先到先得与本项目"按收益排序"的设计意图相反）。
  const planned = clusters.map((c) => {
    const origBytes = c.items.reduce((s, it) => s + Buffer.byteLength(String(it.text ?? ''), 'utf8'), 0);
    return { c, origBytes, budget: Math.floor(origBytes * (1 - p.minSavedRatio)) };
  });
  planned.sort((a, b) => b.origBytes - a.origBytes);

  for (const plan of planned) {
    const c = plan.c, origBytes = plan.origBytes;
    if (calls >= p.maxCallsPerRound) { log('已达单轮调用上限 ' + p.maxCallsPerRound + '，本轮提前收工（下轮继续）'); break; }
    if (used + calls >= p.maxCallsPerHour) { log('已达每小时调用上限 ' + p.maxCallsPerHour + '，本轮提前收工'); break; }
    // ── 调用前闸门①：原簇太小（合了也没意义）──
    if (origBytes < p.minUtf8Bytes) {
      clustersSkipped++;
      log('簇 ' + c.key.slice(0, 8) + '：原簇只有 ' + origBytes + ' 字节（门槛 ' + p.minUtf8Bytes + '），太小不压 —— 没调模型');
      continue;
    }
    // ── 调用前闸门②：合并预算装不下一张最小可用卡片 ⇒ 明显不可能达标 ──
    if (plan.budget < MIN_CARD_BYTES) {
      clustersSkipped++;
      log('簇 ' + c.key.slice(0, 8) + '：合并后最多只允许 ' + plan.budget + ' 字节（' + origBytes + '×(1-' + p.minSavedRatio + ')），装不下一张 ' + MIN_CARD_BYTES + ' 字节的卡片 ⇒ 不可能达标 —— 没调模型');
      continue;
    }
    calls++;
    try {
      const raw = await provider.complete(buildPrompt(c.items));
      const out = mergeCluster(c.items, raw);
      if (out.merged.length === 0) { callsWasted++; log('簇 ' + c.key.slice(0, 8) + '：模型没给出可用合并（丢弃 ' + out.discarded + ' 条），跳过'); discarded += out.discarded; continue; }
      // ── 收益闸门（1020 从 memcore 借鉴：min_saved_ratio；真判据，只能在调用后判）──
      //   没有这层时，模型合出来的东西**无论省多少都算成功** ⇒ 一堆「合了但没省」
      //   的白花调用被记成成果。判据：整个簇的原文总字节 → 合并后总字节，省够才落地。
      const mergedBytes = out.merged.reduce((s, m) => s + Buffer.byteLength(m.text, 'utf8'), 0);
      const savedRatio = origBytes > 0 ? 1 - mergedBytes / origBytes : 0;
      if (savedRatio < p.minSavedRatio) {
        callsWasted++;
        log('簇 ' + c.key.slice(0, 8) + '：合并只省 ' + (savedRatio * 100).toFixed(1) + '%（门槛 ' + (p.minSavedRatio * 100).toFixed(0) + '%），不落地（这次调用算空转）');
        continue;
      }
      for (const m of out.merged) {
        details.push({ clusterKey: c.key, mergedText: m.text, evidenceIds: m.evidenceIds, originals: c.items });
        merged++; itemsOut++;
      }
      discarded += out.discarded;
    } catch (e) {
      callsWasted++;
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
      note: KEEP_ORIGINAL_ALWAYS
        ? '原文快照已存 compress_detail.originals（回滚依据）；调用前判掉 ' + clustersSkipped + ' 簇、空转调用 ' + callsWasted + ' 次'
        : undefined,
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
      //   [R5] 写回现在**逐会话**标（簇可能跨会话），并按 id 定位；返回里带 unmatched 必须显式说出来
      const w = applyCompressionToData(db, details, new Date().toISOString(), log);
      log('已写回数据：' + w.sessions + ' 场、新增卡片 ' + w.cards + ' 条、标记原文 ' + w.marked + ' 条'
        + (w.unmatched ? '；另有 ' + w.unmatched + ' 条定位不到（见上方日志，原文未动）' : ''));
      log('  ⇒ 简报只显示卡片（带 compressed_into 的原文被跳过），检索仍能搜到全部原文');
    }
  } else if (!opts.apply) {
    log('（dry-run：没有写任何东西；加 apply 才落盘）');
  }

  return { clustersSeen: clusters.length, clustersMerged: details.length, itemsIn: all.length, itemsOut, discarded, calls, logId, blocked: null, clustersSkipped, callsWasted };
}
