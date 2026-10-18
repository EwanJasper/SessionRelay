// 决策有效性旁表：同一键被取代后原条不返回、新条返回；
// 无旁表记录的老决策默认 active（兼容性最重要的一条）；回填幂等。
import { describe, it, expect, afterEach } from 'vitest';
import { createDb, listDecisions } from '../../src/store/db.js';
import type { DB } from '../../src/store/db.js';
import {
  decisionKey, markSuperseded, activeKeysOf, filterActive,
  backfillDecisionValidity, validityRowsOf,
} from '../../src/store/decision-validity.js';

const OLD = '用 x86 构建，暂时不上 arm64';
const NEW = '改用 arm64 构建（x86 本机构建太慢）';

function seed(decisions: Array<{ text: string; seq: number; at: string }>): DB {
  const db = createDb(':memory:') as unknown as DB;
  db.prepare('INSERT INTO sessions (id, source, source_session_id, project_id, state, title, created_at, message_count, decisions)'
    + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('s1', 'zcode', 's1', 'p', 'confirmed', 't', '2026-10-01T00:00:00Z', 3, JSON.stringify(decisions));
  return db;
}

afterEach(() => { delete process.env.SRELAY_SHOW_EXPIRED; });

describe('决策有效性 · 旁表过滤（检索主路径 listDecisions）', () => {
  it('被取代的旧决策不返回，新决策返回', () => {
    const db = seed([
      { text: OLD, seq: 1, at: '2026-10-01T01:00:00Z' },
      { text: NEW, seq: 2, at: '2026-10-02T01:00:00Z' },
    ]);
    markSuperseded(db, 's1', decisionKey(OLD), decisionKey(NEW), '2026-10-03T00:00:00Z');
    const texts = listDecisions(db, 'p').map((d) => d.text);
    expect(texts).toContain(NEW);
    expect(texts).not.toContain(OLD);
    db.close();
  });

  it('没有旁表记录的老决策默认 active（不能因为没回填就消失）', () => {
    const db = seed([
      { text: OLD, seq: 1, at: '2026-10-01T01:00:00Z' },
      { text: NEW, seq: 2, at: '2026-10-02T01:00:00Z' },
    ]);
    const texts = listDecisions(db, 'p').map((d) => d.text);
    expect(texts).toContain(OLD);
    expect(texts).toContain(NEW);
    expect(filterActive(db, 's1', [{ text: OLD }, { text: NEW }]).length).toBe(2);
    db.close();
  });

  it('SRELAY_SHOW_EXPIRED=1 看全史；默认关只看有效结论', () => {
    const db = seed([
      { text: OLD, seq: 1, at: '2026-10-01T01:00:00Z' },
      { text: NEW, seq: 2, at: '2026-10-02T01:00:00Z' },
    ]);
    markSuperseded(db, 's1', decisionKey(OLD), decisionKey(NEW), '2026-10-03T00:00:00Z');
    expect(listDecisions(db, 'p').some((d) => d.text === OLD)).toBe(false);
    process.env.SRELAY_SHOW_EXPIRED = '1';
    expect(listDecisions(db, 'p').some((d) => d.text === OLD)).toBe(true);
    db.close();
  });

  it('未回填过的旧键也能被 markSuperseded 置为失效（插 inactive 行）', () => {
    const db = seed([{ text: OLD, seq: 1, at: '2026-10-01T01:00:00Z' }]);
    const r = markSuperseded(db, 's1', decisionKey(OLD), decisionKey(NEW), '2026-10-03T00:00:00Z');
    expect(r.insertedOld).toBe(true);
    expect(r.insertedNew).toBe(true);
    const rows = validityRowsOf(db, 's1');
    const oldRow = rows.find((x) => x.decision_key === decisionKey(OLD));
    expect(oldRow?.active).toBe(0);
    expect(oldRow?.superseded_by).toBe(decisionKey(NEW));
    expect(activeKeysOf(db, 's1').has(decisionKey(OLD))).toBe(false);
    expect(activeKeysOf(db, 's1').has(decisionKey(NEW))).toBe(true);
    db.close();
  });
});

describe('决策有效性 · 回填（幂等）', () => {
  it('从 JSON 的 at 回填 valid_from；重复跑结果一样', () => {
    const db = seed([
      { text: OLD, seq: 1, at: '2026-10-01T01:00:00Z' },
      { text: NEW, seq: 2, at: '2026-10-02T01:00:00Z' },
    ]);
    const r1 = backfillDecisionValidity(db, { now: '2026-10-18T00:00:00Z' });
    expect(r1.inserted).toBe(2);
    const rows1 = validityRowsOf(db, 's1');
    expect(rows1.length).toBe(2);
    expect(rows1.every((r) => r.active === 1)).toBe(true);
    expect(rows1.find((r) => r.decision_key === decisionKey(OLD))?.valid_from).toBe('2026-10-01T01:00:00Z');
    const r2 = backfillDecisionValidity(db, { now: '2026-10-19T00:00:00Z' });
    expect(r2.inserted).toBe(0);
    expect(r2.existing).toBe(2);
    expect(validityRowsOf(db, 's1')).toEqual(rows1);
    db.close();
  });

  it('dryRun 只统计不写库（真库回填前先看数字）', () => {
    const db = seed([{ text: OLD, seq: 1, at: '2026-10-01T01:00:00Z' }]);
    const r = backfillDecisionValidity(db, { dryRun: true, now: '2026-10-18T00:00:00Z' });
    expect(r.dryRun).toBe(true);
    expect(r.inserted).toBe(1);
    expect(validityRowsOf(db, 's1').length).toBe(0);
    db.close();
  });
});

describe('决策有效性 · decisionKey 归一化（唯一一份）', () => {
  it('空白/标点/大小写/全角不影响键', () => {
    expect(decisionKey('PostgreSQL  好用！')).toBe(decisionKey('postgresql好用'));
    expect(decisionKey('ＡＢＣ １２３')).toBe(decisionKey('abc123'));
    expect(decisionKey('a|b｜c.d')).toBe(decisionKey('abcd'));
  });

  it('截断 40 字符（与 dedupKey 同长）', () => {
    expect(decisionKey('x'.repeat(100))).toHaveLength(40);
  });
});
