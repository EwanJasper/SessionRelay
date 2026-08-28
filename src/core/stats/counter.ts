// 本地匿名计数器（方针 §15.5 / D15 / 技术方案 T17）：
// 零外呼红线——只落本地 stats.json，仅事件名计数，无任何内容/路径/项目名。
import fs from 'node:fs';
import path from 'node:path';
import { statsFile } from '../../shared/paths.js';

export type StatsEvent =
  | 'install' | 'init_done' | 'backfill_done' | 'first_hit'
  | 'cli_search' | 'cli_show' | 'mcp_search' | 'mcp_detail'
  | 'export_pkg' | 'import_pkg'
  | 'blocked_by_ignore' | 'resumed' | 'confirmed'; // 后三个为内部健康事件，报告时可剔除

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
    fs.renameSync(tmp, this.file); // 原子替换
  }
}

export function openStats(root: string): StatsCounter {
  return new StatsCounter(statsFile(root));
}
