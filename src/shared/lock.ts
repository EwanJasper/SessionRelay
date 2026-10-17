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

/**
 * 心跳周期与判活阈值（**唯一一份**，守护/面板/CLI 全读这里）。
 *
 * ── [1021 修「面板瞬时报离线」] 原来是两个各写一遍的数：
 *     · 守护每 **60s** 写一次心跳（watch.ts 的 setInterval）
 *     · `isDaemonAlive` 默认阈值也是 **60s**
 *     · 而面板 `watchdogOnline` 用的是 **15 分钟**
 *   前两个卡在边缘 ⇒ 只要某轮 GC 慢一点、或安全周期(capture/archive)占住事件循环，
 *   锁就会**刚好过期**，面板闪一下「离线」再自己好回来。而三个判据互相差 15 倍，
 *   排查时根本说不清「到底算不算活着」。
 *
 *   现在：阈值 = **3 个心跳周期**（180s），能容忍连丢两拍而不误判；
 *   面板与 CLI 读同一个常量 —— **判据只许有一份**。
 */
export const HEARTBEAT_MS = 60_000;
export const DAEMON_STALE_MS = HEARTBEAT_MS * 3;

/** 守护是否存活：心跳新鲜 且 pid 存活 */
export function isDaemonAlive(root: string, maxAgeMs = DAEMON_STALE_MS): { alive: boolean; pid?: number; heartbeat?: string } {
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
