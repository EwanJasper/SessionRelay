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
import { registryHeartbeatFresh } from '../../shared/lock.js';
import type Database from 'better-sqlite3';
import { runSync } from '../../capture/sync.js';
import { recomputeExtractions } from '../../capture/recompute.js';
import { compactExactSessions } from '../compact/exact.js';
import { compactNearDuplicates } from '../compact/near-dup.js';
import { harvestLessons } from '../extract/lesson-harvest.js';
import { resolveWorkspaceId } from '../../shared/workspace.js';
import { cleanDerivedColumns } from '../extract/derived-cleanup.js';
import { buildTagGraph } from '../graph/tags.js';
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
  // ⚠️ [1021 后端红队 #3] `lastAt` **从来没被赋值过**。于是面板同一张卡上出现：
  //   「已执行 196 次」+「最近运行：—」—— 两个数互相矛盾，而 `stages` 段里明明有 43 秒前的时间。
  //   根因就在这一行缺失：只加了 rounds，没写 lastAt，saveLifecycle 把 null 原样写库。
  //   这里补上。注意用**本轮开始时间**（at），不是结束时间 —— 语义是「这一轮是什么时候跑的」。
  state.lastAt = at;

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
    // ── [1021 红队复核后修**第三套阈值**] 这里原来写死 `hbAge < 15 * 60_000`，
    //   而 panel/snapshot.ts 读的是另一个常量 ⇒ 红队实测同一份输入（心跳 246s）得出**相反结论**：
    //     面板 = 离线 / 这里 = 「守护在线，本轮交给它」
    //   ⇒ **守护真死后的 3~15 分钟窗口里谁都不去采集**，是最坏的一类分叉（不是报错，是静默不干活）。
    //   现在统一读 `registryHeartbeatFresh()` —— 判据是**函数**，两边不可能再各写一套比较式。
    if (registryHeartbeatFresh(hbAge)) return '采集守护在线（心跳 ' + Math.round((hbAge as number) / 1000) + 's 前），本轮交给它';
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
      let total = 0, failed = 0, guard = 0, archivedCleaned = 0, archivedFailed = 0;
      for (;;) {
        const r = recomputeExtractions(db, 300);
        total += r.recomputed; failed += r.failed;
        // [1021 红队 T7 修复] `archivedCleaned` 原来**没有任何调用方读** ——
        //   `-1` 那个「清理失败」哨兵永远没人看，注释写的「调用方负责打日志，不许静默」没兑现。
        //   现在在这里读出来并聚合；失败单独计数（不混进 failed：那是抽取失败，不是清理失败）。
        if (r.archivedCleaned === -1) archivedFailed++;
        else if (r.archivedCleaned > 0) archivedCleaned += r.archivedCleaned;
        if ((r.recomputed === 0 && r.remaining === 0) || ++guard > 2000) break;
      }
      return { total, failed, archivedCleaned, archivedFailed };
    });
    const total = res.reduce((a, x) => a + (x.r?.total ?? 0), 0);
    const failed = res.reduce((a, x) => a + (x.r?.failed ?? 0), 0);
    const archCleaned = res.reduce((a, x) => a + (x.r?.archivedCleaned ?? 0), 0);
    const archFailed = res.reduce((a, x) => a + (x.r?.archivedFailed ?? 0), 0);
    const bits: string[] = [];
    if (total) bits.push('重算 ' + total + ' 场');
    if (failed) bits.push(failed + ' 场抽取异常（已打版本戳跳过）');
    if (archCleaned) bits.push('归档会话清掉 ' + archCleaned + ' 条陈旧决策');
    // 清理失败必须显形：这条通道删的是数据，静默失败等于「以为清过了其实没清」。
    if (archFailed) bits.push('警告 ' + archFailed + ' 个库的归档清理失败（原因见日志）');
    return bits.length ? bits.join(' · ') : '没有需要重算的';
  });

  // ── ④b 经验采集（light；全局库 ← 逐项目库）──
  //
  // 1021 新增。病历：此前 harvest 只是**手动命令**，而下一段 consolidate（衰减/退休）
  // 每小时都在跑 ⇒ 经验库**只减不增**。实测 17 条里 7 条被衰减退休、全靠人工偶尔补。
  //
  // 为什么敢让它自动跑：产出永远是 **draft**，而 draft 不进注入层（要 lesson confirm）。
  // 抽错的代价最多是"草稿多一条"，且每条都带 quote + sourceRef，复核一眼可见。
  // 顺序：本段排在 consolidate **之前** —— 先采新的，再衰减旧的。
  if (todue.some((s) => s.id === 'harvest')) await runOne(specOf('harvest'), () => {
    if (!global) return '全局库不可用（' + (globalOpenError ?? '未知') + '），跳过';
    let scanned = 0, found = 0, fresh = 0, written = 0, notDraft = 0, off = 0, errored = 0;
    for (const root of roots) {
      const f = dbFileOf(root);
      if (!fs.existsSync(f)) continue;
      let cfg;
      try { cfg = loadConfig(root); } catch { errored++; continue; }
      if (cfg.lesson?.harvest === false) { off++; continue; }
      const pdb = createDb(f);
      try {
        const r = harvestLessons(global as never, pdb as never, resolveWorkspaceId(root), {
          days: typeof cfg.lesson?.harvest_days === 'number' ? cfg.lesson.harvest_days : 7,
        });
        scanned += r.scanned; found += r.found; fresh += r.fresh; written += r.written;
        notDraft += r.notDraft.length;
      } catch { errored++; }
      finally { try { pdb.close(); } catch { /* 已关 */ } }
    }
    const bits = ['扫 ' + scanned + ' 条', '候选 ' + found, '新的 ' + fresh, '写入草稿 ' + written];
    if (off) bits.push(off + ' 个项目已关');
    // 清理/写入失败必须显形（这条通道写的是全局库，静默失败等于"以为采过了其实没采"）
    if (errored) bits.push('警告 ' + errored + ' 个项目出错（原因见日志）');
    if (notDraft) bits.push('🔴 ' + notDraft + ' 条落库后不是 draft（写入语义被改动了）');
    return bits.join(' · ');
  });

  // ── ⑤ 经验衰减/退休/冲突（light，全局库）──
  if (todue.some((s) => s.id === 'consolidate')) await runOne(specOf('consolidate'), () => {
    if (!global) return '全局库不可用（' + (globalOpenError ?? '未知') + '），跳过';
    const r = maintainLessons(global);
    return '衰减 ' + r.decayed + ' · 退休 ' + r.retired + ' · 复活 ' + r.resurrected + ' · 待人工确认 ' + r.superseded;
  });

  // ── ⑥ 无损去重（light）──
  //   两个子层，判据完全不同，别混：
  //     L0（exact）：**同会话**逐字重复合并 —— 恒定跑，可证明无损
  //     L1b（near-dup）：**跨会话**近重复合并 —— 由 compact.near_dup 控制（默认开）
  //   L1b 的默认值不是拍的：代表选择改成 highest-trust 之后，两个库的召回基准
  //   hit@1/hit@3/hit@10 逐格不变；而旧策略(newest)在 music 库会让 31 条用户拍板
  //   被 workflow 转述吸收、从读路径隐形。压缩量两者相同 ⇒ 修规则不花代价。
  //   写回带审计（compact_log/compact_detail）与回滚（rollbackNearDuplicates）。
  if (todue.some((s) => s.id === 'compact')) await runOne(specOf('compact'), () => {
    const l0 = eachProject((_root, db) => compactExactSessions(db, { apply: true }));
    const m0 = l0.reduce((a, x) => a + (x.r?.merged ?? 0), 0);
    const c0 = l0.reduce((a, x) => a + (x.r?.changed ?? 0), 0);
    // L1b：逐项目读配置（开关可逐项目不同），关掉的跳过并记账
    let m1 = 0, s1 = 0, off = 0, err1 = 0;
    for (const root of roots) {
      const f = dbFileOf(root);
      if (!fs.existsSync(f)) continue;
      let cfg;
      try { cfg = loadConfig(root); } catch { err1++; continue; }
      const nearDup = cfg.compact?.near_dup !== false;
      if (!nearDup) { off++; continue; }
      const db = createDb(f);
      try {
        const r = compactNearDuplicates(db, {
          apply: true,
          representative: 'highest-trust',
          threshold: typeof cfg.compact?.threshold === 'number' ? cfg.compact.threshold : 0.8,
          triggeredBy: 'lifecycle',
        });
        m1 += r.merged; s1 += r.sessionsChanged;
      } catch { err1++; }
      finally { try { db.close(); } catch { /* 已关 */ } }
    }
    const parts: string[] = [];
    parts.push('L0 ' + m0 + ' 条（' + c0 + ' 场会话）');
    parts.push('L1b ' + m1 + ' 条（' + s1 + ' 场会话）' + (off ? ' · ' + off + ' 个项目已关' : '') + (err1 ? ' · ' + err1 + ' 个项目出错' : ''));
    return parts.join(' · ');
  });

  // ── ⑦ 派生列清洗（light）：topics/files 噪声 ──
  // ⑧ 派生列清洗（light）：topics/files 噪声。原先它不在 STAGES 表里（特例分支），
  // 结果 --force 时也跑不到 —— 现已升为一等阶段（表是唯一权威）。
  if (todue.some((s) => s.id === 'cleanup')) await runOne(specOf('cleanup'), () => {
      const res = eachProject((_root, db) => cleanDerivedColumns(db, { apply: true }));
      const changed = res.reduce((a, x) => a + (x.r?.changed ?? 0), 0);
      return changed ? changed + ' 场会话的派生列已清洗（共丢 ' + res.reduce((a, x) => a + (x.r?.droppedKinds ?? 0), 0) + ' 种噪声）' : '0 场（本来就是干净的）';
  });

  // ── [1021] 标签图谱重建（light）──
  //   为什么进生命周期：`scripts/graph-tag-build.mjs` 是手动脚本，而 `core/graph/expand.ts`
  //   读到空表只会提示「先跑脚本」不会自建 ⇒ 会话一多图就与库不一致、且**没有任何机制发现**。
  //   体量 1.3s/620 会话，daily 足够；失败只告警不阻塞（图是增强，不是主链路）。
  if (todue.some((s) => s.id === 'tags')) await runOne(specOf('tags'), () => {
    // reuse 默认 true：会话数没变时直接跳过（图没变就不重建，省 1.3s）

    // ⚠️ `eachProject` 已经把回调返回值放进 `r` 了 —— 回调**直接返回 stats**，不要再套一层 {r:...}，
    //   否则读的是 `x.r.tags` = undefined（我第一版就写错成双重包装，实测一直报「0 个标签」）。
    type TagStats = { tags?: number; edges?: number; reused?: boolean; sessions?: number };
    // [1021 红队 T4 修复] 原来回调里 `try { ... } catch { return null }` —— **异常被就地吞掉**，
    //   `eachProject` 的 `err` 永远拿不到原因，上层只能看到「失败 N 个库」，**不知道是什么错**。
    //   现在不就地 catch：让异常冒到 eachProject，由它记进 `err`，下面把原因打出来。
    const res = eachProject<TagStats>((_root, db) => buildTagGraph(db) as TagStats);
    let tags = 0, edges = 0, failed = 0, reused = 0;
    const failReasons: string[] = [];
    for (const x of res) {
      if (x.err || !x.r) { failed++; if (x.err) failReasons.push(x.err); continue; }
      if (x.r.reused) { reused++; continue; }   // 会话数没变 ⇒ buildTagGraph 自己跳过，不是失败
      tags += x.r.tags ?? 0; edges += x.r.edges ?? 0;
    }
    // 失败必须带原因：只说「N 个库失败」等于没说，接手的人还得重跑一遍才知道为什么。
    if (failed > 0) return '警告 ' + failed + ' 个库重建失败（图是增强，不影响检索）：' + (failReasons.slice(0, 2).join(' / ') || '原因未知');
    // 报文必须区分「跳过」和「建了 0 个」—— 原来一律写 0，看起来像坏了（实测我自己就被骗了一次）
    if (tags === 0 && edges === 0 && reused > 0) return '已是最新（' + reused + ' 个库跳过，图未变）';
    return tags + ' 个标签 / ' + edges + ' 条共现边已刷新';
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
