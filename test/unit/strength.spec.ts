// 连续强度（core/decay/strength.ts）单测 —— 淘汰判据的唯一实现
//
// Lead 的验收要求都落在这里：
//   ① T=1/e 的标定必须可验证：给定 grade，新判据与旧线性模型在 60/241/422 天判定一致；
//   ② 重放=强化：hits/uses 抬高出生分 ⇒ S 变大 ⇒ 同样的年龄保持率更高（与纯时间衰减的本质差别）；
//   ③ inferred 不再"出生即死"：S 反推为负时用观察窗 7 天兜底（旧模型 1.5 分出生即低于阈值 5.5）；
//   ④ 分母不再写死 90：aging 的 strengthOf 必须接受调用方真实窗（生产 config 是 30）；
//   ⑤ 公式只有一份：aging.ts / global.ts 不许再出现手写衰减公式。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { GRADES, INJECT_THRESHOLD, DECAY_PER_DAY, liveImportance, type LessonRow } from '../../src/store/global.js';
import {
  STRENGTH_RETIRE_THRESHOLD, DEFAULT_GRACE_DAYS,
  retentionOf, spanDaysOf, strengthOfItem, strengthOfAge, shouldRetire,
} from '../../src/core/decay/strength.js';
import { planAging, strengthOf } from '../../src/core/compact/aging.js';

const NOW = Date.parse('2026-10-18T00:00:00Z');
const DAY = 86400000;
const PARAMS = { injectThreshold: INJECT_THRESHOLD, decayPerDay: DECAY_PER_DAY, graceDays: DEFAULT_GRACE_DAYS };

/** 构造一条经验行：importance=定级分，hits/uses 默认 0 */
const lesson = (grade: keyof typeof GRADES, ageDays: number, o: Partial<LessonRow> = {}): LessonRow => ({
  id: 1, scope: 'global', workspace_id: null, domain: null, text: 'x',
  grade, importance: GRADES[grade], status: 'verified', hits: 0, uses: 0, needs_review: 0,
  created_at: new Date(NOW - ageDays * DAY).toISOString(), ...o,
});

const liveAtBirthOf = (r: LessonRow, ageDays: number): number => liveImportance(r, NOW) + ageDays * DECAY_PER_DAY;
const strengthOfRow = (r: LessonRow, ageDays: number) => strengthOfItem({
  liveAtBirth: liveAtBirthOf(r, ageDays), daysSinceEvidence: ageDays, recalls: Number(r.hits ?? 0),
}, PARAMS);
/** 旧线性判据（对照臂）：live < INJECT_THRESHOLD；1e-9 容差只用于把浮点边界钉成"相等" */
const oldRetire = (r: LessonRow) => liveImportance(r, NOW) < INJECT_THRESHOLD - 1e-9;
const newRetire = (s: number) => s < STRENGTH_RETIRE_THRESHOLD - 1e-9;

