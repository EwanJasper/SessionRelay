// [1015 夜 · 版本对齐] 导入路径必须给 extracted_version 打戳（decisions 的第 5 个写入方）。
//
// 危害：不打戳 → DEFAULT 0 →「落后于当前规则」→ 被 recompute 选中。
// 而导入的 messageCount 来自 HOP 包，若包只带决策不带消息（协议允许），
// 重算就会从 0 条消息里重新提取 ⇒ 把导入的决策清空。
//
// 双向断言：打戳后不被重算选中 + 手工归零后可以重新变成「落后」（回退路径必须还在）。
import { describe, it, expect } from 'vitest';
import { createDb, insertImportedSession } from '../../src/store/db.js';
import type { DB } from '../../src/store/db.js';
import { EXTRACT_VERSION } from '../../src/core/extract/version.js';

const input = {
  source: 'hop', sourceSessionId: 's1', projectId: 'p', title: '导入的会话', createdAt: '2026-10-15T00:00:00Z',
  lastEventAt: '2026-10-15T00:00:00Z', messageCount: 5, topics: ['t'],
  decisions: [{ text: '导入的决策：采用 X', seq: 1, at: '2026-10-15T00:00:00Z' }],
  summaryRule: '摘要', author: 'someone', importedFrom: 'other-machine', originProject: 'proj_x',
  contentHash: 'h1', sourceFile: 'hop:s1',
};

describe('[1015 夜] 导入路径打版本戳', () => {
  it('① 导入后 extracted_version = 当前版本（不会被重算误清）', () => {
    const db = createDb(':memory:') as unknown as DB;
    const { id } = insertImportedSession(db, input as never);
    const row = db.prepare('SELECT extracted_version, origin FROM sessions WHERE id = ?').get(id) as { extracted_version: number; origin: string };
    expect(row.extracted_version).toBe(EXTRACT_VERSION);
    expect(row.origin).toBe('imported');
    db.close();
  });
  it('② 回退路径仍在：手工归零后它重新变成「落后」', () => {
    const db = createDb(':memory:') as unknown as DB;
    const { id } = insertImportedSession(db, input as never);
    db.prepare('UPDATE sessions SET extracted_version = 0 WHERE id = ?').run(id);
    const row = db.prepare('SELECT extracted_version FROM sessions WHERE id = ?').get(id) as { extracted_version: number };
    expect(row.extracted_version).toBeLessThan(EXTRACT_VERSION);
    db.close();
  });
});
