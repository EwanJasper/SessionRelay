import { describe, it, expect } from 'vitest';
import {
  transition,
  TRANSITIONS,
  type SessionState,
  type SessionEvent,
} from '../../../src/core/state/machine.js';

const STATES: SessionState[] = ['active', 'pending_end', 'confirmed'];
const EVENTS: SessionEvent[] = [
  'NEW_LINE', 'IDLE_TIMEOUT', 'END_SIGNAL', 'COOLDOWN_ELAPSED',
  'RESUMED', 'MANUAL_CONFIRM', 'PURGE',
];

describe('S3 状态机 · 全路径穷举', () => {
  it('3 态 × 7 事件全部有确定结果（合法迁移或明确拒绝）', () => {
    for (const s of STATES) {
      for (const e of EVENTS) {
        const r = transition(s, e);
        expect(r.ok === true || typeof r.reason === 'string').toBe(true);
      }
    }
  });

  it('迁移表无重复定义（每个 (from,on) 组合唯一）', () => {
    const seen = new Set<string>();
    for (const r of TRANSITIONS) {
      for (const f of r.from) {
        const key = `${f}|${r.on}`;
        expect(seen.has(key), `重复迁移规则：${key}`).toBe(false);
        seen.add(key);
      }
    }
    // 表只登记 合法/幂等 迁移（17 条）；非法组合以"无规则 = 拒绝"隐式定义：
    // COOLDOWN_ELAPSED × {active, confirmed}、PURGE × {active, confirmed} 共 4 个
    expect(seen.size).toBe(17);
    expect(transition('active', 'COOLDOWN_ELAPSED').ok).toBe(false);
    expect(transition('confirmed', 'COOLDOWN_ELAPSED').ok).toBe(false);
    expect(transition('active', 'PURGE').ok).toBe(false);
    expect(transition('confirmed', 'PURGE').ok).toBe(false);
  });
});

describe('S3 状态机 · 迁移语义', () => {
  it('NEW_LINE：active 保持（touch）', () => {
    expect(transition('active', 'NEW_LINE')).toMatchObject({ ok: true, to: 'active', effect: 'touch' });
  });

  it('NEW_LINE：pending_end / confirmed → 回滚 active（resume 语义，方针 §6.1）', () => {
    expect(transition('pending_end', 'NEW_LINE')).toMatchObject({ ok: true, to: 'active', effect: 'rollback' });
    expect(transition('confirmed', 'NEW_LINE')).toMatchObject({ ok: true, to: 'active', effect: 'rollback' });
  });

  it('IDLE_TIMEOUT：active → pending_end；pending 幂等；confirmed 不被 tick 降级', () => {
    expect(transition('active', 'IDLE_TIMEOUT')).toMatchObject({ ok: true, to: 'pending_end' });
    expect(transition('pending_end', 'IDLE_TIMEOUT')).toMatchObject({ ok: true, to: 'pending_end' });
    expect(transition('confirmed', 'IDLE_TIMEOUT')).toMatchObject({ ok: true, to: 'confirmed' });
  });

  it('END_SIGNAL：与 IDLE_TIMEOUT 同语义', () => {
    expect(transition('active', 'END_SIGNAL')).toMatchObject({ ok: true, to: 'pending_end' });
    expect(transition('confirmed', 'END_SIGNAL')).toMatchObject({ ok: true, to: 'confirmed' });
  });

  it('COOLDOWN_ELAPSED：仅 pending_end → confirmed（触发提取+摘要）；其余拒绝', () => {
    expect(transition('pending_end', 'COOLDOWN_ELAPSED')).toMatchObject({ ok: true, to: 'confirmed', effect: 'confirm' });
    expect(transition('active', 'COOLDOWN_ELAPSED').ok).toBe(false);
    expect(transition('confirmed', 'COOLDOWN_ELAPSED').ok).toBe(false);
  });

  it('RESUMED：任意态 → active；非 active 态带 rollback 效果', () => {
    expect(transition('active', 'RESUMED')).toMatchObject({ ok: true, to: 'active', effect: 'touch' });
    expect(transition('pending_end', 'RESUMED')).toMatchObject({ ok: true, to: 'active', effect: 'rollback' });
    expect(transition('confirmed', 'RESUMED')).toMatchObject({ ok: true, to: 'active', effect: 'rollback' });
  });

  it('MANUAL_CONFIRM：任意态 → confirmed', () => {
    for (const s of STATES) {
      expect(transition(s, 'MANUAL_CONFIRM')).toMatchObject({ ok: true, to: 'confirmed', effect: 'confirm' });
    }
  });

  it('PURGE：仅 pending_end 可清除；active/confirmed 拒绝', () => {
    expect(transition('pending_end', 'PURGE')).toMatchObject({ ok: true, to: 'deleted', effect: 'purge' });
    expect(transition('active', 'PURGE').ok).toBe(false);
    expect(transition('confirmed', 'PURGE').ok).toBe(false);
  });
});
