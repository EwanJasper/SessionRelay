// ─────────── 生命周期运行器：**内核 API**（不是外挂脚本）───────────
//
// 依据 ADR-002：用户判定"ses-cycle.mjs + 启动 vbs"是外挂脚本 —— 开机拉起 ≠ 生命周期自动化。
// 目标形态是"生命周期 = 框架本体的一条流水线"。本文件就是那条流水线：
//   · 阶段表读 stages.ts（唯一一份，插件 worker 与 CLI 读同一张表）；
//   · 每个阶段**在进程内调用内核函数**（runSync / recomputeExtractions / compactExactSessions /
//     cleanDerivedColumns / maintainLessons / autoArchiveProject / repairProject）——
//     不再 spawn 子进程、不再依赖仓库里的 .mjs 脚本；
//   · 状态与留痕进**库**（全局库的 lifecycle / health_events 表），不再写 lifecycle.json；
//   · 单写入方：一个进程级锁，避免守护与手动轮同时写同一个库（1017 的 SQLITE_BUSY 就是两个写入方）。
//
// 部署物（面板 HTML、离线包）不属于内核 —— 那由宿主用 opts.distribute 注入。内核不该知道
// 什么 DSH 面板，这是"内核/适配器分层"的边界。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDb, type DB } from '../../store/db.js';
import { loadConfig } from '../../shared/config.js';
import { registryCandidates } from '../../shared/registry.js';
import { openGlobal, maintainLessons } from '../../store/global.js';
import type Database from 'better-sqlite3';
import { runSync } from '../../capture/sync.js';
import { recomputeExtractions } from '../../capture/recompute.js';
import { compactExactSessions } from '../compact/exact.js';
import { cleanDerivedColumns } from '../extract/derived-cleanup.js';
import { autoArchiveProject, autoArchivePolicyOf } from '../../capture/archive.js';
import { integrityOf, repairProject } from './repair.js';
import {
  STAGES, ensureLifecycleTables, loadLifecycle, saveLifecycle, recordStage, dueStages, shouldSkip,
  logHealthEvent, heartbeatAgeMs, setHeartbeat, type StageId, type LifecycleState,
} from './stages.js';

export interface LifecycleOptions {
  /** 只跑这些阶段（默认按 STAGES 的节奏判断哪些该跑） */
  only?: StageId[];
  /** 无视节奏，全部强制跑一遍 */
  force?: boolean;
  /** 只跑轻阶段（宿主 worker 用；heavy 阶段会阻塞宿主） */
  lightOnly?: boolean;
  /** 部署层的分发钩子（面板/导出）。内核不管部署物 */
  distribute?: () => Promise<string> | string;
  log?: (line: string) => void;
  now?: number;
}

export interface StageReport { id: StageId; title: string; ok: boolean; note: string; ms: number; skipped?: string }
export interface LifecycleReport { at: string; rounds: number; stages: StageReport[]; projects: number }

const LOCK = path.join(os.homedir(), '.sessionrelay', 'lifecycle.lock');

function projectRoots(): string[] {
  try { return registryCandidates().map((c) => c.root); } catch { return []; }
}
function dbFileOf(root: string): string { return path.join(root, '.sessionrelay', 'relay.sqlite'); }

/** 单写入方锁：拿到返回 true；有活着的持有者返回 false（陈旧锁自动接管） */
function acquireLock(): boolean {
  try {
    if (fs.existsSync(LOCK)) {
      const st = fs.statSync(LOCK);
      const pid = Number(fs.readFileSync(LOCK, 'utf8').trim());
      let alive = false;
      if (Number.isFinite(pid) && pid > 0) { try { process.kill(pid, 0); alive = true; } catch { alive = false; } }
      if (alive && Date.now() - st.mtimeMs < 3600_000) return false;
    }
    fs.mkdirSync(path.dirname(LOCK), { recursive: true });
    fs.writeFileSync(LOCK, String(process.pid));
    return true;
  } catch { return true; }   // 锁本身出问题不该让生命周期停摆
}
function releaseLock(): void { try { fs.unlinkSync(LOCK); } catch { /* 已释放 */ } }

