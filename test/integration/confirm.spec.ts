// Phase 2 验收：resume 后摘要正确重算；决策列表含出处（方针 §十二 Phase 2）
import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, insertSession, insertMessage, confirmSession, rollbackSession,
         listDecisions, listUnresolved, getSession } from '../../src/store/db.js';
import { searchSessions } from '../../src/search-svc/engine.js';
import { runSync } from '../../src/capture/sync.js';
import { runJudge } from '../../src/capture/judge.js';
import { defaultConfig, type RelayConfig } from '../../src/shared/config.js';
import { projectIdOf } from '../../src/shared/paths.js';

const PROJECT = 'C:\\proj\\demo';
const PID = projectIdOf(PROJECT);

let cfg: RelayConfig;
beforeEach(() => {
  cfg = { ...defaultConfig(), capture: { ...defaultConfig().capture, claude_projects_dir: 'Z:\\不存在', zcode_db_path: 'Z:\\不存在', sources: [] } };
});

describe('P2 · confirmed 副作用（提取 + summary_rule + meta_text）', () => {
  it('judge 冷却确认后：决策/话题/文件落库，决策含出处，摘要生成，话题可搜', () => {
    const db = createDb();
    insertSession(db, { id: 's1', source: 'claude-code', sourceSessionId: 'x1', projectId: PID, createdAt: '2026-08-20T08:00:00Z', title: '架构讨论' });
    insertMessage(db, { sessionId: 's1', role: 'user', content: '数据库和索引怎么设计？', seqNum: 1, createdAt: '2026-08-20T08:00:00Z' });
    insertMessage(db, { sessionId: 's1', role: 'assistant', content: '决定采用 PostgreSQL，索引用 B+树。相关文件 src/db/schema.sql', seqNum: 2, createdAt: '2026-08-20T08:05:00Z' });
    db.prepare('UPDATE sessions SET last_event_at = ? WHERE id = ?').run('2026-08-20T08:05:00Z', 's1');
    db.prepare('UPDATE sessions SET state = ?, pending_at = ? WHERE id = ?').run('pending_end', '2026-08-20T08:06:00Z', 's1');

    const j = runJudge(db, { projectId: PID, now: new Date('2026-08-20T20:00:00Z'), idleMin: 10, cooldownH: 6 });
    expect(j.confirmed).toBe(1);

    const s = getSession(db, 's1')!;
    expect(s.state).toBe('confirmed');
    expect(s.summary_rule).toBeTruthy();
    expect(s.summary_rule).toContain('PostgreSQL');

    // 决策含出处（验收标准）
    const decs = listDecisions(db, PID);
    expect(decs.length).toBeGreaterThanOrEqual(1);
    expect(decs[0].text).toContain('PostgreSQL');
    expect(decs[0].sessionId).toBe('s1');
    expect(decs[0].seq).toBe(2);

    // 话题进 meta_text → 可按话题搜到（元数据命中）
    const hits = searchSessions(db, { project: PID, query: '索引' });
    expect(hits.map(h => h.sessionId)).toContain('s1');

    // files 落库
    const files = JSON.parse((db.prepare('SELECT files_mentioned FROM sessions WHERE id=?').get('s1') as { files_mentioned: string }).files_mentioned);
    expect(files).toContain('src/db/schema.sql');
    db.close();
  });

  it('验收：resume 后摘要与元数据正确重算（旧摘要清除 → 新内容重提取）', () => {
    const db = createDb();
    insertSession(db, { id: 's2', source: 'zcode', sourceSessionId: 'z1', projectId: PID, createdAt: '2026-08-21T08:00:00Z', title: '认证讨论' });
    insertMessage(db, { sessionId: 's2', role: 'user', content: '认证方案选哪个？', seqNum: 1, createdAt: '2026-08-21T08:00:00Z' });
    insertMessage(db, { sessionId: 's2', role: 'assistant', content: '决定采用 Session 方案', seqNum: 2, createdAt: '2026-08-21T08:05:00Z' });
    db.prepare('UPDATE sessions SET last_event_at = ? WHERE id = ?').run('2026-08-21T08:05:00Z', 's2');
    confirmSession(db, 's2', '2026-08-21T09:00:00Z');
    expect(getSession(db, 's2')!.summary_rule).toContain('Session');

    // resume：追加新决策，回滚清摘要
    insertMessage(db, { sessionId: 's2', role: 'assistant', content: '补充：最终改用 JWT，放弃 Session。', seqNum: 3, createdAt: '2026-08-22T10:00:00Z' });
    rollbackSession(db, 's2');
    expect(getSession(db, 's2')!.summary_rule).toBeNull();
    expect(getSession(db, 's2')!.state).toBe('active');

    // 再确认 → 基于全量 3 条消息重算，新决策出现
    confirmSession(db, 's2', '2026-08-22T18:00:00Z');
    const s = getSession(db, 's2')!;
    expect(s.state).toBe('confirmed');
    const decs = listDecisions(db, PID, { source: 'zcode' });
    expect(decs.some(d => d.text.includes('JWT'))).toBe(true);
    expect(decs.some(d => d.text.includes('Session'))).toBe(true);
    db.close();
  });

  it('未决问题查询（尾部/含待定词标记）', () => {
    const db = createDb();
    insertSession(db, { id: 's3', source: 'claude-code', sourceSessionId: 'x3', projectId: PID, createdAt: '2026-08-22T08:00:00Z', title: '部署' });
    insertMessage(db, { sessionId: 's3', role: 'user', content: '为什么要用 ECS？', seqNum: 1, createdAt: '2026-08-22T08:00:00Z' });
    insertMessage(db, { sessionId: 's3', role: 'assistant', content: '因为规模小运维成本低。', seqNum: 2, createdAt: '2026-08-22T08:05:00Z' });
    insertMessage(db, { sessionId: 's3', role: 'user', content: '限流策略还没定，要不要下期再说？', seqNum: 3, createdAt: '2026-08-22T08:10:00Z' });
    db.prepare('UPDATE sessions SET last_event_at = ? WHERE id = ?').run('2026-08-22T08:10:00Z', 's3');
    confirmSession(db, 's3', '2026-08-22T09:00:00Z');
    const un = listUnresolved(db, PID);
    expect(un.length).toBeGreaterThanOrEqual(1);
    expect(un.some(u => u.q.includes('限流'))).toBe(true);
    db.close();
  });
});
