// 红队 R2/R3 回归：删决策前必须有 quarantine；失败行不许打当前版本戳、必须留痕。
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  recomputeExtractions, cleanArchivedDecisions, recomputeDryRun, EXTRACT_VERSION,
} from '../../src/capture/recompute.js';
import { passesDecisionTextGuards } from '../../src/core/extract/extract.js';
import type { DB } from '../../src/store/db.js';

const BAD = '决定，因为两条路的工作量差一个数量级';
const GOOD = '改用 SQLite 做本地索引';

function seed(): DB {
  const db = new Database(':memory:') as DB;
  db.exec('CREATE TABLE sessions ('
    + 'id TEXT PRIMARY KEY, source TEXT NOT NULL, source_session_id TEXT NOT NULL,'
    + 'project_id TEXT NOT NULL, origin TEXT NOT NULL DEFAULT "auto", state TEXT NOT NULL DEFAULT "active",'
    + 'title TEXT, created_at TEXT NOT NULL, message_count INTEGER NOT NULL DEFAULT 0,'
    + 'decisions TEXT, key_questions TEXT, topics TEXT, files_mentioned TEXT, summary_rule TEXT,'
    + 'cleanup_at TEXT, original_message_count INTEGER DEFAULT 0, extracted_version INTEGER NOT NULL DEFAULT 0)');
  return db;
}

function addArchived(db: DB, id: string, decisions: Array<Record<string, unknown>>, version = 0) {
  db.prepare('INSERT INTO sessions (id, source, source_session_id, project_id, state, title, created_at, message_count, decisions, cleanup_at, extracted_version) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)')
    .run(id, 'dsh', id, 'p', 'confirmed', 'sess-' + id, '2026-10-01T00:00:00Z', JSON.stringify(decisions), '2026-10-02T00:00:00Z', version);
}

const decisionsOf = (db: DB, id: string): Array<{ text: string; pinned?: boolean }> => {
  const row = db.prepare('SELECT decisions FROM sessions WHERE id = ?').get(id) as { decisions: string | null };
  return row.decisions ? JSON.parse(row.decisions) : [];
};

describe('R2 · 归档会话决策清理：删前必须有 quarantine', () => {
  let db: DB;
  beforeEach(() => {
    db = seed();
    // 触发 ensureTable：建 quarantine/补列（dry 模式不会动数据）
    recomputeExtractions(db, 1, { apply: false });
  });

  it('判据夹具：BAD 确实会被现行守卫拒收', () => {
    expect(passesDecisionTextGuards(BAD)).toBe(false);
    expect(passesDecisionTextGuards(GOOD)).toBe(true);
  });

  it('dry-run 只预演：给出会删条数+样例，但决策/版本/quarantine 一个都没动', () => {
    addArchived(db, 'a1', [{ text: GOOD, seq: 1 }, { text: BAD, seq: 2 }]);
    const r = cleanArchivedDecisions(db, { dryRun: true });
    expect(r.wouldRemove).toBe(1);
    expect(r.removed).toBe(0);
    expect(r.samples[0].text).toBe(BAD);
    expect(decisionsOf(db, 'a1').map((d) => d.text)).toEqual([GOOD, BAD]);
    expect((db.prepare('SELECT count(*) AS c FROM recompute_quarantine').get() as { c: number }).c).toBe(0);
    expect((db.prepare('SELECT extracted_version AS v FROM sessions WHERE id = ?').get('a1') as { v: number }).v).toBe(0);
  });

  it('apply：被删决策整条进 quarantine，pinned 决策豁免，跑过打版本戳', () => {
    addArchived(db, 'a1', [{ text: GOOD, seq: 1 }, { text: BAD, seq: 2 }, { text: BAD, seq: 3, pinned: true }]);
    const r = cleanArchivedDecisions(db);
    expect(r.removed).toBe(1);
    expect(decisionsOf(db, 'a1').map((d) => d.text)).toEqual([GOOD, BAD]);   // pinned 的那条还在
    const q = db.prepare('SELECT session_id, field, old_value FROM recompute_quarantine').all() as Array<{ session_id: string; field: string; old_value: string }>;
    expect(q.length).toBe(1);
    expect(q[0].session_id).toBe('a1');
    expect(q[0].field).toBe('decisions');
    expect(JSON.parse(q[0].old_value).text).toBe(BAD);
    expect((db.prepare('SELECT extracted_version AS v FROM sessions WHERE id = ?').get('a1') as { v: number }).v).toBe(EXTRACT_VERSION);
  });

  it('隔离写入失败 → 该会话跳过（一条不删）且不落版本戳，下轮会重试', () => {
    addArchived(db, 'a1', [{ text: BAD, seq: 1 }]);
    db.exec('DROP TABLE recompute_quarantine');   // 模拟隔离表写不进去
    const r = cleanArchivedDecisions(db);
    expect(r.removed).toBe(0);
    expect(r.skipped.length).toBe(1);
    expect(decisionsOf(db, 'a1').map((d) => d.text)).toEqual([BAD]);   // 没删
    expect((db.prepare('SELECT extracted_version AS v FROM sessions WHERE id = ?').get('a1') as { v: number }).v).toBe(0);
  });
});

