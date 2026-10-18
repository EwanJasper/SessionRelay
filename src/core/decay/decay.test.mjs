// 时间衰减的单元测试（node --test 直接跑，不依赖仓库 test/** 的 vitest 收集）
//   cd core/SessionRelay && node --test src/core/decay/decay.test.mjs
// 每个用例都对应一条设计约束，不是为覆盖率凑数：
//   · 默认关 / 可关 —— 规则 1（先量再接）
//   · 恒为正乘数、集合不变 —— "衰减绝不过滤记录"的结构性证据
//   · 配置写错必须报告 —— 规则 3（容错不许静默）
//   · 零依赖 —— 面板宿主没有原生模块，判据不许 import 东西
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DAY_MS,
  DECAY_KINDS,
  DEFAULT_DECAY,
  DEFAULT_HALF_LIFE_DAYS,
  ageMsOf,
  applyDecay,
  decayConfigWarnings,
  decayFactor,
  decayFactorDetailed,
  defaultDecayConfig,
  halfLifeMsOf,
  normalizeKind,
  rankByDecayedScore,
  resolveDecayConfig,
} from './decay.ts';

const ON = { enabled: true };
const NO_FLOOR = { enabled: true, floor: 0 };
const near = (actual, expected, eps = 1e-12) => {
  assert.ok(Math.abs(actual - expected) <= eps, 'expected ' + actual + ' ~= ' + expected);
};
const days = (d) => d * DAY_MS;

test('默认是关的：任何年龄/类别 factor 恒为 1', () => {
  assert.equal(DEFAULT_DECAY.enabled, false);
  for (const kind of DECAY_KINDS) {
    for (const age of [0, days(1), days(365), days(3650)]) {
      assert.equal(decayFactor(age, kind), 1, kind + '@' + age);
      assert.equal(decayFactorDetailed(age, kind).note.startsWith('disabled'), true);
    }
  }
});

test('指数衰减：半衰期处正好 1/2（2 个半衰期 1/4）', () => {
  near(decayFactor(days(90), 'decision', NO_FLOOR), 0.5);
  near(decayFactor(days(180), 'decision', NO_FLOOR), 0.25);
  near(decayFactor(days(0.5), 'decision', NO_FLOOR), Math.pow(2, -0.5 / 90));
  // 理论值与实现独立算一遍，避免"测试照着实现抄"
  near(decayFactor(days(45), 'negative', NO_FLOOR), Math.exp(-Math.LN2 * 45 / 180));
});

test('floor 保底：10 个半衰期后仍等于 floor 且严格 >0', () => {
  const f = decayFactor(days(900), 'decision', ON); // 10 个半衰期，自然值 1/1024
  assert.equal(f, DEFAULT_DECAY.floor);
  assert.ok(f > 0);
  assert.equal(decayFactorDetailed(days(900), 'decision', ON).floored, true);
  // floor=0 时也必须 >0（下溢保护，0 会让排序退化）
  assert.ok(decayFactor(days(365000), 'decision', NO_FLOOR) > 0);
});

test('未决问题默认不衰减（欠条不因时间而被埋）', () => {
  assert.equal(DEFAULT_HALF_LIFE_DAYS.question, null);
  assert.equal(decayFactor(days(3650), 'question', ON), 1);
  assert.equal(halfLifeMsOf('question'), Infinity);
  assert.match(decayFactorDetailed(days(3650), 'question', ON).note, /no-decay-kind/);
});

test('三类半衰期确实不同：90 天时 decision 0.5 < negative/lesson 0.7071 < question 1', () => {
  const at = days(90);
  const d = decayFactor(at, 'decision', NO_FLOOR);
  const n = decayFactor(at, 'negative', NO_FLOOR);
  const l = decayFactor(at, 'lesson', NO_FLOOR);
  const q = decayFactor(at, 'question', NO_FLOOR);
  near(d, 0.5);
  near(n, Math.pow(2, -0.5));
  near(l, Math.pow(2, -0.5));
  assert.ok(q > n && n > d, q + ' > ' + n + ' > ' + d);
});

test('幂律模式：仍以半衰期为 1/2，且尾部比指数更厚', () => {
  for (const alpha of [0.5, 1, 2]) {
    const opts = { enabled: true, mode: 'power', alpha, floor: 0 };
    near(decayFactor(days(90), 'decision', opts), 0.5);
    assert.ok(decayFactor(days(180), 'decision', opts) > decayFactor(days(180), 'decision', NO_FLOOR));
  }
  // α=1 时 2H 处应为 1/3（指数是 1/4）
  near(decayFactor(days(180), 'decision', { enabled: true, mode: 'power', alpha: 1, floor: 0 }), 1 / 3);
});

