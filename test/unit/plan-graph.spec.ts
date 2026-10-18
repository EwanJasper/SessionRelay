import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildPlanLayout, layerIdOfRank, parseDepText,
} from '../../src/map/plan-graph.js';
import { readDepColumn } from '../../src/cli/kanban.js';

/**
 * 地图层 · 依赖列 → 分层 + 真边。
 *
 * 为什么这批测试值得写：自动孵化出来的图是单层的，而地图不变式要求边**严格跨层向下**
 *   ⇒ 单层图一条边都加不了。「建边」的真正前提是「先分层」，所以这里的判据错一条，
 *   要么孵出一张永远没边的图，要么孵出一张带假边的图 —— 后者更糟。
 *
 * 三条纪律各配一条测试：匹配不上不建边 / 认不准不建边 / 有环整体拒绝。
 */

const noMeta = new Map();
const done = (id: string) => [id, { status: 'done' }] as const;

describe('parseDepText', () => {
  it('空白写法都算无依赖（无 / - / 空 / N/A 大小写）', () => {
    for (const t of ['', '  ', '无', '-', '——', 'N/A', 'n/a', 'none', '暂无']) {
      expect(parseDepText(t).frags, t).toEqual([]);
    }
  });

  it('逗号/顿号/斜杠/分号都当分隔符，且丢掉单字噪声', () => {
    expect(parseDepText('db.ts, index.js、extract.ts；map.ts').frags)
      .toEqual(['db.ts', 'index.js', 'extract.ts', 'map.ts']);
    // 空格**不是**分隔符：中文任务名带空格是常态（「地图 依赖列」是一件事，不是两件）
    expect(parseDepText('地图 依赖列').frags).toEqual(['地图 依赖列']);
    // 单字片段在这里保留下来，由 matchNodes 把关（只认完全同名）
    expect(parseDepText('乙').frags).toEqual(['乙']);
  });

  it('「上方全部 ✅ 项」认成相对表达，不当成名字去匹配', () => {
    expect(parseDepText('上方全部 ✅ 项')).toEqual({ frags: [], upAll: true });
    expect(parseDepText('以上所有项').upAll).toBe(true);
    expect(parseDepText('上方某个具体东西').upAll).toBe(false);
  });
});

describe('buildPlanLayout · 分层与方向', () => {
  it('一条依赖都没有 ⇒ 单层 plan + 0 边（保守：不为有边而造边）', () => {
    const r = buildPlanLayout([
      { id: 'n1', label: 'A', dep: '无' },
      { id: 'n2', label: 'B', dep: '' },
    ], noMeta);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.layout.edges).toEqual([]);
    expect(r.layout.layers.map((l) => l.id)).toEqual(['plan']);
    expect(r.layout.nodes.every((n) => n.layer === 'plan')).toBe(true);
  });

  it('A 依赖 B ⇒ 两层，边 A→B 严格向下（from 的 rank 必须大于 to）', () => {
    const r = buildPlanLayout([
      { id: 'n1', label: '接入检索', dep: '建索引' },
      { id: 'n2', label: '建索引', dep: '无' },
    ], noMeta);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.layout.edges).toEqual([{ from: 'n1', to: 'n2' }]);
    const rankOf = (id: string) => r.layout.layers.find((l) => l.id === id)!.rank;
    const byId = new Map(r.layout.nodes.map((n) => [n.id, n]));
    const from = byId.get('n1')!;
    const to = byId.get('n2')!;
    expect(rankOf(from.layer)).toBeGreaterThan(rankOf(to.layer));
    expect(from.layer).toBe('plan-1');
    expect(to.layer).toBe('plan');
  });

  it('三段链 ⇒ 三层，最长路径定层（跨层边也合法，只要严格向下）', () => {
    const r = buildPlanLayout([
      { id: 'n1', label: '做界面', dep: '接入检索' },
      { id: 'n2', label: '接入检索', dep: '建索引' },
      { id: 'n3', label: '建索引', dep: '' },
    ], noMeta);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.layout.layers.map((l) => l.rank)).toEqual([0, 1, 2]);
    const byId = new Map(r.layout.nodes.map((n) => [n.id, n]));
    expect([byId.get('n1')!.layer, byId.get('n2')!.layer, byId.get('n3')!.layer])
      .toEqual(['plan-2', 'plan-1', 'plan']);
    expect(r.layout.edges).toEqual([{ from: 'n1', to: 'n2' }, { from: 'n2', to: 'n3' }]);
  });

  it('自引用不会生出自环（自己不算自己的依赖）', () => {
    const r = buildPlanLayout([{ id: 'n1', label: '建索引', dep: '建索引' }], noMeta);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.layout.edges).toEqual([]);
  });
});

