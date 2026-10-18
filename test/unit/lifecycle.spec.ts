import { describe, it, expect } from 'vitest';
import { STAGES, dueStages, recordStage, shouldSkip, LIFECYCLE_VERSION, type LifecycleState } from '../../src/core/lifecycle/stages.js';

const empty = (): LifecycleState => ({ version: LIFECYCLE_VERSION, rounds: 0, lastAt: null, stages: {} });

describe('生命周期 · 阶段与状态机', () => {
  it('阶段表是唯一一份，且每个阶段有自己的节奏', () => {
    expect(STAGES.length).toBeGreaterThanOrEqual(8);
    const ids = STAGES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(STAGES.find((s) => s.id === 'aging')!.everySec).toBeGreaterThan(STAGES.find((s) => s.id === 'guard')!.everySec);
  });

  it('从没跑过 → 全部到期；刚跑过 → 不到期', () => {
    const st = empty();
    expect(dueStages(st, Date.now()).length).toBe(STAGES.length);
    for (const s of STAGES) recordStage(st, s.id, { ok: true, note: 'x', at: new Date().toISOString(), ms: 1 });
    expect(dueStages(st, Date.now()).length).toBe(0);
  });

  it('到期按各自间隔算（aging 一天一次，guard 十五分钟一次）', () => {
    const st = empty();
    const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
    for (const s of STAGES) recordStage(st, s.id, { ok: true, note: 'x', at: twoHoursAgo, ms: 1 });
    const due = dueStages(st, Date.now()).map((s) => s.id);
    expect(due).toContain('guard');
    expect(due).not.toContain('aging');
  });

  it('连续失败 3 次 → 跳过（坏阶段不许拖垮整条链路）', () => {
    const st = empty();
    for (let i = 0; i < 2; i++) recordStage(st, 'capture', { ok: false, note: '被占用', at: new Date().toISOString(), ms: 1 });
    expect(shouldSkip(st, 'capture').skip).toBe(false);
    recordStage(st, 'capture', { ok: false, note: '被占用', at: new Date().toISOString(), ms: 1 });
    expect(shouldSkip(st, 'capture').skip).toBe(true);
    recordStage(st, 'capture', { ok: true, note: '好了', at: new Date().toISOString(), ms: 1 });
    expect(shouldSkip(st, 'capture').skip).toBe(false);
  });

  it('时钟异常（at 无法解析）时宁可跑一次', () => {
    const st = empty();
    recordStage(st, 'guard', { ok: true, note: 'x', at: 'garbage', ms: 1 });
    expect(dueStages(st, Date.now()).map((s) => s.id)).toContain('guard');
  });
});