/** 打开全局库（生命周期状态与经验库都住这儿）；打不开就返回 null，阶段降级但仍会跑。
 *  ⚠️ 必须用 store/global 的 openGlobal（全局库 schema 与项目库不同）——1017 实测：
 *  用项目库的 createDb 打开全局库会抛，于是"经验衰减"永远报"全局库不可用"、
 *  心跳协调也随之失效（心跳读不到 ⇒ 采集阶段不认守护在线 ⇒ 两个写入方）。 */
let globalOpenError: string | null = null;
function openGlobalLedger(): Database.Database | null {
  try {
    const db = openGlobal();
    ensureLifecycleTables(db);
    globalOpenError = null;
    return db;
  } catch (e) { globalOpenError = String((e as Error).message).slice(0, 120); return null; }
}

function eachProject<T>(fn: (root: string, db: DB) => T): Array<{ root: string; r?: T; err?: string }> {
  const out: Array<{ root: string; r?: T; err?: string }> = [];
  for (const root of projectRoots()) {
    const f = dbFileOf(root);
    if (!fs.existsSync(f)) continue;
    let db: DB | null = null;
    try { db = createDb(f); out.push({ root, r: fn(root, db) }); }
    catch (e) { out.push({ root, err: String((e as Error).message).slice(0, 60) }); }
    finally { try { db?.close(); } catch { /* 已关 */ } }
  }
  return out;
}

const base = (r: string) => path.basename(r);

