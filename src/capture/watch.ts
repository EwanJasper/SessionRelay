// watch 守护（技术方案 §5.5 / 改进方案 改动1 注册表化）
// [fork 0922] 三项强化：
//   ① 每项目命名管道单实例锁——上游 #2 实例堆积根治（原 acquireLock 先查后写非原子，
//     并发 spawn 同秒全过；管道是内核对象随进程死亡自动消失，EADDRINUSE 即活实例）
//   ② runWatch 拆出 startWatchWorker（可停的 worker），为 --global 复用
//   ③ --global 全局守护：一个进程看管项目注册表里的全部项目，sweep 动态收编/移除
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { openExisting } from '../store/db.js';
import type { RelayConfig } from '../shared/config.js';
import { projectIdOf, dbFile, statsFile } from '../shared/paths.js';
import { StatsCounter } from '../core/stats/counter.js';
import { acquireLock, touchLock, releaseLock, isDaemonAlive } from '../shared/lock.js';
import { watchDir } from '../adapters/claude-code/watcher.js';
import { runSync } from './sync.js';
import { runJudge } from './judge.js';
import { consumeHookEvents } from './hook-spool.js';
import { ensureRegistered, get, adapterConfig } from '../adapters/registry.js';

export interface WatchOptions {
  projectRoot: string;
  config: RelayConfig;
  log?: (msg: string) => void;
}

// ── [fork 0922] 每项目命名管道单实例锁 ──
const pipeLockServers = new Map<string, net.Server>();

function pipeLockName(root: string): string {
  // 反斜杠经 String.fromCharCode 构造，杜绝转义层吃反斜杠；小写归一 + sha1 前 16 位
  const BS = String.fromCharCode(92);
  const h = crypto.createHash('sha1').update(path.resolve(root).toLowerCase()).digest('hex').slice(0, 16);
  return BS + BS + '.' + BS + 'pipe' + BS + 'srelay-watch-' + h;
}

function acquirePipeLock(root: string, log: (m: string) => void): Promise<boolean> {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') { resolve(true); return; } // 非 Windows 走原文件锁
    const srv = net.createServer();
    srv.once('error', (e: NodeJS.ErrnoException) => {
      if (e && e.code === 'EADDRINUSE') {
        log(`管道锁被占（另一守护在跑），本实例退出: ${pipeLockName(root)}`);
        resolve(false);
      } else resolve(true); // 管道不可用 → 降级回文件锁语义
    });
    srv.listen(pipeLockName(root), () => {
      pipeLockServers.set(path.resolve(root).toLowerCase(), srv);
      resolve(true);
    });
  });
}

function releasePipeLock(root: string): void {
  const key = path.resolve(root).toLowerCase();
  const srv = pipeLockServers.get(key);
  if (srv) {
    try { srv.close(); } catch { /* 进程退出内核同样回收 */ }
    pipeLockServers.delete(key);
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

  if (!(await acquirePipeLock(root, log))) return null; // [fork 0922] 同项目已有守护在跑

  const lock = acquireLock(root);
  if (!lock.ok) {
    const alive = isDaemonAlive(root);
    log(lock.reason + (alive.alive ? '' : '（锁已僵死，本次接管）'));
    if (alive.alive) { releasePipeLock(root); return null; }
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
        const j = runJudge(db, { projectId, now: new Date(), idleMin: opts.config.capture.idle_threshold_min, cooldownH: opts.config.capture.cooldown_hours });
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
