// 目录监听（技术方案 §1.2）：fs.watch 递归（win/mac 原生支持）+ 轮询兜底（Linux 无递归 watch）。
// 去抖：窗口期内合并同文件多次事件，一次性派发（技术方案 §5.1 Debounce 500ms）。
import fs from 'node:fs';
import path from 'node:path';

export interface WatchHandle {
  close(): void;
}

export function watchDir(
  dir: string,
  cb: (file: string) => void,
  debounceMs = 500,
): WatchHandle {
  let timer: NodeJS.Timeout | null = null;
  const pending = new Set<string>();
  const flush = () => {
    timer = null; // 清引用，防止 close() 时 clearTimeout 已执行的 timer
    const items = [...pending];
    pending.clear();
    for (const f of items) cb(f);
  };
  const onEvent = (file: string) => {
    pending.add(file);
    // 合并去抖：已有 timer 时不重建（高频事件下避免句柄泄漏）
    if (!timer) timer = setTimeout(flush, debounceMs);
  };

  let watcher: fs.FSWatcher | null = null;
  let pollTimer: NodeJS.Timeout | null = null;

  // [fork 0922] 轮询兜底提为函数：原本只在 fs.watch 同步创建失败（Linux）时进入，
  // 但运行中的 error 事件（目录被删/句柄溢出/杀软干扰）无人监听会让 EventEmitter
  // 直接 throw——全局守护一死全部项目捕获停摆。error 时降级轮询自愈。
  const startPolling = () => {
    if (pollTimer) return;
    const snap = new Map<string, number>();
    const scan = () => {
      try {
        const entries = fs.readdirSync(dir, { recursive: true, withFileTypes: false }) as string[];
        for (const rel of entries) {
          const full = path.join(dir, rel);
          let st: fs.Stats;
          try {
            st = fs.statSync(full);
          } catch {
            continue;
          }
          if (!st.isFile()) continue;
          const prev = snap.get(full);
          if (prev !== undefined && prev !== st.mtimeMs) onEvent(full);
          snap.set(full, st.mtimeMs);
        }
      } catch {
        /* 目录消失等瞬态忽略 */
      }
    };
    scan(); // 建立基线
    pollTimer = setInterval(scan, 1000);
  };

  try {
    watcher = fs.watch(dir, { recursive: true }, (_ev, filename) => {
      if (!filename) return;
      onEvent(path.join(dir, filename.toString()));
    });
    watcher.on('error', () => {
      try { watcher?.close(); } catch { /* 已关 */ }
      watcher = null;
      startPolling(); // 事件流断了就退化为 1s 轮询，捕获不断线
    });
  } catch {
    startPolling();
  }

  return {
    close() {
      watcher?.close();
      if (pollTimer) clearInterval(pollTimer);
      if (timer) clearTimeout(timer);
    },
  };
}