describe('R3 · 失败行不许打版本戳', () => {
  it('提取抛异常 → 版本回 0 + retry_count/last_error 留痕；到上限才 park', () => {
    const db = seed();
    // 没有 messages 表 ⇒ recomputeSession 抛异常，模拟坏行
    db.prepare('INSERT INTO sessions (id, source, source_session_id, project_id, state, title, created_at, message_count) VALUES (?, ?, ?, ?, ?, ?, ?, 3)')
      .run('f1', 'dsh', 'f1', 'p', 'confirmed', 'bad', '2026-10-01T00:00:00Z');
    const r1 = recomputeExtractions(db, 10);
    expect(r1.failed).toBe(1);
    const row = db.prepare('SELECT extracted_version AS v, extract_retry_count AS n, extract_last_error AS e FROM sessions WHERE id = ?').get('f1') as { v: number; n: number; e: string | null };
    expect(row.v).toBe(0);                       // 关键：没被打成当前版本
    expect(row.n).toBe(1);
    expect(row.e).toBeTruthy();
    // 再失败 2 次 → 到上限 park（不再每轮空转），但 last_error 写明已放弃
    recomputeExtractions(db, 10);
    recomputeExtractions(db, 10);
    const parked = db.prepare('SELECT extracted_version AS v, extract_retry_count AS n, extract_last_error AS e FROM sessions WHERE id = ?').get('f1') as { v: number; n: number; e: string | null };
    expect(parked.v).toBe(EXTRACT_VERSION);
    expect(parked.n).toBe(3);
    expect(parked.e).toContain('已放弃');
  });

  it('成功重算会清掉 retry_count/last_error（失败标记不是永久污点）', () => {
    const db = seed();
    recomputeExtractions(db, 1, { apply: false });   // 触发 ensureTable：补 extract_retry_count/extract_last_error 列
    db.exec('CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, search_text TEXT, seq_num INTEGER NOT NULL, created_at TEXT)');
    db.prepare('INSERT INTO sessions (id, source, source_session_id, project_id, state, title, created_at, message_count, extract_retry_count, extract_last_error) VALUES (?, ?, ?, ?, ?, ?, ?, 2, 2, ?)')
      .run('ok1', 'dsh', 'ok1', 'p', 'confirmed', 'ok', '2026-10-01T00:00:00Z', '旧错误');
    db.prepare('INSERT INTO messages (session_id, role, content, seq_num) VALUES (?, ?, ?, ?)').run('ok1', 'user', '我们决定改用 SQLite 做本地索引', 1);
    recomputeExtractions(db, 10);
    const row = db.prepare('SELECT extracted_version AS v, extract_retry_count AS n, extract_last_error AS e FROM sessions WHERE id = ?').get('ok1') as { v: number; n: number; e: string | null };
    expect(row.v).toBe(EXTRACT_VERSION);
    expect(row.n).toBe(0);
    expect(row.e).toBeNull();
  });
});
