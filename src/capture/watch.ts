// watch 守护（技术方案 §5.5 / 改进方案 改动1 注册表化）
// [fork 0922] 三项强化：
//   ① 每项目命名管道单实例锁——上游 #2 实例堆积根治（原 acquireLock 先查后写非原子，
//     并发 spawn 同秒全过；管道是内核对象随进程死亡自动消失，EADDRINUSE 即活实例）
//   ② runWatch 拆出 startWatchWorker（可停的 worker），为 --global 复用
//   ③ --global 全局守护：一个进程看管项目注册表里的全部项目，sweep 动态收编/移除
import path from 'node:path';
import fs from 'node:fs';
import net from 'node:net';
import crypto from 'node:crypto';
import { openExisting, createDb } from '../store/db.js';
import { openGlobal } from '../store/global.js';
import { ensureLifecycleTables, setHeartbeat } from '../core/lifecycle/stages.js';
import type { RelayConfig } from '../shared/config.js';
import { loadConfig } from '../shared/config.js';
import { projectIdOf, dbFile, statsFile, watchLogPath } from '../shared/paths.js';
import { rotateLogFile } from '../shared/logrotate.js';
import { StatsCounter } from '../core/stats/counter.js';
import { acquireLock, touchLock, releaseLock, isDaemonAlive, LOCK_TOUCH_MS, REGISTRY_HEARTBEAT_MS } from '../shared/lock.js';
import { runLifecycle } from '../core/lifecycle/runner.js';
import { watchDir } from '../adapters/claude-code/watcher.js';
import { runSync } from './sync.js';
import { autoArchiveProject, autoArchivePolicyOf } from './archive.js';
import { recomputeExtractions } from './recompute.js';
import { runJudge } from './judge.js';
import { consumeHookEvents } from './hook-spool.js';
import { ensureRegistered, get, adapterConfig } from '../adapters/registry.js';
import { registryCandidates } from '../shared/registry.js';

export interface WatchOptions {
  projectRoot: string;
  config: RelayConfig;
  log?: (msg: string) => void;
  /** [fork 1010] 由 runWatchGlobal 收编时为 true：跳过让位检查与防孤儿计时器 */
  inGlobalDaemon?: boolean;
}

// ── [fork 0922] 每项目命名管道单实例锁 ──
const pipeLockServers = new Map<string, net.Server>();

function pipeLockName(root: string): string {
  // 反斜杠经 String.fromCharCode 构造，杜绝转义层吃反斜杠；小写归一 + sha1 前 16 位
  const BS = String.fromCharCode(92);
  const h = crypto.createHash('sha1').update(path.resolve(root).toLowerCase()).digest('hex').slice(0, 16);
  return BS + BS + '.' + BS + 'pipe' + BS + 'srelay-watch-' + h;
}

function globalPipeName(): string {
  const BS = String.fromCharCode(92);
  // SRELAY_GLOBAL_PIPE 仅供测试/调试隔离用，默认走固定名
  const name = process.env.SRELAY_GLOBAL_PIPE ?? 'srelay-watch-global';
  return BS + BS + '.' + BS + 'pipe' + BS + name;
}

// [fork 1010] 全局守护是否在跑：连它的固定名管道，连上即活（内核对象随进程死亡自动消失）。
// project 模式启动前先问这个——有全局守护在跑还起 project 实例，只会抢走项目锁、
// 让全局守护永远收编不了该项目（live: mc整合包 连续 30 次撞锁 + 孤儿实例无限期存活）。
export function globalDaemonAlive(timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect(globalPipeName());
    const done = (ok: boolean) => { try { sock.destroy(); } catch { /* 已关 */ } resolve(ok); };
    sock.once('connect', () => done(true));
    sock.once('error', () => resolve(false));
    setTimeout(() => done(false), timeoutMs).unref?.();
  });
}

