// 守护锁（技术方案 T7）：pid + 心跳；僵死 60s 自动接管（Windows 无可靠 ps 的跨平台方案）
import fs from 'node:fs';
import path from 'node:path';
import { lockFile } from './paths.js';

interface LockInfo { pid: number; heartbeat: number; at: string }

function read(root: string): LockInfo | null {
  try {
    return JSON.parse(fs.readFileSync(lockFile(root), 'utf8'));
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: unknown) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'; // EPERM = 存在但无权限
  }
}

/** 守护是否存活：心跳新鲜 且 pid 存活 */
export function isDaemonAlive(root: string, maxAgeMs = 60_000): { alive: boolean; pid?: number; heartbeat?: string } {
  const info = read(root);
  if (!info) return { alive: false };
  const fresh = Date.now() - info.heartbeat < maxAgeMs;
  const alive = fresh && pidAlive(info.pid);
  return { alive, pid: info.pid, heartbeat: new Date(info.heartbeat).toISOString() };
}

export function acquireLock(root: string): { ok: boolean; reason?: string } {
  const cur = isDaemonAlive(root);
  if (cur.alive) return { ok: false, reason: `守护已在运行 (pid ${cur.pid})` };
  fs.mkdirSync(path.dirname(lockFile(root)), { recursive: true });
  fs.writeFileSync(lockFile(root), JSON.stringify(lockBody()));
  return { ok: true };
}

function lockBody(): LockInfo {
  return { pid: process.pid, heartbeat: Date.now(), at: new Date().toISOString() };
}

export function touchLock(root: string): void {
  try {
    const cur = read(root);
    if (cur && cur.pid !== process.pid) return; // 只刷新自己的锁
    fs.writeFileSync(lockFile(root), JSON.stringify(lockBody()));
  } catch { /* 瞬态忽略 */ }
}

export function releaseLock(root: string): void {
  const cur = read(root);
  if (cur && cur.pid !== process.pid) return;
  try { fs.rmSync(lockFile(root), { force: true }); } catch { /* 忽略 */ }
}
