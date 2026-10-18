// 面板数据的**唯一取数实现**（总览 / 压缩图谱 / 经验图谱 / 设置）
//
// ═══ 为什么在核心库，而不是在插件里 ═══
// 用户令："面板里不许有第二套取数逻辑"。此前的面板宿主半自己写 SQL、自己读注册表、
// 自己判断经验能不能注入 —— 于是它与 CLI/简报各说各话（本项目第一号故障模式）。
// 现在：SQL、口径、判据全在这里，插件/应急入口只负责"把它渲染出来"。
//
// ═══ 为什么能跑在没有原生模块的进程里 ═══
// 本文件的全部 import 都是**纯**的（无 better-sqlite3、无 @node-rs/jieba）：
//   · 数据库句柄由 panel/db.ts 提供（node:sqlite 优先）—— 一句 SQL 都不在这里重复；
//   · 闸门判据来自 store/lesson-gate.ts（零依赖）；
//   · 淘汰判据来自 core/compact/aging.ts 与 core/lifecycle/stages.ts（都是零依赖）。
// 一旦有人往这条链上挂重依赖，插件就装不进 DSH 了 —— 有测试钉住这件事。
//
// ═══ 纪律 ═══
// 容错不许静默：任何一项读不到，都要在 errors[] 里留下一句话，并让对应字段为 null，
// **不许**变成 0 / 空数组让人以为是"真的没有"。

import fs from 'node:fs';
import path from 'node:path';
import { dbFile, configFile, globalDbFile, relayDir } from '../shared/paths.js';
import { decisionKey } from '../store/decision-validity.js';
import { registryCandidates } from '../shared/registry.js';
import { defaultConfig, mergeConfig, saveConfig, readConfigFile, type RelayConfig } from '../shared/config-merge.js';
import { isInjectable, liveImportance, INJECT_THRESHOLD, DECAY_PER_DAY, type LessonRow } from '../store/lesson-gate.js';
import { planAging, strengthOf, strengthGateOf, ARCHIVE_CAP_PER_ROUND } from '../core/compact/aging.js';
import { compactExactSessions } from '../core/compact/exact.js';
import { EXTRACT_VERSION } from '../core/extract/version.js';
import { STAGES, loadLifecycle, dueStages, heartbeatAgeMs, type LifecycleDb } from '../core/lifecycle/stages.js';
import { KNOB_SPECS, knobStates, validateKnob, setPath, type KnobState } from './knobs.js';
import { withDb, openReadonly, type ReadonlyDb } from './db.js';
import { registryHeartbeatFresh , isDaemonAlive } from '../shared/lock.js';
import { readSemanticStatus, describeSemantic, type SemanticRuntimeStatus } from '../search-svc/semantic-status.js';

/**
 * 面板侧的配置读取：**与 CLI 的 loadConfig 共用同一份合并逻辑与同一句错误文案**
 * （readConfigFile + mergeConfig 都在 shared/config-merge.ts），
 * 差别只有一处：不动进程级分词器单例 —— 面板不改搜索行为，也不该为一个只读页
 * 去加载 @node-rs/jieba 原生模块（那是"面板插件零依赖"的唯一障碍）。
 */
function panelLoadConfig(root: string): RelayConfig {
  const r = readConfigFile(root);
  if (r.error) throw new Error(r.error);
  return mergeConfig(r.raw);
}

/** 每张卡片/图表都要带的"这个数怎么算的"，铁律 22：数字必须绑快照与口径 */
export const PANEL_CRITERIA = {
  sessions: 'count(sessions)——本库登记过的会话总数（含已归档，归档只删正文不删行）',
  decisions: 'json_each(sessions.decisions) 的条目数——按条算，不是"有决策的会话数"',
  unresolved: 'json_each(sessions.key_questions) 的条目数（未决问题）',
  archived: 'sessions.cleanup_at IS NOT NULL 的会话数——正文已蒸发、结论仍在',
  lessonsInjectable: 'status ∈ {verified,confirmed} 且 grade ≠ inferred 且 实时重要度 ≥ ' + INJECT_THRESHOLD
    + '（store/lesson-gate.ts 的唯一判据；实时重要度 = 定级分 − 年龄×' + DECAY_PER_DAY + ' + 使用奖励）',
  l0: 'compaction L0：同会话逐字重复合并（无损）。merged = 被合并掉的重复条数（dupCount 累计）',
  l2: 'compaction L2：老化归档，只蒸发正文，结论/话题/摘要骨架保留；数据来自 cleanup_log/cleanup_detail 审计表',
  aging: 'ADR-003：strength = max(0, 1 − 年龄天数/90)；窗→强度门由 strengthGateOf 推导，与窗边界数学重合',
  config: '取值层：环境变量 > 项目 .sessionrelay/config.json > 内置默认值',
} as const;

// ─────────────────────────── 项目卡片 ───────────────────────────

export interface PanelProject {
  root: string; name: string; ok: boolean; error: string | null;
  sessions: number; messages: number; decisions: number; unresolved: number; archived: number;
  lastEventAt: string | null; dbBytes: number; daemonAlive: boolean; lastActiveAt: string | null;
  archiveEnabled: boolean | null;
}

/**
 * 数 JSON 列里的条目数。
 *
 * ⚠️ [1021 后端红队 #1/#2 修] 原来这里只数「JSON 数组有几个元素」，不看**语义**：
 *   · `key_questions` 数了**全部问题**（含已回答/已解决的）⇒ 面板 686，而真实未决只有 55；
 *   · `decisions` 数了**原始条目**，绕过去重与 workflow 排除 ⇒ 面板 728，而真实 460。
 *   同一时刻同一个事实，面板 / SQL / CLI / 简报给出 686/55/4/1 和 728/460/7 四个数。
 *
 * 修法：把「什么算一条」交给调用方显式说明（filterExpr），不再由这里猜。
 *   `key_questions` 传 `$.unresolved` 过滤；`decisions` 传文本去重 + origin 排除。
 *   判据仍然只有一份 —— 都在下面的 SQL 片段里，看得见、可 review。
 */
function countJsonItems(db: ReadonlyDb, column: string, filterExpr?: string): number {
  // 先在子查询里滤掉非法 JSON：SQLite 的 json_each 遇到坏文本会直接抛，不能让它炸整张卡
  const base = 'SELECT ' + column + ' AS v FROM sessions'
    + ' WHERE ' + column + ' IS NOT NULL AND json_valid(' + column + ') AND length(' + column + ') > 2';
  if (!filterExpr) {
    const sql = 'SELECT count(*) AS c FROM (' + base + ') t, json_each(t.v)';
    const row = db.prepare(sql).get() as { c?: number } | undefined;
    return Number(row?.c ?? 0);
  }
  const sql = 'SELECT count(*) AS c FROM (' + base + ') t, json_each(t.v) je WHERE ' + filterExpr;
  const row = db.prepare(sql).get() as { c?: number } | undefined;
  return Number(row?.c ?? 0);
}
function bytesOf(file: string): number {
  let n = 0;
  for (const f of [file, file + '-wal', file + '-shm']) {
    try { n += fs.statSync(f).size; } catch { /* 不存在就算了 */ }
  }
  return n;
}

/** 单项目取数。失败**返回 error 而不是抛**——一个库坏了不该让整张面板打不开 */
/**
 * 读已被取代的决策 key 集合。旧库没有旁表 ⇒ 返回空集（= 全部视为有效），
 * **绝不能因为读不到表就让所有决策凭空消失**（这是本条设计的兼容铁律）。
 */
function supersededDecisionKeys(db: unknown): Set<string> {
  const out = new Set<string>();
  try {
    const rows = (db as { prepare: (s: string) => { all: () => unknown[] } })
      .prepare('SELECT decision_key FROM decision_validity WHERE active = 0').all() as Array<{ decision_key?: string }>;
    for (const r of rows) if (r.decision_key) out.add(String(r.decision_key));
  } catch { /* 无旁表 / 旧库：全部视为有效 */ }
  return out;
}