export async function runLifecycle(opts: LifecycleOptions = {}): Promise<LifecycleReport> {
  const log = opts.log ?? (() => {});
  const now = opts.now ?? Date.now();
  const at = new Date(now).toISOString();
  const roots = projectRoots();

  if (!acquireLock()) {
    return { at, rounds: 0, projects: roots.length,
      stages: [{ id: 'guard', title: '体检与自检', ok: true, note: '已有另一个生命周期进程在跑（单写入方锁）', ms: 0, skipped: 'locked' }] };
  }
  const global = openGlobalLedger();
  let state: LifecycleState = global ? loadLifecycle(global) : { version: 1, rounds: 0, lastAt: null, stages: {} };
  state.rounds = (state.rounds || 0) + 1;

  const pool = opts.lightOnly ? STAGES.filter((s) => s.weight === 'light') : STAGES;
  const due = opts.force || opts.only?.length
    ? pool.filter((s) => !opts.only?.length || opts.only.includes(s.id))
    : dueStages(state, now, { only: opts.only });
  const todue = due.filter((s) => pool.some((p) => p.id === s.id));

  const stages: StageReport[] = [];
  const runOne = async (spec: { id: StageId; title: string }, fn: () => Promise<string> | string) => {
    const skip = shouldSkip(state, spec.id);
    if (skip.skip && !opts.force) {
      // [1021 红队 R3] 原来这里 `ok: true` + 不打印 —— 用户看到「一切正常」，实际该阶段早已不干活，
      //   是本项目最嫌恶的「静默半失效」。改成 ok:false（它确实没成功）、把原因写进 note、并打一行日志。
      //   注意 `skipped` 字段保留：调用方靠它区分「跳过」与「真失败」。
      stages.push({ id: spec.id, title: spec.title, ok: false, note: skip.reason ?? '跳过', ms: 0, skipped: skip.reason });
      log('  ⏭  ' + spec.title + '：' + (skip.reason ?? '跳过'));
      return;
    }
    const t0 = Date.now();
    try {
      const note = await fn();
      const ms = Date.now() - t0;
      stages.push({ id: spec.id, title: spec.title, ok: true, note, ms });
      state = recordStage(state, spec.id, { ok: true, note, at: new Date().toISOString(), ms });
      log('  ✅ ' + spec.title + '：' + note);
    } catch (e) {
      const ms = Date.now() - t0;
      const note = String((e as Error).message).slice(0, 120);
      stages.push({ id: spec.id, title: spec.title, ok: false, note, ms });
      state = recordStage(state, spec.id, { ok: false, note, at: new Date().toISOString(), ms });
      try { if (global) logHealthEvent(global, spec.id, 'error', note); } catch { /* 记账失败不阻塞 */ }
      log('  ❌ ' + spec.title + '：' + note);
    }
  };

  const specOf = (id: StageId) => STAGES.find((s) => s.id === id) as { id: StageId; title: string };

  // ── ① 体检：完整性 + 记账 ──
  if (todue.some((s) => s.id === 'guard')) await runOne(specOf('guard'), () => {
    const bad: string[] = [];
    for (const r of roots) { const v = integrityOf(dbFileOf(r)); if (!v.ok) bad.push(base(r) + '(' + v.detail.slice(0, 30) + ')'); }
    if (bad.length) { try { if (global) logHealthEvent(global, 'guard', 'warn', '完整性异常：' + bad.join(' / ')); } catch { /* 记账失败不阻塞 */ } }
    return bad.length ? '异常 ' + bad.length + ' 个：' + bad.join(' / ') : roots.length + ' 个库全部完整';
  });

  // ── ② 自愈：只修坏的 ──
  if (todue.some((s) => s.id === 'repair')) await runOne(specOf('repair'), async () => {
    const fixed: string[] = [];
    for (const r of roots) {
      const v = integrityOf(dbFileOf(r));
      if (v.ok) continue;
      const out = await repairProject(r);
      fixed.push(base(r) + (out.repaired ? ' 已重建' : ' 重建失败（' + out.note.slice(0, 30) + '）'));
    }
    return fixed.length ? fixed.join(' / ') : '没有需要重建的库';
  });

  // ── ③ 采集（heavy：全量重放，别放进宿主）──
  if (todue.some((s) => s.id === 'capture')) await runOne(specOf('capture'), async () => {
    // 单一写入方：采集守护（srelay watch）在线时就别自己再 sync —— 两个写入方同写一个库
    // 的结果是 SQLITE_BUSY + "为什么这轮失败了下一轮又好了"的间歇性故障（1017 实测）。
    const hbAge = global ? heartbeatAgeMs(global, 'watch') : null;
    if (hbAge != null && hbAge < 15 * 60_000) return '采集守护在线（心跳 ' + Math.round(hbAge / 1000) + 's 前），本轮交给它';
    const diag = global ? '（守护心跳 ' + (hbAge == null ? '缺失' : Math.round(hbAge / 1000) + 's 前') + '）' : '（全局库不可用：' + (globalOpenError ?? '未知') + '）';
    const ok: string[] = []; const bad: string[] = [];
    for (const root of roots) {
      const f = dbFileOf(root);
      if (!fs.existsSync(f)) continue;
      try {
        const cfg = loadConfig(root);
        const db = createDb(f);
        try { const r = await runSync({ projectRoot: root, config: cfg, db }); ok.push(base(root) + ' +' + r.newSessions); }
        finally { try { db.close(); } catch { /* 已关 */ } }
      } catch (e) {
        const m = String((e as Error).message);
        bad.push(base(root) + (/SQLITE_BUSY|locked/i.test(m) ? '(库被占用)' : '(' + m.slice(0, 30) + ')'));
      }
    }
    if (bad.length) throw new Error(ok.length + ' 个已采集，失败：' + bad.join(' / '));
    return ok.length + ' 个项目已采集' + diag;
  });

  // ── ④ 抽取/重算（light）──
  if (todue.some((s) => s.id === 'extract')) await runOne(specOf('extract'), () => {
    const res = eachProject((root, db) => {
      let total = 0, failed = 0, guard = 0;
      for (;;) {
        const r = recomputeExtractions(db, 300);
        total += r.recomputed; failed += r.failed;
        if ((r.recomputed === 0 && r.remaining === 0) || ++guard > 2000) break;
      }
      return { total, failed };
    });
    const total = res.reduce((a, x) => a + (x.r?.total ?? 0), 0);
    const failed = res.reduce((a, x) => a + (x.r?.failed ?? 0), 0);
    return total ? '重算 ' + total + ' 场' + (failed ? '（其中 ' + failed + ' 场抽取异常，已打版本戳跳过）' : '') : '没有需要重算的';
  });

  // ── ⑤ 经验衰减/退休/冲突（light，全局库）──
  if (todue.some((s) => s.id === 'consolidate')) await runOne(specOf('consolidate'), () => {
    if (!global) return '全局库不可用（' + (globalOpenError ?? '未知') + '），跳过';
    const r = maintainLessons(global);
    return '衰减 ' + r.decayed + ' · 退休 ' + r.retired + ' · 复活 ' + r.resurrected + ' · 待人工确认 ' + r.superseded;
  });

  // ── ⑥ 无损去重（light）──
  if (todue.some((s) => s.id === 'compact')) await runOne(specOf('compact'), () => {
    const res = eachProject((_root, db) => compactExactSessions(db, { apply: true }));
    const merged = res.reduce((a, x) => a + (x.r?.merged ?? 0), 0);
    const changed = res.reduce((a, x) => a + (x.r?.changed ?? 0), 0);
    return merged ? (merged + ' 条重复已合并（' + changed + ' 场会话，零信息损失）') : '0 条重复已合并（零信息损失）';
  });

  // ── ⑦ 派生列清洗（light）：topics/files 噪声 ──
  // ⑧ 派生列清洗（light）：topics/files 噪声。原先它不在 STAGES 表里（特例分支），
  // 结果 --force 时也跑不到 —— 现已升为一等阶段（表是唯一权威）。
  if (todue.some((s) => s.id === 'cleanup')) await runOne(specOf('cleanup'), () => {
      const res = eachProject((_root, db) => cleanDerivedColumns(db, { apply: true }));
      const changed = res.reduce((a, x) => a + (x.r?.changed ?? 0), 0);
      return changed ? changed + ' 场会话的派生列已清洗（共丢 ' + res.reduce((a, x) => a + (x.r?.droppedKinds ?? 0), 0) + ' 种噪声）' : '0 场（本来就是干净的）';
  });

  // ── ⑨ 老化压缩（heavy；有损，ADR-003 强度门）──
  if (todue.some((s) => s.id === 'aging')) await runOne(specOf('aging'), () => {
    let wf = 0, other = 0, criteria = '';
    for (const root of roots) {
      const f = dbFileOf(root);
      if (!fs.existsSync(f)) continue;
      const cfg = loadConfig(root);
      const policy = autoArchivePolicyOf(cfg);
      if (!policy) continue;
      const db = createDb(f);
      try { const r = autoArchiveProject(db, policy); wf += r.workflowArchived; other += r.hotArchived; criteria = r.criteria; }
      finally { try { db.close(); } catch { /* 已关 */ } }
    }
    return wf + other ? ('workflow ' + wf + ' · 普通 ' + other + ' · ' + criteria) : '本轮无会话可归档（' + (criteria || '策略关闭') + '）';
  });

  // ── ⑨ 分发（部署物由宿主注入；内核不碰 HTML）──
  if (todue.some((s) => s.id === 'distribute')) await runOne(specOf('distribute'), async () => {
    if (!opts.distribute) return '未注入分发钩子（面板/导出属部署层，由宿主提供）';
    return await opts.distribute();
  });

  if (global) { try { saveLifecycle(global, state); } catch { /* 记账失败不阻塞 */ } }
  try { global?.close(); } catch { /* 已关 */ }
  releaseLock();
  log('══ 第 ' + state.rounds + ' 轮完成（' + roots.length + ' 个项目）══');
  return { at, rounds: state.rounds, stages, projects: roots.length };
}

/** 只看状态（不跑任何阶段）：插件/面板/CLI 都调它 */
export function lifecycleStatus(): { rounds: number; lastAt: string | null; stages: Partial<Record<StageId, { ok: boolean; note: string; at: string }>> } {
  const global = openGlobalLedger();
  if (!global) return { rounds: 0, lastAt: null, stages: {} };
  try {
    const st = loadLifecycle(global);
    return { rounds: st.rounds, lastAt: st.lastAt, stages: st.stages };
  } finally { try { global.close(); } catch { /* 已关 */ } }
}
