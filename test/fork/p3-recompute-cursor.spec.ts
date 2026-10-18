// [1015 Bug-2 回归] 重算判据必须逐会话自报，不能用库级字典序游标。
//
// 病历（本机用真实库副本 81MB + 哨兵列实跑复现）：
//   旧判据 = extract_meta.progress_version + `WHERE s.id > lastId`。会话 ID 是随机 16 位 hex，
//   字典序与时间序无关（真实库按时间相邻对里 273/580 是逆序）。于是一旦分批重算跑到中途，
//   任何"状态流转（active→confirmed）进来、ID 字典序更小"的会话会被永久跳过；
//   而收尾时元数据照样写 remaining=0 / version=最新，doctor 的「提取规则版本」检查全绿。
//
// 这条测试是**双向**的（单向断言挡不住未来的退化）：
//   ① 该被捞到的必须被捞到（ID 更小、中途入集、库版本已最新——三个旧实现全踩中的形态）
//   ② 已经跟上的不许被再算一遍（否则只是把"漏算"换成"每周期空转"）
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { recomputeExtractions, EXTRACT_VERSION } from '../../src/capture/recompute.js';
import type { DB } from '../../src/store/db.js';

function seed(): DB {
  const db = new Database(':memory:') as unknown as DB;
  db.exec(`CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY, source TEXT NOT NULL, source_session_id TEXT NOT NULL,
    project_id TEXT NOT NULL, origin TEXT NOT NULL DEFAULT 'auto',
    state TEXT NOT NULL DEFAULT 'active', git_branch TEXT, title TEXT,
    created_at TEXT NOT NULL, last_event_at TEXT, confirmed_at TEXT, pending_at TEXT,
    message_count INTEGER NOT NULL DEFAULT 0, files_mentioned TEXT, topics TEXT,
    decisions TEXT, key_questions TEXT, code_changes TEXT, summary_rule TEXT,
    summary_ai TEXT, user_summary TEXT, user_tags TEXT, author TEXT,
    imported_from TEXT, origin_project TEXT, content_hash TEXT, source_file TEXT,
    synced_at TEXT, meta_text TEXT, cleanup_at TEXT, original_message_count INTEGER DEFAULT 0
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS extract_meta (
    id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL, last_run_at TEXT,
    last_recomputed INTEGER NOT NULL DEFAULT 0, remaining INTEGER NOT NULL DEFAULT 0,
    progress INTEGER NOT NULL DEFAULT 0, progress_version INTEGER NOT NULL DEFAULT 0,
    cursor_id TEXT NOT NULL DEFAULT ''
  )`);
  db.prepare('INSERT OR IGNORE INTO extract_meta (id, version) VALUES (1, 0)').run();
  db.exec(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL,
    content TEXT NOT NULL, search_text TEXT, seq_num INTEGER NOT NULL, created_at TEXT
  )`);
  return db;
}

function addSession(db: DB, id: string, state: string, topics = '[]') {
  db.prepare(
    `INSERT INTO sessions (id, source, source_session_id, project_id, state, title, created_at, confirmed_at, message_count, topics)
     VALUES (?, 'dsh', ?, 'p', ?, ?, '2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z', 2, ?)`,
  ).run(id, id, state, 'sess-' + id, topics);
  db.prepare('INSERT INTO messages (session_id, role, content, seq_num) VALUES (?, ?, ?, ?)')
    .run(id, 'user', '决定改用 node:sqlite 直查 SQL', 1);
  db.prepare('INSERT INTO messages (session_id, role, content, seq_num) VALUES (?, ?, ?, ?)')
    .run(id, 'user', '改用 Write 脚本文件代替 heredoc', 2);
}

const topicsOf = (db: DB, id: string): string => {
  const r = db.prepare('SELECT topics FROM sessions WHERE id = ?').get(id) as { topics: string | null };
  return r?.topics ?? '';
};
const versionOf = (db: DB, id: string): number => {
  const r = db.prepare('SELECT extracted_version AS v FROM sessions WHERE id = ?').get(id) as { v: number };
  return r?.v ?? -1;
};
const setLibVersion = (db: DB, v: number) => {
  db.prepare('UPDATE extract_meta SET version = ?, progress_version = ? WHERE id = 1').run(v, v);
};

describe('[v14] 重算判据：逐会话 extracted_version', () => {
  it('① ID 字典序更小的会话中途入集，必须被捞到（旧实现会永久漏算）', () => {
    const db = seed();
    // 一个"低 ID"会话先离集（active），其余高 ID 会话在集内
    addSession(db, '0000000000000001', 'active', '["SENTINEL_未被重算"]');
    for (let i = 2; i <= 6; i++) addSession(db, 'f00000000000000' + i, 'confirmed');
    setLibVersion(db, EXTRACT_VERSION - 1);

    // 跑一批，游标（若还用旧实现）会远远越过 0000000000000001
    recomputeExtractions(db, 2);
    // 此时低 ID 会话"进入目标集"（active → confirmed）
    db.prepare("UPDATE sessions SET state = 'confirmed' WHERE id = '0000000000000001'").run();

    // 继续跑到收尾
    for (let i = 0; i < 20; i++) { if (recomputeExtractions(db, 2).remaining === 0) break; }

    expect(topicsOf(db, '0000000000000001')).not.toContain('SENTINEL_未被重算');
    expect(versionOf(db, '0000000000000001')).toBe(EXTRACT_VERSION);
  });

  it('② 库版本已最新，但单行落后 → 仍必须被捞到（旧实现直接早退）', () => {
    const db = seed();
    addSession(db, 'aaaaaaaaaaaaaaaa', 'confirmed');
    recomputeExtractions(db, 50);
    expect(versionOf(db, 'aaaaaaaaaaaaaaaa')).toBe(EXTRACT_VERSION);

    // 人为把单行打回落后（模拟"某条路写了派生列但没打戳"）
    db.prepare('UPDATE sessions SET extracted_version = ?, topics = ? WHERE id = ?')
      .run(EXTRACT_VERSION - 1, '["SENTINEL_未被重算"]', 'aaaaaaaaaaaaaaaa');
    const libV = (db.prepare('SELECT version FROM extract_meta WHERE id = 1').get() as { version: number }).version;
    expect(libV).toBe(EXTRACT_VERSION); // 库级已经是"最新"

    const r = recomputeExtractions(db, 50);
    expect(r.recomputed).toBe(1);
    expect(topicsOf(db, 'aaaaaaaaaaaaaaaa')).not.toContain('SENTINEL_未被重算');
  });

  it('③ 全部跟上之后必须零成本空转（不许每周期重算一遍）', () => {
    const db = seed();
    addSession(db, 'bbbbbbbbbbbbbbbb', 'confirmed');
    addSession(db, 'cccccccccccccccc', 'confirmed');
    recomputeExtractions(db, 50);
    const again = recomputeExtractions(db, 50);
    expect(again.recomputed).toBe(0);
    expect(again.remaining).toBe(0);
  });
});