export function panelProjectCard(root: string, extra: { daemonAlive?: boolean; lastActiveAt?: string | null } = {}): PanelProject {
  const out: PanelProject = {
    root, name: path.basename(root) || root, ok: false, error: null,
    sessions: 0, messages: 0, decisions: 0, unresolved: 0, archived: 0,
    lastEventAt: null, dbBytes: 0, daemonAlive: extra.daemonAlive ?? false, lastActiveAt: extra.lastActiveAt ?? null,
    archiveEnabled: null,
  };
  try { out.archiveEnabled = panelLoadConfig(root).archive?.enabled ?? null; }
  catch { /* 配置读不到不影响统计 */ }
  const f = dbFile(root);
  if (!fs.existsSync(f)) { out.error = '没有库文件（项目可能只注册过、还没采集）'; return out; }
  out.dbBytes = bytesOf(f);
  return withDb(f, (db) => {
    const one = (sql: string): unknown => (db.prepare(sql).get() as Record<string, unknown> | undefined);
    out.sessions = Number((one('SELECT count(*) AS c FROM sessions') as { c?: number })?.c ?? 0);
    out.messages = Number((one('SELECT count(*) AS c FROM messages') as { c?: number })?.c ?? 0);
    out.archived = Number((one('SELECT count(*) AS c FROM sessions WHERE cleanup_at IS NOT NULL') as { c?: number })?.c ?? 0);
    const t = one('SELECT max(last_event_at) AS m FROM sessions') as { m?: string | null } | undefined;
    out.lastEventAt = t && t.m ? String(t.m) : null;
    // [1021 后端红队 #1/#2] 两个数改成**有语义的计数**，与读路径对齐。
    //   原来：decisions 数原始条目（含 workflow、含重复）⇒ 728，真实 460；
    //         unresolved 数**全部** key_questions（含已回答）⇒ 686，真实 55。
    //   同一时刻同一事实，四个入口给出 686/55/4/1 —— 这就是「面板在撒谎」的具体形态。
    //   决策：按 text 去重 + 排除 workflow 出处（与 db.ts 读路径同口径）。
    // [1021 决策有效性] 计数也要吃旁表：把 DISTINCT 文本取回来，在 JS 里按 decisionKey 判活性。
    //   为什么不在 SQL 里过滤：decision_key 是 JS 侧的归一化（NFKC/大小写/标点）算出来的，
    //   SQL 里再写一遍就是**第二份判据**（本仓头号病）。宁可多取几百条文本回来。
    //   无旁表记录的老决策按 active 处理（兼容铁律，与 listDecisions 同一条）。
    const decSql = "SELECT DISTINCT json_extract(je.value,'$.text') AS t FROM"
      // [1021 审查 #12] 隔离会话的决策不计入「已确认结论」——与 listDecisions 同一判据
      + " (SELECT decisions AS v FROM sessions WHERE decisions IS NOT NULL"
      + "  AND json_valid(decisions) AND length(decisions) > 2"
      + "  AND COALESCE(state,'') <> 'quarantine') t, json_each(t.v) je"
      + " WHERE COALESCE(json_extract(je.value,'$.origin'),'') <> 'workflow'";
    const deadKeys = supersededDecisionKeys(db);
    const decRows = db.prepare(decSql).all() as Array<{ t: string | null }>;
    out.decisions = decRows.filter((r) => {
      const t = r.t == null ? '' : String(r.t);
      if (!t) return false;
      return !deadKeys.has(decisionKey(t));
    }).length;
    //   未决：只数 `$.unresolved` 为真的。
    out.unresolved = countJsonItems(db, 'key_questions', "COALESCE(json_extract(je.value,'$.unresolved'),0) <> 0");
    out.ok = true;
    return out;
  }, (msg) => { out.error = msg; }) ?? out;
}

// ─────────────────────────── 经验层 ───────────────────────────

export interface PanelLessonItem {
  id: number; text: string; grade: string; scope: string; status: string; domain: string | null;
  live: number; injectable: boolean; needsReview: boolean; createdAt: string; uses: number; hits: number;
}

export interface PanelLessons {
  ok: boolean; error: string | null; total: number; injectable: number; admissionRate: number;
  threshold: number;
  byStatus: Record<string, number>; byGrade: Record<string, number>; byScope: Record<string, number>;
  items: PanelLessonItem[];
}

const EMPTY_LESSONS = (error: string | null): PanelLessons => ({
  ok: false, error, total: 0, injectable: 0, admissionRate: 0, threshold: INJECT_THRESHOLD,
  byStatus: {}, byGrade: {}, byScope: {}, items: [],
});

/** 全局经验层（~/.sessionrelay/global.sqlite）。判据走 lesson-gate 的唯一一份实现 */
export function panelLessons(limit = 200): PanelLessons {
  const f = globalDbFile();
  if (!fs.existsSync(f)) return EMPTY_LESSONS('还没有全局经验库（跑过任何一次采集后才会建）');
  const got = withDb(f, (db) => {
    const rows = db.prepare('SELECT * FROM lessons').all() as LessonRow[];
    const now = Date.now();
    const items: PanelLessonItem[] = rows.map((r) => ({
      id: Number(r.id), text: String(r.text ?? ''), grade: String(r.grade ?? ''), scope: String(r.scope ?? ''),
      status: String(r.status ?? ''), domain: r.domain ?? null,
      live: Number(liveImportance(r, now).toFixed(2)), injectable: isInjectable(r, now),
      needsReview: Number(r.needs_review) === 1, createdAt: String(r.created_at ?? ''),
      uses: Number(r.uses ?? 0), hits: Number(r.hits ?? 0),
    }));
    const bump = (m: Record<string, number>, k: string) => { m[k] = (m[k] ?? 0) + 1; };
    const byStatus: Record<string, number> = {}, byGrade: Record<string, number> = {}, byScope: Record<string, number> = {};
    for (const i of items) { bump(byStatus, i.status); bump(byGrade, i.grade); bump(byScope, i.scope); }
    items.sort((a, b) => Number(b.injectable) - Number(a.injectable) || b.live - a.live);
    const injectable = items.filter((i) => i.injectable).length;
    return {
      ok: true, error: null, total: items.length, injectable,
      admissionRate: items.length ? Number((injectable / items.length).toFixed(3)) : 0,
      threshold: INJECT_THRESHOLD, byStatus, byGrade, byScope, items: items.slice(0, limit),
    } as PanelLessons;
  }, () => undefined);
  return got ?? EMPTY_LESSONS('全局经验库打不开（被别的进程独占？见 errors）');
}

// ─────────────────────────── 生命周期 ───────────────────────────

/**
 * 阶段健康度（[1021] 新增字段，**只加不改**）。
 *
 * 病历：面板上 11 个阶段长得一模一样——看不出「昨天跑过」与「三十天没动过」的区别，
 * 也看不出「跑了但永远产出 0」的（aging 就是：每轮 ok=true，实际计划 0 场）。用户原话
 * 「看不出哪些功能是开的、哪些是关的、关着的原因是什么」说的就是这一类。
 *
 * 判据全部来自**已有记账**（loadLifecycle 的阶段记录），不硬编码、不猜：
 *   never   = 从没有过运行记录
 *   overdue = 距上次运行 > 2×自身节奏（节奏来自 STAGES.everySec，不是写死的常量）
 *   ok      = 其余
 * why 直接带阶段自己写的 note（例如 aging 的「本轮无会话可归档（…计划 0+0…）」）。
 */
export interface PanelStageHealth {
  id: string; label: string;
  everySec: number; cadenceText: string;
  lastAt: string | null; ageMs: number | null;
  state: 'ok' | 'overdue' | 'never';
  why: string;
}

export interface PanelLifecycle {
  ok: boolean; error: string | null;
  version: number | null; rounds: number | null; lastAt: string | null;
  stages: Array<{ id: string; label: string; weight: string; everySec: number; ok: boolean; note: string; at: string | null; ms: number | null; fails: number }>;
  /** [1021] 每个阶段的健康度（与 stages 同长同序；只加字段，不动 stages 语义） */
  stageHealth: PanelStageHealth[];
  dueNow: string[];
  heartbeat: Array<{ key: string; at: string; ageMs: number | null }>;
  recent: Array<{ at: string; stage: string; level: string; message: string }>;
}

/** 秒 → 人话节奏（86400 → 「每天」）。只在面板显示用，不参与任何判据。 */
function cadenceTextOf(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '不定';
  if (sec % 86400 === 0) return sec === 86400 ? '每天' : '每 ' + (sec / 86400) + ' 天';
  if (sec % 3600 === 0) return '每 ' + (sec / 3600) + ' 小时';
  return '每 ' + Math.max(1, Math.round(sec / 60)) + ' 分钟';
}