describe('连续强度 · 参数标定（T=1/e 与旧线性模型逐日重合）', () => {
  it('阈值就是 1/e（不是手感值）', () => {
    expect(STRENGTH_RETIRE_THRESHOLD).toBeCloseTo(1 / Math.E, 9);
  });

  it('verified-file：60/61 天新旧判据判定一致', () => {
    const at60 = lesson('verified-file', 60), at61 = lesson('verified-file', 61);
    expect(oldRetire(at60)).toBe(false); expect(newRetire(strengthOfRow(at60, 60).strength)).toBe(false);
    expect(oldRetire(at61)).toBe(true);  expect(newRetire(strengthOfRow(at61, 61).strength)).toBe(true);
  });

  it('verified-user：240/241 天新旧判据判定一致（S=(7.5-5.5)/0.0083≈241）', () => {
    const at240 = lesson('verified-user', 240), at241 = lesson('verified-user', 241);
    expect(oldRetire(at240)).toBe(false); expect(newRetire(strengthOfRow(at240, 240).strength)).toBe(false);
    expect(oldRetire(at241)).toBe(true);  expect(newRetire(strengthOfRow(at241, 241).strength)).toBe(true);
  });

  it('verified-tool：421/422 天新旧判据判定一致（S=(9-5.5)/0.0083≈422）', () => {
    const at421 = lesson('verified-tool', 421), at422 = lesson('verified-tool', 422);
    expect(oldRetire(at421)).toBe(false); expect(newRetire(strengthOfRow(at421, 421).strength)).toBe(false);
    expect(oldRetire(at422)).toBe(true);  expect(newRetire(strengthOfRow(at422, 422).strength)).toBe(true);
  });

  it('S 与旧标定同值：verified-file ≈60.2 天 / user ≈241 天 / tool ≈421.7 天', () => {
    expect(spanDaysOf(GRADES['verified-file'], PARAMS)!).toBeCloseTo(60.24, 1);
    expect(spanDaysOf(GRADES['verified-user'], PARAMS)!).toBeCloseTo(240.96, 1);
    expect(spanDaysOf(GRADES['verified-tool'], PARAMS)!).toBeCloseTo(421.69, 1);
  });
});

describe('连续强度 · 重放=强化（与纯时间衰减的本质差别）', () => {
  it('同一个年龄，被反复挖到（hits 大）⇒ 强度更高、不再退休', () => {
    const base = strengthOfRow(lesson('verified-file', 100), 100);
    const replayed = strengthOfRow(lesson('verified-file', 100, { hits: 5 }), 100);
    expect(newRetire(base.strength)).toBe(true);      // 100 天 > S=60：该退休
    expect(newRetire(replayed.strength)).toBe(false); // hits=5 把 S 抬到 ≈120 天：活下来
    expect(replayed.spanDays).toBeGreaterThan(base.spanDays);
    expect(replayed.strength).toBeGreaterThan(base.strength);
  });

  it('被实际复用（uses 大）⇒ 强度更高（旧模型的 bonus 折算成天数）', () => {
    const base = strengthOfRow(lesson('verified-file', 400), 400);
    const used = strengthOfRow(lesson('verified-file', 400, { uses: 50 }), 400);
    expect(newRetire(base.strength)).toBe(true);
    expect(newRetire(used.strength)).toBe(false);
    expect(used.spanDays).toBeGreaterThan(500);       // ln(51)*1.5/0.0083 ≈ 709 天
  });

  it('保持率曲线单调、t=0 时恒为 1（新条目不会被误杀）', () => {
    expect(retentionOf(0, 30)).toBe(1);
    expect(retentionOf(30, 30)).toBeCloseTo(1 / Math.E, 9);
    expect(retentionOf(60, 30)).toBeLessThan(retentionOf(30, 30));
  });
});

describe('连续强度 · inferred 不再出生即死', () => {
  it('出生分低于阈值 → 观察窗兜底（S=7 天），出生当天强度 1.0', () => {
    const fresh = strengthOfRow(lesson('inferred', 0), 0);
    expect(fresh.floored).toBe(true);
    expect(fresh.spanDays).toBe(DEFAULT_GRACE_DAYS);
    expect(fresh.strength).toBe(1);
    expect(shouldRetire(fresh.strength)).toBe(false);   // 旧模型这里是 1.5 < 5.5 ⇒ 出生即退休
  });

  it('观察窗过后（7 天以后）才可能退休；期间被再次挖到则回血', () => {
    const at6 = strengthOfRow(lesson('inferred', 6), 6);
    const at9 = strengthOfRow(lesson('inferred', 9), 9);
    const replayed = strengthOfItem({
      liveAtBirth: liveAtBirthOf(lesson('inferred', 9, { hits: 3 }), 9), daysSinceEvidence: 9,
      recalls: 3, recallBoostDays: 3 * 30,
    }, PARAMS);
    expect(shouldRetire(at6.strength)).toBe(false);
    expect(shouldRetire(at9.strength)).toBe(true);
    expect(shouldRetire(replayed.strength)).toBe(false);
  });
});

