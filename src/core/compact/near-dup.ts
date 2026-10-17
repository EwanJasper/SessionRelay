// ─────────── 压缩 L1b：跨会话近重复合并（写回 + 可审计 + 可回滚）───────────
//
// 与 L0（exact.ts，同会话逐字重复）的分工：
//   L0 = 同一场会话里逐字相同的条目合并（键是"会话+归一化文本"，可证明无损）
//   L1b = **跨会话**近重复合并（判据是 isNearDuplicate 的重叠系数 ≥ 阈值）
//
// 为什么拖到 1021 才敢接自动路径（历史上被否决过一次）：
//   AC 1026 的否决理由是"省 57% 体积但 hit@1 掉 5~7pt"。真正的机制不是"合并有损"，
//   而是**代表选择规则**：原来的规则是"保留最新一条"，而跨来源的近重复里最新往往是
//   workflow 子代理的转述 —— 它吸收掉主会话的拍板后，幸存者带 origin='workflow'，
//   被读路径的 `origin != 'workflow'` 硬过滤整组挡掉 ⇒ 才会掉召回。
//   现在代表选择改成 highest-trust（低可信不许当代表），机制上不再可能发生。
//
// 四条纪律（与 L3 压缩同规，ADR-002 §2）：
//   ① 原文永不删：被吸收的条目原文快照进 compact_detail.absorbed，可回滚
//   ② 可审计：每次合并写 compact_log（策略/阈值/进多少出多少/字节数）
//   ③ 只动 decisions 与 meta_text：messages 一条不碰，派生列其余字段不动
//   ④ 掉召回整批回滚：由调用方用召回基准把关（见 docs）

import type { DB } from '../../store/db.js';
import { recomputeSessionMetaText } from '../../store/db.js';
import { compactItems, type RepresentativePolicy } from './dedup.js';

/** 参与合并的决策条目（内部用：带上归属会话与原始序号，落库前会被剥掉） */
interface WorkItem {
  text: string;
  at?: string | null;
  kind?: string | null;
  [k: string]: unknown;
  /** 归属会话（内部字段，不落库） */
  sid: string;
  /** 在该会话 decisions 数组里的原始位置（内部字段，用于恢复相对顺序） */
  ord: number;
  /** 会话来源（内部字段，只用于选代表） */
  origin: string;
}

export interface NearDupSample {
  kept: string;
  absorbed: string[];
  keptOrigin: string;
  absorbedOrigins: string[];
}

export interface NearDupReport {
  /** 扫描的会话数（有 decisions 的） */
  sessions: number;
  /** 参与比较的条目总数 */
  itemsIn: number;
  /** 合并后剩余条目数 */
  itemsOut: number;
  /** 近重复组数 */
  groups: number;
  /** 被吸收掉的条目数 */
  merged: number;
  /** decisions 真的被改写的会话数 */
  sessionsChanged: number;
  bytesBefore: number;
  bytesAfter: number;
  /** 审计样本（前 5 组），dry-run 时用来人眼核对 */
  samples: NearDupSample[];
  /** 是否真写库 */
  applied: boolean;
  /** 本次审计日志 id（apply 时才有） */
  logId: number | null;
}

export interface NearDupOptions {
  /** 只统计不写（默认 true —— 与 L0 的 apply=false 语义一致） */
  apply?: boolean;
  /** 近重复阈值（默认 0.8，实测能吃掉约 1/3 而不误杀） */
  threshold?: number;
  /** 代表选择策略（默认 highest-trust：低可信来源不许当代表） */
  representative?: RepresentativePolicy;
  /** 触发者（写进审计日志，默认 'manual'） */
  triggeredBy?: string;
}

const bytes = (s: unknown): number => Buffer.byteLength(String(s ?? ''), 'utf8');

function safeJson<T>(raw: unknown, fallback: T): T {
  try {
    const v = JSON.parse(String(raw ?? ''));
    return (v ?? fallback) as T;
  } catch { return fallback; }
}