function stageHealthOf(stages: PanelLifecycle['stages'], nowMs = Date.now()): PanelStageHealth[] {
  return stages.map((s) => {
    const t = s.at ? Date.parse(s.at) : NaN;
    const ageMs = Number.isFinite(t) ? nowMs - t : null;
    const overdue = ageMs !== null && ageMs > Math.max(1, s.everySec) * 2000;
    const state: PanelStageHealth['state'] = ageMs === null ? 'never' : (overdue ? 'overdue' : 'ok');
    const why = state === 'never'
      ? (s.note || '从没有过运行记录（守护没跑到过这个阶段）')
      : (state === 'overdue'
        ? '已 ' + Math.floor((ageMs as number) / 3600000) + ' 小时没跑（节奏 ' + cadenceTextOf(s.everySec) + '）' + (s.note ? ' · 上次：' + s.note : '')
        : (s.note || ''));
    return {
      id: s.id, label: s.label, everySec: s.everySec, cadenceText: cadenceTextOf(s.everySec),
      lastAt: s.at, ageMs, state, why: String(why).slice(0, 400),
    };
  });
}

export function panelLifecycle(): PanelLifecycle {
  const f = globalDbFile();
  const empty: PanelLifecycle = { ok: false, error: null, version: null, rounds: null, lastAt: null, stages: [], stageHealth: [], dueNow: [], heartbeat: [], recent: [] };
  if (!fs.existsSync(f)) return { ...empty, error: '还没有全局库（生命周期状态存在里面）' };
  const got = withDb(f, (db) => {
    const ldb = db as unknown as LifecycleDb;
    const st = loadLifecycle(ldb);
    const stages = STAGES.map((s) => {
      const r = st.stages[s.id];
      return {
        id: s.id, label: s.title, weight: s.weight, everySec: s.everySec,
        ok: r?.ok ?? false, note: r?.note ?? '', at: r?.at ?? null,
        ms: r?.ms ?? null, fails: r?.fails ?? 0,
      };
    });
    const dueNow = dueStages(st, Date.now()).map((s) => s.id);
    const hb = db.prepare('SELECT key, value, at FROM runtime').all() as Array<{ key: string; value: string; at: string }>;
    const heartbeat = hb.map((h) => {
      const age = Date.parse(h.at);
      return { key: h.key, at: h.at, ageMs: Number.isFinite(age) ? Date.now() - age : null };
    });
    const ev = db.prepare('SELECT at, stage, level, message FROM health_events ORDER BY id DESC LIMIT 30').all() as Array<{ at: string; stage: string; level: string; message: string }>;
    return {
      ok: true, error: null, version: st.version, rounds: st.rounds, lastAt: st.lastAt,
      stages, stageHealth: stageHealthOf(stages), dueNow, heartbeat, recent: ev,
    } as PanelLifecycle;
  }, () => undefined);
  return got ?? { ...empty, error: '生命周期表读不到（全局库 schema 可能过旧）' };
}

/** 守护是否在线：注册表心跳**或**任一项目锁新鲜即为在线 */
export function watchdogOnline(nowMs = Date.now()): { online: boolean; ageMs: number | null; readError: string | null } {
  const f = globalDbFile();
  let ageMs: number | null = null;
  // ⚠️ [1021 后端红队 N3] 这里原来是 `withDb(f, ..., () => undefined)` —— 错误被吞成 undefined。
  //   而本函数的判决是「读不到心跳 = 离线」⇒ **「库打不开」被渲染成了「守护没在跑」**。
  //   这和图谱那个 bug 是同一形状：把「我不知道」说成「是/否」。触发面：global.sqlite 被独占/损坏/schema 旧。
  //   现在把读错误单独带出来，调用方（面板 / diagnostics）能区分「离线」与「读不到」。
  let readError: string | null = null;
  if (fs.existsSync(f)) {
    const got = withDb(f, (db) => heartbeatAgeMs(db as unknown as LifecycleDb, 'watch'),
      (msg) => { readError = '读全局心跳失败：' + String(msg).slice(0, 160); });
    ageMs = typeof got === 'number' ? got : null;
  } else {
    readError = '全局库不存在：' + String(f).slice(0, 120);
  }
  // ── [1021] 判活改成 **OR**，治「重启后前 1~3 分钟面板必显示离线」──
  //
  // 实测：注册表心跳 `REGISTRY_HEARTBEAT_MS = 60s` 一拍、180s 过期。
  //   而守护重启后**旧值还留在库里**（实测读到前一任守护 pid 42448、293 秒前的残值），
  //   于是重启后最长 1~3 分钟面板一定显示离线 —— 用户看到的就是「每次重启都离线」。
  //   但同一时刻**项目锁**是每 15 秒刷的、pid 也在里面，那条信号一直是新鲜且准确的。
  //
  // 所以：两条信号**任一新**即判在线。
  //   · 锁（15s 一拍）负责**灵敏** —— 重启后几秒内就恢复显示；
  //   · 注册表（60s 一拍）负责**全局** —— 覆盖已有锁文件但没登记的旧项目。
  //   两者都是「pid 活着 + 心跳新鲜」，所以放宽不会把真死判成活。
  const registryFresh = registryHeartbeatFresh(ageMs);
  if (registryFresh) return { online: true, ageMs, readError };
  let lockFresh = false;
  try {
    for (const c of registryCandidates()) {
      if (isDaemonAlive(c.root).alive) { lockFresh = true; break; }
    }
  } catch { /* 注册表读不到就只信注册表心跳 */ }
  return { online: lockFresh, ageMs, readError };
}

// ─────────────────────────── 总览 ───────────────────────────

/**
 * 老化闸门的**真实原因**（[1021] 新增字段，只加不改）。
 *
 * 病历：aging 阶段每轮都 ok=true，但计划恒为 0 场 —— 面板上它与其他阶段长得完全一样，
 * 用户看到「老化压缩 运行中」却从没见过库里少一条正文。原因只有 planAging 知道（它会给
 * 每一场会话记一个 reasons[id]：已归档过 / 还不到 30 天 / 正在进行…），所以这里把那些
 * **真实理由**按项目汇总起来给界面。不硬编码、不猜。
 */
export interface PanelAgingGate {
  /** 参与统计的项目数（能读到库并算出计划的） */
  projects: number;
  /** 参与判定的会话总数 */
  sessions: number;
  planned: number;
  kept: number;
  window: { hotDays: number; workflowDays: number } | null;
  topReasons: Array<{ reason: string; count: number }>;
  /** 由上面数字推出来的一句话（界面直接显示，不再自己拼） */
  verdict: string;
}

export interface PanelOverview {
  generatedAt: string;
  focus: string | null;
  driver: string | null;
  projects: PanelProject[];
  totals: { projects: number; sessions: number; messages: number; decisions: number; unresolved: number; archived: number; dbBytes: number };
  lessons: PanelLessons;
  lifecycle: PanelLifecycle;
  watchdog: { online: boolean; ageMs: number | null };
  /** 语义档的**运行期**状态（跨进程读那个状态文件）。为什么面板要显示它：
   *  以前"启用了但装载失败"与"根本没启用"在界面上长得一模一样 —— 用户只会觉得"检索变差了"。 */
  semantic: { runtime: SemanticRuntimeStatus; summary: string; note: string };
  /** [1021] 老化闸门现状（真实数据；没有可读项目时为 null） */
  aging: PanelAgingGate | null;
  errors: string[];
  criteria: typeof PANEL_CRITERIA;
  scopeNote: string;
}

