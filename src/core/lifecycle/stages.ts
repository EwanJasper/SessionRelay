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

export type StageId = 'capture' | 'extract' | 'harvest' | 'consolidate' | 'compact' | 'cleanup' | 'tags' | 'aging' | 'distribute' | 'guard' | 'repair';

export interface StageSpec {
  id: StageId;
  title: string;
  /** 最小间隔（秒）—— 每个阶段自己的节奏 */
  everySec: number;
  /** 会不会改动数据（改动型阶段跑前要先有可用备份） */
  mutates: boolean;
  /** 有损阶段（必须带门禁） */
  lossy?: boolean;
  /** 体量：light = 单项目秒级、可以跑在**宿主进程内**（插件 worker）；
   *  heavy = 全量重放/整库重写、只许跑在独立进程（srelay lifecycle / watch）。
   *  为什么必须有这个字段：ADR-002 要把生命周期搬进宿主 worker，但把"全库重放"放进
   *  DSH 宿主进程会阻塞 UI —— 不能靠"记得别那么干"，要在数据上写清楚。 */
  weight: 'light' | 'heavy';
}

/** 阶段表：**唯一一份**（外部驱动与插件 hooks/workers 都读它） */
export const STAGES: StageSpec[] = [
  { id: 'guard', title: '体检与自检', everySec: 900, mutates: false, weight: 'light' },
  { id: 'repair', title: '损坏自愈（从原始会话重放）', everySec: 3600, mutates: true, weight: 'heavy' },
  { id: 'capture', title: '采集客户端会话', everySec: 900, mutates: true, weight: 'heavy' },
  { id: 'extract', title: '抽取 / 按规则版本重算', everySec: 1800, mutates: true, weight: 'light' },
  // [1021] 经验采集：**必须排在 consolidate（衰减/退休）之前**。
  //   病历：此前 harvest 只由手动命令跑，而 consolidate 每小时在跑 ——
  //   结果经验库**只减不增**（17 条里 7 条被衰减退休，全靠人工偶尔补几条）。
  //   顺序也要紧：先采新的再衰减旧的；反过来会让"这一轮刚采的"先被算一次衰减。
  //   体量 light：每项目扫最近 7 天 ≤4000 条消息，纯正则匹配；6 小时一次足够。
  { id: 'harvest', title: '经验采集（从项目记忆刨草稿）', everySec: 21600, mutates: true, weight: 'light' },
  { id: 'consolidate', title: '经验衰减 / 退休 / 冲突标记', everySec: 3600, mutates: true, weight: 'light' },
  { id: 'compact', title: '无损去重（同会话精确重复）', everySec: 3600, mutates: true, weight: 'light' },
  { id: 'cleanup', title: '派生列清洗（topics/files 噪声）', everySec: 3600, mutates: true, weight: 'light' },
  // [1021] 标签图谱重建：**必须进生命周期，否则它会烂掉**。
  //   此前它只由 `scripts/graph-tag-build.mjs` 手动建一次，会话一变就与库不一致 ——
  //   而 `core/graph/expand.ts` 读它时只会在空表时提示「先跑脚本」，**不会自己重建**。
  //   这属于「模块做完 ≠ 进入运行」的同类问题（时间衰减那轮刚吃过一次）。
  //   体量 light：实测 620 会话全量重建 1.3s，可跑在宿主进程内；每天一次足够。
  { id: 'tags', title: '标签图谱重建（检索扩展 / 逐词溯源用）', everySec: 86400, mutates: true, weight: 'heavy' },
  { id: 'aging', title: '老化压缩（老会话正文→摘要，结论留全）', everySec: 86400, mutates: true, lossy: true, weight: 'heavy' },
  { id: 'distribute', title: '分发（简报段 / 面板 / 导出）', everySec: 900, mutates: false, weight: 'light' },
];

/** 宿主内可跑的轻阶段（插件 worker 用）：heavy 阶段留给独立进程，别阻塞宿主 UI */
export function lightStages(): StageSpec[] { return STAGES.filter((s) => s.weight === 'light'); }

/** 结构性最小接口：只要一个能 exec/prepare 的库句柄（不绑定具体驱动，单测可传内存库） */
export interface LifecycleDb {
  exec: (sql: string) => unknown;
  // better-sqlite3 的 Statement 是带参泛型，结构上写不出"任意参数"；这里是适配边界，
  // 用 any 换掉一堆无意义的类型体操（调用点全部自带类型断言）。
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  prepare: (sql: string) => any;
}

export interface StageState { ok: boolean; note: string; at: string; ms: number; fails: number }
export interface LifecycleState { version: number; rounds: number; lastAt: string | null; stages: Partial<Record<StageId, StageState>> }

export const LIFECYCLE_VERSION = 1;