/** 把内部字段剥掉，只留该落库的键（decisions 的原有形状：text/at/kind + dupCount/firstSeen） */
function toStored(it: WorkItem): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(it)) {
    if (k === 'sid' || k === 'ord' || k === 'origin') continue;
    out[k] = v;
  }
  return out;
}

/**
 * 跨会话近重复合并。
 *
 * ⚠️ dry-run（apply 缺省）只统计、不写库。写库时会在同一个事务里完成：
 *   decisions 改写 → meta_text 重算 → 审计日志，任一步失败整批回滚。
 */
export function compactNearDuplicates(db: DB, opts: NearDupOptions = {}): NearDupReport {
  const apply = opts.apply === true;
  const threshold = opts.threshold ?? 0.8;
  const policy: RepresentativePolicy = opts.representative ?? 'highest-trust';
  const triggeredBy = opts.triggeredBy ?? 'manual';

  const rows = db.prepare(
    "SELECT id, title, topics, user_tags, COALESCE(origin, '') AS origin, decisions FROM sessions "
    + "WHERE decisions IS NOT NULL AND json_valid(decisions) AND length(decisions) > 2"
  ).all() as Array<{ id: string; title?: string | null; topics?: string | null; user_tags?: string | null; origin?: string; decisions?: string }>;

  const items: WorkItem[] = [];
  let bytesBefore = 0;
  for (const r of rows) {
    const arr = safeJson<unknown[]>(r.decisions, []);
    if (!Array.isArray(arr)) continue;
    bytesBefore += bytes(String(r.decisions ?? ''));
    arr.forEach((raw, ord) => {
      if (!raw || typeof raw !== 'object') return;
      const d = raw as Record<string, unknown>;
      const text = String(d.text ?? '');
      if (!text) return;
      items.push({ ...d, text, sid: String(r.id), ord, origin: String(r.origin ?? '') });
    });
  }

  const { kept, groups } = compactItems(items, { threshold, representative: policy });

  // 按会话回填：保留条目里属于该会话的那些，**恢复原始相对顺序**
  const bySid = new Map<string, WorkItem[]>();
  for (const k of kept) {
    const list = bySid.get(k.sid) ?? [];
    list.push(k);
    bySid.set(k.sid, list);
  }

  let sessionsChanged = 0;
  let bytesAfter = 0;
  const writes: Array<{ id: string; json: string }> = [];
  for (const r of rows) {
    const list = (bySid.get(String(r.id)) ?? []).slice().sort((a, b) => a.ord - b.ord);
    const json = JSON.stringify(list.map(toStored));
    bytesAfter += bytes(json);
    if (json !== String(r.decisions ?? '')) {
      sessionsChanged++;
      writes.push({ id: String(r.id), json });
    }
  }

  const samples: NearDupSample[] = groups.slice(0, 5).map((g) => ({
    kept: String(g.keep.text).slice(0, 120),
    absorbed: g.absorbed.map((a) => String(a.text).slice(0, 120)),
    keptOrigin: String((g.keep as WorkItem).origin ?? ''),
    absorbedOrigins: g.absorbed.map((a) => String((a as WorkItem).origin ?? '')),
  }));

  const report: NearDupReport = {
    sessions: rows.length,
    itemsIn: items.length,
    itemsOut: kept.length,
    groups: groups.length,
    merged: groups.reduce((s, g) => s + g.absorbed.length, 0),
    sessionsChanged,
    bytesBefore,
    bytesAfter,
    samples,
    applied: false,
    logId: null,
  };
  if (!apply) return report;

  // ── 写库：一个事务里 decisions + meta_text + 审计 ──
  const now = new Date().toISOString();
  db.exec('BEGIN');
  try {
    const insLog = db.prepare(
      'INSERT INTO compact_log (triggered_by, policy, threshold, groups_merged, items_in, items_out, sessions_changed, bytes_before, bytes_after, created_at) '
      + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    const info = insLog.run(triggeredBy, policy, threshold, report.groups, report.itemsIn, report.itemsOut, report.sessionsChanged, report.bytesBefore, report.bytesAfter, now);
    const logId = Number(info.lastInsertRowid);

    const insDetail = db.prepare(
      'INSERT INTO compact_detail (compact_log_id, session_id, kept_text, absorbed, created_at) VALUES (?, ?, ?, ?, ?)'
    );
    const upd = db.prepare('UPDATE sessions SET decisions = ? WHERE id = ?');
    for (const w of writes) upd.run(w.json, w.id);
    for (const g of groups) {
      const keep = g.keep as WorkItem;
      // ⚠️ 快照必须**带上每条自己的归属会话**（sid）。
      //   病历：第一版只存了"保留条目"的 sid，回滚时把被吸收的条目一股脑塞回那个会话 ——
      //   而跨会话合并的本质正是"被吸收的来自别的会话"。实测 12 个受影响会话只回滚了 3 个、
      //   734 条只恢复 5 条，其余全错位。回滚口径必须与被处理对象一一对应。
      const snap = g.absorbed.map((a) => {
        const w = a as WorkItem;
        return { sid: w.sid, item: toStored(w) };
      });
      insDetail.run(logId, keep.sid, String(keep.text), JSON.stringify(snap), now);
    }
    // meta_text 必须跟着重建：它是 title + topics + decisions 前 30 字 + user_tags 的拼接，
    // decisions 一变索引就旧了。不重建 = 库里已经合并、检索面还是老样子（两边分叉）。
    for (const w of writes) recomputeSessionMetaText(db, w.id);

    db.exec('COMMIT');
    report.applied = true;
    report.logId = logId;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* 已回滚 */ }
    throw e;
  }
  return report;
}

