// Hook spool（R4）：session-end 事件 → 立即转 pending（跳过 idle 等待）
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createDb, insertSession, insertMessage, getSession } from '../../src/store/db.js';
import { writeHookEvent, consumeHookEvents } from '../../src/capture/hook-spool.js';
import { projectIdOf } from '../../src/shared/paths.js';

const TMP = path.resolve('test/.tmp/spool');
const PROJECT = path.join(TMP, 'app');
const PID = projectIdOf(PROJECT);

beforeAll(() => { fs.rmSync(TMP, { recursive: true, force: true }); fs.mkdirSync(PROJECT, { recursive: true }); });
afterAll(() => { fs.rmSync(TMP, { recursive: true, force: true }); });

describe('P2 · hook spool', () => {
  it('session-end 事件让 active 会话立即转 pending；文件消费后清理', () => {
    const db = createDb();
    insertSession(db, { id: 'h1', source: 'claude-code', sourceSessionId: 'uuid-abc', projectId: PID, createdAt: '2026-08-28T08:00:00Z', title: '钩子测试' });
    insertMessage(db, { sessionId: 'h1', role: 'user', content: '随便聊', seqNum: 1 });
    db.prepare('UPDATE sessions SET last_event_at = ? WHERE id = ?').run('2026-08-28T08:01:00Z', 'h1');

    writeHookEvent(PROJECT, 'session-end', 'uuid-abc');
    writeHookEvent(PROJECT, 'unknown-event', 'x');

    const r = consumeHookEvents(PROJECT, db, new Date('2026-08-28T08:02:00Z'));
    expect(r.consumed).toBe(2);
    expect(r.endSignals).toBe(1);
    expect(getSession(db, 'h1')!.state).toBe('pending_end');

    // spool 目录已清空；重复消费无副作用
    expect(fs.readdirSync(path.join(PROJECT, '.sessionrelay', 'events'))).toHaveLength(0);
    const r2 = consumeHookEvents(PROJECT, db, new Date());
    expect(r2.consumed).toBe(0);
    expect(getSession(db, 'h1')!.state).toBe('pending_end');
    db.close();
  });
});
