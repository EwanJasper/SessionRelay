// Scope CLI + attach/detach（方针 §6.4/§6.5）：scope.json 生命周期 + scope_log + CLI 检索受契约约束
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createDb, insertSession, insertMessage, listSessions, recentScopeLogs } from '../../src/store/db.js';
import { defaultConfig, saveConfig } from '../../src/shared/config.js';
import { dbFile, projectIdOf } from '../../src/shared/paths.js';
import { saveScopeFile, loadScopeFile, makeScopeFile, mergeFilters, resetScopeFile, scopeFilePath } from '../../src/core/scope/scopeFile.js';
import { assembleScope } from '../../src/core/scope/assemble.js';
import { searchSessions } from '../../src/search-svc/engine.js';

const TMP = path.resolve('test/.tmp/scopecmd');
const PROJECT = path.join(TMP, 'app');
const PID = projectIdOf(PROJECT);
const cfg = { ...defaultConfig(), identity: { project_id: PID } };

beforeAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(path.join(PROJECT, '.sessionrelay'), { recursive: true });
  saveConfig(PROJECT, cfg);
  const db = createDb(dbFile(PROJECT));
  insertSession(db, { id: 'aaa00000000000001', source: 'zcode', sourceSessionId: 'z1', projectId: PID, createdAt: '2026-08-20T08:00:00Z', topics: ['auth'], title: '认证' });
  insertMessage(db, { sessionId: 'aaa00000000000001', role: 'assistant', content: '认证方案定为 JWT', seqNum: 1 });
  insertSession(db, { id: 'bbb00000000000001', source: 'claude-code', sourceSessionId: 'c1', projectId: PID, createdAt: '2026-08-21T08:00:00Z', topics: ['db'], title: '数据库' });
  insertMessage(db, { sessionId: 'bbb00000000000001', role: 'assistant', content: '数据库选 PostgreSQL', seqNum: 1 });
  db.close();
});
afterAll(() => { fs.rmSync(TMP, { recursive: true, force: true }); });

describe('P3 · scopeFile 生命周期', () => {
  it('set → add 合并（数组并集）→ reset 清除', () => {
    saveScopeFile(PROJECT, makeScopeFile({ topics: ['auth'] }));
    const cur = loadScopeFile(PROJECT)!;
    expect(cur.filters.topics).toEqual(['auth']);
    saveScopeFile(PROJECT, makeScopeFile(mergeFilters(cur.filters, { topics: ['db'], since: '2026-08-01T00:00:00Z' })));
    const merged = loadScopeFile(PROJECT)!;
    expect(merged.filters.topics?.sort()).toEqual(['auth', 'db']);
    expect(merged.filters.since).toBe('2026-08-01T00:00:00Z');
    resetScopeFile(PROJECT);
    expect(loadScopeFile(PROJECT)).toBeNull();
    expect(fs.existsSync(scopeFilePath(PROJECT))).toBe(false);
  });

  it('full 逃生口：makeScopeFile({},{full:true}) 得空谓词 + mode full', () => {
    const sf = makeScopeFile({ topics: ['x'] }, { full: true });
    expect(sf.mode).toBe('full');
    expect(sf.filters).toEqual({});
  });
});

describe('P3 · CLI 检索受 B 档契约约束（assemble 集成）', () => {
  it('无契约 → 全库；契约 topics=db → 只剩 db 会话；full → 恢复', () => {
    const none = assembleScope({ root: PROJECT, cfg, includeAuto: false });
    expect(none.where).toBeNull();
    { const db0 = createTmp(); expect(listSessions(db0, { projectId: PID, where: none.where })).toHaveLength(2); db0.close(); }

    saveScopeFile(PROJECT, makeScopeFile({ topics: ['db'] }));
    const scoped = assembleScope({ root: PROJECT, cfg, includeAuto: false });
    const db = createTmp();
    const rows = listSessions(db, { projectId: PID, where: scoped.where });
    expect(rows).toHaveLength(1);
    expect(rows[0].source_session_id).toBe('c1');
    // 搜索同样受限
    const hits = searchSessions(db, { project: PID, query: '认证 JWT', extraWhere: scoped.where });
    expect(hits).toHaveLength(0);
    db.close();

    saveScopeFile(PROJECT, makeScopeFile({}, { full: true }));
    const escaped = assembleScope({ root: PROJECT, cfg, includeAuto: false });
    expect(escaped.escaped).toBe(true);
    expect(escaped.where).toBeNull();
    resetScopeFile(PROJECT);
  });

  it('scope_log 记录（set/add/reset/attach 供审计）', () => {
    const db = createTmp();
    db.prepare('INSERT INTO scope_log (action, predicate, issued_by, created_at) VALUES (?,?,?,?)').run('set', '{"topics":["auth"]}', 'cli', new Date().toISOString());
    expect(recentScopeLogs(db, 1)[0].action).toBe('set');
    db.close();
  });
});

function createTmp() {
  return createDb(dbFile(PROJECT));
}