/** 建表（幂等）：状态与错误都在库里，谁跑都能读到同一份 */
export function ensureLifecycleTables(db: LifecycleDb): void {
  db.exec([
    'CREATE TABLE IF NOT EXISTS lifecycle (',
    "  id INTEGER PRIMARY KEY CHECK (id = 1),",
    '  version INTEGER NOT NULL,',
    '  rounds INTEGER NOT NULL DEFAULT 0,',
    '  last_at TEXT,',
    '  stages TEXT NOT NULL',
    ');',
    'CREATE TABLE IF NOT EXISTS health_events (',
    '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
    '  at TEXT NOT NULL, stage TEXT NOT NULL, level TEXT NOT NULL,',
    '  message TEXT NOT NULL, detail TEXT',
    ');',
    'CREATE INDEX IF NOT EXISTS health_events_at ON health_events (at DESC);',
    // 运行时心跳：谁在线、最近一次动过什么。用途是**协调单一写入方**——
    // 采集守护在线时，生命周期就不该再跑采集（两个写入方同写一个库 = SQLITE_BUSY，1017 实测）。
    // 这比"再挂一个脚本去查进程表"可靠：数据在库里，跨进程可读，不依赖 powershell。
    'CREATE TABLE IF NOT EXISTS runtime (',
    '  key TEXT PRIMARY KEY,',
    '  value TEXT,',
    '  at TEXT NOT NULL',
    ');',
  ].join('\n'));
}

/** 写心跳（谁在线/最近做了什么） */
export function setHeartbeat(db: LifecycleDb, key: string, value: string): void {
  try {
    db.prepare('INSERT INTO runtime (key, value, at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, at = excluded.at')
      .run(key, value, new Date().toISOString());
  } catch { /* 心跳失败不影响主流程 */ }
}

/** 读心跳的年龄（毫秒）；没有记录返回 null */
export function heartbeatAgeMs(db: LifecycleDb, key: string): number | null {
  try {
    const row = db.prepare('SELECT at FROM runtime WHERE key = ?').get(key) as { at: string } | undefined;
    if (!row?.at) return null;
    const t = Date.parse(row.at);
    return Number.isFinite(t) ? Date.now() - t : null;
  } catch { return null; }
}

export function loadLifecycle(db: LifecycleDb): LifecycleState {
  const row = db.prepare('SELECT version, rounds, last_at, stages FROM lifecycle WHERE id = 1').get() as
    { version: number; rounds: number; last_at: string | null; stages: string } | undefined;
  if (!row) return { version: LIFECYCLE_VERSION, rounds: 0, lastAt: null, stages: {} };
  let stages: LifecycleState['stages'] = {};
  try { stages = JSON.parse(row.stages); } catch { stages = {}; }
  return { version: Number(row.version) || LIFECYCLE_VERSION, rounds: Number(row.rounds) || 0, lastAt: row.last_at, stages };
}

export function saveLifecycle(db: LifecycleDb, st: LifecycleState): void {
  db.prepare('INSERT INTO lifecycle (id, version, rounds, last_at, stages) VALUES (1, ?, ?, ?, ?)'
    + ' ON CONFLICT(id) DO UPDATE SET version = excluded.version, rounds = excluded.rounds, last_at = excluded.last_at, stages = excluded.stages')
    .run(st.version, st.rounds, st.lastAt, JSON.stringify(st.stages));
}

export function recordStage(st: LifecycleState, id: StageId, r: Omit<StageState, 'fails'> & { fails?: number }): LifecycleState {
  const prev = st.stages[id];
  st.stages[id] = { ...r, fails: r.ok ? 0 : (r.fails ?? (prev?.fails ?? 0) + 1) };
  return st;
}

export function logHealthEvent(db: LifecycleDb,
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

/**
 * 连续失败降级：同一阶段连续失败 ≥3 次时本轮跳过（避免坏阶段拖垮整条链路）。
 *
 * ── [1021 红队 R3 修复] 原来的实现是**永久停用**，不是「降级」 ──
 *   死循环：失败 3 次 → 跳过 → **永远不跑** → 永远不可能成功 → `fails` 永不为 0 → 永远跳过。
 *   实测（红队探针）：`fails=3` 后连跑 100 轮仍然 skip，日志一行不打，报告还写 `ok:true`。
 *   用户看到的是「一切正常」，实际那条阶段早就不干活了 —— 这正是本项目最嫌恶的静默半失效。
 *
 * 修法：**熔断器的半开状态** —— 跳过不等于永久放弃。超过 `RETRY_AFTER_MS` 就放**一次**探测：
 *   · 探测成功 ⇒ recordStage 把 fails 归 0，阶段自动恢复（自愈）
 *   · 探测再失败 ⇒ fails 继续累加，再等一个冷却期
 *   这样最坏情况只是「每冷却期试一次」，不会把链路拖垮，也不会永久装死。
 */
export const RETRY_AFTER_MS = 30 * 60_000;  // 30 分钟放一次探测

export function shouldSkip(st: LifecycleState, id: StageId, nowMs = Date.now()): { skip: boolean; reason?: string } {
  const prev = st.stages[id];
  if (!prev || prev.ok || (prev.fails ?? 0) < 3) return { skip: false };
  // 到了冷却期 ⇒ 放行一次探测（注意：这里**不清零 fails**，探测成功才由 recordStage 归零）
  const lastAt = Date.parse(prev.at);
  if (Number.isFinite(lastAt) && nowMs - lastAt >= RETRY_AFTER_MS) return { skip: false };
  return { skip: true, reason: '连续失败 ' + prev.fails + ' 次，冷却中（每 30 分钟放一次探测；原因：' + prev.note + '）' };
}
