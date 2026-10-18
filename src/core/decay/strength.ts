// 连续强度（0~1）：淘汰判据的唯一实现（decay 家族；与 decay.ts 同纪律：纯函数、可单测）
//
// 学术依据（ADR-003 D1 / 2026-10-18 衍总报告 §1.4）：
//   MemoryBank（Zhong 等, AAAI 2024）用艾宾浩斯记忆强度：保持率 R(t)=exp(-t/S)，
//   每次"被召回"强化 S 并重置计时 —— 这就是"重放=强化"与"纯时间衰减"的本质差别；
//   ACT-R 的 B=ln(Σt^-d)、Wixted & Ebbesen 的幂律是同类连续量，但我们只需要**淘汰**这一个用途，
//   保持率形式最可解释（S 的单位就是"天"，T 可以直接读成"还剩多少比例"）。
//
// 参数不是拍脑袋 —— 全部由**现有线性标定反推**：
//   旧模型 live = importance + bonus - ageDays*DECAY_PER_DAY，淘汰点 ageDays* = (liveAtBirth - INJECT_THRESHOLD)/DECAY_PER_DAY。
//   令 S = ageDays*、T = 1/e，则 strength(T 点) = exp(-S/S) = e^-1 = T —— **逐日重合**。
//   于是 verified-file / verified-user / verified-tool 的 S 自动等于 60.2 / 241.0 / 421.7 天
//   （= (6-5.5)/0.0083 等），与旧行为在下述意义下完全一致：strength < T ⟺ live < INJECT_THRESHOLD。
//   这条等价性由 test/unit/strength.spec.ts 在 60 / 241 / 422 天上钉死（Lead 要求可验证）。
//
// 为什么"重放"体现为 S 变大、而不是把计时清零：
//   曾经想直接用 lessons.updated_at 当"上次召回时间"，但 updated_at 会被 maintainLessons 自身
//   的退休/复活动作刷新 ⇒ 退休后立刻读到"刚强化过" ⇒ 判定翻转（flapping）。这是实测型负结果，
//   所以这里只接受**显式的证据计数**（hits/uses 抬高 liveAtBirth ⇒ 抬高 S），
//   aging 侧则接受可选的 recallBoostDays（会话被恢复/追加消息时可给），默认 0 = 不加戏。

import { DAY_MS } from './decay.js';

/** 淘汰阈值：保持率跌破 1/e 视为"已过期"。选 1/e 的理由见文件头（与旧线性标定逐日重合，不是手感）。 */
export const STRENGTH_RETIRE_THRESHOLD = Number((1 / Math.E).toFixed(9));

/** 出生分低于注入阈值时给的观察窗（天）：inferred 出生 1.5 分 ⇒ S 反推为负 ⇒ 用这个兜底，等价于现有 7 天观察窗。 */
export const DEFAULT_GRACE_DAYS = 7;

/**
 * 每次"被召回/再次出现"额外续命的天数（重放=强化）。
 * ⚠️ 这是本模块**唯一没能用现有数据拟合的参数**（真库 hits 只有 0–5、跨度 1.5 天，拟合不出斜率）。
 * 取值依据：文献 MemoryBank 用"每次召回 S+=1"，但其 S 单位是检索轮次、不可直接搬；
 * 这里取 30 天/次，语义是"一次重放至少把观察窗（7 天）续到下一个量级"。
 * 仅对**出生分低于阈值**的条目生效（inferred 等）：verified-* 的 hits 已经通过旧 bonus
 * 折算进 spanDays（0.1 分/次 ÷ 0.0083 ≈ 12 天/次），再叠一次就是重复计数，会破坏与旧模型的逐日等价。
 */
export const DEFAULT_RECALL_BOOST_DAYS = 30;

export interface StrengthParams {
  /** 注入阈值（旧线性模型的失效线） */
  injectThreshold: number;
  /** 旧线性模型每天扣多少分 */
  decayPerDay: number;
  /** 出生分不足阈值时的强度兜底（天） */
  graceDays?: number;
}

