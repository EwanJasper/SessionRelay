// [1015 夜 · 语义档实测] 语义补充命中的**槽位保底**（修 bug 的现场记录）。
//
// 原实现：语义命中在 sort 之后 push，最后统一 slice(0, limit) ⇒ FTS 命中一旦 ≥ limit，
// 语义命中被整段切掉（分数给到 999 也进不来）——「换一种说法也能命中」结构性不可达。
// 现实现：保底 min(reserve, floor(limit/3)) 个槽位，从 FTS **尾部** 腾，头部一条不动；
// reserve=0 逐字回到旧行为（config: semantic.reserve_slots）。
//
// 实测背景（2026-10-15 深夜）：20 条大白话问句在 583 场库里 3 条完全找不到
// （board.mmd / source.kind / bigram），打开语义档在旧实现下救不了这 3 条。
import { describe, it, expect } from 'vitest';
import { createDb, insertImportedSession, insertImportedMessage } from '../../src/store/db.js';
import { searchSessions } from '../../src/search-svc/engine.js';

const mk = (db: ReturnType<typeof createDb>, sid: string, title: string, content: string) => {
  const { id } = insertImportedSession(db, {
    source: 'dsh', sourceSessionId: sid, projectId: 'p', title,
    createdAt: '2026-10-15T00:00:00.000Z', lastEventAt: '2026-10-15T00:00:00.000Z',
    messageCount: 1, topics: [], decisions: [], summaryRule: null,
    author: null, importedFrom: null, originProject: null, contentHash: null, sourceFile: null,
  });
  insertImportedMessage(db, id, { seq: 1, role: 'user', content });
  return id;
};

/** n 场含检索词的会话 + 1 场「换词靶子」（一个检索词都不含——模拟只有语义档才找得到的会话） */
function seed(n: number) {
  const db = createDb(':memory:');
  for (let i = 0; i < n; i++) mk(db, 'hit' + i, '命中会话 ' + i, '记忆简报 记忆简报 第' + i + '场');
  const targetId = mk(db, 'semantic-target', '换词靶子', '完全无关的另一种说法，一个字都不重叠');
  return { db, targetId };
}

describe('[1015 夜] 语义档槽位保底', () => {
  it('① FTS 命中已满 limit 时：语义命中仍保底进来（修复后）', () => {
    const { db, targetId } = seed(20);
    const hits = searchSessions(db, {
      project: 'p', query: '记忆简报', limit: 10,
      semanticHits: [{ sessionId: targetId, score: 1 }],
    });
    expect(hits.length).toBe(10);
    expect(hits.some((h) => h.viaSemantic && h.sessionId === targetId)).toBe(true);
  });

  it('② 保底只从尾部腾：FTS 头部与前 9 条一条不被挤掉', () => {
    const { db, targetId } = seed(20);
    const base = searchSessions(db, { project: 'p', query: '记忆简报', limit: 10 });
    const withSem = searchSessions(db, {
      project: 'p', query: '记忆简报', limit: 10,
      semanticHits: [{ sessionId: targetId, score: 1 }],
    });
    // 只让出 1 个槽位（语义只有 1 条，take=1）⇒ FTS 前 9 条逐条保留、顺序不变
    expect(withSem.slice(0, 9).map((h) => h.sessionId)).toEqual(base.slice(0, 9).map((h) => h.sessionId));
    expect(withSem[9].viaSemantic).toBe(true);
  });

  it('③ reserve=0：逐字回到旧行为（只追加，被 slice 切掉）', () => {
    const { db, targetId } = seed(20);
    const hits = searchSessions(db, {
      project: 'p', query: '记忆简报', limit: 10, semanticReserve: 0,
      semanticHits: [{ sessionId: targetId, score: 999 }],
    });
    expect(hits.length).toBe(10);
    expect(hits.some((h) => h.sessionId === targetId)).toBe(false);
  });

  it('④ FTS 命中不足 limit 时：语义命中照常露头', () => {
    const { db, targetId } = seed(3);
    const hits = searchSessions(db, {
      project: 'p', query: '记忆简报', limit: 10,
      semanticHits: [{ sessionId: targetId, score: 1 }],
    });
    expect(hits.some((h) => h.viaSemantic && h.sessionId === targetId)).toBe(true);
  });

  it('⑤ 对照：不传 semanticHits 时行为与纯 FTS 完全一致（不启用零变化）', () => {
    const { db } = seed(20);
    const a = searchSessions(db, { project: 'p', query: '记忆简报', limit: 10 });
    const b = searchSessions(db, { project: 'p', query: '记忆简报', limit: 10, semanticHits: null });
    expect(a.map((h) => h.sessionId)).toEqual(b.map((h) => h.sessionId));
  });
});
