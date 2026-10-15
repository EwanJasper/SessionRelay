// [1015 夜 · 红队 A] 两个真 bug 的回归测试：
//   ① listDecisions 同键覆写绕过 --kind（A#2）
//   ② 空正文会话（归档/只带决策的导入）不推进 extracted_version（A#3/B#1）
import { describe, it, expect } from 'vitest';
import { createDb, listDecisions } from '../../src/store/db.js';
import type { DB } from '../../src/store/db.js';
import { recomputeExtractions } from '../../src/capture/recompute.js';
import { EXTRACT_VERSION } from '../../src/core/extract/version.js';

const TEXT = '改用 node:sqlite 直查 SQL，不再起子进程';

function seedPair(): DB {
  const db = createDb(':memory:') as unknown as DB;
  const st = db.prepare(`INSERT INTO sessions (id, source, source_session_id, project_id, state, title, created_at, message_count, decisions)
    VALUES (?, 'zcode', ?, 'p', 'confirmed', 't', ?, 3, ?)`);
  // 先到的：kind=decision，时间早
  st.run('a100000000000001', 's1', '2026-10-15T10:00:00Z', JSON.stringify([{ text: TEXT, seq: 1, at: '2026-10-13T00:00:00Z', kind: 'decision' }]));
  // 后到的：同文本，kind=negative，时间**更新**（旧实现会覆写掉第一条 → --kind decision 拿到 negative）
  st.run('b100000000000001', 's2', '2026-10-10T10:00:00Z', JSON.stringify([{ text: TEXT, seq: 1, at: '2026-10-15T00:00:00Z', kind: 'negative' }]));
  return db;
}

describe('[1015 夜] 同键覆写不许绕过 --kind', () => {
  it('① 请求 kind=decision 时，返回值里不许出现 kind=negative', () => {
    const db = seedPair();
    const rows = listDecisions(db, 'p', { kind: 'decision' });
    expect(rows.every((r) => r.kind === 'decision')).toBe(true);
    db.close();
  });
  it('② 反向：请求 kind=negative 时也一样，且不因此丢光整类', () => {
    const db = seedPair();
    const neg = listDecisions(db, 'p', { kind: 'negative' });
    expect(neg.every((r) => r.kind === 'negative')).toBe(true);
    db.close();
  });
  it('③ 不带 --kind 时仍然是「保留更新的一条」语义（本次修复没有把它改坏）', () => {
    const db = seedPair();
    const all = listDecisions(db, 'p');
    expect(all.length).toBe(1);
    expect(all[0].at).toBe('2026-10-15T00:00:00Z');
    db.close();
  });
});

describe('[1015 夜] 空正文会话必须打戳（否则 remaining 永久卡住）', () => {
  it('④ 归档/导入类会话：跑一次重算后版本跟上、剩余为 0', () => {
    const db = createDb(':memory:') as unknown as DB;
    db.prepare(`INSERT INTO sessions (id, source, source_session_id, project_id, state, title, created_at, message_count, decisions, extracted_version)
      VALUES ('c100000000000001','hop','s3','p','confirmed','t','2026-10-15T00:00:00Z',5,?,0)`)
      .run(JSON.stringify([{ text: TEXT, seq: 1, at: '2026-10-15T00:00:00Z' }]));
    recomputeExtractions(db, 50);
    const row = db.prepare('SELECT extracted_version FROM sessions WHERE id = ?').get('c100000000000001') as { extracted_version: number };
    expect(row.extracted_version).toBe(EXTRACT_VERSION);
    const again = recomputeExtractions(db, 50);
    expect(again.recomputed).toBe(0);   // 不会每批虚增
    db.close();
  });
  it('⑤ 空正文时按现行文本级守卫清理存量噪声（归档会话也能被新规则追上）', () => {
    const db = createDb(':memory:') as unknown as DB;
    db.prepare(`INSERT INTO sessions (id, source, source_session_id, project_id, state, title, created_at, message_count, decisions, extracted_version)
      VALUES ('d100000000000001','zcode','s4','p','confirmed','t','2026-10-15T00:00:00Z',5,?,0)`)
      .run(JSON.stringify([{ text: '选择器是旧的', seq: 1, at: '2026-10-15T00:00:00Z' }, { text: TEXT, seq: 2, at: '2026-10-15T00:00:00Z' }]));
    recomputeExtractions(db, 50);
    const row = db.prepare('SELECT decisions FROM sessions WHERE id = ?').get('d100000000000001') as { decisions: string };
    const texts = (JSON.parse(row.decisions) as Array<{ text: string }>).map((d) => d.text);
    expect(texts).not.toContain('选择器是旧的');
    expect(texts).toContain(TEXT);
    db.close();
  });
});
