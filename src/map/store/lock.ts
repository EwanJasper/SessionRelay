// 页级独占锁：openSync(wx) + 僵尸兜底。
//
// 为什么用 openSync(…, 'wx')（= O_CREAT|O_EXCL）：内核保证"创建即独占"，是**原子**判定，
// 不靠先查后写的时序。抢不到就是有人正持有 → 返回 BUSY（可重试），**不是异常**：
// 两个守护同时刷是正常现象，把正常现象做成异常，就会有人为了让日志干净去 catch 掉它。
//
// 为什么锁文件不删掉而是每次重建：删掉的文件再创建，另一个进程可能正握着"已被删除的那个 inode"，
// 于是两边都以为自己持锁。每次都是新的 openSync 创建，判定才始终落在同一个路径上。
//
// 僵尸兜底（10s）：持锁进程崩了不该留下永久死锁。判据只有 mtime 一条——超过 staleMs 就清掉。
// 为什么敢这么粗暴：一次 apply 是毫秒级（读一个 JSON、改内存、原子 rename），
// 10s 只可能是"持锁的人已经死了"。清了之后仍然是 openSync(wx) 定胜负，没有仁慈判定。
//
// 为什么不移植 mellos 的 N-API 锁：那是跨进程协作的大锁（项目级）；这里要的只是
// 「同一个页文件、极短持有」——与 kanban.ts 的 withKanbanLock 同一思路，不引原生依赖。

import { closeSync, mkdirSync, openSync, rmSync, statSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { err, type Res } from '../domain/types.js';
import { errnoOf } from './atomic.js';

/** 超过这个时长没动静的锁按僵尸处理（毫秒）。 */
export const MAP_LOCK_STALE_MS = 10_000;

export function lockPathOf(file: string): string {
  return file + '.lock';
}

/**
 * 在独占锁下执行 `fn`。
 *
 * @param file - 被保护的文件（锁文件是 `<file>.lock`）。页与页之间互不阻塞：一个页一个文件一个锁。
 * @param fn - 临界区，返回统一的 Res；它的错误原样透出（锁不改变动作的结论）。
 * @returns fn 的结果，或 BUSY / LOCK_UNAVAILABLE。
 */
export function withMapLock<T>(
  file: string,
  fn: () => Res<T>,
  opts: { staleMs?: number } = {},
): Res<T> {
  const staleMs = opts.staleMs ?? MAP_LOCK_STALE_MS;
  const lock = lockPathOf(file);
  try {
    mkdirSync(dirname(lock), { recursive: true });
  } catch (e) {
    return err('LOCK_UNAVAILABLE', '建不了地图目录 ' + dirname(lock) + '：' + errnoOf(e), '检查目录权限');
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const st = statSync(lock, { throwIfNoEntry: false });
    if (st !== undefined && Date.now() - st.mtimeMs > staleMs) {
      try {
        rmSync(lock, { force: true });
      } catch {
        // 别人先清掉了，或它刚刚被重新创建：下面的 openSync 会给出结论，这里不猜
      }
    }
    let fd: number;
    try {
      fd = openSync(lock, 'wx', 0o600);
    } catch (e) {
      const code = errnoOf(e);
      if (code === 'EEXIST') {
        if (attempt === 0) continue; // 可能是刚清掉的僵尸，第二轮再判一次
        return err(
          'BUSY',
          '另一个写入者正持有 ' + lock,
          'busy 是可重试的（CLI 退出码 2）：稍后重跑；或在 10s 后重试（那时僵尸锁会被兜底清掉）',
          { lock },
        );
      }
      return err('LOCK_UNAVAILABLE', '抢锁失败（' + code + '）：' + lock, '确认地图目录可写', { lock, errno: code });
    }
    try {
      writeSync(fd, String(process.pid));
    } catch {
      // pid 只用于排障；写不进去不影响互斥本身
    } finally {
      try {
        closeSync(fd);
      } catch {
        // 关不掉也不影响：进程退出时内核会释放
      }
    }
    try {
      return fn();
    } finally {
      try {
        rmSync(lock, { force: true });
      } catch {
        // 被僵尸兜底清掉过，或路径已被换掉：锁已经不在，目的达成
      }
    }
  }
  /* istanbul ignore next —— 两轮之内必然有结论（返回或返回 BUSY） */
  return err('BUSY', '抢不到 ' + lock, '稍后重试');
}
