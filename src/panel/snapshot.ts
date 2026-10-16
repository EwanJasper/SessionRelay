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
import { registryCandidates } from '../shared/registry.js';
import { defaultConfig, mergeConfig, saveConfig, readConfigFile, type RelayConfig } from '../shared/config-merge.js';
import { isInjectable, liveImportance, INJECT_THRESHOLD, DECAY_PER_DAY, type LessonRow } from '../store/lesson-gate.js';
import { planAging, strengthOf, strengthGateOf, ARCHIVE_CAP_PER_ROUND } from '../core/compact/aging.js';
import { compactExactSessions } from '../core/compact/exact.js';
import { EXTRACT_VERSION } from '../core/extract/version.js';
import { STAGES, loadLifecycle, dueStages, heartbeatAgeMs, type LifecycleDb } from '../core/lifecycle/stages.js';
import { KNOB_SPECS, knobStates, validateKnob, setPath, type KnobState } from './knobs.js';
import { withDb, openReadonly, type ReadonlyDb } from './db.js';
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

function countJsonItems(db: ReadonlyDb, column: string): number {
  // 先在子查询里滤掉非法 JSON：SQLite 的 json_each 遇到坏文本会直接抛，不能让它炸整张卡
  const sql = 'SELECT count(*) AS c FROM (SELECT ' + column + ' AS v FROM sessions'
    + ' WHERE ' + column + ' IS NOT NULL AND json_valid(' + column + ') AND length(' + column + ') > 2) t, json_each(t.v)';
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
    out.decisions = countJsonItems(db, 'decisions');
    out.unresolved = countJsonItems(db, 'key_questions');
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

export interface PanelLifecycle {
  ok: boolean; error: string | null;
  version: number | null; rounds: number | null; lastAt: string | null;
  stages: Array<{ id: string; label: string; weight: string; everySec: number; ok: boolean; note: string; at: string | null; ms: number | null; fails: number }>;
  dueNow: string[];
  heartbeat: Array<{ key: string; at: string; ageMs: number | null }>;
  recent: Array<{ at: string; stage: string; level: string; message: string }>;
}

export function panelLifecycle(): PanelLifecycle {
  const f = globalDbFile();
  const empty: PanelLifecycle = { ok: false, error: null, version: null, rounds: null, lastAt: null, stages: [], dueNow: [], heartbeat: [], recent: [] };
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
      stages, dueNow, heartbeat, recent: ev,
    } as PanelLifecycle;
  }, () => undefined);
  return got ?? { ...empty, error: '生命周期表读不到（全局库 schema 可能过旧）' };
}

/** 守护是否在线：直接读 runtime 心跳（与生命周期让位判据同源），不查进程表 */
export function watchdogOnline(nowMs = Date.now()): { online: boolean; ageMs: number | null } {
  const f = globalDbFile();
  if (!fs.existsSync(f)) return { online: false, ageMs: null };
  const got = withDb(f, (db) => heartbeatAgeMs(db as unknown as LifecycleDb, 'watch'), () => undefined);
  const ageMs = typeof got === 'number' ? got : null;
  return { online: ageMs !== null && ageMs < 15 * 60 * 1000, ageMs };
}

// ─────────────────────────── 总览 ───────────────────────────

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
  errors: string[];
  criteria: typeof PANEL_CRITERIA;
  scopeNote: string;
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
  l0: { dupEntries: number; merged: number; changedSessions: number; bytesBefore: number | null; bytesAfter: number | null } | null;
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
}

const LAYERS: CompressionLayer[] = [
  { id: 'L0', name: '同会话逐字去重', kind: '无损', status: 'on',
    note: '同一场会话里逐字重复的条目合并成一条并记 dupCount；检索面看不到噪声，信息一条不丢。由生命周期的 compact 阶段自动跑。' },
  { id: 'L1', name: '跨会话近重复合并', kind: '无损（但掉召回）', status: 'rejected',
    note: '实测省 57% 体积却掉召回，被门禁否决 ⇒ 默认不跑。代码留在核心库可复现（core/compact/dedup.ts），但不接任何自动路径。' },
  { id: 'L2', name: '老化归档', kind: '有损（只删正文）', status: 'on',
    note: '老会话的原始正文蒸发，派生结论/话题/摘要骨架保留，审计进 cleanup_log。ADR-003：判据是连续强度 strength = max(0, 1 − 年龄/90)。' },
  { id: 'L3', name: '有损合并（多条经验合成上级经验）', kind: '有损', status: 'todo',
    note: '未做。前置条件：配额告急且过召回基准门禁 —— 两者都还没到。' },
  { id: 'P', name: '呈现层折叠', kind: '只影响这一次显示', status: 'on',
    note: '近重复只在"这一次显示"里合成一条（foldNearDuplicates），数据通道不折叠 —— 三处呈现同源：DSH 插件 / 核心 CLI / ZCode hook。' },
];

/** 某项目库的压缩现状。deep=false（默认）只读现成证据；deep=true 才跑一次 L0 全量测量 */
export function panelCompression(root: string, opts: { deep?: boolean } = {}): PanelCompression {
  const deep = opts.deep === true;
  const out: PanelCompression = {
    root, generatedAt: new Date().toISOString(), ok: false, error: null, deep,
    l0: null, l2: null, aging: null, layers: LAYERS, criteria: PANEL_CRITERIA,
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
      out.l0 = { dupEntries: rep.merged, merged: rep.merged, changedSessions: rep.changed, bytesBefore, bytesAfter };
    } else {
      out.l0 = {
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
    // ── 老化计划（只读，与守护同一个 planAging）──
    const cfg = panelLoadConfig(root);
    const hotDays = cfg.archive?.hot_days ?? 30;
    const workflowDays = cfg.archive?.workflow_days ?? 7;
    const rows = db.prepare('SELECT id, origin, state, last_event_at, message_count, extracted_version, decisions, cleanup_at FROM sessions').all() as Array<Record<string, unknown>>;
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
    out.aging = {
      hotDays, workflowDays, cap: ARCHIVE_CAP_PER_ROUND,
      hotGate: strengthGateOf(hotDays), workflowGate: strengthGateOf(workflowDays),
      planned: pw.archive.length + po.archive.length,
      plannedWorkflow: pw.archive.length, plannedHot: po.archive.length,
      kept: (rows.length - pw.archive.length - po.archive.length),
      topReasons: tally({ ...pw.reasons, ...po.reasons }),
      strengthBuckets,
    };
    return true;
  }, (msg) => { out.error = msg; });
  out.ok = got === true;
  return out;
}

// ─────────────────────────── 设置 ───────────────────────────

export interface PanelConfigView {
  root: string; configFile: string; hasFile: boolean;
  knobs: KnobState[]; errors: string[];
  schemaVersion: string;
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
  return {
    root,
    configFile: configFile(root),
    hasFile: fs.existsSync(configFile(root)),
    knobs: knobStates(cfg, raw, process.env as Record<string, string | undefined>),
    errors,
    schemaVersion: String(cfg.version ?? ''),
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