test('单调不增：年龄越大分数不高（触保底前严格递减）', () => {
  let prev = 1;
  for (const d of [0, 1, 7, 30, 90, 180, 360]) {
    const f = decayFactor(days(d), 'decision', NO_FLOOR);
    assert.ok(f <= prev, 'age ' + d);
    prev = f;
  }
  assert.ok(decayFactor(days(91), 'decision', NO_FLOOR) < decayFactor(days(90), 'decision', NO_FLOOR));
});

test('绝不淘汰：排序前后 id 集合完全一致、长度不变、分数恒为正', () => {
  const cands = [
    { id: 'today', score: 1.0, ageMs: days(0.1), kind: 'decision' },
    { id: '10y', score: 1.0, ageMs: days(3650), kind: 'decision' },
    { id: '10y-negative', score: 1.0, ageMs: days(3650), kind: 'negative' },
    { id: '10y-question', score: 1.0, ageMs: days(3650), kind: 'question' },
    { id: 'null-age', score: 1.0, ageMs: null, kind: 'lesson' },
  ];
  const out = rankByDecayedScore(cands, ON);
  assert.equal(out.length, cands.length);
  assert.deepEqual(new Set(out.map((r) => r.candidate.id)), new Set(cands.map((c) => c.id)));
  for (const r of out) assert.ok(r.decayedScore > 0, r.candidate.id + ' 分数不应被衰减到 <=0');
  // 最老的决策仍在结果里，只是名次靠后
  const old = out.find((r) => r.candidate.id === '10y');
  assert.ok(old.rankWith > out.find((r) => r.candidate.id === 'today').rankWith);
});

test('很老但很相关，仍能压过很新但勉强相关（floor 的意义）', () => {
  const cands = [
    { id: 'old-strong', score: 10, ageMs: days(1095), kind: 'decision' },
    { id: 'new-weak', score: 1, ageMs: days(1), kind: 'decision' },
  ];
  const out = rankByDecayedScore(cands, ON);
  assert.equal(out[0].candidate.id, 'old-strong');
  assert.equal(out[0].decayedScore, 10 * DEFAULT_DECAY.floor);
});

test('排序确实会变：默认配置下同分时新记录上浮', () => {
  const cands = [
    { id: 'old', score: 1.0, ageMs: days(120), kind: 'decision' },
    { id: 'new', score: 1.0, ageMs: days(0.01), kind: 'decision' },
  ];
  const off = rankByDecayedScore(cands, { enabled: false });
  const on = rankByDecayedScore(cands, ON);
  assert.equal(off[0].candidate.id, 'old'); // 同分按入参顺序稳定 —— 关掉时顺序不可解释
  assert.equal(on[0].candidate.id, 'new');
  assert.equal(on[0].rankWithout, 2);
  assert.equal(on[0].rankWith, 1);
});

test('缺/坏时间戳不惩罚（显式 note，不静默）', () => {
  for (const bad of [null, undefined, NaN, Infinity, -Infinity]) {
    const d = decayFactorDetailed(bad, 'decision', ON);
    assert.equal(d.factor, 1);
    assert.match(d.note, /unknown-age/);
  }
  assert.equal(ageMsOf('not-a-date'), null);
  assert.equal(ageMsOf(''), null);
  assert.equal(ageMsOf(null), null);
  assert.equal(ageMsOf(new Date('2026-01-01T00:00:00Z'), Date.parse('2026-01-02T00:00:00Z')), DAY_MS);
});

test('未来时间戳不奖励也不惩罚', () => {
  assert.equal(decayFactor(-days(30), 'decision', ON), 1);
  assert.match(decayFactorDetailed(-days(30), 'decision', ON).note, /future-age/);
});

test('非正分数不缩放：防止"越老越靠前"的方向反转', () => {
  assert.equal(applyDecay(-3, days(3650), 'decision', ON), -3);
  assert.equal(applyDecay(0, days(3650), 'decision', ON), 0);
  assert.equal(applyDecay(NaN, days(3650), 'decision', ON), NaN);
  near(applyDecay(2, days(90), 'decision', NO_FLOOR), 1);
});

