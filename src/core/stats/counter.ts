// 本地匿名计数器（方针 §15.5 / D15 / 技术方案 T17）：
// 零外呼红线——只落本地 stats.json，仅事件名计数，无任何内容/路径/项目名。
import fs from 'node:fs';
import path from 'node:path';
import { statsFile } from '../../shared/paths.js';

export type StatsEvent =
  | 'install' | 'init_done' | 'backfill_done' | 'first_hit'
  | 'cli_search' | 'cli_show' | 'mcp_search' | 'mcp_detail'
  | 'export_pkg' | 'import_pkg'
  | 'blocked_by_ignore' | 'resumed' | 'confirmed' | 'manual_save'; // 后三个为内部健康事件，报告时可剔除

export class StatsCounter {
  constructor(private file: string) {}

  increment(ev: StatsEvent, n = 1): void {
    const snap = this.snapshot();
    snap[ev] = (snap[ev] ?? 0) + n;
    this.write(snap);
  }

  snapshot(): Record<string, number> {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return {};
    }
  }

  reset(): void {
    this.write({});
  }

  /** 自愿提交用匿名报告（方针 §15.5）：只含事件计数 */
  reportText(): string {
    const snap = this.snapshot();
    const lines = Object.entries(snap).sort().map(([k, v]) => `${k}: ${v}`);
    return ['sessionrelay-stats-v1 (匿名事件计数，可自愿提交到官方讨论区)', ...lines].join('\n');
  }

  private write(snap: Record<string, number>): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(snap, null, 2));
    // [fork 1011] rename 目标偶发被外部句柄占住（AV 实时扫描 / 并发 CLI 计数），
    // EPERM 丢本周期计数（状态面板计数陈旧，watch.log 反复报错）。短同步退避
    // 重试两次；仍失败则静默放弃本周期——下一周期 overwrite tmp 自愈，不打断守护。
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(tmp, this.file);
        return;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code ?? '';
        if (attempt >= 2 || !['EPERM', 'EACCES', 'EBUSY'].includes(code)) return;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
      }
    }
  }
}

export function openStats(root: string): StatsCounter {
  return new StatsCounter(statsFile(root));
}
