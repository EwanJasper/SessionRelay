// [1015 夜 · 外部报告 §4.5] 抽取快照与零标注 Diff：双向断言
// ① 同一库两次快照 → 零差异（否则门禁会天天误报）
// ② 人为改一条 → 必须精确报出 removed/added（否则门禁是摆设）
import { describe, it, expect } from 'vitest';
import { createDb } from '../../src/store/db.js';
import type { DB } from '../../src/store/db.js';
import { diffSnapshots } from '../../src/cli/bench.js';

const mk = (decisions: string[], questions: string[] = []) => ({
  meta: { extractVersion: 18, extractMd5: 'x', dbBytes: 1, dbMtime: '', sessions: 1, takenAt: '', root: '/p' },
  decisions, questions,
}) as never;

describe('[1015 夜] bench-extract 的 diff', () => {
  it('① 同一集合 → 零差异', () => {
    const d = diffSnapshots(mk(['a', 'b']), mk(['a', 'b']));
    expect(d.removed.decisions).toEqual([]);
    expect(d.added.decisions).toEqual([]);
  });
  it('② 删一条、加一条 → 精确报出', () => {
    const d = diffSnapshots(mk(['a', 'b']), mk(['a', 'c']));
    expect(d.removed.decisions).toEqual(['b']);
    expect(d.added.decisions).toEqual(['c']);
  });
  it('③ 未决通道独立统计（不许合并成一个数）', () => {
    const d = diffSnapshots(mk([], ['q1']), mk([], ['q2']));
    expect(d.removed.questions).toEqual(['q1']);
    expect(d.added.questions).toEqual(['q2']);
    expect(d.removed.decisions).toEqual([]);
  });
  it('④ 空库也能跑（不给假差异）', () => {
    const db = createDb(':memory:') as unknown as DB;
    expect(db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toBeTruthy();
    const d = diffSnapshots(mk([]), mk([]));
    expect(d.removed.decisions.length + d.added.decisions.length).toBe(0);
    db.close();
  });
});