function acquirePipeLockByName(name: string, log: (m: string) => void, label: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') { resolve(true); return; } // 非 Windows 走原文件锁
    const srv = net.createServer();
    srv.once('error', (e: NodeJS.ErrnoException) => {
      if (e && e.code === 'EADDRINUSE') {
        log(`${label}锁被占（另一守护在跑），本实例退出: ${name}`);
        resolve(false);
      } else resolve(true); // 管道不可用 → 降级回文件锁语义
    });
    srv.listen(name, () => {
      pipeLockServers.set(name, srv);
      resolve(true);
    });
  });
}

function acquirePipeLock(root: string, log: (m: string) => void): Promise<boolean> {
  return acquirePipeLockByName(pipeLockName(root), log, '管道');
}

function releasePipeLock(root: string): void {
  const name = pipeLockName(root);
  const srv = pipeLockServers.get(name);
  if (srv) {
    try { srv.close(); } catch { /* 进程退出内核同样回收 */ }
    pipeLockServers.delete(name);
  }
}

function releaseGlobalPipeLock(): void {
  const name = globalPipeName();
  const srv = pipeLockServers.get(name);
  if (srv) {
    try { srv.close(); } catch { /* 忽略 */ }
    pipeLockServers.delete(name);
  }
}

// ── [1021 审查 #02 修复] 运行期配置：每轮热读 + 校验 + 「哪些改动必须重启」 ──
//
// 病历：cycle 里 runSync 用的是**启动时**那份 opts.config（cfgTick 只喂给了 digestSemantic）。
//   于是把 capture.mode 改成 off 之后，守护照收不误——用户按文档"关了采集"，库里还在涨。
//   这是本项目最忌的"看起来在工作/看起来关了其实没关"。
// 现在：每个写周期先 loadConfig → 校验 → runSync / runJudge / digestSemantic **全用新配置**；
//   只有「启动时就固化进定时器/监听器」的项变更才算"尚未生效"，并**明确打一行日志**。
// 判据只一份：热读走 resolveTickConfig，启动固化项走 startupFixedConfig/diffStartupFixed。

/** 启动时固化、改了必须重启守护才生效的配置项（每项一个可比较的字符串快照）。 */
export function startupFixedConfig(cfg: RelayConfig): Record<string, string> {
  return {
    'capture.sources': JSON.stringify(cfg.capture?.sources ?? []),
    'archive.enabled': String(cfg.archive?.enabled ?? true),
    'archive.hot_days': String(cfg.archive?.hot_days ?? 60),
    'archive.workflow_days': String(cfg.archive?.workflow_days ?? 7),
    'archive.check_every_min': String(cfg.archive?.check_every_min ?? 60),
    'recompute.check_every_min': String(cfg.recompute?.check_every_min ?? 360),
  };
}

/** 返回「改了但需要重启才生效」的项（空数组 = 全部立即生效）。 */
export function diffStartupFixed(startedWith: RelayConfig, now: RelayConfig): string[] {
  const a = startupFixedConfig(startedWith);
  const b = startupFixedConfig(now);
  return Object.keys(a).filter((k) => a[k] !== b[k]);
}

/** 每一项「为什么必须重启」的准确说明（不许用一句笼统话糊过去 —— 说错同样是误导）。 */
export const STARTUP_FIXED_NOTES: Record<string, string> = {
  'capture.sources': '文件监听目录在启动时注册；定时周期采集已按新源跑，实时触发要重启',
  'archive.enabled': '自动归档定时器按启动时的开关注册',
  'archive.hot_days': '自动归档策略在启动时固化',
  'archive.workflow_days': '自动归档策略在启动时固化',
  'archive.check_every_min': '归档检查节奏在启动时固化',
  'recompute.check_every_min': '重算检查节奏在启动时固化',
};

/** 运行期校验：真正会跑的那几个字段，非法值宁可沿用上一份，也不许悄悄照跑。 */
export function validateRuntimeConfig(cfg: RelayConfig): string | null {
  const mode = cfg.capture?.mode;
  if (mode !== 'off' && mode !== 'meta' && mode !== 'full') return `capture.mode=${String(mode)} 不在 off|meta|full`;
  if (!Array.isArray(cfg.capture?.sources)) return 'capture.sources 不是数组';
  return null;
}

export interface TickConfig { config: RelayConfig; warnings: string[] }

