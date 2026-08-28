// S1 出口验收：方针 §14.1 中文检索用例 C1-C6，真实 SQLite + FTS5 + jieba。
import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, insertSession, insertMessage, type DB } from '../../src/store/db.js';
import { searchSessions } from '../../src/search-svc/engine.js';
import { toSearchText } from '../../src/core/tokenize/tokenizer.js';

let db: DB;

beforeEach(() => {
  db = createDb();
  const sessions: Array<{
    sid: string;
    createdAt: string;
    topics?: string[];
    metaText?: string;
    msgs: Array<[string, string]>;
  }> = [
    {
      sid: 's1', createdAt: '2026-08-20', topics: ['db'],
      msgs: [
        ['user', '我们讨论了建索引的方案'],
        ['assistant', '索引策略选 B+树，建索引时注意最左前缀'],
      ],
    },
    {
      sid: 's2', createdAt: '2026-08-21', topics: ['auth'],
      msgs: [
        ['user', '认证方案定了吗'],
        ['assistant', '用 JWT 做认证，微服务间无法共享 Session'],
      ],
    },
    {
      sid: 's3', createdAt: '2026-08-22', topics: ['auth'],
      msgs: [['user', 'JWT 过期时间设为 30 分钟']],
    },
    {
      sid: 's4', createdAt: '2026-08-23', topics: ['db'],
      msgs: [
        ['user', '数据库选型讨论'],
        ['assistant', '按月分区方案适合按月增长的数据'],
      ],
    },
    {
      // C5 反例：包含"分区"与"按月"但非相邻出现
      sid: 's7', createdAt: '2026-08-24', topics: ['misc'],
      msgs: [['user', '先按月汇总，再谈分区表的维护']],
    },
  ];
  for (const s of sessions) {
    insertSession(db, {
      id: s.sid, source: 'claude-code', sourceSessionId: s.sid, projectId: 'p1',
      createdAt: s.createdAt, topics: s.topics,
    });
    s.msgs.forEach(([role, content], i) => {
      insertMessage(db, { sessionId: s.sid, role, content, seqNum: i + 1 });
    });
  }
  // C6：meta 模式会话（无正文，仅 title/topics 入 sessions_fts）
  insertSession(db, {
    id: 's5', source: 'zcode', sourceSessionId: 'z9', projectId: 'p1',
    createdAt: '2026-08-25', topics: ['auth'],
    metaText: toSearchText('认证方案评审 auth'),
  });
  // 项目隔离对照：同文案的另一个项目
  insertSession(db, { id: 'x1', source: 'claude-code', sourceSessionId: 'x1', projectId: 'p2', createdAt: '2026-08-26', topics: ['auth'] });
  insertMessage(db, { sessionId: 'x1', role: 'user', content: '认证方案与索引', seqNum: 1 });
});

const ids = (q: string) => searchSessions(db, { project: 'p1', query: q }).map((h) => h.sessionId);

describe('S1 中文检索验收 C1-C6（方针 §14.1，Phase 1 合并门槛）', () => {
  it('C1 「索引」命中含"建索引/索引策略"的会话', () => {
    expect(ids('索引')).toContain('s1');
  });

  it('C2 「认证方案」命中含"用 JWT 做认证"的会话', () => {
    expect(ids('认证方案')).toContain('s2');
  });

  it('C3 「JWT 过期」中英混合正文可查', () => {
    expect(ids('JWT 过期')).toContain('s3');
  });

  it('C4 「数据库 分区」跨消息 AND：s4 命中、仅含"分区"的 s7 排除', () => {
    const hits = ids('数据库 分区');
    expect(hits).toContain('s4');
    expect(hits).not.toContain('s7');
  });

  it('C5 短语 "按月分区"：s4 命中、词序不符的 s7 排除', () => {
    const hits = ids('"按月分区"');
    expect(hits).toContain('s4');
    expect(hits).not.toContain('s7');
  });

  it('C6 meta 模式会话仅靠 title/topics 命中（无正文）', () => {
    const hits = searchSessions(db, { project: 'p1', query: '认证方案' });
    const s5 = hits.find((h) => h.sessionId === 's5');
    expect(s5).toBeDefined();
    expect(s5!.viaMeta).toBe(true);
  });

  it('项目隔离：p2 会话不出现在 p1 结果中', () => {
    expect(ids('认证方案')).not.toContain('x1');
  });

  it('AND 零命中 → OR 兜底（部分关键词仍可召回，Spike 决策）', () => {
    // s2 无 "RS256"，AND 必空；兜底后凭"微服务"召回
    const hits = searchSessions(db, { project: 'p1', query: 'RS256 微服务' });
    const s2 = hits.find((h) => h.sessionId === 's2');
    expect(s2).toBeDefined();
    expect(s2!.coverage).toBeLessThan(1);
  });

  it('结果携带出处（snippet 非空，正文命中时）', () => {
    const hits = searchSessions(db, { project: 'p1', query: '索引' });
    expect(hits[0].snippet.length).toBeGreaterThan(0);
  });
});