test('非有限分数不炸、不丢，只标 note', () => {
  const out = rankByDecayedScore([{ id: 'nan', score: NaN, ageMs: days(1), kind: 'decision' }], ON);
  assert.equal(out.length, 1);
  assert.equal(out[0].candidate.id, 'nan');
  assert.ok(out[0].notes.includes('non-finite-score: 分数不是有限数，排到最后但**不删除**'));
});

test('配置写错必须逐条报告，并在 resolve 时退回默认值', () => {
  const warn = decayConfigWarnings({
    enable: true, // 拼错：应为 enabled
    mode: 'linear',
    floor: 1.5,
    alpha: 0,
    half_life_days: { decision: -1, unresolved: 30 },
  });
  assert.ok(warn.length >= 5, JSON.stringify(warn));
  assert.ok(warn.some((w) => w.includes('enable')));
  assert.ok(warn.some((w) => w.includes('mode')));
  assert.ok(warn.some((w) => w.includes('floor')));
  assert.ok(warn.some((w) => w.includes('alpha')));
  assert.ok(warn.some((w) => w.includes('unresolved')));
  assert.ok(warn.some((w) => w.includes('decision')));
  const cfg = resolveDecayConfig({ enabled: 'yes', floor: 1.5, alpha: 0, mode: 'linear', half_life_days: { decision: -1 } });
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.floor, DEFAULT_DECAY.floor);
  assert.equal(cfg.alpha, DEFAULT_DECAY.alpha);
  assert.equal(cfg.mode, DEFAULT_DECAY.mode);
  assert.equal(cfg.half_life_days.decision, DEFAULT_HALF_LIFE_DAYS.decision);
  // 合法配置原样生效
  const good = resolveDecayConfig({ enabled: true, floor: 0.4, half_life_days: { decision: 30, question: 90 } });
  assert.equal(good.enabled, true);
  assert.equal(good.floor, 0.4);
  assert.equal(good.half_life_days.decision, 30);
  assert.equal(good.half_life_days.question, 90);
  assert.deepEqual(decayConfigWarnings({}), []);
});

test('resolve 不污染共享默认常量（深拷贝）', () => {
  const a = resolveDecayConfig({ enabled: true });
  a.half_life_days.decision = 1;
  a.floor = 0;
  assert.equal(DEFAULT_HALF_LIFE_DAYS.decision, 90);
  assert.equal(DEFAULT_DECAY.floor, 0.25);
  const b = defaultDecayConfig();
  b.half_life_days.lesson = 3;
  assert.equal(DEFAULT_HALF_LIFE_DAYS.lesson, 180);
  assert.notEqual(a, b);
});

test('默认值就是文档里那套（改动必须过这里，防止悄悄漂）', () => {
  assert.equal(DEFAULT_DECAY.enabled, false);
  assert.equal(DEFAULT_DECAY.mode, 'exponential');
  assert.equal(DEFAULT_DECAY.floor, 0.25);
  assert.equal(DEFAULT_DECAY.alpha, 1);
  assert.deepEqual({ ...DEFAULT_HALF_LIFE_DAYS }, { decision: 90, negative: 180, question: null, lesson: 180, other: 90 });
});

test('类别归一：库里字符串 → DecayKind', () => {
  assert.equal(normalizeKind('decision'), 'decision');
  assert.equal(normalizeKind('negative'), 'negative');
  assert.equal(normalizeKind('question'), 'question');
  assert.equal(normalizeKind('lesson'), 'lesson');
  assert.equal(normalizeKind('unresolved'), 'other');
  assert.equal(normalizeKind(undefined), 'other');
  assert.equal(normalizeKind(null), 'other');
});

test('便捷入口与详细入口是同一份判据', () => {
  for (const kind of DECAY_KINDS) {
    for (const d of [0, 1, 90, 365]) {
      assert.equal(decayFactor(days(d), kind, ON), decayFactorDetailed(days(d), kind, ON).factor);
    }
  }
});

test('零依赖：decay.ts 里不许出现 import / require', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, 'decay.ts'), 'utf8');
  const lines = src.split(/\r?\n/);
  const bad = lines.filter((l) => /^\s*(import|export\s+\*\s+from|export\s+\{[^}]*\}\s+from)\b/.test(l) || /\brequire\s*\(/.test(l));
  assert.deepEqual(bad, [], 'decay.ts 必须零依赖（面板宿主无原生模块）: ' + bad.join(' | '));
});