describe('连续强度 · 容错与边界（不静默）', () => {
  it('时间戳不可解析 → 当新条目（强度 1），绝不误淘汰，且给出原因', () => {
    const det = strengthOfItem({ liveAtBirth: 6, daysSinceEvidence: NaN }, PARAMS);
    expect(det.strength).toBe(1);
    expect(det.note).toContain('bad-time');
  });

  it('S 非法/为负且无观察窗 → 强度 0（已无强度），不会返回 NaN', () => {
    expect(retentionOf(10, 0)).toBe(0);
    expect(retentionOf(10, NaN)).toBe(0);
    expect(spanDaysOf(1.5, PARAMS)).toBeUndefined();
  });

  it('shouldRetire 是全项目唯一比较处：等于阈值不退休（strictly less）', () => {
    expect(shouldRetire(STRENGTH_RETIRE_THRESHOLD)).toBe(false);
    expect(shouldRetire(STRENGTH_RETIRE_THRESHOLD - 1e-9)).toBe(true);
  });
});

describe('aging · 分母不再写死 90（生产窗 30）', () => {
  const srow = (ageDays: number, over: Record<string, unknown> = {}) => ({
    id: 'a', last_event_at: new Date(NOW - ageDays * DAY).toISOString(), message_count: 20,
    extracted_version: 25, state: 'confirmed', decisions: JSON.stringify([{ text: '决策一', at: 'x' }]),
    cleanup_at: null, ...over,
  });
  const O = { now: NOW, currentVersion: 25 };

  it('strengthOf 的窗参数生效：31 天在 30 天窗下 <T，在默认 90 天窗下 ≥T', () => {
    const r = { id: 'x', last_event_at: new Date(NOW - 31 * DAY).toISOString() };
    expect(strengthOf(r as never, NOW, 30)).toBeLessThan(STRENGTH_RETIRE_THRESHOLD);
    expect(strengthOf(r as never, NOW, 90)).toBeGreaterThan(STRENGTH_RETIRE_THRESHOLD);
    expect(strengthOf(r as never, NOW)).toBeCloseTo(strengthOf(r as never, NOW, 90), 9);   // 默认仍是 90（独立调用方的兼容默认）
  });

  it('planAging：30 天窗 → 31 天可归档、29 天不动（连续判据与窗边界重合）', () => {
    expect(planAging([srow(31)], { ...O, minAgeDays: 30 }).archive.map((r) => r.id)).toEqual(['a']);
    expect(planAging([srow(29)], { ...O, minAgeDays: 30 }).archive).toEqual([]);
  });

  it('[实测记录] 默认窗 90 对 65 天的真实库不触发 —— 这就是"积压为 0"而不是"判据坏了"的原因', () => {
    expect(planAging([srow(65)], O).archive).toEqual([]);                                  // 默认 90
    expect(planAging([srow(65)], { ...O, minAgeDays: 30 }).archive.map((r) => r.id)).toEqual(['a']);
  });
});

describe('单一实现（防止公式被复制成第二份）', () => {
  const src = (p: string) => fs.readFileSync(path.resolve(process.cwd(), p), 'utf8');
  it('aging.ts 不再手写衰减公式，且从 decay/strength.ts 取判据', () => {
    const s = src('src/core/compact/aging.ts');
    expect(s).toContain("from '../decay/strength.js'");
    expect(s).not.toMatch(/Math\.exp\(/);                       // 公式不许有第二份
    expect(s).toMatch(/shouldRetire\(s\)/);                     // 判定走唯一比较处
    expect(s).not.toContain('Math.max(0, 1 - age / 90)');        // 旧的写死 90 公式已删（注释里提到不算）
  });
  it('global.ts 的淘汰判据也不手写公式', () => {
    const s = src('src/store/global.ts');
    expect(s).toContain("from '../core/decay/strength.js'");
    expect(s).toMatch(/shouldRetire\(/);
    expect(s).not.toMatch(/Math\.exp\(/);
  });
});
