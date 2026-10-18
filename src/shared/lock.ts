// 守护锁（技术方案 T7）：pid + 心跳；**文件锁 4 拍（=60s）**僵死即接管（Windows 无可靠 ps 的跨平台方案）。
//   ⚠️ 别和「注册表心跳」（60s 一拍、3 拍过期 = 180s）搞混 —— 两者节奏不同，判据已拆开，见下方常量块。
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
 * 两套心跳的节奏与过期阈值（**唯一一份**）。
 *
 * ⚠️ [1021 红队复核后**重做**：上一版把两套节奏算混了]
 *   系统里有**两种不同节奏**的心跳，上一版给它们共用一个过期阈值，于是「3 拍」是错的：
 *     ① **项目文件锁**：`capture/watch.ts` 每 **15s** `touchLock`（**无条件定时器**，与有没有活动无关）
 *     ② **注册表心跳**：`capture/watch.ts` 每 **60s** 往 global.sqlite 的 runtime 表写一行
 *   把 180s 同时套在两者上 ⇒ 对文件锁是 **12 拍**而非 3 拍，
 *   「进程活着但卡死」的接管时延从 60s 被悄悄抬到 180s（**3 倍回归**，红队实测指出）。
 *
 *   现在拆开：
 *     · 文件锁 15s/拍、**4 拍**过期 = 60s（保持原接管时延，不回归）
 *     · 注册表 60s/拍、**3 拍**过期 = 180s（容忍连丢两拍；实测历史最长阶段 2336ms、整轮约 5s，不会误报）
 */
export const LOCK_TOUCH_MS = 15_000;
export const LOCK_STALE_MS = LOCK_TOUCH_MS * 4;
export const REGISTRY_HEARTBEAT_MS = 60_000;
export const REGISTRY_STALE_MS = REGISTRY_HEARTBEAT_MS * 3;

/**
 * 注册表心跳是否还算新鲜 —— **判据是函数，不是常量**。
 *
 * 为什么必须是函数：上一版只统一了数字，`core/lifecycle/runner.ts` 里还留着一句
 * `hbAge < 15 * 60_000`（**第三套**阈值）。红队实测同一份输入（心跳 246s）得到两个相反结论：
 *   面板 = 离线 / 生命周期 = 「守护在线，本轮交给它」
 * ⇒ **守护真死后的 3~15 分钟窗口里，谁都不去采集**。
 * 只要判据散在各处自己写比较式，就一定还会再分叉一次；所以这里只暴露函数，调用方不许再写比较式。
 */
export function registryHeartbeatFresh(ageMs: number | null | undefined): boolean {
  return typeof ageMs === 'number' && Number.isFinite(ageMs) && ageMs < REGISTRY_STALE_MS;
}

/** 守护是否存活：**文件锁**新鲜 且 pid 存活（用 LOCK_STALE_MS，不是注册表那套） */
export function isDaemonAlive(root: string, maxAgeMs = LOCK_STALE_MS): { alive: boolean; pid?: number; heartbeat?: string } {
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
