// 原子保存：temp + rename，Windows 下对瞬时错误退避重试。
//
// 为什么必须原子：读者（守护、CLI、看板投影）随时可能读到这个文件。
// 「先清空再写」会让读者读到半个 JSON；rename 在同一个卷上是原子的——读到的要么是旧内容，
// 要么是新内容，不会是中间的某个版本。
//
// 为什么要重试（而且只在 Windows 上真的会用到）：Windows 的 rename 会被**打开着的句柄**
// 挡住（EPERM/EBUSY/EACCES），杀毒/索引进程还可能让目标瞬间 ENOENT。这些都是"等一会儿就好"，
// 不是故障。其余 errno（ENOSPC/EROFS/ENOTDIR…）重试只是延迟报告，所以只退避这四种。
//
// 为什么不 fsync：本契约要的是"读者永远看到完整内容"，不是"断电不丢最后一次写"。
// 每次保存都付一次 fsync 的代价，换不来这个项目需要的东西。

import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { err, ok, type Res } from '../domain/types.js';

/** 最多试这么多次。读者持句柄的时间远小于十次退避的总和（约 450ms）。 */
export const RENAME_MAX_ATTEMPTS = 10;
/** 第 N 次失败后退避 N * 10ms。 */
export const RENAME_BACKOFF_STEP_MS = 10;
/** 只有这些 errno 值得重试（见模块头）。 */
const TRANSIENT_RENAME_CODES: ReadonlySet<string> = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOENT']);

/** 保存路径是同步契约（调用方拿到结果时文件已在盘上），退避也只能同步。 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function errnoOf(e: unknown): string {
  const code = (e as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' ? code : e instanceof Error ? e.message : String(e);
}

/** 失败写留下的 temp 要清掉：留一个 *.tmp 比掩盖原始失败更糟，但清不掉也不掩盖。 */
function discardTemp(tmp: string): void {
  try {
    rmSync(tmp, { force: true });
  } catch {
    // temp 不可达的原因和写失败是同一个，这里再抛只会盖掉真正的错误码
  }
}

/**
 * 把 `contents` 原子写到 `path`。
 *
 * 前置条件：无——父目录不存在会建。
 * 成功后：`path` 恰好是 `contents`，没有 temp 残留。
 * 失败后：`path` **一个字节都没变**（还是旧内容，或仍然不存在），没有 temp 残留。
 *
 * temp 名字带 pid + 随机数：两个写入者抢同一个页时，谁也不会读到对方的半截内容，
 * 也不会把对方的 rename 撞掉（各自 rename 自己那个 temp）。
 */
export function writeFileAtomic(
  path: string,
  contents: string,
  maxAttempts = RENAME_MAX_ATTEMPTS,
): Res<void> {
  const tmp = path + '.' + String(process.pid) + '.' + Math.random().toString(36).slice(2, 10) + '.tmp';
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, contents, 'utf8');
  } catch (e) {
    discardTemp(tmp);
    return err('SAVE_FAILED', '写临时文件失败：' + errnoOf(e), '检查目录权限与磁盘空间', { path, tmp, errno: errnoOf(e) });
  }

  let attempt = 1;
  for (;;) {
    try {
      renameSync(tmp, path);
      return ok(undefined);
    } catch (e) {
      const code = errnoOf(e);
      if (!TRANSIENT_RENAME_CODES.has(code) || attempt >= maxAttempts) {
        discardTemp(tmp);
        return err(
          'SAVE_FAILED',
          '落盘失败（' + code + '，试了 ' + String(attempt) + ' 次）：' + path,
          code === 'EPERM' || code === 'EBUSY' || code === 'EACCES' ? '多半是别的进程正占着这个文件：稍后重试（CLI 退出码 2）' : '检查磁盘与权限',
          { path, errno: code, attempts: attempt },
        );
      }
      sleepSync(attempt * RENAME_BACKOFF_STEP_MS);
      attempt += 1;
    }
  }
}