/**
 * 回滚一次 L1 合并：把 compact_detail 里快照的原文并回对应会话的 decisions。
 *
 * 注意"并回"而不是"覆盖"：合并之后可能又有新决策写入，直接覆盖会丢掉这段时间的新内容。
 * 判据：快照里的条目按 text 去重并回；已存在的不重复加。
 */
export function rollbackNearDuplicates(db: DB, logId: number): { sessions: number; restored: number } {
  const details = db.prepare('SELECT absorbed FROM compact_detail WHERE compact_log_id = ?').all(logId) as Array<{ absorbed: string }>;
  let sessions = 0;
  let restored = 0;
  db.exec('BEGIN');
  try {
    // 按**被吸收条目自己的会话**分组后再并回（见 compactNearDuplicates 里那段病历）
    const bySid = new Map<string, Record<string, unknown>[]>();
    for (const d of details) {
      const snap = safeJson<Array<{ sid?: string; item?: Record<string, unknown> }>>(d.absorbed, []);
      for (const s of snap) {
        const sid = String(s?.sid ?? '');
        if (!sid || !s?.item) continue;
        const list = bySid.get(sid) ?? [];
        list.push(s.item);
        bySid.set(sid, list);
      }
    }
    for (const [sid, snap] of bySid) {
      const row = db.prepare('SELECT decisions FROM sessions WHERE id = ?').get(sid) as { decisions?: string } | undefined;
      if (!row) continue;
      const cur = safeJson<Record<string, unknown>[]>(row.decisions, []);
      const have = new Set(cur.map((x) => String(x?.text ?? '')));
      const add = snap.filter((x) => !have.has(String(x?.text ?? '')));
      if (!add.length) continue;
      db.prepare('UPDATE sessions SET decisions = ? WHERE id = ?').run(JSON.stringify([...cur, ...add]), sid);
      recomputeSessionMetaText(db, sid);
      sessions++; restored += add.length;
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* 已回滚 */ }
    throw e;
  }
  return { sessions, restored };
}
