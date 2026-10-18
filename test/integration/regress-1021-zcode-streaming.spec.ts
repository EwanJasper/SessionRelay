// #04 回归：ZCode 流式回答的**半截正文**必须能被追平（1021 适配器组）
//
// 病历（docs/1021-红队审计-RT.md #04 + 适配器组复核）：
//   ZCode 先写 message 行、text part 流式后到，**同一条 part 的正文原地从半截变完整**（rowid 不变）。
//   旧实现两道闸都看不见 UPDATE：
//     · changeProbe 只看 MAX(rowid) ⇒ 签名不变 ⇒ runSync 直接跳过该会话，readNew 根本不被调用；
//     · readNew 只查 rowid > 游标 ⇒ 就算被调用也读不到已经越过的那一行。
//   结果：库里永久停在半截（实测：第二次 readNew 0 条、探针 1/1 → 1/1 不变）。
//
// 修前会红：
//   · 回退 readNew 的 pending 重读分支（或换回 commit 60c5de0 之前的 src/adapters/zcode/index.ts）
//     ⇒ 用例① 拿到 0 条、用例② 的 updatedMessages 恒为 0、正文永远「结论是半截」。
//   · 只回退 changeProbe（改回 MAX(rowid)）⇒ 用例① 仍绿、用例② 红（runSync 被水位线跳过）。
//
// 用例全部用**临时假库**（schema 照真实 ZCode 库：message/part 都有 time_created + time_updated），
// 不碰真实数据、不发网络请求。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { adapter, readNew, resetConn } from '../../src/adapters/zcode/index.js';
import { createDb } from '../../src/store/db.js';
import { runSync } from '../../src/capture/sync.js';

const HALF = '结论是半截';
const FULL = '结论是半截……全文完整了：最后决定用 30 天';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'srelay-r1021-stream-'));
});
afterEach(() => {
  resetConn();
  delete process.env.ZCODE_DB_PATH;
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 清理失败不影响判据 */ }
});

function makeDb(dbPath: string): Database.Database {
  const z = new Database(dbPath);
  z.exec(`
    CREATE TABLE session (id text primary key, project_id text, directory text not null, title text not null,
                          time_created integer not null, time_updated integer not null, task_type text);
    CREATE TABLE message (id text primary key, session_id text not null, time_created integer not null,
                          time_updated integer not null, data text not null, sequence integer);
    CREATE TABLE part (id text primary key, message_id text not null, session_id text not null,
                       time_created integer not null, time_updated integer not null, data text not null, sequence integer);
  `);
  return z;
}

function seedHalfResponse(z: Database.Database, sessionId: string, projectRoot: string): number {
  const t0 = Date.now() - 5_000;
  z.prepare('INSERT INTO session VALUES (?,?,?,?,?,?,?)').run(sessionId, 'p', projectRoot, '流式会话', t0, t0, 'interactive');
  z.prepare('INSERT INTO message VALUES (?,?,?,?,?,?)').run('m1', sessionId, t0, t0, JSON.stringify({ role: 'assistant' }), 1);
  z.prepare('INSERT INTO part VALUES (?,?,?,?,?,?,?)').run('p1', 'm1', sessionId, t0, t0,
    JSON.stringify({ type: 'text', text: HALF }), 0);
  return t0;
}

/** 模拟流式完成：同一条 part 原地变完整（rowid 不变，只有 time_updated 往前推） */
function completeResponse(z: Database.Database): void {
  z.prepare('UPDATE part SET data = ?, time_updated = ? WHERE id = ?')
    .run(JSON.stringify({ type: 'text', text: FULL }), Date.now(), 'p1');
}

describe('#04 · ZCode 流式半截正文', () => {
  it('① 同一条 part 原地更新后，readNew 能重读并拿到完整正文（且 seqNum 不变）', () => {
    const dbPath = path.join(root, 'db.sqlite');
    const z = makeDb(dbPath);
    const t0 = seedHalfResponse(z, 's1', root);
    const ds = { source: 'zcode', sourceSessionId: 's1', sourceFile: 'zcode:s1', sizeBytes: 0, mtimeMs: t0 };

    const r1 = readNew(ds, dbPath, {});
    expect(r1.messages.map((m) => m.content)).toEqual([HALF]);

    // 探针必须能看见「原地更新」——否则 runSync 本轮直接跳过，readNew 压根不会被调用
    const sig1 = adapter.changeProbe?.({ dbPath })?.get('s1');
    completeResponse(z);
    const sig2 = adapter.changeProbe?.({ dbPath })?.get('s1');
    expect(sig1).toBeTruthy();
    expect(sig2, 'changeProbe 必须反映 part 的原地 UPDATE（修前只取 MAX(rowid)，这里恒等）').not.toBe(sig1);

    const r2 = readNew(ds, dbPath, r1.cursor);
    // 修前这里恒为 0 条：游标已越过 m1，而 rowid 没变
    expect(r2.messages).toHaveLength(1);
    expect(r2.messages[0].content).toBe(FULL);
    expect(r2.messages[0].seqNum).toBe(1);
    z.close();
  });

  it('② 端到端：半截 → 原地更新 → 再 runSync → 库里是完整正文，且不算新增消息', async () => {
    const dbPath = path.join(root, 'db.sqlite');
    const z = makeDb(dbPath);
    seedHalfResponse(z, 's1', root);
    process.env.ZCODE_DB_PATH = dbPath;   // zcodeDbPath() 优先读环境变量

    const relay = createDb(':memory:');
    const cfg = { capture: { mode: 'full', sources: ['zcode'] }, identity: { project_id: 'proj_regress_1021' } };
    try {
      const s1 = await runSync({ projectRoot: root, config: cfg as never, db: relay });
      expect(s1.newMessages).toBe(1);
      const stored1 = relay.prepare('SELECT content FROM messages').all() as Array<{ content: string }>;
      expect(stored1.map((r) => r.content)).toEqual([HALF]);

      completeResponse(z);
      resetConn();   // 让只读连接重新打开，保证读到 WAL 里的更新（真实守护是长连接 + 每轮 busy_timeout）

      const s2 = await runSync({ projectRoot: root, config: cfg as never, db: relay });
      // 修前：updatedMessages 恒 0（readNew 返回 0 条，根本没东西可覆盖），正文永远停半截
      expect(s2.updatedMessages, '覆盖必须被计数（否则「重读并覆盖」又成了静默行为）').toBe(1);
      expect(s2.newMessages, '覆盖不是新增').toBe(0);

      const stored2 = relay.prepare('SELECT content FROM messages').all() as Array<{ content: string }>;
      expect(stored2.map((r) => r.content)).toEqual([FULL]);
      const count = relay.prepare("SELECT message_count AS n FROM sessions WHERE source = 'zcode'").get() as { n: number };
      expect(count.n, '覆盖不许把 message_count 撑大').toBe(1);
    } finally {
      relay.close();
      z.close();
    }
  });
});