/** 每轮热读配置。读失败/校验不过 → 沿用上一份**并留痕**（不许静默继续用旧配置当没事）。 */
export function resolveTickConfig(root: string, fallback: RelayConfig): TickConfig {
  let cfg: RelayConfig;
  try { cfg = loadConfig(root); }
  catch (e) { return { config: fallback, warnings: [`配置读取失败，本轮沿用上一份（修改尚未生效）：${(e as Error).message}`] }; }
  const invalid = validateRuntimeConfig(cfg);
  if (invalid) return { config: fallback, warnings: [`配置非法（${invalid}），本轮沿用上一份（修改尚未生效）`] };
  return { config: cfg, warnings: [] };
}

// ── [fork 0922] 可停 worker：单项目守护的全部生命周期（原 runWatch 主体，信号等待外提） ──
export interface WatchWorker {
  root: string;
  stop(): Promise<void>;
}

export async function startWatchWorker(opts: WatchOptions): Promise<WatchWorker | null> {
  const root = opts.projectRoot;
  const log = opts.log ?? ((m: string) => process.stderr.write(`[srelay-watch] ${m}\n`));

  // [fork 1010] 让位全局守护：--global 实例在跑时，project 模式实例只会抢锁+双重捕获
  if (!opts.inGlobalDaemon && (await globalDaemonAlive())) {
    log('全局守护已在运行，本项目模式实例退出（全局守护会自动收编本项目）');
    return null;
  }

  if (!(await acquirePipeLock(root, log))) return null; // [fork 0922] 同项目已有守护在跑

  const lock = acquireLock(root);
  if (!lock.ok) {
    const alive = isDaemonAlive(root);
    log(lock.reason + (alive.alive ? '' : '（锁已僵死，本次接管）'));
    if (alive.alive) { releasePipeLock(root); return null; }
  }

  // ── [1021 红队 R9] 启动资源账本：从这里起，拿到的每样东西都必须能被回滚 ──
  //   病历（红队探针实测，修前三条全部复现）：
  //     A 库文件损坏 → openExisting 抛错**直接穿出本函数**（原第 151 行在 try 之外）：
  //       管道锁 + 文件锁双双泄漏。管道锁是进程级内核对象，本进程不死就永远占着；
  //       文件锁让 isDaemonAlive 恒为 true ⇒ 全局守护每 10 分钟收编一次、每次失败、
  //       每次再占一份，该项目**永久收编不进来**。
  //     B openExisting 成功之后才失败（如 config 缺 identity）→ 原 catch 只清 timer 与管道锁：
  //       db 句柄没人关（Windows 上 relay.sqlite 一直 EBUSY，forget/rebuild 全废），
  //       文件锁也没释放，且**一条日志都不打**（异常发生在 try 之外，连 catch 都进不去）。
  //   现在：所有失败分支共用同一个 cleanup()（定时器/监听器/db/两把锁一处释放），
  //   并把失败原因写进 log —— 硬规则 4：容错不许静默。
  const timers: NodeJS.Timeout[] = [];
  const watchers: Array<{ close(): void }> = [];
  let dbRef: ReturnType<typeof openExisting> | undefined;
  let freed = false;
  const cleanup = () => {
    if (freed) return;
    freed = true;
    for (const t of timers) clearInterval(t);
    for (const w of watchers) { try { w.close(); } catch { /* 关不上也不掩盖原始错误 */ } }
    if (dbRef) { try { dbRef.close(); } catch { /* 同上 */ } dbRef = undefined; }
    releaseLock(root);
    releasePipeLock(root);
  };

  try {
  // [fork 1010] 防孤儿：启动 shell 退出时本实例随之退出。agent 后台命令拉起的
  // project 模式 watch 曾无限期存活（父 shell 早已不在），与全局守护抢锁。
  let orphanTimer: NodeJS.Timeout | undefined;
  if (!opts.inGlobalDaemon && process.ppid > 0) {
    const launcher = process.ppid;
    orphanTimer = setInterval(() => {
      try {
        process.kill(launcher, 0);
      } catch (e) {
        // [1021 R9] 原先这里是空 catch：把"启动器已退出"与其他错误（EPERM 等）混为一谈，
        // 且不留任何原因。现在带上原因（仍是退出语义，只补可诊断性）。
        log(`启动器进程不可达（${(e as Error).message}），本实例退出（防孤儿）`);
        clearInterval(orphanTimer);
        releaseLock(root);
        releasePipeLock(root);
        if (dbRef) { try { dbRef.close(); } catch { /* 进程即将退出 */ } }
        process.exit(0);
      }
    }, 15_000);
    timers.push(orphanTimer);
  }

  // [1021] 文件锁 15s 一拍（与注册表心跳 60s **不是同一个节奏** —— 上一版混用过，见 shared/lock.ts）
  const heartbeat = setInterval(() => touchLock(root), LOCK_TOUCH_MS);
  timers.push(heartbeat);
  const db = openExisting(dbFile(root));
  dbRef = db;                                   // [R9] 交给账本，失败时由 cleanup 关闭

  let chain: Promise<void> = Promise.resolve(); // 串行化所有写周期（T23 的进程内体现）
  // [fork 0922] 接通本地匿名计数器：守护侧的 ignore 拦截/resumed/confirmed 原来从不计数，
  // status 面板"拦截 0 次"与实际不符
  const stats = new StatsCounter(statsFile(root));
  // [修 #02] 上一份**可用**配置（热读失败时回落它，并留痕）；以及"只在变化时打一次"的提示状态
  let lastCfg = opts.config;
  let lastCfgWarn = '';
  let warnedFixedSig = '';
  let warnedMode = String(opts.config.capture.mode);
  const cycle = (why: string) => {
    chain = chain.then(async () => {
      try {
        // ── [修 #02] 每轮热读配置：runSync / runJudge / digestSemantic 一律用它 ──
        const tick = resolveTickConfig(root, lastCfg);
        const warnText = tick.warnings.join(' | ');
        if (warnText && warnText !== lastCfgWarn) { lastCfgWarn = warnText; log(`配置：${warnText}`); }
        else if (!warnText) lastCfgWarn = '';
        const cfgNow = tick.config;
        lastCfg = cfgNow;
        // 启动时固化的项：改了必须重启才生效 —— 明说，不许假装生效
        const fixedChanged = diffStartupFixed(opts.config, cfgNow);
        if (fixedChanged.length > 0) {
          const sig = fixedChanged.join(',');
          if (sig !== warnedFixedSig) {
            warnedFixedSig = sig;
            log(`⚠ 配置已改，但下列项**需重启守护才生效**（当前仍按启动时的值跑）：`
              + fixedChanged.map((k) => `${k}（${STARTUP_FIXED_NOTES[k] ?? '启动时固化'}）`).join('、'));
          }
        } else if (warnedFixedSig) warnedFixedSig = '';
        if (String(cfgNow.capture.mode) !== warnedMode) {
          log(`采集模式已切换：${warnedMode} → ${cfgNow.capture.mode}（立即生效）`);
          warnedMode = String(cfgNow.capture.mode);
        }
        const projectIdNow = cfgNow.identity.project_id ?? projectIdOf(root);
        const s = await runSync({ projectRoot: root, config: cfgNow, db, stats });
        const spool = consumeHookEvents(root, db, new Date()); // R4：hook 事件 → 立即转 pending
        const j = runJudge(db, { projectId: projectIdNow, now: new Date(), idleMin: cfgNow.capture.idle_threshold_min, cooldownH: cfgNow.capture.cooldown_hours, stats });
        if (s.newMessages > 0 || s.resumed > 0 || j.confirmed > 0 || spool.endSignals > 0 || why !== 'tick') {
          log(`${why}: +${s.newMessages} 消息 · resumed ${s.resumed} · pending ${j.toPending} · confirmed ${j.confirmed}${spool.endSignals ? ` · hook信号 ${spool.endSignals}` : ''}`);
        }
        // 语义 digest（design-semantic §3.2）：confirmed 且无向量的会话限量补嵌，CPU 友好
        // [1017 夜] **每 tick 重读配置**：守护是常驻进程，缓存 config 会让"关掉语义档"不生效 ——
        // 用户关了开关，后台还在默默补嵌向量（调研件 §4 的头号风险：看起来在工作）。
        const { digestSemantic } = await import('../search-svc/semantic.js');
        await digestSemantic(db, cfgNow, { projectId: projectIdNow, limit: 20 });
      } catch (e) {
        log(`周期失败（不退出）: ${(e as Error).message}`);
      }
    });
    return chain;
  };

  // [1021 R9] watchers 复用外层账本里的数组：启动失败时由 cleanup 统一 close
  const judgeTimer = setInterval(() => cycle('tick'), 30_000);
  const safetyTimer = setInterval(() => cycle('safety'), 60_000);
  timers.push(judgeTimer, safetyTimer);

  // [fork 1011] D26 自动归档（用户拍板：默认启用/60d/7d/增量式 VACUUM）：
  // 低频检查串行进写链；首次启动即跑一次——顺带完成 auto_vacuum 启用式 VACUUM，
  // 回收既有 freelist 空洞（实测 56MB）。runArchive 的保护规则/复活/审计全复用。
  const archivePolicy = autoArchivePolicyOf(opts.config);
  let archiveTimer: NodeJS.Timeout | undefined;
  if (archivePolicy) {
    const runAuto = () => {
      chain = chain.then(async () => {
        try {
          const r = autoArchiveProject(db, archivePolicy);
          if (r.workflowArchived + r.hotArchived > 0 || r.vacuumEnabled) {
            // 带上判据摘要：ADR-003 D1 要求"淘汰决定必须能从数字上说清"——只报条数等于没说清
            log(`自动归档：workflow ${r.workflowArchived} · 普通 ${r.hotArchived} · 释放 ${r.freedPages} 页${r.vacuumEnabled ? '（已启用增量式 VACUUM）' : ''} · ${r.criteria}`);
          }
        } catch (e) {
          log(`自动归档失败（不退出，下周期重试）: ${(e as Error).message}`);
        }
      });
    };
    runAuto();
    archiveTimer = setInterval(runAuto, archivePolicy.checkEveryMin * 60_000);
    archiveTimer.unref();
    timers.push(archiveTimer);          // [R9] 进账本，失败/停止时统一清
  }

  // [fork 1013] 审计 P3：提取规则版本落后 → 后台分批重算。
  // 不这么做的话，改规则只对新数据生效，历史垃圾永久留存——用户观感是"修了没用"。
  // 节奏比归档更保守（默认 6h）：这是纯 CPU 活，且只在版本落后时才真正做事。
  let recomputeTimer: NodeJS.Timeout | undefined;
  const RECOMPUTE_EVERY_MS = Math.max(1, opts.config.recompute?.check_every_min ?? 360) * 60_000;
  const runRecompute = () => {
    chain = chain.then(() => {
      try {
        const r = recomputeExtractions(db);
        if (r.recomputed > 0) {
          log(`提取规则重算：${r.recomputed} 个会话${r.remaining > 0 ? `（剩 ${r.remaining} 待下批）` : '（已跟上版本）'}`);
        }
      } catch (e) {
        log(`提取重算失败（不退出，下周期重试）: ${(e as Error).message}`);
      }
    });
  };
  runRecompute();
  recomputeTimer = setInterval(runRecompute, RECOMPUTE_EVERY_MS);
  recomputeTimer.unref();
  timers.push(recomputeTimer);          // [R9] 进账本，失败/停止时统一清
  let stopped = false;

  try {
    await cycle('initial');
    // 改动 1：从注册表获取各源的监听目录（不再硬编码）
    ensureRegistered(root);
    const roots = new Set<string>();
    for (const s of opts.config.capture.sources) {
      const adapter = get(s, root);   // [B2] 显式项目根：不再依赖进程级 activeKey
      if (adapter?.watchRoots) {
        for (const dir of adapter.watchRoots(root, adapterConfig(opts.config, s))) {
          roots.add(dir);
        }
      }
    }
    for (const dir of roots) {
      try {
        watchers.push(watchDir(dir, () => cycle('watch'), 500));
        log(`监听 ${dir}`);
      } catch { /* 目录不存在，安全定时器兜底 */ }
    }
    log(`守护运行中（pid ${process.pid}，项目 ${root}）`);
  } catch (e) {
    // [fork 0922] worker 初始化失败：报告 null（全局模式下跳过该项目，不拖垮进程）
    // [1021 红队 R9] 释放**全部**已持资源：定时器 + 监听器 + db 句柄 + 文件锁 + 管道锁。
    //   原实现只清 timer 与管道锁 ⇒ db 句柄与文件锁泄漏（红队探针：db 文件 EBUSY、
    //   isDaemonAlive 恒 true、日志一行不打）。openExisting 自身抛错的路径原先根本
    //   进不到这里（异常穿出函数），现由上面的 try 收口。
    cleanup();
    log(`守护初始化失败（${root}）: ${(e as Error).message}`);
    return null;
  }

  return {
    root,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      // [1021 R9] 与启动失败共用 cleanup：停止不再单独维护资源清单（原实现与失败分支
      // 已经漂移过 —— 失败分支漏了 db.close 与文件锁，正是 R9 的病根）。
      for (const t of timers) clearInterval(t);
      // 原实现是 `await chain.catch(() => {})`：写链失败被静默吞掉。容错不许静默，
      // 至少打一行（资源照样释放）。
      await chain.catch((e) => log(`退出前等待写链失败（继续释放资源）: ${(e as Error).message}`));
      cleanup();
      log('已退出');
    },
  };
  } catch (e) {
    // [1021 红队 R9] 收口"进入初始化 try 之前"的失败：openExisting（库损坏 / schema 过新 /
    //   SQLITE_BUSY）、projectId 解析、定时器初始化。原实现这些语句在 try 之外，异常直接
    //   穿出本函数（调用方只看到 throw），管道锁与文件锁留在原地、db 句柄不关、一行日志不打。
    //   cleanup() 幂等；这里的 log 是"失败必须留痕"的唯一保证（硬规则 4）。
    cleanup();
    log(`守护启动失败（${root}）: ${(e as Error).message}`);
    return null;
  }
}

