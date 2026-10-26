// [fork 0924] 本 fork 新增逻辑的回归锁：origin=workflow 排除 + 决策增量刷新（水位幂等）
// 这两个行为是 mc整合包 实测反馈的根治产物——没有测试锁定就会被无意破坏
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDb, upsertCapturedSession, insertMessage, markPending, refreshDecisionsIncremental, confirmSession, listDecisions } from '../../src/store/db.js';

let TMP = '';
let db: ReturnType<typeof createDb>;
const PID = 'proj-fork-test';
const ids: Record<string, string> = {};

const ins = (key: string, title: string, origin: 'auto' | 'workflow', msgs: Array<[number, string]>) => {
  const up = upsertCapturedSession(db, {
    source: 'zcode', sourceSessionId: 'src-' + key, projectId: PID, title,
    createdAt: new Date().toISOString(), lastEventAt: new Date().toISOString(), origin,
  });
  ids[key] = up.id;
  for (const [seq, content] of msgs) {
    insertMessage(db, { sessionId: up.id, role: seq % 2 ? 'user' : 'assistant', content, seqNum: seq, createdAt: new Date().toISOString() });
  }
  db.prepare('UPDATE sessions SET message_count = ? WHERE id = ?').run(msgs.length, up.id);
};

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forkrt-'));
  fs.mkdirSync(path.join(TMP, '.sessionrelay'), { recursive: true });
  process.chdir(TMP);
  db = createDb(path.join(TMP, '.sessionrelay', 'relay.sqlite'));
});
afterEach(() => {
  process.chdir(os.tmpdir());
  try { db.close(); } catch { /* 已关 */ }
  for (let i = 0; i < 3; i++) { try { fs.rmSync(TMP, { recursive: true, force: true }); break; } catch { /* Windows 句柄延迟重试 */ } }
});

describe('fork · origin=workflow 排除', () => {
  it('施工会话的决策不进 listDecisions，正主会话的进', () => {
    ins('wf', 'workflow subagent actor#1@1', 'workflow', [[1, '决定主题能不能实现']]);
    ins('main', '正主会话', 'auto', [[1, '决定采用 PostgreSQL 作为主库']]);
    markPending(db, ids.wf, new Date().toISOString());
    markPending(db, ids.main, new Date().toISOString());
    refreshDecisionsIncremental(db, ids.wf);
    refreshDecisionsIncremental(db, ids.main);
    confirmSession(db, ids.wf, new Date().toISOString());
    confirmSession(db, ids.main, new Date().toISOString());
    const rows = listDecisions(db, PID);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every((r) => !/workflow subagent/.test(r.title ?? ''))).toBe(true);
  });
});

describe('fork · 决策增量刷新', () => {
  it('水位之后的新消息追加决策，且幂等去重', () => {
    ins('inc', '增量会话', 'auto', [[1, '决定采用方案 A']]);
    confirmSession(db, ids.inc, new Date().toISOString());
    insertMessage(db, { sessionId: ids.inc, role: 'assistant', content: '决定追加方案 B 作为兜底', seqNum: 2, createdAt: new Date().toISOString() });
    refreshDecisionsIncremental(db, ids.inc);
    refreshDecisionsIncremental(db, ids.inc); // 幂等：二次调用不重复追加
    const rows = listDecisions(db, PID);
    const texts = rows.map((r) => r.text);
    expect(texts.some((t) => t.includes('方案 A'))).toBe(true);
    expect(texts.some((t) => t.includes('方案 B'))).toBe(true);
    expect(texts.filter((t) => t.includes('方案 B')).length).toBe(1);
  });
});
