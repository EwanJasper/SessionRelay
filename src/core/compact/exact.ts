// ─────────── 压缩 L0/L1：同会话**逐字重复**合并（零信息损失）───────────
//
// 为什么是"同会话 + 归一化文本"这个最笨的键：它**可证明无损** —— 重复的那条文本仍在
// 同一场会话里留着一条，频次记在 dupCount 上；检索面看不到任何新增噪声，也丢不了信息。
// 跨会话近重复（compactItems 的 global 模式）实测省 57% 体积但掉召回，已被门禁否决
// （见 ADR-002 §3 与 docs/2026-10-17-compression-l1-l4.md），所以默认只跑这一层。
//
// ⚠️ 这份实现原先在 tools/ses-compact.mjs 里（外挂脚本）。按 ADR-002 §4"外挂脚本降级为内核
// API 的薄壳"搬进内核：脚本只负责参数解析与打印，判据与写回只有这一处。

import type { DB } from '../../store/db.js';

export interface ExactCompactReport {
  /** 扫描的会话数 */
  sessions: number;
  /** 实际发生合并的会话数 */
  changed: number;
  /** 合并掉的重复条数 */
  merged: number;
  bytesBefore: number;
  bytesAfter: number;
}

const bytes = (s: unknown): number => Buffer.byteLength(String(s ?? ''), 'utf8');

/** 同会话逐字重复合并。apply=false 时只统计不写（默认 dry-run，与旧脚本一致）。 */
export function compactExactSessions(db: DB, opts: { apply?: boolean } = {}): ExactCompactReport {
  const apply = opts.apply === true;
  const rows = db.prepare(
    "SELECT id, decisions FROM sessions WHERE decisions IS NOT NULL AND json_valid(decisions) AND length(decisions) > 2"
  ).all() as Array<{ id: string; decisions: string }>;

  // 逐会话分组保留：键 = 会话 + 归一化空白后的文本；保留最早出现的那条并记 dupCount
  const bySid = new Map<string, Array<Record<string, unknown>>>();
  let merged = 0;
  for (const r of rows) {
    let arr: unknown;
    try { arr = JSON.parse(r.decisions); } catch { continue; }
    if (!Array.isArray(arr)) continue;
    const seen = new Map<string, Record<string, unknown>>();
    const kept: Array<Record<string, unknown>> = [];
    for (const d of arr as Array<Record<string, unknown>>) {
      if (!d || typeof d.text !== 'string' || !d.text) { kept.push(d); continue; }
      const key = String(d.text).replace(/\s+/g, ' ').trim();
      const hit = seen.get(key);
      if (hit) { hit.dupCount = (Number(hit.dupCount) || 1) + 1; merged++; continue; }
      seen.set(key, d);
      kept.push(d);
    }
    if (kept.length !== arr.length) bySid.set(r.id, kept);
  }

  let bytesBefore = 0, bytesAfter = 0;
  for (const r of rows) {
    bytesBefore += bytes(r.decisions);
    const w = bySid.get(r.id);
    if (!w) { bytesAfter += bytes(r.decisions); continue; }
    const after = JSON.stringify(w);
    bytesAfter += bytes(after);
    if (apply) db.prepare('UPDATE sessions SET decisions = ? WHERE id = ?').run(after, r.id);
  }
  return { sessions: rows.length, changed: bySid.size, merged, bytesBefore, bytesAfter };
}
