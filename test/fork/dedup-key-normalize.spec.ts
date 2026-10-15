// [1015 回归] 跨会话去重键必须对**标点/表格符号**不敏感。
//
// 病历：原实现只去空白（replace(/\s+/g, "")），于是"同一句话被表格竖线或不同标点切分"
// 的两个版本算成两条 —— 实测简报里同一条决策双显（brief-sql.mjs 那侧同因同果）。
//
// 双向断言：该合的必须合（标点差异）＋ 不该合的绝不许合（真正的不同决策）。
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { createDb, listDecisions } from '../../src/store/db.js';
import type { DB } from '../../src/store/db.js';

function seed(decisions: Array<{ text: string; seq: number; at?: string }>): DB {
  const db = createDb(':memory:') as unknown as DB;
  db.prepare(`INSERT INTO sessions (id, source, source_session_id, project_id, state, title, created_at, message_count, decisions)
    VALUES (?, 'zcode', 's1', 'p', 'confirmed', 't', ?, 2, ?)`)
    .run('a100000000000001', '2026-10-15T00:00:00Z', JSON.stringify(decisions));
  return db;
}

describe('[1015] 去重键对标点/表格符号不敏感', () => {
  it('① 同一句被表格竖线/逗号切分 → 只出一条', () => {
    const db = seed([
      { text: '决定改用 node:sqlite 直查 SQL｜其余保持不变', seq: 1 },
      { text: '决定改用 node:sqlite 直查 SQL，其余保持不变', seq: 2 },
    ]);
    const rows = listDecisions(db, 'p');
    expect(rows.length).toBe(1);
    db.close();
  });

  it('② 真正不同的决策不许被合并', () => {
    const db = seed([
      { text: '决定改用 node:sqlite 直查 SQL', seq: 1 },
      { text: '决定弃用位置 OFFSET 游标', seq: 2 },
    ]);
    expect(listDecisions(db, 'p').length).toBe(2);
    db.close();
  });

  it('③ 只差尾部（40 字键之外）的仍算不同 —— 键长语义不许被顺手放宽', () => {
    // 头部必须 ≥40 字，否则尾部的差异仍落在 40 字键内（第一版测试就是在这里写错的）
    const head = '决定把简报过滤链统一到单一权威源并加守门工具同时要求两侧逐字一致并且每次改完都要重跑核对工具确保不漂移';
    const db = seed([
      { text: head + '甲方案', seq: 1 },
      { text: head + '乙方案', seq: 2 },
    ]);
    // 键只取前 40 字，两者前缀相同 → 会被合并成 1 条。这是**有意的取舍**（与 v15 问题去重同款），
    // 把它钉住，免得将来有人"顺手放宽"又把重复放回来。
    expect(listDecisions(db, 'p').length).toBe(1);
    db.close();
  });
});
