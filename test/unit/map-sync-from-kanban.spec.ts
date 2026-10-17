import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hatchMapFromKanban, syncMapFromKanban } from '../../src/cli/map.js';
import { readPageIfExists } from '../../src/map/index.js';

/**
 * 看板 → 地图增量同步（2026-10-18）。
 *
 * 病根：地图建好之后**没有任何路径能让它变** —— hatch 只管「还没有地图」，
 *   upgrade 只管「单层孵化图」，两者对「已有地图 + 看板新增了行」都返回不动。
 *   于是 progress.md 里新写的事永远进不了图，用户看到的就是「标签和节点一直那样」。
 */
const kanban = (rows) => {
  const lines = ['| 任务 | 状态 | 模块 | 明细 |', '|---|---|---|---|'];
  for (const pair of rows) lines.push('| ' + pair[0] + ' | ' + pair[1] + ' | core | - |');
  return lines.join('\n');
};
const mk = (rows) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'srelay-sync-'));
  fs.writeFileSync(path.join(dir, 'progress.md'), kanban(rows));
  return dir;
};
const pageOf = (dir) => {
  const r = readPageIfExists(dir);
  return r.ok ? r.value : undefined;
};

describe('看板 → 地图增量同步', () => {
  it('没有地图时什么也不做（首次建图归孵化器）', () => {
    const d = mk([['甲', '✅']]);
    const r = syncMapFromKanban(d);
    expect(r.ok).toBe(false);
    expect(r.note).toContain('孵化');
  });

  it('★ 看板新增一行 ⇒ 图里多一个节点（这就是「刷新」）', () => {
    const d = mk([['甲', '✅']]);
    hatchMapFromKanban(d);
    const before = pageOf(d).page.nodes.length;
    fs.writeFileSync(path.join(d, 'progress.md'), kanban([['甲', '✅'], ['新事', '🔄']]));
    const r = syncMapFromKanban(d);
    expect(r.ok).toBe(true);
    expect(r.added).toBe(1);
    expect(pageOf(d).page.nodes.length).toBe(before + 1);
  });
  it('★ 新节点落进收件箱层，且不改动已有层的 rank', () => {
    const d = mk([['甲', '✅']]);
    hatchMapFromKanban(d);
    const ranksBefore = pageOf(d).page.layers.map((l) => l.id + '@' + l.rank).join(',');
    fs.writeFileSync(path.join(d, 'progress.md'), kanban([['甲', '✅'], ['新事', '🔄']]));
    syncMapFromKanban(d);
    const page = pageOf(d).page;
    const added = page.nodes.find((n) => n.label === '新事');
    expect(added.layer).toBe('inbox');
    expect(page.layers.some((l) => l.id === 'inbox')).toBe(true);
    const kept = page.layers.filter((l) => l.id !== 'inbox').map((l) => l.id + '@' + l.rank).join(',');
    expect(kept).toBe(ranksBefore);
  });

  it('看板状态变了 ⇒ 图里节点状态跟着变（而不只是新增）', () => {
    const d = mk([['甲', '🔄 进行中']]);
    hatchMapFromKanban(d);
    fs.writeFileSync(path.join(d, 'progress.md'), kanban([['甲', '✅ 完成']]));
    const r = syncMapFromKanban(d);
    expect(r.statusFixed).toBe(1);
    expect(pageOf(d).page.nodes.find((n) => n.label === '甲').status).toBe('done');
  });

  it('★ 看板行消失 ⇒ 不删节点（删是人的决定）', () => {
    const d = mk([['甲', '✅'], ['乙', '✅']]);
    hatchMapFromKanban(d);
    fs.writeFileSync(path.join(d, 'progress.md'), kanban([['甲', '✅']]));
    syncMapFromKanban(d);
    expect(pageOf(d).page.nodes.map((n) => n.label)).toContain('乙');
  });

  it('与看板一致时返回「与看板一致」且不写盘（revision 不变）', () => {
    const d = mk([['甲', '✅']]);
    hatchMapFromKanban(d);
    const revBefore = pageOf(d).revision;
    const r = syncMapFromKanban(d);
    expect(r.ok).toBe(true);
    expect(r.added).toBe(0);
    expect(r.statusFixed).toBe(0);
    expect(pageOf(d).revision).toBe(revBefore);
  });
});
