// [1015 夜] 同键去重必须保留**决策自身时间更新**的那条。
//
// 病历：原实现是「先遇到的赢」，而遍历顺序是会话 created_at 降序——两者不一致时就会留下更旧的一条。
// 实测：music 2/325 组、agent1super 30/893 组；music 那一组把 31h 的新决策顶成 48h 的旧重复，
// 于是简报的决策段（48h 新鲜度窗）**提前 17 小时空掉**。
//
// 双向断言：更新的要被留下 + 置顶继承的旧语义不许被改坏。
import { describe, it, expect } from 'vitest';
import { createDb, listDecisions } from '../../src/store/db.js';
import type { DB } from '../../src/store/db.js';

const TEXT = '决定改用 pwsh 直接 HTTPS 拉取，拿到 registry 原始 packument';

function seed(rows: Array<{ id: string; createdAt: string; decisions: Array<{ text: string; seq: number; at: string; pinned?: boolean }> }>): DB {
  const db = createDb(':memory:') as unknown as DB;
  const stmt = db.prepare(`INSERT INTO sessions (id, source, source_session_id, project_id, state, title, created_at, message_count, decisions)
    VALUES (?, 'zcode', ?, 'p', 'confirmed', 't', ?, 3, ?)`);
  for (const r of rows) stmt.run(r.id, r.id, r.createdAt, JSON.stringify(r.decisions));
  return db;
}

describe('[1015 夜] 决策去重保留最新的那条', () => {
  it('① 新会话里的旧文本 vs 旧会话里的新文本 → 留下更新的那条', () => {
    const db = seed([
      // 会话 A 更晚创建（遍历先遇到），但它的决策时间更早
      { id: 'a100000000000001', createdAt: '2026-10-15T10:00:00Z', decisions: [{ text: TEXT, seq: 1, at: '2026-10-13T12:36:00Z' }] },
      // 会话 B 更早创建，但那里的同一个决策是**新**的
      { id: 'b100000000000001', createdAt: '2026-10-10T10:00:00Z', decisions: [{ text: TEXT, seq: 2, at: '2026-10-14T05:39:00Z' }] },
    ]);
    const rows = listDecisions(db, 'p');
    expect(rows.length).toBe(1);
    expect(rows[0].at).toBe('2026-10-14T05:39:00Z');
    expect(rows[0].sessionId).toBe('b100000000000001');
    db.close();
  });

  it('② 三份副本 → 仍然只留最新的一份', () => {
    const db = seed([
      { id: 'c100000000000001', createdAt: '2026-10-15T10:00:00Z', decisions: [{ text: TEXT, seq: 1, at: '2026-10-14T05:39:00Z' }] },
      { id: 'c100000000000002', createdAt: '2026-10-14T10:00:00Z', decisions: [{ text: TEXT, seq: 1, at: '2026-10-12T00:00:00Z' }] },
      { id: 'c100000000000003', createdAt: '2026-10-13T10:00:00Z', decisions: [{ text: TEXT, seq: 1, at: '2026-10-15T01:00:00Z' }] },
    ]);
    const rows = listDecisions(db, 'p');
    expect(rows.length).toBe(1);
    expect(rows[0].at).toBe('2026-10-15T01:00:00Z');
    db.close();
  });

  it('③ 置顶继承不许被改坏：旧那条 pin 过，胜出的新条目照样 pinned', () => {
    const db = seed([
      { id: 'd100000000000001', createdAt: '2026-10-15T10:00:00Z', decisions: [{ text: TEXT, seq: 1, at: '2026-10-12T00:00:00Z', pinned: true }] },
      { id: 'd100000000000002', createdAt: '2026-10-11T10:00:00Z', decisions: [{ text: TEXT, seq: 1, at: '2026-10-14T00:00:00Z' }] },
    ]);
    const rows = listDecisions(db, 'p');
    expect(rows.length).toBe(1);
    expect(rows[0].pinned).toBe(true);
    expect(rows[0].at).toBe('2026-10-14T00:00:00Z');
    db.close();
  });
});
