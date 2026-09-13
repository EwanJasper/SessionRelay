// zcode adapter 游标竞态回归（用户实报：assistant 消息整批丢失）
// 机制：ZCode 先写 message 行、text part 流式后到；旧实现读到空正文行时游标照样
// 越过，正文落库后永久丢失。修复：宽限期（10min）内游标停在第一个空正文行之前。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { readNew, resetConn } from '../../src/adapters/zcode/index.js';

const TMP = path.resolve('test/.tmp/zcode-race');
const DB = path.join(TMP, 'db.sqlite');

let z: Database.Database;
let seq = 0;

beforeAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  z = new Database(DB);
  z.exec(`
    CREATE TABLE session (id text primary key, project_id text, directory text not null, title text not null,
                          time_created integer not null, time_updated integer not null);
    CREATE TABLE message (id text primary key, session_id text not null, time_created integer not null,
                          data text not null, sequence integer);
    CREATE TABLE part (id text primary key, message_id text not null, session_id text not null,
                       time_created integer, time_updated integer, data text not null, sequence integer);
  `);
});
afterAll(() => { resetConn(); z.close(); fs.rmSync(TMP, { recursive: true, force: true }); });

let sessionN = 0;
function freshSession(): { sid: string; ds: { source: string; sourceSessionId: string; sourceFile: string; sizeBytes: number; mtimeMs: number } } {
  const sid = `sess_race_${++sessionN}`;
  z.prepare('INSERT INTO session VALUES (?,?,?,?,?,?)').run(sid, 'proj', 'D:/x', '竞态会话', Date.now(), Date.now());
  return { sid, ds: { source: 'zcode', sourceSessionId: sid, sourceFile: `zcode:${sid}`, sizeBytes: 0, mtimeMs: Date.now() } };
}

function addMsg(sid: string, id: string, role: 'user' | 'assistant', text: string | null, at = Date.now()) {
  z.prepare('INSERT INTO message VALUES (?,?,?,?,?)').run(id, sid, at, JSON.stringify({ role, time: { created: at } }), ++seq);
  if (text !== null) {
    z.prepare('INSERT INTO part VALUES (?,?,?,?,?,?,?)').run(`${id}_p0`, id, sid, at, at, JSON.stringify({ type: 'text', text }), 0);
  }
}
const rowidOf = (id: string) => (z.prepare('SELECT rowid FROM message WHERE id = ?').get(id) as { rowid: number }).rowid;

describe('zcode adapter · 游标竞态（streaming part 延迟落库）', () => {
  it('R1 user 立即可读；assistant 正文未到 → 跳过但游标停在它之前；part 到达后下轮读到', () => {
    const { sid, ds } = freshSession();
    const now = Date.now();
    addMsg(sid, 'u1', 'user', '用户提问', now - 5000);
    addMsg(sid, 'a1', 'assistant', null, now - 3000); // assistant 行已写，正文 part 未到
    // 第一轮：只有 user；游标不得越过 a1
    const r1 = readNew(ds, DB, {});
    expect(r1.messages.map((m) => m.role)).toEqual(['user']);
    expect(r1.cursor.rowid).toBeLessThan(rowidOf('a1')); // 修复前 = a1.rowid（越过即丢失）
    // 第二轮：正文到达（模拟流式完成）
    z.prepare('INSERT INTO part VALUES (?,?,?,?,?,?,?)').run('a1_p0', 'a1', sid, now, now, JSON.stringify({ type: 'text', text: 'assistant 的回答' }), 0);
    const r2 = readNew(ds, DB, r1.cursor);
    expect(r2.messages.map((m) => m.role)).toEqual(['assistant']); // 追回
    expect(r2.messages[0].content).toBe('assistant 的回答');
  });

  it('R2 已插入消息重扫幂等：正常推进后不重出', () => {
    const { sid, ds } = freshSession();
    const now = Date.now();
    addMsg(sid, 'u2', 'user', '第二轮提问', now - 1000);
    const r1 = readNew(ds, DB, {});
    expect(r1.messages.length).toBe(1);
    const r2 = readNew(ds, DB, r1.cursor);
    expect(r2.messages.length).toBe(0); // 游标已到底，无重扫重出
  });

  it('R3 过宽限（10min）的空行不再拖住游标（防永久停滞）', () => {
    const { sid, ds } = freshSession();
    const now = Date.now();
    addMsg(sid, 'a3', 'assistant', null, now - 15 * 60_000); // 15 分钟前的空 assistant 行：等不到了
    addMsg(sid, 'u3', 'user', '第三轮', now - 1000);
    const r = readNew(ds, DB, {});
    expect(r.cursor.rowid).toBeGreaterThanOrEqual(rowidOf('a3')); // 越过（放弃等待）
    expect(r.messages.map((m) => m.role)).toEqual(['user']);
  });

  it('R4 竞态全周期：断档后的历史空行过宽限 → 新消息正常推进', () => {
    const { sid, ds } = freshSession();
    const now = Date.now();
    // 模拟真实受害现场：一批历史空 assistant 行（已过宽限）
    for (let i = 0; i < 3; i++) addMsg(sid, `old${i}`, 'assistant', null, now - 20 * 60_000);
    addMsg(sid, 'u4', 'user', '新提问', now - 1000);
    const r1 = readNew(ds, DB, {});
    expect(r1.messages.map((m) => m.role)).toEqual(['user']); // 历史空行不阻塞新消息
    expect(r1.cursor.rowid).toBeGreaterThanOrEqual(rowidOf('u4'));
  });
});
