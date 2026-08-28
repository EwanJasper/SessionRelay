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
    const items = [...pending];
    pending.clear();
    for (const f of items) cb(f);
  };
  const onEvent = (file: string) => {
    pending.add(file);
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, debounceMs);
  };

  let watcher: fs.FSWatcher | null = null;
  let pollTimer: NodeJS.Timeout | null = null;

  try {
    watcher = fs.watch(dir, { recursive: true }, (_ev, filename) => {
      if (!filename) return;
      onEvent(path.join(dir, filename.toString()));
    });
  } catch {
    // Linux 递归不支持 → mtime 轮询兜底（技术方案 §9.1）
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
  }

  return {
    close() {
      watcher?.close();
      if (pollTimer) clearInterval(pollTimer);
      if (timer) clearTimeout(timer);
    },
  };
}