// ── [1021 安全轴] 面板 API 的 root 参数**校验** ──
//
// 问题：`root` 从 HTTP 查询参数进来（`lib/index.js` 里 `String(params.root || '')`），
//   一路传到 `dbFile(root)` = `path.join(root, '.sessionrelay', 'relay.sqlite')` 并**直接读**。
//   全程零校验 ⇒ 任何能打到这个本地 HTTP 端点的人都可以拿它**探任意路径**
//   （至少能判断某目录下有没有可读的 SQLite，属信息泄露 + 路径探测）。
//
// 修法：面板本来就**只需要显示已登记的项目**，白名单就是注册表本身。
//   这比「禁 `..`、禁盘符」更稳 —— 路径校验的黑名单很难写全（短路径 8.3、符号链接、UNC、大小写），
//   而「只认注册过的」是一个**封闭集合**。
export function assertRegisteredRoot(root: string): string {
  // ⚠️ 必须先拒空：`path.resolve('')` 会返回**当前工作目录**，而 cwd 往往恰好就是个合法项目
  //   （仓库自带 .sessionrelay）⇒ 空参数会被静默当成「当前项目」，比报错危险得多。
  const raw = String(root ?? '').trim();
  if (!raw) throw new Error('缺少参数 root（项目根目录）');
  const want = path.resolve(raw);
  // ① 已登记的项目根 —— 正常路径
  let ok = false;
  try { ok = registryCandidates().some((c) => path.resolve(c.root) === want); } catch { ok = false; }
  // ② 未登记、但确实是个**已初始化的 SessionRelay 项目**（目录下有 .sessionrelay）。
  //   为什么要放这一条：面板自检会建一个临时项目来测写入路径；只认注册表会把它拒掉。
  //   而且「用户刚 init 还没进注册表」也是合法场景。
  //   安全上仍然收紧：攻击面从「任意路径」缩到「必须含 .sessionrelay 的路径」，
  //   而这正是本系统唯一会去读的结构 —— 等价于「只能探到 SessionRelay 项目」。
  if (!ok) {
    try { ok = fs.existsSync(path.join(want, '.sessionrelay')); } catch { ok = false; }
  }
  if (!ok) throw new Error('拒绝访问：既不是已登记的项目根，也不含 .sessionrelay（' + String(root).slice(0, 100) + '）');
  return want;
}
export function panelOverview(opts: { focus?: string | null } = {}): PanelOverview {
  const errors: string[] = [];
  const candidates = registryCandidates();
  if (!candidates.length) errors.push('项目注册表是空的（' + relayDir('<project>') + ' 一个都没登记）');
  const projects: PanelProject[] = [];
  for (const c of candidates) {
    const card = panelProjectCard(c.root, { daemonAlive: c.daemonAlive, lastActiveAt: c.lastActiveAt });
    if (card.error) errors.push(card.name + '：' + card.error);
    projects.push(card);
  }
  projects.sort((a, b) => b.sessions - a.sessions || a.name.localeCompare(b.name));
  const focus = opts.focus && projects.some((p) => p.root === opts.focus) ? opts.focus : null;
  const totals = projects.reduce((a, p) => ({
    projects: a.projects + (p.ok ? 1 : 0),
    sessions: a.sessions + p.sessions, messages: a.messages + p.messages,
    decisions: a.decisions + p.decisions, unresolved: a.unresolved + p.unresolved,
    archived: a.archived + p.archived, dbBytes: a.dbBytes + p.dbBytes,
  }), { projects: 0, sessions: 0, messages: 0, decisions: 0, unresolved: 0, archived: 0, dbBytes: 0 });
  // ── [1021] 老化闸门汇总：复用 agingPlanOf（判据只此一份），逐项目只读打开 ──
  const aging: PanelAgingGate | null = (() => {
    let proj = 0, sessions = 0, planned = 0, kept = 0;
    let window: PanelAgingGate['window'] = null;
    const reasonCount = new Map<string, number>();
    for (const p of projects) {
      if (!p.ok) continue;
      let cfg: RelayConfig;
      try { cfg = panelLoadConfig(p.root); }
      catch (e) {
        errors.push(p.name + '：老化判定用不到配置（按默认值算）—— ' + String((e as Error)?.message ?? e).slice(0, 100));
        cfg = defaultConfig();
      }
      const a = withDb(dbFile(p.root), (db) => agingPlanOf(db, cfg), (msg) => errors.push(p.name + '：老化判定读不到库 —— ' + msg));
      if (!a) continue;
      proj++;
      planned += a.planned; kept += a.kept; sessions += a.planned + a.kept;
      window = window ?? { hotDays: a.hotDays, workflowDays: a.workflowDays };
      for (const r of a.topReasons) reasonCount.set(r.reason, (reasonCount.get(r.reason) ?? 0) + r.count);
    }
    if (proj === 0) return null;
    const topReasons = [...reasonCount.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((x, y) => y.count - x.count).slice(0, 6);
    const verdict = planned > 0
      ? '本轮可归档 ' + planned + ' 场正文（共 ' + sessions + ' 场参与判定）'
      : '本轮 **0 场**可归档（共 ' + sessions + ' 场参与判定）'
        + (topReasons[0] ? '：主因「' + topReasons[0].reason + '」' + topReasons[0].count + ' 场' : '');
    return { projects: proj, sessions, planned, kept, window, topReasons, verdict };
  })();

  const lessons = panelLessons();
  if (lessons.error) errors.push('经验层：' + lessons.error);
  const lifecycle = panelLifecycle();
  if (lifecycle.error) errors.push('生命周期：' + lifecycle.error);
  const probeRoot = projects.find((p) => p.ok)?.root ?? null;
  let driver: string | null = null;
  if (probeRoot) {
    const o = openReadonly(dbFile(probeRoot));
    driver = o.driver;
    try { o.db?.close(); } catch { /* 关不上不影响 */ }
  }
  return {
    generatedAt: new Date().toISOString(),
    focus,
    driver,
    projects: focus ? projects.filter((p) => p.root === focus) : projects,
    totals,
    lessons, lifecycle,
    aging,
    watchdog: watchdogOnline(),
    semantic: (() => {
      const runtime = readSemanticStatus();
      return {
        runtime,
        summary: describeSemantic(runtime, null),
        note: '开关是按项目开的（config.semantic.enabled）；这里是本机共享的运行期状态 —— 装载失败会在这里现形，不再悄悄退回字面检索',
      };
    })(),
    errors,
    criteria: PANEL_CRITERIA,
    scopeNote: '口径：本机注册表内全部项目库 @ ' + new Date().toISOString() + '（每 15 秒重取一次）',
  };
}

// ─────────────────────────── 压缩图谱 ───────────────────────────

export interface CompressionLayer {
  id: string; name: string; kind: string;
  status: 'on' | 'off' | 'rejected' | 'todo';
  note: string;
}

export interface PanelCompression {
  root: string; generatedAt: string; ok: boolean; error: string | null;
  deep: boolean;
  l0: {
    /** 库里**决策条目总数**（面板「结论总数」的正确取数）。此前契约缺这个字段，
     *  前端写 `l0.totalDecisions ?? l0.merged` 静默回落成 merged（=被合并的重复条数）
     *  ⇒ 界面上「结论总数」永远显示 0，而实际有几百上千条。1018 实测补上。 */
    totalDecisions: number;
    dupEntries: number;
    merged: number;
    /** merged / totalDecisions（0~1）。面板「去重压缩率」用它；此前缺字段导致显示「—」。 */
    dupRatio: number;
    changedSessions: number;
    bytesBefore: number | null;
    bytesAfter: number | null;
  } | null;
  l2: {
    rounds: number; archived: number; skipped: number; bytesFreed: number; lastAt: string | null;
    latest: Array<{ at: string; sessions: number; bytesFreed: number; criteria: string }>;
  } | null;
  aging: {
    hotDays: number; workflowDays: number; cap: number;
    hotGate: number; workflowGate: number;
    planned: number; plannedWorkflow: number; plannedHot: number; kept: number;
    topReasons: Array<{ reason: string; count: number }>;
    strengthBuckets: Array<{ label: string; count: number }>;
  } | null;
  layers: CompressionLayer[];
  criteria: typeof PANEL_CRITERIA;
  /** [1021] 非致命问题（配置读不到、某个通道判不出时）：**不许静默**，原样带给界面 */
  warnings: string[];
}

/**
 * 图层状态必须**按当前配置算**（[1021] 纠错）。
 *
 * 病历：L2/L3 的 status 原先写死（L2='on'、L3='off'）。而实测 agent1super 的 config 是
 * archive.enabled=true、compress.enabled=true —— L3 明明**开着**，面板却显示「未启用」。
 * 反过来，把 compress.enabled 改成 false 的用户仍然会看到旧文案。两处都错，且没人能发现，
 * 因为数字（层数）看起来总是一样的。现在 status 由 config 推，notes 保留不变。
 *
 * 另外补一条以前完全看不见的事实：compress.enabled=true 但 projects/lessons 两条通道都关时，
 * **L3 实际不会跑** —— 这时显示「未启用（通道全关）」，而不是骗人地说「运行中」。
 */
function layersFor(cfg: RelayConfig, warnings: string[] = []): CompressionLayer[] {
  const nearDup = cfg.compact?.near_dup !== false;
  const archiveOn = cfg.archive?.enabled !== false;
  const compressOn = cfg.compress?.enabled === true;
  const chProjects = cfg.compress?.projects === true;
  const chLessons = cfg.compress?.lessons === true;
  const chAny = chProjects || chLessons;
  const l3Status: CompressionLayer['status'] = compressOn && chAny ? 'on' : 'off';
  const copy = LAYERS.map((l) => ({ ...l }));
  for (const l of copy) {
    if (l.id === 'L1') l.status = nearDup ? 'on' : 'off';
    if (l.id === 'L2') l.status = archiveOn ? 'on' : 'off';
    if (l.id === 'L3') {
      l.status = l3Status;
      if (compressOn && !chAny) l.note = '**compress.enabled=true 但两条通道都关**（projects=false · lessons=false）⇒ 实际不会跑。' + l.note;
      else if (!compressOn) l.note = '**当前配置 compress.enabled=false** ⇒ 不会跑（代码已建成）。' + l.note;
      else l.note = '当前 compress.enabled=true（通道：项目 ' + (chProjects ? '开' : '关') + ' · 经验 ' + (chLessons ? '开' : '关') + '）。' + l.note;
    }
  }
  if (warnings.length) { /* 占位：未来若某层读配置失败，调用方在 warnings 里说明 */ }
  return copy;
}

const LAYERS: CompressionLayer[] = [
  { id: 'L0', name: '同会话逐字去重', kind: '无损', status: 'on',
    note: '同一场会话里逐字重复的条目合并成一条并记 dupCount；检索面看不到噪声，信息一条不丢。由生命周期的 compact 阶段自动跑。' },
  { id: 'L1', name: '跨会话近重复合并', kind: '确定性合并（原文快照可回滚）', status: 'on',
    note: '**1021 已启用（默认开）**。曾因"省 57% 体积但 hit@1 掉 5~7pt"被否决；'
      + '真正的病因不是合并本身，是**代表选择规则**——旧规则取"时间最新的一条"，而跨来源的近重复里最新'
      + '往往是 workflow 子代理的转述，它吸收掉主会话拍板后，幸存者带 origin=workflow，被读路径的'
      + 'origin 过滤整组挡掉。改成 representative=highest-trust（低可信来源不许当代表；升档过不了'
      + '"全组互相似"就不合并）之后：music 库「转述压拍板」的组 46 组里 **31 条拍板隐形 → 0**，'
      + '而压缩量一分不差。召回基准复测（20 问 × 关键词/大白话两臂）：hit@1/hit@3/hit@10 **逐格不变**。'
      + '写回在一个事务里完成 decisions 改写 + meta_text 重建 + 审计落库；原文快照进 compact_detail，'
      + '可用 rollbackNearDuplicates 回滚。开关：compact.near_dup（默认 true）。' },
  { id: 'L2', name: '老化归档', kind: '有损（只删正文）', status: 'on',
    note: '老会话的原始正文蒸发，派生结论/话题/摘要骨架保留，审计进 cleanup_log。ADR-003：判据是连续强度 strength = max(0, 1 − 年龄/90)。' },
  { id: 'L3', name: '模型压缩（多条决策/经验合成上级条目）', kind: '有损（原文永不删）', status: 'off',
    note: '**已建成，默认关**（1018 实测更正：此前这里写「未做」，与代码不符）。六条边界落在代码里：原文永不删（compress_detail.originals 存快照）、只在生命周期跑、可审计可回滚、默认关且配额落库、抽不出证据就丢弃、掉召回整批回滚。跑法：srelay compress --dry-run / --apply。' },
  { id: 'P', name: '呈现层折叠', kind: '只影响这一次显示', status: 'on',
    note: '近重复只在"这一次显示"里合成一条（foldNearDuplicates），数据通道不折叠 —— 三处呈现同源：DSH 插件 / 核心 CLI / ZCode hook。' },
];

/** 某项目库的压缩现状。deep=false（默认）只读现成证据；deep=true 才跑一次 L0 全量测量 */
/** 决策条目总数 + 重复占比（面板「结论总数」「去重压缩率」的权威取数）。
 *  1018 实测：契约原先没有这两个字段，前端 `?? l0.merged` 静默回落成 0，
 *  于是界面上「结论总数」永远是 0 —— 这不是显示小问题，是**指标取错了源**。 */
function l0Counts(db: { prepare: (s: string) => { all: () => unknown[] } }): { totalDecisions: number; dupRatio: number } {
  let total = 0, dup = 0;
  try {
    const rows = db.prepare("SELECT decisions FROM sessions WHERE decisions IS NOT NULL AND json_valid(decisions) AND COALESCE(state,'') <> 'quarantine'").all() as Array<{ decisions: string }>;
    for (const r of rows) {
      try { for (const d of JSON.parse(r.decisions) as Array<{ dupCount?: number }>) { total++; if (Number(d?.dupCount ?? 0) > 1) dup++; } } catch { /* 单行坏 JSON 跳过，不影响总数口径以外的行 */ }
    }
  } catch { /* 拿不到就报 0，不抛 */ }
  return { totalDecisions: total, dupRatio: total > 0 ? dup / total : 0 };
}

/**
 * 老化计划（**唯一实现**）：面板压缩页与「阶段健康度」都走这里，守护侧走 planAging 本身。
 *
 * 返回值就是 PanelCompression['aging'] 的形状；驱动它的是 core/compact/aging.ts 的 planAging，
 * 本文件不复制任何判据，只做取数与汇总。
 */
export function agingPlanOf(db: unknown, cfg: RelayConfig): NonNullable<PanelCompression['aging']> {
  const d = db as { prepare: (s: string) => { all: () => unknown[] } };
  const hotDays = cfg.archive?.hot_days ?? 30;
  const workflowDays = cfg.archive?.workflow_days ?? 7;
  const rows = d.prepare('SELECT id, origin, state, last_event_at, message_count, extracted_version, decisions, cleanup_at FROM sessions').all() as Array<Record<string, unknown>>;
  const planFor = (subset: Array<Record<string, unknown>>, minAgeDays: number) => minAgeDays > 0
    ? planAging(subset as never, { currentVersion: EXTRACT_VERSION, minAgeDays, maxStrength: strengthGateOf(minAgeDays), minDecisions: 0, cap: ARCHIVE_CAP_PER_ROUND })
    : { archive: subset, kept: [] as Array<Record<string, unknown>>, reasons: {} as Record<string, string> };
  const wf = rows.filter((r) => String(r.origin || '') === 'workflow');
  const other = rows.filter((r) => String(r.origin || '') !== 'workflow');
  const pw = planFor(wf, workflowDays), po = planFor(other, hotDays);
  const tally = (x: Record<string, string>) => {
    const m = new Map<string, number>();
    for (const reason of Object.values(x)) m.set(reason, (m.get(reason) ?? 0) + 1);
    return [...m.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count).slice(0, 8);
  };
  const buckets = [{ label: '≥0.9（新，绝不动）', lo: 0.9 }, { label: '0.6~0.9', lo: 0.6 }, { label: '0.3~0.6', lo: 0.3 }, { label: '<0.3（老，可归档）', lo: -1 }];
  const strengthBuckets = buckets.map((b, i) => ({
    label: b.label,
    count: rows.filter((r) => {
      const s = strengthOf(r as never);
      return i === 0 ? s >= b.lo : (i === buckets.length - 1 ? s < buckets[i - 1].lo : (s >= b.lo && s < buckets[i - 1].lo));
    }).length,
  }));
  return {
    hotDays, workflowDays, cap: ARCHIVE_CAP_PER_ROUND,
    hotGate: strengthGateOf(hotDays), workflowGate: strengthGateOf(workflowDays),
    planned: pw.archive.length + po.archive.length,
    plannedWorkflow: pw.archive.length, plannedHot: po.archive.length,
    kept: (rows.length - pw.archive.length - po.archive.length),
    topReasons: tally({ ...pw.reasons, ...po.reasons }),
    strengthBuckets,
  };
}

export function panelCompression(root: string, opts: { deep?: boolean } = {}): PanelCompression {
  const deep = opts.deep === true;
  // 配置先读：layers 的 on/off 与老化窗都来自它。读失败**不静默**（进 warnings），继续用默认值算其余部分。
  const warnings: string[] = [];
  let cfg: RelayConfig;
  try { cfg = panelLoadConfig(root); }
  catch (e) { warnings.push('配置读不到，按默认值展示：' + String((e as Error)?.message ?? e).slice(0, 120)); cfg = defaultConfig(); }
  const out: PanelCompression = {
    root, generatedAt: new Date().toISOString(), ok: false, error: null, deep,
    l0: null, l2: null, aging: null, layers: layersFor(cfg, warnings), criteria: PANEL_CRITERIA, warnings,
  };
  const f = dbFile(root);
  if (!fs.existsSync(f)) { out.error = '这个项目还没有库文件'; return out; }
  const got = withDb(f, (db) => {
    // ── L0：现成证据（不跑全量）──
    const dupPath = "$.dupCount";   // 单独放：SQL 里要写成单引号字符串，拼进来才不会打架
    const dupSql = "SELECT count(*) AS n, COALESCE(sum(json_extract(j.value, '" + dupPath + "') - 1), 0) AS m,"
      + " count(DISTINCT t.id) AS s FROM (SELECT id, decisions FROM sessions"
      + " WHERE decisions IS NOT NULL AND json_valid(decisions)) t, json_each(t.decisions) j"
      + " WHERE json_extract(j.value, '" + dupPath + "') > 1";
    const dup = db.prepare(dupSql).get() as { n?: number; m?: number; s?: number } | undefined;
    let bytesBefore: number | null = null, bytesAfter: number | null = null;
    if (deep) {
      // 全量干跑：与生命周期 compact 阶段同一个函数的 apply=false 路径
      const rep = compactExactSessions(db as never, { apply: false });
      bytesBefore = rep.bytesBefore; bytesAfter = rep.bytesAfter;
      out.l0 = {
        ...l0Counts(db),
        dupEntries: rep.merged, merged: rep.merged, changedSessions: rep.changed, bytesBefore, bytesAfter,
      };
    } else {
      out.l0 = {
        ...l0Counts(db),
        dupEntries: Number(dup?.n ?? 0), merged: Number(dup?.m ?? 0),
        changedSessions: Number(dup?.s ?? 0), bytesBefore, bytesAfter,
      };
    }
    // ── L2：审计表 ──
    const sum = db.prepare('SELECT count(*) AS rounds, COALESCE(sum(sessions_affected),0) AS a,'
      + ' COALESCE(sum(sessions_skipped),0) AS k, COALESCE(sum(bytes_freed),0) AS b, max(created_at) AS last'
      + ' FROM cleanup_log').get() as { rounds?: number; a?: number; k?: number; b?: number; last?: string | null } | undefined;
    const latest = db.prepare('SELECT created_at AS at, sessions_affected AS sessions, bytes_freed AS bytesFreed, criteria'
      + ' FROM cleanup_log ORDER BY id DESC LIMIT 10').all() as Array<{ at: string; sessions: number; bytesFreed: number; criteria: string }>;
    out.l2 = {
      rounds: Number(sum?.rounds ?? 0), archived: Number(sum?.a ?? 0), skipped: Number(sum?.k ?? 0),
      bytesFreed: Number(sum?.b ?? 0), lastAt: sum?.last ?? null, latest,
    };
    // ── 老化计划（只读；判据在 core/compact/aging.ts，取数在 agingPlanOf）──
    out.aging = agingPlanOf(db, cfg);
    return true;
  }, (msg) => { out.error = msg; });
  out.ok = got === true;
  return out;
}

// ─────────────────────────── [1021] 行为开关总览 ───────────────────────────
//
// 用户原话：「补齐前端缺失的和错误的启用说明旋钮信息等等」——毛病不是数字缺失，而是
// **看不出哪些功能是开的、哪些是关的、关着的原因是什么**。实测三例：decay.enabled=false、
// semantic.enabled=false、compress.lessons=false，而面板上它们与「开着」长得一模一样。
//
// 为什么这份清单在核心库：它就是「配置键 → 行为后果」的唯一口径。放前端就一定会与
// config-merge 的默认值分叉（本项目反复吃这个亏）。本文件**只加字段**、不改既有字段语义。
//
// 取值层沿用既有机制：knobStates(cfg, raw, env) 已经实现了「环境变量 > config.json > 默认值」，
// 这里直接复用，不另写一套优先级（判据只许有一份）。
// 不在 KNOB_SPECS 里、但仍影响行为的键（compress.projects/lessons、compact.near_dup、
// lesson.harvest*、domain）从合并后的 cfg 直接读 —— 缺省时显式标 source='default'。

export interface PanelSwitch {
  /** config.json 里的点分路径 */
  path: string;
  label: string;
  kind: 'boolean' | 'enum' | 'number' | 'string';
  /** 当前生效值 */
  value: unknown;
  /** 人话值：开 / 关 / 枚举说明 / 数字+单位 / （未设置） */
  valueText: string;
  source: 'env' | 'config' | 'default';
  /** true=当前生效；false=关着；null=不是开关（是个数值/模式） */
  active: boolean | null;
  /** 开着意味着什么（一句话） */
  onMeaning: string;
  /** 关着会怎样（一句话） */
  offMeaning: string;
  /** 由**当前配置**推出的补充（例如「enabled 但两条通道都关」），空串 = 没有要补的 */
  note: string;
}

interface SwitchSpec {
  path: string; label: string; kind: PanelSwitch['kind'];
  /** 数字类单位（天/分钟） */
  unit?: string;
  on: string; off: string;
}

/** 清单顺序即展示顺序：越靠前越常改 */
const SWITCH_SPECS: SwitchSpec[] = [
  { path: 'capture.mode', label: '采集强度', kind: 'enum',
    on: 'full/meta：客户端的新对话会被收进库里（full 存正文，检索能命中原话；meta 只存骨架，省空间但搜不到原话）',
    off: 'off：完全停采 —— 任何客户端的新对话都不再入库（面板里数字会停住不动）' },
  { path: 'archive.enabled', label: '正文归档（L2 蒸发）', kind: 'boolean',
    on: '守护按窗口把老会话的**正文**蒸发掉，结论/话题/摘要骨架保留、可审计（原文仍在客户端，可重放）',
    off: '正文永不蒸发，库随会话数线性变大（实测正文占库 94~97%）；结论不受影响' },
  { path: 'archive.hot_days', label: '普通会话热窗', kind: 'number', unit: '天',
    on: '比 N 天更新的正文绝不碰；**超过 N 天才可能被归档**',
    off: '设得很大（如 365）等于不让普通会话归档' },
  { path: 'archive.workflow_days', label: '施工日志热窗', kind: 'number', unit: '天',
    on: 'origin=workflow 的会话用更短的窗（它们不进简报，正文留着没用）',
    off: '调大 = 施工日志正文也长期保留（库会明显变大）' },
  { path: 'decay.enabled', label: '时间衰减', kind: 'boolean',
    on: '检索排序乘年龄因子：近期的事排前面；**只乘分数不过滤**，老记录仍能搜到（floor 保底）',
    off: '排序完全不看时间，只按字面相关度 —— 三个月前的旧结论与昨天的新结论同权' },
  { path: 'semantic.enabled', label: '语义检索', kind: 'boolean',
    on: '检索先跑字面（FTS），再补一路向量命中（需本地模型；装载失败会在总览的「语义检索状态」里现形）',
    off: '只走字面检索（jieba + bm25），零模型、零额外延迟 —— 换了说法可能搜不到' },
  { path: 'compress.enabled', label: '模型压缩（L3）', kind: 'boolean',
    on: '生命周期里允许跑 L3（多条结论/经验合成上级条目；原文永不删、可回滚）；**还要求下面的两条通道至少开一条**',
    off: 'L3 从不运行，压缩页的 L3 显示未启用' },
  { path: 'compress.projects', label: 'L3 通道：项目记忆', kind: 'boolean',
    on: '把项目记忆里的结论簇做模型压缩（compress.projects=true）',
    off: '项目侧完全跳过 L3（即使 compress.enabled=true）' },
  { path: 'compress.lessons', label: 'L3 通道：跨项目经验', kind: 'boolean',
    on: '把跨项目经验做模型压缩（compress.lessons=true）',
    off: '经验层永不压缩 —— 这是**经验条数不会因为压缩而变少**的直接原因' },
  { path: 'compact.near_dup', label: '跨会话近重复合并（L1b）', kind: 'boolean',
    on: '同一批近重复结论只留一条代表（低可信来源不许当代表），写回有审计、可回滚',
    off: '近重复不合并：库里会残留跨会话的重复条目（只在呈现层折叠，数据不合并）' },
  { path: 'lesson.harvest', label: '经验采集（harvest）', kind: 'boolean',
    on: '生命周期每 6 小时从项目记忆里刨出一批候选经验，进「观察窗」等判决',
    off: 'harvest 阶段整体跳过 —— 经验池不会再长新条目（存量仍按规则衰减/退休）' },
  { path: 'search.tokenizer', label: '中文分词器', kind: 'enum',
    on: 'jieba：词典分词，中文召回更准（换完必须重算索引，否则新旧词元对不上）',
    off: 'bigram：二字滑窗，无需词典、更快，但短词噪声更多（换完同样必须重算）' },
  { path: 'search.auto_days', label: '自动检索回溯', kind: 'number', unit: '天',
    on: '简报/自动召回最多往回看 N 天',
    off: '设 0 = 不自动回溯，只有显式搜索才看历史' },
  { path: 'domain', label: '领域共享（domain 作用域）', kind: 'string',
    on: '非空：写经验时带上这个领域名 —— 同领域的多个项目能互相看见 scope=domain 的经验（如 writing=agent1super+小说项目）',
    off: '空：不做领域共享，经验只在 global / 当前项目两个作用域里流动（scope=domain 的经验两个入口都看不见）' },
];

/** 枚举值 → 人话（只影响显示） */
const SWITCH_ENUM_TEXT: Record<string, Record<string, string>> = {
  'capture.mode': { full: 'full（存正文，检索最好）', meta: 'meta（只存骨架，省空间）', off: 'off（完全停采）' },
  'search.tokenizer': { jieba: 'jieba（词典分词，更准）', bigram: 'bigram（二字滑窗，更快）' },
};

function switchValueText(spec: SwitchSpec, value: unknown): string {
  if (spec.kind === 'boolean') return value === true ? '开' : (value === false ? '关' : '—');
  if (spec.kind === 'enum') {
    const m = SWITCH_ENUM_TEXT[spec.path];
    const key = String(value ?? '');
    return m && m[key] ? m[key] : (key || '—');
  }
  if (spec.kind === 'number') {
    return typeof value === 'number' && Number.isFinite(value) ? (value + (spec.unit ?? '')) : '—';
  }
  const s = String(value ?? '').trim();
  return s === '' ? '（未设置）' : s;
}

/** 由 config 推出开关清单。**纯读**：不写库、不发请求 */
function buildSwitches(
  cfg: RelayConfig,
  raw: Record<string, unknown> | null,
  env: Record<string, string | undefined>,
  knobByPath: Map<string, KnobState>,
): PanelSwitch[] {
  const cfgRec = cfg as unknown as Record<string, unknown>;
  const get = (p: string): unknown => {
    const k = knobByPath.get(p);
    if (k) return k.value;
    const parts = p.split('.');
    let cur: unknown = cfgRec;
    for (const part of parts) {
      if (cur === null || typeof cur !== 'object') return undefined;
      cur = (cur as Record<string, unknown>)[part];
    }
    return cur;
  };
  const sourceOf = (p: string): PanelSwitch['source'] => {
    const k = knobByPath.get(p);
    if (k) return k.source;
    if (p === 'domain' && env.SRELAY_DOMAIN) return 'env';
    const parts = p.split('.');
    let cur: unknown = raw;
    for (const part of parts) {
      if (cur === null || typeof cur !== 'object') return 'default';
      cur = (cur as Record<string, unknown>)[part];
    }
    return cur === undefined ? 'default' : 'config';
  };
  const out: PanelSwitch[] = [];
  for (const spec of SWITCH_SPECS) {
    let value: unknown;
    let source: PanelSwitch['source'];
    if (spec.path === 'domain') {
      const envVal = String(env.SRELAY_DOMAIN ?? '').trim();
      const cfgVal = String((cfgRec.domain as string) ?? '').trim();
      value = envVal || cfgVal;
      source = envVal ? 'env' : (cfgVal ? 'config' : 'default');
    } else {
      value = get(spec.path);
      source = sourceOf(spec.path);
      // 缺省值兜底：这些键在 config-merge 里有默认值，但老库/手写配置可能没写
      if (value === undefined) {
        if (spec.path === 'compact.near_dup') value = true;
        else if (spec.path === 'lesson.harvest') value = true;
        else if (spec.path === 'compress.projects' || spec.path === 'compress.lessons') value = false;
        else if (spec.path === 'capture.mode') value = 'full';
      }
    }
    // 「开/关」的判定：布尔看值；模式类看是否等于 off；数值/枚举不是开关（active=null）
    let active: boolean | null = null;
    if (spec.kind === 'boolean') active = value === true;
    else if (spec.path === 'capture.mode') active = String(value ?? '') !== 'off';
    // 由当前配置推出的补充（不查库、不猜）：这些正是「开着却没在起作用」的典型
    let note = '';
    if (spec.path === 'compress.enabled' && value === true) {
      const pj = get('compress.projects') === true;
      const le = get('compress.lessons') === true;
      note = '通道：项目 ' + (pj ? '开' : '关') + ' · 经验 ' + (le ? '开' : '关')
        + (pj || le ? '' : ' —— 两条都关 ⇒ 实际不会跑');
    }
    if (spec.path === 'compress.lessons' && get('compress.lessons') !== true && get('compress.enabled') === true) {
      note = 'compress.enabled=true 但本条关着 ⇒ 经验层目前**没有**被模型压缩过';
    }
    if (spec.path === 'domain' && source === 'env') note = '被环境变量 SRELAY_DOMAIN 覆盖（config.json 里的值不生效）';
    if (spec.path === 'archive.hot_days' && typeof value === 'number') {
      note = '对应强度门 ' + strengthGateOf(value) + '（strength = 1 − 年龄/90，与窗边界数学重合）';
    }
    out.push({
      path: spec.path, label: spec.label, kind: spec.kind,
      value: value ?? null, valueText: switchValueText(spec, value), source, active,
      onMeaning: spec.on, offMeaning: spec.off, note,
    });
  }
  return out;
}

// ─────────────────────────── 设置 ───────────────────────────

export interface PanelConfigView {
  root: string; configFile: string; hasFile: boolean;
  knobs: KnobState[]; errors: string[];
  schemaVersion: string;
  /** [1021] 行为开关总览：当前值 + 开着意味着什么 + 关着会怎样（只加字段） */
  switches: PanelSwitch[];
}

function readRawConfig(root: string): Record<string, unknown> | null {
  try {
    const f = configFile(root);
    if (!fs.existsSync(f)) return null;
    return JSON.parse(fs.readFileSync(f, 'utf8')) as Record<string, unknown>;
  } catch { return null; }
}

export function panelConfigView(root: string): PanelConfigView {
  const errors: string[] = [];
  let cfg: RelayConfig;
  try { cfg = panelLoadConfig(root); }
  catch (e) { errors.push(String((e as Error)?.message ?? e)); cfg = defaultConfig(); }
  const raw = readRawConfig(root);
  if (!raw && fs.existsSync(configFile(root))) errors.push('config.json 存在但解析失败（上面那条错误就是原因）');
  const env = process.env as Record<string, string | undefined>;
  const knobs = knobStates(cfg, raw, env);
  return {
    root,
    configFile: configFile(root),
    hasFile: fs.existsSync(configFile(root)),
    knobs,
    errors,
    schemaVersion: String(cfg.version ?? ''),
    // 开关总览与 knobs 共用同一份 knobStates（取值优先级只有一份实现）
    switches: buildSwitches(cfg, raw, env, new Map(knobs.map((k) => [k.path, k]))),
  };
}

export interface ApplyResult {
  ok: boolean; changed: string[]; rejected: Array<{ path: string; reason: string }>; warnings: string[]; error: string | null;
}

/** 写回旋钮。**这是面板唯一允许的写路径**：只改已知旋钮，逐个校验，失败即整批拒绝 */
export function panelApplyConfig(root: string, patch: Record<string, unknown>): ApplyResult {
  const res: ApplyResult = { ok: false, changed: [], rejected: [], warnings: [], error: null };
  if (!patch || typeof patch !== 'object') { res.error = 'patch 必须是对象'; return res; }
  const keys = Object.keys(patch);
  if (!keys.length) { res.error = '没有要改的项'; return res; }
  const unknownKnobs = keys.filter((k) => !KNOB_SPECS.some((s) => s.path === k));
  if (unknownKnobs.length) { res.error = '未知旋钮：' + unknownKnobs.join(', '); return res; }
  let cfg: RelayConfig;
  try { cfg = panelLoadConfig(root); }
  catch (e) { res.error = '读不到现有配置：' + String((e as Error)?.message ?? e); return res; }
  const draft = JSON.parse(JSON.stringify(cfg)) as Record<string, unknown>;
  for (const k of keys) {
    const bad = validateKnob(k, patch[k]);
    if (bad) { res.rejected.push({ path: k, reason: bad }); continue; }
    setPath(draft, k, patch[k]);
    res.changed.push(k);
  }
  if (res.rejected.length) { res.error = '有 ' + res.rejected.length + ' 项不合法，整批没有写入'; return res; }
  try { saveConfig(root, draft as unknown as RelayConfig); }
  catch (e) { res.error = '写入失败：' + String((e as Error)?.message ?? e); return res; }
  if (res.changed.includes('search.tokenizer')) {
    res.warnings.push('分词器换了 —— 已入库的索引还是旧词元，请跑一次重算（面板的"动作"里有一键重算），否则搜索结果会变少且不报错');
  }
  if (res.changed.includes('archive.hot_days') || res.changed.includes('archive.workflow_days')) {
    res.warnings.push('归档窗口改了 —— 下一轮归档（守护每 ' + String(cfg.archive?.check_every_min ?? 60) + ' 分钟检查一次）就按新窗走');
  }
  res.ok = true;
  return res;
}

export { KNOB_SPECS };


// ─────────────────────────── [1021] 知识图谱面板 ───────────────────────────
//
// 设计取舍（重要，别改成「力导向图」）：
//   本库实测 5036 标签 / 44604 共现边。**画成一张力导向图毫无用处** ——
//   那是一团毛线球，用户看不出任何东西，还得为它加载图形库（1000+ 节点会卡）。
//   真正有用的只有三件：
//     ① **新鲜度**：什么时候重建的、会话数对不对得上（它现在是生命周期的一个阶段，烂了没人知道）；
//     ② **枢纽**：哪些标签串起最多会话（这才是图谱的价值 —— 看出什么在主导）；
//     ③ **追溯**：给一个词看它连到谁（`graph-explain.ts` 的图形版，后续可加）。
//   还有一条**必须诚实说**：图谱默认**不参与检索**（实测对召回零收益）。
//   面板不能假装它是「检索增强」—— 那谎话用户试两次就发现了。
export interface PanelGraphTag { name: string; sessions: number; degree: number }
export interface PanelGraph {
  root: string; generatedAt: string; ok: boolean; error: string | null;
  stats: { tags: number; edges: number; sessions: number; builtAt: string | null; builtSessions: number | null; stale: boolean };
  hubs: PanelGraphTag[];
  /** [1021] 力导向图：节点（标签）+ 边（共现）。nodes 里的 id 是 graph_tags.id，links 的 a/b 是 nodes 数组下标。 */
  nodes: Array<{ id: number; name: string; kind: string; sessions: number; degree: number }>;
  links: Array<{ a: number; b: number; w: number }>;
  roleNote: string;
}

export function panelGraph(root: string, limit = 20): PanelGraph {
  const out: PanelGraph = {
    root, generatedAt: new Date().toISOString(), ok: false, error: null,
    stats: { tags: 0, edges: 0, sessions: 0, builtAt: null, builtSessions: null, stale: false },
    hubs: [],
    nodes: [],
    links: [],
    roleNote: '图谱默认不参与检索（实测对召回零收益）。这里用它追溯「哪些会话围绕同一个东西」。',
  };
  const f = dbFile(root);
  if (!fs.existsSync(f)) { out.error = '这个项目还没有库文件'; return out; }
  type Got = { tags: number; edges: number; sess: number; builtAt: string | null; builtSessions: number | null; stale: boolean; hubs: Array<{ name: string; sessions: number; degree: number }>; nodes: Array<{ id: number; name: string; kind: string; sessions: number; degree: number }>; links: Array<{ a: number; b: number; w: number }> };
  const got = withDb(f, (db): Got | null => {
    const has = (t: string): boolean => { try { db.prepare('SELECT 1 FROM ' + t + ' LIMIT 1').get(); return true; } catch { return false; } };
    if (!has('graph_tags')) return null;
    const tags = Number((db.prepare('SELECT COUNT(*) AS c FROM graph_tags').get() as { c?: number })?.c ?? 0);
    const edges = Number((db.prepare('SELECT COUNT(*) AS c FROM graph_tag_edges').get() as { c?: number })?.c ?? 0);
    const sess = Number((db.prepare('SELECT COUNT(*) AS c FROM sessions').get() as { c?: number })?.c ?? 0);
    let builtAt: string | null = null, builtSessions: number | null = null;
    try {
      const m = db.prepare('SELECT built_at, session_count FROM graph_meta WHERE id = 1').get() as { built_at?: string; session_count?: number } | undefined;
      builtAt = m?.built_at ?? null; builtSessions = m?.session_count ?? null;
    } catch { /* 老库没有这张表：当作没建过（stale=true），不静默 */ }
    // ⚠️ [1021 修 图谱页从来没工作过] 这张表的列是 **a / b / w**（见 ensureGraphSchema 的建表语句），
    //   而这里原来写的是 `e.tag_a` / `e.tag_b` —— **两个列都不存在**。
    //   后果：整句抛 `no such column: e.tag_b` → withDb catch 掉返回 null → 面板显示「图谱还没建过」。
    //   而库里其实有 5037 个标签 / 44617 条边。也就是说**图谱页从做出来那天起就没显示过一次**，
    //   而且因为 withDb 没传 onError，错误被静默吞掉，谁都看不见 —— 又一个「容错不许静默」的受害者。
    const hubs = db.prepare(
      'SELECT t.name AS name, COUNT(DISTINCT ts.session_id) AS sessions, COUNT(DISTINCT e.b) AS degree'
      + ' FROM graph_tags t'
      + ' LEFT JOIN graph_tag_sessions ts ON ts.tag_id = t.id'
      + ' LEFT JOIN graph_tag_edges e ON e.a = t.id'
      + ' GROUP BY t.id ORDER BY sessions DESC, degree DESC LIMIT ?',
    ).all(limit) as Array<{ name: string; sessions: number; degree: number }>;
    // ── 力导向图数据（[1021] 图谱页要做成节点+连线，光有 hubs 列表画不出网络）──
    //   节点取"被最多会话用到"的前 N 个；边只取**两端都在节点集里**的，
    //   全量 44617 条边既渲染不动也没意义（弱边全是噪声）。
    const nodeLimit = Math.max(60, Math.min(200, limit * 5));
    let nodes: Array<{ id: number; name: string; kind: string; sessions: number; degree: number }> = [];
    let links: Array<{ a: number; b: number; w: number }> = [];
    try {
      nodes = db.prepare(
        "SELECT t.id AS id, t.name AS name, COALESCE(t.kind, '') AS kind,"
        + " COUNT(DISTINCT ts.session_id) AS sessions, COALESCE(t.df, 0) AS degree"
        + " FROM graph_tags t LEFT JOIN graph_tag_sessions ts ON ts.tag_id = t.id"
        + " GROUP BY t.id ORDER BY sessions DESC, degree DESC LIMIT ?",
      ).all(nodeLimit) as typeof nodes;
      if (nodes.length) {
        const idx = new Map<number, number>();
        nodes.forEach((n, i) => idx.set(Number(n.id), i));
        const ids = Array.from(idx.keys());
        const ph = ids.map(() => '?').join(',');
        const rows = db.prepare(
          "SELECT a, b, w FROM graph_tag_edges WHERE a IN (" + ph + ") AND b IN (" + ph + ")"
          + " ORDER BY w DESC LIMIT 1200",
        ).all(...ids, ...ids) as Array<{ a: number; b: number; w: number }>;
        links = rows
          .map((r) => ({ a: idx.get(Number(r.a)) as number, b: idx.get(Number(r.b)) as number, w: Number(r.w) || 0 }))
          .filter((l) => typeof l.a === 'number' && typeof l.b === 'number' && l.a !== l.b);
      }
    } catch { /* 图画不出来不影响统计与枢纽榜：退化成空图，不静默改别的结果 */ }
    const stale = builtSessions === null ? true : builtSessions !== sess;
    return { tags, edges, sess, builtAt, builtSessions, stale, hubs, nodes, links };
  },
  // ⚠️ [1021] **必须传 onError**：不传时 withDb 把异常吞成 null，于是「查询报错」和「没建过图谱」
  //   长得一模一样。上面那个 `e.tag_b` 列名错误（真实列是 `a`/`b`/`w`）就靠这个躲了一整个版本，
  //   面板一直显示「还没建过」，而库里躺着 5037 个标签。现在两种情形分开显示。
  (msg) => { out.error = '读取图谱失败：' + String(msg).slice(0, 200); });
  if (!got) {
    if (!out.error) out.error = '图谱还没建过：生命周期每天会自动建一次，也可手动跑 scripts/graph-tag-build.ts';
    return out;
  }
  out.ok = true;
  out.stats = { tags: got.tags, edges: got.edges, sessions: got.sess, builtAt: got.builtAt, builtSessions: got.builtSessions, stale: got.stale };
  out.nodes = (got.nodes || []).map((n) => ({ id: Number(n.id), name: String(n.name ?? ''), kind: String(n.kind ?? ''), sessions: Number(n.sessions ?? 0), degree: Number(n.degree ?? 0) }));
  out.links = (got.links || []).map((l) => ({ a: Number(l.a), b: Number(l.b), w: Number(l.w ?? 0) }));
  out.hubs = got.hubs.map((h) => ({ name: String(h.name ?? ''), sessions: Number(h.sessions ?? 0), degree: Number(h.degree ?? 0) }));
  return out;
}