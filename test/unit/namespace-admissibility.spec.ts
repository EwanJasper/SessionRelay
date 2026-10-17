import { describe, it, expect } from 'vitest';
import { mergeByRoundRobin, admissible, type ProjectHits } from '../../src/search-svc/namespace.js';

const hit = (sessionId: string, score: number) => ({ sessionId, score, snippet: '', viaMeta: false, coverage: 0, seq: 0 });

const A: ProjectHits = { projectRoot: 'D:/p/a', projectName: 'a', hits: [hit('a1', 50), hit('a2', 40), hit('a3', 30)] };
const B: ProjectHits = { projectRoot: 'D:/p/b', projectName: 'b', hits: [hit('b1', 45), hit('b2', 35)] };
const C: ProjectHits = { projectRoot: 'D:/p/c', projectName: 'c', hits: [hit('c1', 20)] };

/**
 * admissibility（研究报告 §1.2 引 2610.07309）：
 *   「过滤跨项目条目」不得改变「项目内条目排序」
 * 这条性质必须**由构造成立**——不同项目库的 BM25 分数不可比，
 * 任何"按分数归一化再排"的做法都会引入一个单库测试验证不了的变换。
 */
describe('namespace 两态检索 · 合并必须可容许（admissible）', () => {
  it('项目内次序与原次序逐位相同（三项目混合）', () => {
    const merged = mergeByRoundRobin([A, B, C]);
    expect(admisibleAll(merged, [A, B, C])).toBe(true);
  });

  it('把别的项目过滤掉，剩下的序列与单库检索一致', () => {
    const merged = mergeByRoundRobin([A, B, C]);
    const onlyA = merged.filter((h) => h.projectRoot === A.projectRoot).map((h) => h.sessionId);
    const single = A.hits.map((h) => h.sessionId);
    expect(onlyA).toEqual(single.slice(0, onlyA.length));
  });

  it('首条分数只决定项目出场顺序，不重排组内', () => {
    const low: ProjectHits = { projectRoot: 'D:/p/x', projectName: 'x', hits: [hit('x1', 1), hit('x2', 99)] };
    const high: ProjectHits = { projectRoot: 'D:/p/y', projectName: 'y', hits: [hit('y1', 100)] };
    const merged = mergeByRoundRobin([low, high]);
    // x2 分数更高，但 x1 必须仍在 x2 之前（组内不许重排）
    const xs = merged.filter((h) => h.projectName === 'x').map((h) => h.sessionId);
    expect(xs).toEqual(['x1', 'x2']);
  });

  it('轮转保证小项目不会被大项目淹没', () => {
    const big: ProjectHits = {
      projectRoot: 'D:/p/big', projectName: 'big',
      hits: Array.from({ length: 10 }, (_, i) => hit('big' + i, 100 - i)),
    };
    const merged = mergeByRoundRobin([big, C], 4);
    expect(merged.map((h) => h.sessionId)).toEqual(['big0', 'c1', 'big1', 'big2']);
  });

  it('limit 生效且不死循环（有空项目 / 全空项目）', () => {
    const empty: ProjectHits = { projectRoot: 'D:/p/e', projectName: 'e', hits: [] };
    expect(mergeByRoundRobin([], 10)).toEqual([]);
    expect(mergeByRoundRobin([empty], 10)).toEqual([]);
    expect(mergeByRoundRobin([A, empty, B], 3).length).toBe(3);
  });

  it('反例：组内真被改序时，admissible 必须判定为假（防止判据本身失效）', () => {
    const merged = mergeByRoundRobin([A, B, C]);
    // ⚠️ 这里有个反直觉的事实（我第一版写成"按分数全局排序"当反例，结果测试红了）：
    //   只要每个项目内部本来就是分数降序的，**全局按分数排序也是可容许的** ——
    //   它不会改变任何组内的相对次序。所以"不能按分数排序"这个说法不成立，
    //   真正的风险是任何**组内**重排。反例必须真的动组内次序。
    const bad = [...merged];
    const ia = bad.findIndex((h) => h.sessionId === 'a1');
    const ib = bad.findIndex((h) => h.sessionId === 'a2');
    const t = bad[ia]; bad[ia] = bad[ib]; bad[ib] = t;   // 交换 A 的两条
    expect(admissible(bad, A)).toBe(false);
    expect(admissible(bad, B)).toBe(true);               // 只破坏 A，B 仍可容许
  });
});

function admisibleAll(merged: ReturnType<typeof mergeByRoundRobin>, singles: ProjectHits[]): boolean {
  return singles.every((s) => admissible(merged, s));
}