describe('buildPlanLayout · 三条纪律', () => {
  it('纪律①：片段指不到任何节点 ⇒ 不建边，但原样报进 unresolved', () => {
    const r = buildPlanLayout([
      { id: 'n1', label: '接入检索', dep: '一个根本不存在的模块' },
      { id: 'n2', label: '建索引', dep: '' },
    ], noMeta);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.layout.edges).toEqual([]);
    expect(r.layout.unresolved).toEqual(['接入检索 ← 一个根本不存在的模块']);
  });

  it('纪律②：一个片段命中多个节点 ⇒ 放弃这条，报进 ambiguous', () => {
    const r = buildPlanLayout([
      { id: 'n1', label: '上层', dep: '索引' },
      { id: 'n2', label: '建索引 A', dep: '' },
      { id: 'n3', label: '建索引 B', dep: '' },
    ], noMeta);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.layout.edges).toEqual([]);
    expect(r.layout.ambiguous.length).toBe(1);
    expect(r.layout.ambiguous[0]).toContain('命中 2 个');
  });

  it('纪律③：依赖绕成环 ⇒ 整体拒绝，且环上报出来（不悄悄丢边）', () => {
    const r = buildPlanLayout([
      { id: 'n1', label: '甲', dep: '乙' },
      { id: 'n2', label: '乙', dep: '丙' },
      { id: 'n3', label: '丙', dep: '甲' },
    ], noMeta);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('CYCLE');
    expect(r.cycle.length).toBeGreaterThanOrEqual(3);
    expect(r.msg).toContain('环');
  });
});

describe('buildPlanLayout · 相对表达与状态', () => {
  it('「上方全部 ✅ 项」= 依赖它前面所有已完成的项（后面的不算）', () => {
    const meta = new Map([done('n1'), done('n2')] as any);
    const r = buildPlanLayout([
      { id: 'n1', label: '甲', dep: '' },
      { id: 'n2', label: '乙', dep: '' },
      { id: 'n3', label: '丙', dep: '上方全部 ✅ 项' },
      { id: 'n4', label: '丁', dep: '' },
    ], meta as any);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.layout.edges.map((e) => e.from + '>' + e.to).sort()).toEqual(['n3>n1', 'n3>n2']);
  });

  it('状态与 detail 原样带进节点（不在这里二次解释）', () => {
    const meta = new Map([['n1', { status: 'in-progress', detail: '细节' }]] as any);
    const r = buildPlanLayout([{ id: 'n1', label: '甲', dep: '' }], meta as any);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.layout.nodes[0]).toEqual({ id: 'n1', label: '甲', layer: 'plan', status: 'in-progress', detail: '细节' });
  });

  it('layerIdOfRank 只认 rank 0 是 plan，其余带阶数（升级已孵化的图时层 id 不变）', () => {
    expect([layerIdOfRank(0), layerIdOfRank(1), layerIdOfRank(7)]).toEqual(['plan', 'plan-1', 'plan-7']);
  });
});

describe('readDepColumn · 依赖列在哪一格', () => {
  const withKanban = (md: string): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'srelay-depcol-'));
    fs.writeFileSync(path.join(dir, 'progress.md'), md);
    return dir;
  };

  it('标准看板（任务|状态|模块|明细）没有依赖列 ⇒ null', () => {
    const dir = withKanban([
      '| 任务 | 状态 | 模块 | 明细 |',
      '|---|---|---|---|',
      '| 建索引 | ✅ | core | 完成 |',
    ].join('\n'));
    expect(readDepColumn(dir)).toBe(null);
  });

  it('人工表（模块|状态|依赖|现状与出处）⇒ 第 3 格', () => {
    const dir = withKanban([
      '| 模块 | 状态 | 依赖 | 现状与出处 |',
      '|---|---|---|---|',
      '| db.ts | ✅ | 无 | 好了 |',
    ].join('\n'));
    expect(readDepColumn(dir)).toBe(3);
  });

  it('数据行里出现「依赖」不算表头（实测踩过：整文件扫描会把明细列当成依赖列）', () => {
    const dir = withKanban([
      '| 任务 | 状态 | 模块 | 明细 |',
      '|---|---|---|---|',
      '| 依赖列解析建边 | ✅ | map | 真边 21 条 |',
    ].join('\n'));
    expect(readDepColumn(dir)).toBe(null);
  });

  it('没有 progress.md ⇒ null（不抛）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'srelay-depcol-'));
    expect(readDepColumn(dir)).toBe(null);
  });
});
