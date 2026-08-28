// watch 守护（技术方案 §5.5 / 改进方案 改动1 注册表化）
import path from 'node:path';
import { openExisting } from '../store/db.js';
import type { RelayConfig } from '../shared/config.js';
import { projectIdOf, dbFile } from '../shared/paths.js';
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

export async function runWatch(opts: WatchOptions): Promise<void> {
  const root = opts.projectRoot;
  const log = opts.log ?? ((m: string) => process.stderr.write(`[srelay-watch] ${m}\n`));

  const lock = acquireLock(root);
  if (!lock.ok) {
    const alive = isDaemonAlive(root);
    log(lock.reason + (alive.alive ? '' : '（锁已僵死，本次接管）'));
    if (alive.alive) return;
  }

  const heartbeat = setInterval(() => touchLock(root), 15_000);
  const db = openExisting(dbFile(root));
  const projectId = opts.config.identity.project_id ?? projectIdOf(root);

  let chain: Promise<void> = Promise.resolve(); // 串行化所有写周期（T23 的进程内体现）
  const cycle = (why: string) => {
    chain = chain.then(async () => {
      try {
        const s = await runSync({ projectRoot: root, config: opts.config, db });
        const spool = consumeHookEvents(root, db, new Date()); // R4：hook 事件 → 立即转 pending
        const j = runJudge(db, { projectId, now: new Date(), idleMin: opts.config.capture.idle_threshold_min, cooldownH: opts.config.capture.cooldown_hours });
        if (s.newMessages > 0 || s.resumed > 0 || j.confirmed > 0 || spool.endSignals > 0 || why !== 'tick') {
          log(`${why}: +${s.newMessages} 消息 · resumed ${s.resumed} · pending ${j.toPending} · confirmed ${j.confirmed}${spool.endSignals ? ` · hook信号 ${spool.endSignals}` : ''}`);
        }
      } catch (e) {
        log(`周期失败（不退出）: ${(e as Error).message}`);
      }
    });
    return chain;
  };

  const watchers: Array<{ close(): void }> = [];
  const judgeTimer = setInterval(() => cycle('tick'), 30_000);
  const safetyTimer = setInterval(() => cycle('safety'), 60_000);

  try {
    await cycle('initial');
    // 改动 1：从注册表获取各源的监听目录（不再硬编码）
    ensureRegistered(root);
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
    log(`守护运行中（pid ${process.pid}，Ctrl+C 退出）`);
    await new Promise<void>((resolve) => {
      const stop = () => resolve();
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    });
  } finally {
    for (const w of watchers) w.close();
    clearInterval(heartbeat);
    clearInterval(judgeTimer);
    clearInterval(safetyTimer);
    await chain.catch(() => {});
    db.close();
    releaseLock(root);
    log('已退出');
  }
}
