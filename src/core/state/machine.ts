// 会话状态机（方针 §6.1 / 技术方案 §3.2）：表驱动，全路径可穷举测试。
// 事件语义：
//   NEW_LINE        捕获到新行。active → touch；非 active → 等价 RESUMED（回滚，方针："任意状态回滚 active"）
//   IDLE_TIMEOUT / END_SIGNAL   active → pending_end；已 pending/confirmed → 幂等保持（防 tick 抖动降级 confirmed）
//   COOLDOWN_ELAPSED 仅 pending_end → confirmed（触发元数据提取 + summary_rule）
//   RESUMED         任意非删除态 → active（清 summary_rule 重算）
//   MANUAL_CONFIRM  任意态 → confirmed（srelay confirm）
//   PURGE           仅 pending_end → 删除（srelay purge --pending）
export type SessionState = 'active' | 'pending_end' | 'confirmed';
export type SessionDest = SessionState | 'deleted';
export type SessionEvent =
  | 'NEW_LINE'
  | 'IDLE_TIMEOUT'
  | 'END_SIGNAL'
  | 'COOLDOWN_ELAPSED'
  | 'RESUMED'
  | 'MANUAL_CONFIRM'
  | 'PURGE';
export type Effect = 'touch' | 'rollback' | 'confirm' | 'purge';

export interface TransitionRule {
  from: SessionState[];
  on: SessionEvent;
  to: SessionDest;
  effect?: Effect;
  note?: string;
}

export const TRANSITIONS: TransitionRule[] = [
  { from: ['active'], on: 'NEW_LINE', to: 'active', effect: 'touch' },
  { from: ['pending_end', 'confirmed'], on: 'NEW_LINE', to: 'active', effect: 'rollback', note: '非 active 态收到新行 = resume（方针 §6.1）' },
  { from: ['active'], on: 'IDLE_TIMEOUT', to: 'pending_end' },
  { from: ['pending_end'], on: 'IDLE_TIMEOUT', to: 'pending_end', note: '幂等' },
  { from: ['confirmed'], on: 'IDLE_TIMEOUT', to: 'confirmed', note: '幂等：confirmed 不得被 tick 抖动降级' },
  { from: ['active'], on: 'END_SIGNAL', to: 'pending_end' },
  { from: ['pending_end'], on: 'END_SIGNAL', to: 'pending_end', note: '幂等' },
  { from: ['confirmed'], on: 'END_SIGNAL', to: 'confirmed', note: '幂等：同上' },
  { from: ['pending_end'], on: 'COOLDOWN_ELAPSED', to: 'confirmed', effect: 'confirm' },
  { from: ['active'], on: 'RESUMED', to: 'active', effect: 'touch', note: '已在 active，等价 touch' },
  { from: ['pending_end', 'confirmed'], on: 'RESUMED', to: 'active', effect: 'rollback' },
  { from: ['active', 'pending_end', 'confirmed'], on: 'MANUAL_CONFIRM', to: 'confirmed', effect: 'confirm' },
  { from: ['pending_end'], on: 'PURGE', to: 'deleted', effect: 'purge' },
];

export interface TransitionResult {
  ok: boolean;
  from: SessionState;
  on: SessionEvent;
  to?: SessionDest;
  effect?: Effect;
  reason?: string;
}

/** 唯一迁移入口：非法组合返回 ok:false（调用方记日志，不改状态） */
export function transition(from: SessionState, on: SessionEvent): TransitionResult {
  const rule = TRANSITIONS.find((r) => r.on === on && r.from.includes(from));
  if (!rule) {
    return { ok: false, from, on, reason: `非法迁移：${from} × ${on}（迁移表无此组合）` };
  }
  return { ok: true, from, on, to: rule.to, effect: rule.effect };
}
