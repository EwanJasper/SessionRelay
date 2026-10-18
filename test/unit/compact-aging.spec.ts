import { describe, it, expect } from 'vitest';
import { planAging } from '../../src/core/compact/aging.js';

const dec = (n: number) => JSON.stringify(Array.from({ length: n }, (_, i) => ({ text: '决策' + i, at: '2026-01-01T00:00:00Z' })));
const row = (id: string, over: Record<string, unknown> = {}) => ({
  id, last_event_at: '2026-01-01T00:00:00Z', message_count: 20, extracted_version: 20,
  state: 'confirmed', decisions: dec(2), cleanup_at: null, ...over,
});
const O = { now: Date.parse('2026-10-17T00:00:00Z'), currentVersion: 20 };

describe('压缩 L2 · 老化压缩计划', () => {
  it('够老 + 版本新 + 有结论 + 已落定 → 归档', () => {
    const p = planAging([row('a')], O);
    expect(p.archive.map((r) => r.id)).toEqual(['a']);
  });
  it('没有派生结论的不许归档（归档了就真没了）', () => {
    const p = planAging([row('a', { decisions: '[]' })], O);
    expect(p.archive.length).toBe(0);
    expect(p.reasons['a']).toContain('没有派生结论');
  });
  it('规则版本旧的先重算再说', () => {
    expect(planAging([row('a', { extracted_version: 19 })], O).archive.length).toBe(0);
  });
  it('还不够老的不动', () => {
    expect(planAging([row('a', { last_event_at: '2026-10-01T00:00:00Z' })], O).archive.length).toBe(0);
  });
  it('[实测纠正] pending_end 也能归档（原门禁要求 confirmed ⇒ 重建后的库计划恒空）', () => {
    expect(planAging([row('a', { state: 'pending_end' })], O).archive.map((r) => r.id)).toEqual(['a']);
  });
  it('active 与导入/笔记不归档（对齐 archive.ts 的 isProtected）', () => {
    expect(planAging([row('a', { state: 'active' })], O).archive.length).toBe(0);
    expect(planAging([row('a', { origin: 'note' })], O).archive.length).toBe(0);
    expect(planAging([row('a', { origin: 'imported' })], O).archive.length).toBe(0);
  });
  it('已经归档过的不重复处理', () => {
    expect(planAging([row('a', { cleanup_at: '2026-09-01T00:00:00Z' })], O).archive.length).toBe(0);
  });
  it('每轮有上限（渐变不突变）', () => {
    const rows = Array.from({ length: 10 }, (_, i) => row('s' + i, { last_event_at: '2026-0' + ((i % 9) + 1) + '-01T00:00:00Z' }));
    const p = planAging(rows, { ...O, cap: 3 });
    expect(p.archive.length).toBe(3);
    expect(p.kept.length).toBe(7);
  });
});
