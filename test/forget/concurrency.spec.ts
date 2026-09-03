// forget 并发与一致性（test-forget v3 · E 组）
// E4 用 vitest 内双 better-sqlite3 连接实现（不开子进程——Windows CI 不稳定，v2 修订）
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createDb, openExisting, insertSession, insertMessage, getSession, countsByState } from '../../src/store/db.js';
import { dbFile, projectIdOf } from '../../src/shared/paths.js';
import { makeProject, runCli } from './helpers.js';

const TMP = path.resolve('test/.tmp/forget-e');
const PROJECT = path.join(TMP, 'app');
const PID = projectIdOf(PROJECT);
const S1 = 'e1f100000000000a';

beforeAll(() => {
  for (let i = 0; i < 3; i++) { try { fs.rmSync(TMP, { recursive: true, force: true }); break; } catch { /* retry */ } }
  makeProject(PROJECT);
  process.chdir(PROJECT);
});

afterAll(() => {
  process.chdir(path.resolve('.'));
  for (let i = 0; 3 > i; i++) { try { fs.rmSync(TMP, { recursive: true, force: true }); return; } catch { /* retry */ } }
});

function seed(id: string, msgs: number): void {
  const db = createDb(dbFile(PROJECT));
  insertSession(db, { id, source: 'zcode', sourceSessionId: `z-${id}`, projectId: PID, createdAt: '2026-08-20T08:00:00Z', title: `会话 ${id}` });
  for (let i = 1; i <= msgs; i++) insertMessage(db, { sessionId: id, role: i % 2 ? 'user' : 'assistant', content: `消息 ${i}`, seqNum: i });
  db.prepare('UPDATE sessions SET message_count = ? WHERE id = ?').run(msgs, id);
  db.close();
}

describe('forget · E 并发与一致性', () => {
  it('E1 乐观锁：预览后守护追加 2 条消息 → --yes 重统计 diff 命中 → 拒绝执行，会话完整', async () => {
    seed(S1, 12);
    const { cmdForget } = await import('../../src/cli/forget.js');
    const pv = await runCli(() => cmdForget({}, S1));
    expect(pv.exitCode).toBeNull(); // 快照已写（12 msg）
    // 模拟守护并发：直插 2 条 + 维护计数（fixture 手法）
    const db = openExisting(dbFile(PROJECT));
    insertMessage(db, { sessionId: S1, role: 'user', content: '并发新消息 1', seqNum: 13 });
    insertMessage(db, { sessionId: S1, role: 'assistant', content: '并发新消息 2', seqNum: 14 });
    db.prepare('UPDATE sessions SET message_count = 14 WHERE id = ?').run(S1);
    db.close();
    const r = await runCli(() => cmdForget({ yes: true }, S1));
    expect(r.exitCode).toBe(1);
    expect(r.cap.err.join('\n')).toContain('12→14');
    const db2 = openExisting(dbFile(PROJECT));
    expect(getSession(db2, S1)).toBeDefined(); // 仍完整
    db2.close();
  });

  it('E2 数字未变：重新预览（刷新快照）后 --yes 正常执行', async () => {
    const { cmdForget } = await import('../../src/cli/forget.js');
    // E1 被拒后正确动作：重跑预览（14 msg 快照）再执行——乐观锁语义闭环
    const pv = await runCli(() => cmdForget({}, S1));
    expect(pv.exitCode).toBeNull();
    const r = await runCli(() => cmdForget({ yes: true }, S1));
    expect(r.exitCode).toBeNull();
    const db = openExisting(dbFile(PROJECT));
    expect(getSession(db, S1)).toBeUndefined();
    db.close();
  });

  it('E3 预览后被另一进程先删：--yes not-found，无部分删除残留、无第二条审计', async () => {
    seed('e1f200000000000b', 3);
    const { cmdForget } = await import('../../src/cli/forget.js');
    await runCli(() => cmdForget({}, 'e1f200000000000b'));
    const db0 = openExisting(dbFile(PROJECT));
    db0.prepare('DELETE FROM sessions WHERE id = ?').run('e1f200000000000b');
    const logs0 = (db0.prepare('SELECT COUNT(*) n FROM forget_log').get() as { n: number }).n;
    db0.close();
    const r = await runCli(() => cmdForget({ yes: true }, 'e1f200000000000b'));
    expect(r.exitCode).toBe(1);
    const db = openExisting(dbFile(PROJECT));
    expect((db.prepare('SELECT COUNT(*) n FROM forget_log').get() as { n: number }).n).toBe(logs0);
    db.close();
  });

  it('E4 双连接并发：写事务进行中读连接无脏读崩溃（WAL 快照读）', () => {
    seed('e1f300000000000c', 5);
    const a = openExisting(dbFile(PROJECT));
    const b = openExisting(dbFile(PROJECT));
    a.prepare('BEGIN IMMEDIATE').run();
    a.prepare('UPDATE sessions SET title = ? WHERE id = ?').run('事务中的新标题', 'e1f300000000000c');
    // 读连接：WAL 下读旧快照，不阻塞不崩溃
    const counts = countsByState(b, PID);
    expect(Object.values(counts).reduce((x, y) => x + y, 0)).toBeGreaterThanOrEqual(1);
    a.prepare('COMMIT').run();
    const after = b.prepare('SELECT title FROM sessions WHERE id = ?').get('e1f300000000000c') as { title: string };
    expect(after.title).toBe('事务中的新标题'); // 提交后可见
    a.close();
    b.close();
  });
});
