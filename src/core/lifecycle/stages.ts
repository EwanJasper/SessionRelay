// ─────────── 生命周期：阶段 / 状态机 / 门禁（判据与状态都在 core）───────────
//
// 为什么要有它（ADR-002）：生命周期不是"一个外部脚本 + 开机自启"，而是**框架内的一条流水线**。
// 外部脚本（ses-cycle.mjs / 启动文件夹 vbs）只是驱动它的一种方式；DSH 插件里的 hooks + workers
// 是另一种、也是更原生的方式 —— 两者必须跑**同一份阶段定义**，否则又变成两套判据。
//
// 三条纪律：
//   ① 状态**落库**（lifecycle / health_events 两张表），不是 JSON 文件 —— 可查、可回溯、可跨进程共享；
//   ② 每个阶段**独立到期**（各自节奏），不是"每 30 分钟把所有阶段都跑一遍"；
//   ③ 有损阶段（L3）必须带门禁，门禁不过就回滚并写 health_events。

export type StageId = 'capture' | 'extract' | 'consolidate' | 'compact' | 'aging' | 'distribute' | 'guard' | 'repair';

export interface StageSpec {
  id: StageId;
  title: string;
  /** 最小间隔（秒）—— 每个阶段自己的节奏 */
  everySec: number;
  /** 会不会改动数据（改动型阶段跑前要先有可用备份） */
  mutates: boolean;
  /** 有损阶段（必须带门禁） */
  lossy?: boolean;
}

/** 阶段表：**唯一一份**（外部驱动与插件 hooks/workers 都读它） */
export const STAGES: StageSpec[] = [
  { id: 'guard', title: '体检与自检', everySec: 900, mutates: false },
  { id: 'repair', title: '损坏自愈（从原始会话重放）', everySec: 3600, mutates: true },
  { id: 'capture', title: '采集客户端会话', everySec: 900, mutates: true },
  { id: 'extract', title: '抽取 / 按规则版本重算', everySec: 1800, mutates: true },
  { id: 'consolidate', title: '经验衰减 / 退休 / 冲突标记', everySec: 3600, mutates: true },
  { id: 'compact', title: '无损去重（同会话精确重复）', everySec: 3600, mutates: true },
  { id: 'aging', title: '老化压缩（老会话正文→摘要，结论留全）', everySec: 86400, mutates: true },
  { id: 'distribute', title: '分发（简报段 / 面板 / 导出）', everySec: 900, mutates: false },
];

export interface StageState { ok: boolean; note: string; at: string; ms: number; fails: number }
export interface LifecycleState { version: number; rounds: number; lastAt: string | null; stages: Partial<Record<StageId, StageState>> }

export const LIFECYCLE_VERSION = 1;

/** 建表（幂等）：状态与错误都在库里，谁跑都能读到同一份 */
export function ensureLifecycleTables(db: { exec: (sql: string) => void }): void {
  db.exec([
    'CREATE TABLE IF NOT EXISTS lifecycle (',
    "  id INTEGER PRIMARY KEY CHECK (id = 1),",
    '  version INTEGER NOT NULL,',
    '  rounds INTEGER NOT NULL DEFAULT 0,',
    '  last_at TEXT,',
    '  stages TEXT NOT NULL',
    ')',
    'CREATE TABLE IF NOT EXISTS health_events (',
    '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
    '  at TEXT NOT NULL, stage TEXT NOT NULL, level TEXT NOT NULL,',
    '  message TEXT NOT NULL, detail TEXT',
    ')',
    'CREATE INDEX IF NOT EXISTS health_events_at ON health_events (at DESC)',
  ].join('\n'));
}

export function loadLifecycle(db: { prepare: (s: string) => { get: () => unknown } }): LifecycleState {
  const row = db.prepare('SELECT version, rounds, last_at, stages FROM lifecycle WHERE id = 1').get() as
    { version: number; rounds: number; last_at: string | null; stages: string } | undefined;
  if (!row) return { version: LIFECYCLE_VERSION, rounds: 0, lastAt: null, stages: {} };
  let stages: LifecycleState['stages'] = {};
  try { stages = JSON.parse(row.stages); } catch { stages = {}; }
  return { version: Number(row.version) || LIFECYCLE_VERSION, rounds: Number(row.rounds) || 0, lastAt: row.last_at, stages };
}

export function saveLifecycle(db: { prepare: (s: string) => { run: (...a: unknown[]) => unknown } }, st: LifecycleState): void {
  db.prepare('INSERT INTO lifecycle (id, version, rounds, last_at, stages) VALUES (1, ?, ?, ?, ?)'
    + ' ON CONFLICT(id) DO UPDATE SET version = excluded.version, rounds = excluded.rounds, last_at = excluded.last_at, stages = excluded.stages')
    .run(st.version, st.rounds, st.lastAt, JSON.stringify(st.stages));
}

export function recordStage(st: LifecycleState, id: StageId, r: Omit<StageState, 'fails'> & { fails?: number }): LifecycleState {
  const prev = st.stages[id];
  st.stages[id] = { ...r, fails: r.ok ? 0 : (r.fails ?? (prev?.fails ?? 0) + 1) };
  return st;
}

export function logHealthEvent(db: { prepare: (s: string) => { run: (...a: unknown[]) => unknown } },
  stage: StageId | string, level: 'info' | 'warn' | 'error', message: string, detail?: string): void {
  try { db.prepare('INSERT INTO health_events (at, stage, level, message, detail) VALUES (?,?,?,?,?)')
    .run(new Date().toISOString(), stage, level, message.slice(0, 500), (detail || '').slice(0, 4000)); } catch { /* 记账失败不许影响主流程 */ }
}

/**
 * 哪些阶段到期。**每个阶段自己的节奏**，所以"全跑一遍"不是唯一形态：
 * 高频（guard/capture/distribute）可以几分钟一次，低频（aging）一天一次。
 */
export function dueStages(st: LifecycleState, nowMs: number, opts: { only?: StageId[]; force?: boolean } = {}): StageSpec[] {
  return STAGES.filter((s) => {
    if (opts.only && !opts.only.includes(s.id)) return false;
    if (opts.force) return true;
    const last = st.stages[s.id];
    if (!last || !last.at) return true;
    const age = (nowMs - Date.parse(last.at)) / 1000;
    return !Number.isFinite(age) || age >= s.everySec;   // 时钟异常时宁可跑一次
  });
}

/** 连续失败降级：同一阶段连续失败 ≥3 次时，本轮跳过（避免坏阶段拖垮整条链路） */
export function shouldSkip(st: LifecycleState, id: StageId): { skip: boolean; reason?: string } {
  const prev = st.stages[id];
  if (prev && !prev.ok && (prev.fails ?? 0) >= 3) return { skip: true, reason: '连续失败 ' + prev.fails + ' 次，先跳过（原因：' + prev.note + '）' };
  return { skip: false };
}