/** 单项目守护（原入口语义）：worker + SIGINT/SIGTERM 等待 */
export async function runWatch(opts: WatchOptions): Promise<void> {
  const worker = await startWatchWorker(opts);
  if (!worker) return;
  await new Promise<void>((resolve) => {
    const stop = () => resolve();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  await worker.stop();
}

// ── [fork 0922] 全局守护：一个进程看管注册表全部项目 ──
export async function runWatchGlobal(opts: { log?: (msg: string) => void } = {}): Promise<void> {
  const log = opts.log ?? ((m: string) => process.stderr.write(`[srelay-watch] ${m}\n`));
  // [fork] 全局实例锁：项目级管道锁只挡 worker，不挡壳——没有它，第二个 --global
  // 进程会收编 0 个项目后空转变僵尸。固定名（与 cwd 无关），内核对象随进程死亡自动消失。
  if (!(await acquirePipeLockByName(globalPipeName(), log, '全局'))) return;

  const workers = new Map<string, WatchWorker>();

  const adopt = async (why: string) => {
    for (const c of registryCandidates()) {
      const key = path.resolve(c.root).toLowerCase();
      if (workers.has(key)) continue;
      try {
        // [fork 0922] 日志双写：全局守护的 stderr 全部落在启动项目（cwd）的 watch.log，
        // 其余项目的 watch.log 会永久冻结——`srelay watch --status` 在那些项目里打印
        // 僵尸日志尾巴，诊断直呼"守护死了"。worker 日志追加回自己项目的 watch.log。
        const ownLog = path.join(c.root, '.sessionrelay', 'watch.log');
        const w = await startWatchWorker({
          projectRoot: c.root,
          config: loadConfig(c.root),
          inGlobalDaemon: true,
          log: (m) => {
            log(`[${c.name}] ${m}`);
            fs.appendFile(ownLog, `[srelay-watch] ${m}\n`, () => { /* 追加失败不影响运行 */ });
          },
        });
        if (w) { workers.set(key, w); log(`${why}: 收编 ${c.root}`); }
      } catch (e) {
        log(`${why}: 收编失败 ${c.root}: ${(e as Error).message}`);
      }
    }
    // 根目录消失的项目：停 worker 并移除
    // [fork] 项目删除时 sqlite/.cmd 被本进程句柄锁住、目录删不干净，只查根目录永远不触发；
    // config.json（loadConfig 读完即关，不持句柄）消失 = 用户已删库跑路的可靠信号
    for (const [key, w] of workers) {
      if (!fs.existsSync(w.root) || !fs.existsSync(path.join(w.root, '.sessionrelay', 'config.json'))) {
        await w.stop();
        workers.delete(key);
        log(`${why}: 移除失效项目 ${w.root}`);
      }
    }
  };

  await adopt('initial');

  // ── 心跳（ADR-002 / 1017 夜）：把"采集守护在线"写进**库**，而不是再让别的脚本去查进程表 ──
  // 用途：生命周期运行器据此让出采集阶段（两个写入方同写一个库 = SQLITE_BUSY，实测过）。
  // 数据在库里 ⇒ 跨进程可读、不依赖 powershell、不依赖进程名匹配（那玩意已经被引号坑过一次）。
  {
    const hb = () => {
      try {
        const g = openGlobal();
        ensureLifecycleTables(g);
        setHeartbeat(g, 'watch', 'pid ' + process.pid);
        g.close();
      } catch { /* 心跳失败不影响采集 */ }
    };
    hb();
    setInterval(hb, REGISTRY_HEARTBEAT_MS);   // [1021] 注册表心跳：60s 一拍，3 拍过期（见 shared/lock.ts）
  }

  // [fork 1011] 启动即轮转一次：双写让每个收编项目的 watch.log 都会增长，
  // 原轮转只覆盖 cwd 根，其余项目日志无限堆积（实测 D 33.7MB / E 7.4MB）。
  for (const w of workers.values()) rotateLogFile(watchLogPath(w.root));
  const adoptTimer = setInterval(() => { void adopt('sweep'); }, 10 * 60_000);

  // ── 生命周期定时器（ADR-002）：守护**就是**生命周期的宿主 ──────────────────
  // 为什么放在这里而不是再起一个进程：框架本该只有**一个写入方**。守护已经在采集，
  // 生命周期剩下的阶段（体检/自愈/重算/经验/去重/清洗/老化）由它顺手按各自节奏跑，
  // 采集阶段会因为守护自己的心跳而让位（见 runner 的 capture 段）——不会两个写入方撞库。
  // 节奏由 stages.ts 的 everySec 决定（guard 15min / extract 30min / compact 1h / aging 1d…）。
  {
    const tick = async () => {
      try {
        const r = await runLifecycle({ log: (m: string) => log(m.replace(/^\s+/, '')) });
        const bad = r.stages.filter((s) => !s.ok);
        if (bad.length) log('生命周期：' + bad.length + ' 个阶段失败（' + bad.map((s) => s.id).join(',') + '）');
      } catch (e) { log('生命周期失败（不退出）: ' + (e as Error).message); }
    };
    setTimeout(() => { void tick(); }, 20_000);            // 启动 20 秒后先跑一轮
    setInterval(() => { void tick(); }, 5 * 60_000);       // 之后每 5 分钟看一次"哪些阶段到期"
  }
  // [fork 1011] 逐小时轮转全部收编项目的日志（含 sweep 新收编的）
  const logRotator = setInterval(() => {
    for (const w of workers.values()) rotateLogFile(watchLogPath(w.root));
  }, 3_600_000);
  logRotator.unref();
  log(`全局守护运行中（pid ${process.pid}，项目 ${workers.size}，Ctrl+C 退出）`);
  await new Promise<void>((resolve) => {
    const stop = () => resolve();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  clearInterval(adoptTimer);
  clearInterval(logRotator);
  for (const w of workers.values()) await w.stop();
  releaseGlobalPipeLock();
  log('已退出');
}
