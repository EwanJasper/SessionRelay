// #05 回归：ZCode 库是 WAL 模式，**新增先落 -wal**，discover 的缓存不能只看主库 mtime（1021 适配器组）
//
// 病历（docs/1021-红队审计-RT.md #05）：discover 的缓存键是 `fs.statSync(dbPath).mtimeMs`。
//   WAL 模式下插入只写 `-wal`，**主库文件 mtime 一个字节都不动** ⇒ 缓存永远命中旧列表，
//   第 2 个会话在 SQL 里明明查得到、适配器却始终报 1 个。
//   本机实测：插一行后主库 mtime 仍是 1792257069983.0781，而 -wal 从 12392B → 16512B。
//
// 修前会红：把 src/adapters/zcode/index.ts 的 dbSig 换回 `fs.statSync(dbPath).mtimeMs`（或回退 60c5de0）
//   ⇒ 本用例第二次 discover 仍只有 sess1（断言 toEqual 失败）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { discover, resetConn } from '../../src/adapters/zcode/index.js';

let root: string;
let z: Database.Database | null = null;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'srelay-r1021-wal-'));
});
afterEach(() => {
  resetConn();
  try { z?.close(); } catch { /* 已关 */ }
  z = null;
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 清理失败不影响判据 */ }
});

describe('#05 · discover 必须看见 WAL 里的新增', () => {
  it('第 2 个会话只写进 -wal（主库 mtime 不变）时，discover 也要发现它', () => {
    const dbPath = path.join(root, 'db.sqlite');
    z = new Database(dbPath);
    const mode = z.pragma('journal_mode = WAL') as Array<{ journal_mode: string }>;
    expect(mode[0]?.journal_mode.toLowerCase()).toBe('wal');
    z.exec(`
      CREATE TABLE session (id text primary key, project_id text, directory text not null, title text not null,
                            time_created integer not null, time_updated integer not null, task_type text);
    `);
    const insert = z.prepare('INSERT INTO session VALUES (?,?,?,?,?,?,?)');
    const now = Date.now();
    insert.run('sess1', 'p', root, 'A', now, now, 'interactive');

    const first = discover(root, dbPath);
    expect(first.map((s) => s.sourceSessionId)).toEqual(['sess1']);

    // 关键动作：新增第 2 个会话，但**写连接不关、不 checkpoint** ⇒ 只进 -wal
    const mtimeBefore = fs.statSync(dbPath).mtimeMs;
    insert.run('sess2', 'p', root, 'B', now, now, 'interactive');
    const mtimeAfter = fs.statSync(dbPath).mtimeMs;
    // SQL 侧确实已有 2 个会话
    expect((z.prepare('SELECT COUNT(*) AS n FROM session').get() as { n: number }).n).toBe(2);
    // 而主库文件本身没被写过（这正是旧缓存键看不见变化的原因；若不同 OS 会 bump mtime，本断言只是留证，不参与判定）
    expect({ mtimeChanged: mtimeAfter !== mtimeBefore }).toEqual({ mtimeChanged: false });

    // 修前：这里仍然只有 sess1（缓存命中，永远返回旧列表）
    const second = discover(root, dbPath);
    expect(second.map((s) => s.sourceSessionId).sort()).toEqual(['sess1', 'sess2']);
  });
});