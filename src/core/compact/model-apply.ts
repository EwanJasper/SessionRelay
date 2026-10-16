// ─────────── L3 应用层：把 model.ts 的纯逻辑接到库上（审计 / 配额 / 回滚）───────────
//
// 分工：model.ts 是**纯函数**（分簇、提示词、解析、证据校验），本文件负责 IO 与账。
// 这样分是因为"抽不出证据就丢弃"这条边界必须能**单独测**（不需要起模型、不需要库）。

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
  } else if (!opts.apply) {
    log('（dry-run：没有写任何东西；加 apply 才落盘）');
  }

  return { clustersSeen: clusters.length, clustersMerged: details.length, itemsIn: all.length, itemsOut, discarded, calls, logId, blocked: null };
}
