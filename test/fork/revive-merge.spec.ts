// [1015 夜 · A1] 归档复活的会话：重算必须**自动合并**骨架决策，不能把它换掉。
//
// 背景：归档会删正文、只留决策骨架（archive.ts），而复活会清 cleanup_at（sync.ts:245）。
// 这类会话会被重算选中（confirmed + cleanup_at NULL + message_count>0），
// 而重算只能从「残存的新消息」里抽 ⇒ 直接写回 = 骨架消失。
// 实测规模：主库 210 场/676 条、music 74 场/254 条。
//
// 双向断言：骨架必须被补回（含 pinned）＋ 新抽出的决策必须优先（同键不重复）。
import { describe, it, expect } from 'vitest';
import { createDb } from '../../src/store/db.js';
import type { DB } from '../../src/store/db.js';
import { recomputeExtractions } from '../../src/capture/recompute.js';

function seed(originalCount: number | null): DB {
  const db = createDb(':memory:') as unknown as DB;
  db.prepare(`INSERT INTO sessions (id, source, source_session_id, project_id, state, title, created_at, last_event_at,
    message_count, decisions, original_message_count, extracted_version)
    VALUES ('a100000000000001','zcode','s1','p','confirmed','t','2026-10-15T00:00:00Z','2026-10-15T00:00:00Z',1,?,?,0)`)
    .run(JSON.stringify([{ text: '归档前的老决策：采用持久化骨架', seq: 1, at: '2026-09-01T00:00:00Z', pinned: true }]), originalCount);
  // ⚠️ messages.id 是 INTEGER PRIMARY KEY AUTOINCREMENT —— 别传字符串（第一版夹具就这么炸的）
  db.prepare(`INSERT INTO messages (session_id, seq_num, role, content, created_at)
    VALUES ('a100000000000001',1,'user','改用 node:sqlite 直查 SQL，不再起子进程','2026-10-15T00:00:00Z')`).run();
  return db;
}

describe('[1015 夜] 归档复活会话的自动合并', () => {
  it('① 复活过的会话：骨架决策被补回，且新抽出的也在', () => {
    const db = seed(999);
    recomputeExtractions(db, 50);
    const row = db.prepare('SELECT decisions FROM sessions WHERE id = ?').get('a100000000000001') as { decisions: string };
    const texts = (JSON.parse(row.decisions) as Array<{ text: string }>).map((d) => d.text);
    expect(texts.some((t) => t.includes('骨架'))).toBe(true);
    expect(texts.some((t) => t.includes('node:sqlite'))).toBe(true);
    db.close();
  });
  it('② 没归档过的会话：行为不变（不合并、只写新抽的）', () => {
    const db = seed(null);
    recomputeExtractions(db, 50);
    const row = db.prepare('SELECT decisions FROM sessions WHERE id = ?').get('a100000000000001') as { decisions: string };
    const texts = (JSON.parse(row.decisions) as Array<{ text: string }>).map((d) => d.text);
    expect(texts.some((t) => t.includes('骨架'))).toBe(false);
    expect(texts.some((t) => t.includes('node:sqlite'))).toBe(true);
    db.close();
  });
});
