import { describe, it, expect } from 'vitest';
import { mcnemar, clusterDiffCI, pairedDiffCI } from '../../scripts/bench-stats.mjs';

/**
 * 评测比较的统计判据。
 *
 * 为什么值得单独测：这三个函数决定「这次改动算不算有效」。它们错了，不会崩、不会报错，
 *   只会安静地给出一个偏窄的区间，然后我们拿着一句「显著提升」去改产品。
 *   这是本仓最贵的一种错 —— 错的是结论，不是代码。
 */

describe('mcnemar · 配对二分类', () => {
  it('b=c 时 p=1（完全没差别）', () => {
    expect(mcnemar(5, 5).p).toBe(1);
    expect(mcnemar(0, 0).p).toBe(1);
  });

  it('b=10,c=0 ⇒ p=2*0.5^10=0.001953125（单侧全胜）', () => {
    expect(mcnemar(10, 0).p).toBeCloseTo(0.001953125, 10);
  });

  it('b=8,c=2 ⇒ p=2*(1+10+45)/1024=0.109375（手算核对）', () => {
    expect(mcnemar(8, 2).p).toBeCloseTo(0.109375, 10);
  });

  it('b 和 c 交换位置，p 必须相同（检验对方向对称）', () => {
    expect(mcnemar(12, 3).p).toBe(mcnemar(3, 12).p);
  });

  it('delta 是有符号的：谁更好要能读出来', () => {
    expect(mcnemar(12, 3).delta).toBeCloseTo(0.6, 10);
    expect(mcnemar(3, 12).delta).toBeCloseTo(-0.6, 10);
  });
});

describe('clusterDiffCI · 为什么必须按会话重采样', () => {
  /**
   * 构造「簇内完全相关」的数据：10 个会话各 3 题，同会话的题答案一模一样。
   * 这模拟真实情况 —— 同一会话的题常常一起答对或一起答错。
   */
  const pairs = [];
  for (let s = 0; s < 10; s++) {
    const d = s < 5 ? 1 : -1;   // 一半会话 A 更好，一半 B 更好 ⇒ 总体均值 0
    for (let k = 0; k < 3; k++) pairs.push({ target: "s" + s, a: d > 0 ? 1 : 0, b: d > 0 ? 0 : 1 });
  }
  const A = pairs.map((p) => p.a), B = pairs.map((p) => p.b);
  const q = pairedDiffCI(A, B);
  const c = clusterDiffCI(pairs);

  it('两种口径的点估计相同（都算同一批题）', () => {
    expect(q.mean).toBeCloseTo(0, 10);
    expect(c.mean).toBeCloseTo(0, 10);
  });

  it('★ 按题重采样的区间明显更窄（这就是假窄）', () => {
    const wq = q.hi - q.lo, wc = c.hi - c.lo;
    // 理论上窄 sqrt(3) 倍（30 题 vs 10 簇，簇内 3 题完全相关），给足余量只要 >1.3 倍
    expect(wq).toBeGreaterThan(0);
    expect(wc / wq).toBeGreaterThan(1.3);
  });

  it('簇数被如实报出来（下游要拿它算有效样本量）', () => {
    expect(c.clusters).toBe(10);
    expect(c.unit).toBe('cluster');
    expect(q.unit).toBe('question');
  });

  it('每题自成一个簇时，两种口径必须几乎一致（说明按簇不引入偏差）', () => {
    const solo = [];
    for (let i = 0; i < 40; i++) solo.push({ target: "t" + i, a: i % 3 === 0 ? 1 : 0, b: i % 4 === 0 ? 1 : 0 });
    const q2 = pairedDiffCI(solo.map((p) => p.a), solo.map((p) => p.b));
    const c2 = clusterDiffCI(solo);
    expect(Math.abs(c2.mean - q2.mean)).toBeLessThan(1e-9);
    expect(c2.clusters).toBe(40);
    // 宽度应在同一量级（给 1.6 倍余量，bootstrap 有随机性）
    expect((c2.hi - c2.lo) / (q2.hi - q2.lo)).toBeLessThan(1.6);
  });

  it('空输入返回 null，不抛（分析脚本不该因为没数据就崩）', () => {
    expect(clusterDiffCI([])).toBe(null);
    expect(pairedDiffCI([], [])).toBe(null);
  });
});
