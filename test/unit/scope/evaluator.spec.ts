import { describe, it, expect } from 'vitest';
import {
  compilePredicate,
  buildScopeFilter,
  escapeLikePrefix,
} from '../../../src/core/scope/evaluator.js';
import { createDb, insertSession } from '../../../src/store/db.js';

const ignore = { tags: ['sensitive'] };

describe('S4 谓词编译（规格 → SQL）', () => {
  it('topics/tags → json_each EXISTS + 参数序', () => {
    const w = compilePredicate({ topics: ['auth', 'db'] })!;
    expect(w.sql).toContain('json_each(s.topics)');
    expect(w.params).toEqual(['auth', 'db']);
  });

  it('files → 前缀 LIKE + 通配符转义', () => {
    expect(escapeLikePrefix('src/a%b_')).toBe('src/a\\%b\\_%');
    const w = compilePredicate({ files: ['src/db/'] })!;
    expect(w.sql).toContain("ESCAPE '\\'");
    expect(w.params).toEqual(['src/db/%']);
  });

  it('复合谓词 AND 连接，参数顺序稳定', () => {
    const w = compilePredicate({ sources: ['zcode'], since: '2026-08-01' })!;
    expect(w.sql).toContain('s.source IN (?)');
    expect(w.sql).toContain('s.created_at >= ?');
    expect(w.params).toEqual(['zcode', '2026-08-01']);
  });

  it('sessionIds → IN（attach 档）', () => {
    const w = compilePredicate({ sessionIds: ['a', 'b'] })!;
    expect(w.sql).toContain('s.id IN (?,?)');
  });

  it('空谓词 / null → 无约束', () => {
    expect(compilePredicate(null)).toBeNull();
    expect(compilePredicate({})).toBeNull();
  });
});

describe('S4 交集语义（方针 D5：只能互相收窄）', () => {
  it('ignore 永在第一位；B ∩ call 逐段 AND', () => {
    const w = buildScopeFilter({ ignore, b: { topics: ['auth'] }, call: { sources: ['zcode'] } })!;
    expect(w.sql).toContain('s.user_tags');
    expect(w.sql).toContain('s.topics');
    expect(w.sql).toContain('s.source IN (?)');
    expect(w.params).toEqual(['sensitive', 'auth', 'zcode']);
  });

  it('mode:full 逃生口丢弃 A/B/C 裁剪，但 ignore 不可解除', () => {
    const w = buildScopeFilter({
      ignore,
      b: { topics: ['auth'] },
      a: { since: '2026-08-01' },
      call: { mode: 'full' },
    })!;
    expect(w.sql).toContain('NOT'); // ignore 为排除片段
    expect(w.sql).toContain('s.user_tags');
    expect(w.sql).not.toContain('s.topics');
    expect(w.sql).not.toContain('s.created_at');
  });

  it('无任何谓词且无 ignore → null（全库）', () => {
    expect(buildScopeFilter({})).toBeNull();
  });
});

describe('S4 端到端（:memory: 库真实过滤）', () => {
  it('scoped 查询只返回 交集 - ignore 会话', () => {
    const db = createDb();
    insertSession(db, { id: 's1', source: 'claude-code', sourceSessionId: 'a1', projectId: 'p1', createdAt: '2026-08-20', topics: ['auth'], tags: [] });
    insertSession(db, { id: 's2', source: 'zcode', sourceSessionId: 'b1', projectId: 'p1', createdAt: '2026-08-25', topics: ['auth'] });
    insertSession(db, { id: 's3', source: 'zcode', sourceSessionId: 'c1', projectId: 'p1', createdAt: '2026-08-26', topics: ['db'] });
    insertSession(db, { id: 's4', source: 'zcode', sourceSessionId: 'd1', projectId: 'p1', createdAt: '2026-08-26', topics: ['auth'], tags: ['sensitive'] });

    const where = buildScopeFilter({
      b: { topics: ['auth'] },
      call: { sources: ['zcode'] },
      ignore,
    })!;
    const rows = db
      .prepare(`SELECT s.id FROM sessions s WHERE s.project_id = ? AND ${where.sql}`)
      .all('p1', ...where.params) as Array<{ id: string }>;

    // s1：非 zcode（call 收窄）；s3：无 auth（B 收窄）；s4：ignore 硬边界
    expect(rows.map((r) => r.id)).toEqual(['s2']);
  });
});
