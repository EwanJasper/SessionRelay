import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hatchMapFromKanban } from '../../src/cli/map.js';

/**
 * 地图开工档位（map.hatch）—— 用户原话：「设一次永久生效」。
 *
 * 三档：always（默认，与加这个开关之前逐字等价）/ complex（行数够了才建）/ manual（从不自动建）。
 *
 * 为什么默认必须是 always：改默认值等于改所有已有项目的行为。这条自动孵化已经在 7 个真实项目上
 *   跑过、没人抱怨噪音，凭「我觉得小项目不需要图」去改默认，是拿别人的工作流替自己的判断买单。
 *   想省噪音的人自己设 complex —— 开关是给选择，不是给强加。
 */
const proj = (rows: string[], cfg?: unknown): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'srelay-hatch-'));
  const lines = ['| 任务 | 状态 | 模块 | 明细 |', '|---|---|---|---|'];
  rows.forEach((r, i) => lines.push('| ' + r + ' | ✅ | core | 第' + (i + 1) + '行 |'));
  fs.writeFileSync(path.join(dir, 'progress.md'), lines.join('\n'));
  if (cfg !== undefined) {
    fs.mkdirSync(path.join(dir, '.sessionrelay'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.sessionrelay', 'config.json'), JSON.stringify(cfg));
  }
  return dir;
};
const mapExists = (dir: string) => fs.existsSync(path.join(dir, '.sessionrelay', 'map', 'map.json'));

describe('地图开工档位', () => {
  it('默认（没配 map.hatch）= always：照常孵化', () => {
    const d = proj(['甲', '乙']);
    const r = hatchMapFromKanban(d);
    expect(r.ok).toBe(true);
    expect(mapExists(d)).toBe(true);
  });

  it('manual ⇒ 一行都不读、一张图都不建', () => {
    const d = proj(['甲', '乙'], { map: { hatch: 'manual' } });
    const r = hatchMapFromKanban(d);
    expect(r.ok).toBe(false);
    expect(r.note).toContain('manual');
    expect(mapExists(d)).toBe(false);
  });

  it('complex + 行数不够 ⇒ 不建（这正是用户要的「小项目不打扰」）', () => {
    const d = proj(['甲', '乙'], { map: { hatch: 'complex', complex_min_rows: 5 } });
    const r = hatchMapFromKanban(d);
    expect(r.ok).toBe(false);
    expect(r.note).toContain('complex');
    expect(mapExists(d)).toBe(false);
  });

  it('complex + 行数达标 ⇒ 建', () => {
    const d = proj(['甲', '乙', '丙', '丁', '戊'], { map: { hatch: 'complex', complex_min_rows: 5 } });
    const r = hatchMapFromKanban(d);
    expect(r.ok).toBe(true);
    expect(mapExists(d)).toBe(true);
  });

  it('不认识的档位值 ⇒ 退回 always（配置写错不该让自动孵化停摆）', () => {
    const d = proj(['甲'], { map: { hatch: 'whatever' } });
    expect(hatchMapFromKanban(d).ok).toBe(true);
  });

  it('complex_min_rows 非法值（0 / 负数 / NaN）不许变成「门槛=0」', () => {
    // 变成 0 等于把 complex 悄悄降级成 always —— 用户设了等于没设。
    for (const bad of [0, -3, 'abc']) {
      const d = proj(['甲'], { map: { hatch: 'complex', complex_min_rows: bad } });
      expect(hatchMapFromKanban(d).ok, String(bad)).toBe(false);
    }
  });
});
