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
import { openExisting } from '../store/db.js';
import type { RelayConfig } from '../shared/config.js';
import { loadConfig } from '../shared/config.js';
import { projectIdOf, dbFile, statsFile, watchLogPath } from '../shared/paths.js';
import { rotateLogFile } from '../shared/logrotate.js';
import { StatsCounter } from '../core/stats/counter.js';
import { acquireLock, touchLock, releaseLock, isDaemonAlive } from '../shared/lock.js';
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

  // [fork 1010] 防孤儿：启动 shell 退出时本实例随之退出。agent 后台命令拉起的
  // project 模式 watch 曾无限期存活（父 shell 早已不在），与全局守护抢锁。
  let orphanTimer: NodeJS.Timeout | undefined;
  if (!opts.inGlobalDaemon && process.ppid > 0) {
    const launcher = process.ppid;
    orphanTimer = setInterval(() => {
      try {
        process.kill(launcher, 0);
      } catch {
        log('启动器进程已退出，本实例退出（防孤儿）');
        clearInterval(orphanTimer);
        releaseLock(root);
        releasePipeLock(root);
        process.exit(0);
      }
    }, 15_000);
  }

  const heartbeat = setInterval(() => touchLock(root), 15_000);
  const db = openExisting(dbFile(root));
  const projectId = opts.config.identity.project_id ?? projectIdOf(root);

  let chain: Promise<void> = Promise.resolve(); // 串行化所有写周期（T23 的进程内体现）
  // [fork 0922] 接通本地匿名计数器：守护侧的 ignore 拦截/resumed/confirmed 原来从不计数，
  // status 面板"拦截 0 次"与实际不符
  const stats = new StatsCounter(statsFile(root));
  const cycle = (why: string) => {
    chain = chain.then(async () => {
      try {
        const s = await runSync({ projectRoot: root, config: opts.config, db, stats });
        const spool = consumeHookEvents(root, db, new Date()); // R4：hook 事件 → 立即转 pending
        const j = runJudge(db, { projectId, now: new Date(), idleMin: opts.config.capture.idle_threshold_min, cooldownH: opts.config.capture.cooldown_hours, stats });
        if (s.newMessages > 0 || s.resumed > 0 || j.confirmed > 0 || spool.endSignals > 0 || why !== 'tick') {
          log(`${why}: +${s.newMessages} 消息 · resumed ${s.resumed} · pending ${j.toPending} · confirmed ${j.confirmed}${spool.endSignals ? ` · hook信号 ${spool.endSignals}` : ''}`);
        }
        // 语义 digest（design-semantic §3.2）：confirmed 且无向量的会话限量补嵌，CPU 友好
        const { digestSemantic } = await import('../search-svc/semantic.js');
        await digestSemantic(db, opts.config, { projectId, limit: 20 });
      } catch (e) {
        log(`周期失败（不退出）: ${(e as Error).message}`);
      }
    });
    return chain;
  };

  const watchers: Array<{ close(): void }> = [];
  const judgeTimer = setInterval(() => cycle('tick'), 30_000);
  const safetyTimer = setInterval(() => cycle('safety'), 60_000);

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
            log(`自动归档：workflow ${r.workflowArchived} · 普通 ${r.hotArchived} · 释放 ${r.freedPages} 页${r.vacuumEnabled ? '（已启用增量式 VACUUM）' : ''}`);
          }
        } catch (e) {
          log(`自动归档失败（不退出，下周期重试）: ${(e as Error).message}`);
        }
      });
    };
    runAuto();
    archiveTimer = setInterval(runAuto, archivePolicy.checkEveryMin * 60_000);
    archiveTimer.unref();
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
  let stopped = false;

  try {
    await cycle('initial');
    // 改动 1：从注册表获取各源的监听目录（不再硬编码）
    ensureRegistered(root);
    const roots = new Set<string>();
    for (const s of opts.config.capture.sources) {
      const adapter = get(s);
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
    // [fork 0922] worker 初始化失败：释放已持资源并报告 null（全局模式下跳过该项目，不拖垮进程）
    if (orphanTimer) clearInterval(orphanTimer);
    if (archiveTimer) clearInterval(archiveTimer);
    if (recomputeTimer) clearInterval(recomputeTimer);
    clearInterval(heartbeat); clearInterval(judgeTimer); clearInterval(safetyTimer);
    releasePipeLock(root);
    log(`守护启动失败（${root}）: ${(e as Error).message}`);
    return null;
  }

  return {
    root,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      if (orphanTimer) clearInterval(orphanTimer);
      if (archiveTimer) clearInterval(archiveTimer);
      if (recomputeTimer) clearInterval(recomputeTimer);
      for (const w of watchers) w.close();
      clearInterval(heartbeat); clearInterval(judgeTimer); clearInterval(safetyTimer);
      await chain.catch(() => {});
      db.close();
      releaseLock(root);
      releasePipeLock(root);
      log('已退出');
    },
  };
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
  // [fork 1011] 启动即轮转一次：双写让每个收编项目的 watch.log 都会增长，
  // 原轮转只覆盖 cwd 根，其余项目日志无限堆积（实测 D 33.7MB / E 7.4MB）。
  for (const w of workers.values()) rotateLogFile(watchLogPath(w.root));
  const adoptTimer = setInterval(() => { void adopt('sweep'); }, 10 * 60_000);
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