export interface StrengthInput {
  /** 按旧模型算出的"出生分"（importance + bonus，即 ageDays=0 时的 live 分） */
  liveAtBirth: number;
  /** 距证据产生（会话=最后活动；经验=创建）的天数 */
  daysSinceEvidence: number;
  /** 每多一次"被召回/被复用"额外获得的天数（重放=强化）；会话侧通常 0 */
  recallBoostDays?: number;
  /** 召回次数（只用于可解释性与上限，不直接乘） */
  recalls?: number;
}

export interface StrengthDetail {
  /** 保持率 (0,1] */
  strength: number;
  /** 强度天数 S（越大越"扛衰减"） */
  spanDays: number;
  daysSinceEvidence: number;
  /** 是否被观察窗兜底 */
  floored: boolean;
  /** 非 null 时说明为什么按"新条目"处理（不淘汰） */
  note: string | null;
}

function finite(v: number): boolean { return Number.isFinite(v); }

/**
 * 核心公式（**唯一**）：艾宾浩斯保持率 R = exp(-t/S)。
 * t 或 S 非法时的约定（不静默）：t 非有限 → 1（当新条目，绝不误淘汰）；S<=0 → 0（已无强度）。
 */
export function retentionOf(daysSinceEvidence: number, spanDays: number): number {
  if (!finite(daysSinceEvidence) || daysSinceEvidence <= 0) return 1;
  if (!finite(spanDays) || spanDays <= 0) return 0;
  return Math.exp(-daysSinceEvidence / spanDays);
}

/** S（天）由"出生分"反推：S = (liveAtBirth - injectThreshold) / decayPerDay。非法/为负 → undefined。 */
export function spanDaysOf(liveAtBirth: number, p: StrengthParams): number | undefined {
  if (!finite(liveAtBirth) || !finite(p.injectThreshold) || !finite(p.decayPerDay) || p.decayPerDay <= 0) return undefined;
  const s = (liveAtBirth - p.injectThreshold) / p.decayPerDay;
  return finite(s) && s > 0 ? s : undefined;
}

/**
 * 经验/记忆条目的连续强度（淘汰判据）。
 * 重放=强化：hits/uses 抬高 liveAtBirth ⇒ spanDays 变大 ⇒ 同样的年龄保持率更高。
 */
export function strengthOfItem(i: StrengthInput, p: StrengthParams): StrengthDetail {
  const daysSince = i.daysSinceEvidence;
  const grace = p.graceDays ?? DEFAULT_GRACE_DAYS;
  if (!finite(daysSince)) {
    return { strength: 1, spanDays: 0, daysSinceEvidence: daysSince, floored: false, note: 'bad-time: 时间戳不可解析，按新条目处理（不淘汰）' };
  }
  const recallBoost = finite(i.recallBoostDays ?? 0) && (i.recallBoostDays ?? 0) > 0 ? (i.recallBoostDays as number) : 0;
  const baseSpan = spanDaysOf(i.liveAtBirth, p);
  // recallBoost 只在"出生分不足阈值"时叠加（见 DEFAULT_RECALL_BOOST_DAYS 注释：否则重复计数）
  const spanDays = baseSpan === undefined ? grace + recallBoost : baseSpan;
  const floored = baseSpan === undefined;
  return {
    strength: retentionOf(daysSince, spanDays),
    spanDays,
    daysSinceEvidence: daysSince,
    floored,
    note: floored ? 'floored: 出生分低于注入阈值（如 inferred），用观察窗 ' + grace + ' 天兜底' : null,
  };
}

/**
 * 会话/正文的连续强度：只按"最后活动"计（会话没有 hits/uses 列，别硬造信号）。
 * 重放=强化：会话被恢复/追加消息时 last_event_at 前移 ⇒ daysSinceEvidence 归零 ⇒ 立即回血。
 */
export function strengthOfAge(ageDays: number, spanDays: number): number {
  return retentionOf(ageDays, spanDays);
}

/** 淘汰判据：**唯一比较处** —— 全项目只有这里写"strength < T"。 */
export function shouldRetire(strength: number, threshold: number = STRENGTH_RETIRE_THRESHOLD): boolean {
  return finite(strength) && strength < threshold;
}

/** 天 → 毫秒（与 decay.ts 不重复定义，统一从这里取）。 */
export { DAY_MS };
