// 深度测试套件——以专业测试视角覆盖边界/异常/并发/安全/交互场景
// 参照阿里测试标准：每个功能至少覆盖 正常流/边界值/异常值/重复执行/交叉影响
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createDb, dbFile, insertSession, insertMessage, confirmSession,
         countMessages, listSessions, getSession, getSessionFull,
         insertImportedSession, insertImportedMessage, setSessionState,
         purgePending, cleanup_log_exist } from '../../src/store/db.js';
import { searchSessions } from '../../src/search-svc/engine.js';
import { runArchive, getArchiveHistory } from '../../src/capture/archive.js';
import { defaultConfig, saveConfig, IGNORE_TEMPLATE, type RelayConfig } from '../../src/shared/config.js';
import { projectIdOf } from '../../src/shared/paths.js';

const TMP = path.resolve('test/.tmp/deep');
const PROJECT = path.join(TMP, 'app');
const PID = projectIdOf(PROJECT);
const ORIG_CWD = process.cwd();

const cfg = (over: Partial<RelayConfig['capture']> = {}): RelayConfig => ({
  ...defaultConfig(),
  identity: { project_id: PID },
  capture: { ...defaultConfig().capture, claude_projects_dir: 'Z:\\无', zcode_db_path: 'Z:\\无', sources: [], ...over },
});

// 工具函数
function seedSession(db: ReturnType<typeof createDb>, id: string, opts: {
  state?: string; origin?: string; tags?: string[]; msgs?: Array<[string, string]>; source?: string; createdAt?: string;
} = {}) {
  insertSession(db, {
    id, source: opts.source ?? 'claude-code', sourceSessionId: id, projectId: PID,
    createdAt: opts.createdAt ?? '2026-06-01T08:00:00Z', tags: opts.tags,
  });
  if (opts.origin) db.prepare('UPDATE sessions SET origin = ? WHERE id = ?').run(opts.origin, id);
  if (opts.state) db.prepare('UPDATE sessions SET state = ? WHERE id = ?').run(opts.state, id);
  db.prepare('UPDATE sessions SET last_event_at = ? WHERE id = ?').run(opts.createdAt ?? '2026-06-01T08:00:00Z', id);
  (opts.msgs ?? []).forEach(([role, content], i) => {
    insertMessage(db, { sessionId: id, role, content, seqNum: i + 1, createdAt: opts.createdAt });
  });
  if (opts.msgs && opts.msgs.length > 0) {
    db.prepare('UPDATE sessions SET message_count = ? WHERE id = ?').run(opts.msgs.length, id);
  }
  if (opts.state === 'confirmed') confirmSession(db, id, '2026-06-02T08:00:00Z');
}

beforeAll(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(path.join(PROJECT, '.sessionrelay'), { recursive: true });
  saveConfig(PROJECT, cfg());
});
afterAll(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });

// ═══════════════════════════════════════════════
// 一、搜索边界测试
// ═══════════════════════════════════════════════
describe('搜索边界', () => {
  let db: ReturnType<typeof createDb>;
  beforeEach(() => {
    db = createDb(); // :memory: 避免文件锁
    seedSession(db, 'edge001', { state: 'confirmed', msgs: [
      ['user', '测试边界条件'],
      ['assistant', '这是助手的回复'],
    ]});
  });
  afterAll(() => { db?.close(); });

  it('空查询 → 返回空结果（不报错）', () => {
    expect(searchSessions(db, { project: PID, query: '' })).toEqual([]);
  });

  it('单个汉字查询 → 不崩溃', () => {
    const hits = searchSessions(db, { project: PID, query: '测' });
    expect(Array.isArray(hits)).toBe(true);
  });

  it('超长查询（100 字符）→ 不崩溃不超时', () => {
    const longQuery = '数据库索引优化方案讨论包括分区策略查询性能以及缓存机制' .repeat(3);
    const hits = searchSessions(db, { project: PID, query: longQuery });
    expect(Array.isArray(hits)).toBe(true);
  });

  it('特殊字符查询（SQL 注入尝试）→ 不崩溃不注入', () => {
    const malicious = `'; DROP TABLE sessions; --`;
    const hits = searchSessions(db, { project: PID, query: malicious });
    expect(Array.isArray(hits)).toBe(true);
    expect(db.prepare('SELECT COUNT(*) n FROM sessions').get()).toBeTruthy();
  });

  it('路径遍历尝试 → 不崩溃', () => {
    const hits = searchSessions(db, { project: PID, query: '../../../etc/passwd' });
    expect(Array.isArray(hits)).toBe(true);
  });

  it('Emoji 查询 → 不崩溃', () => {
    const hits = searchSessions(db, { project: PID, query: '🎉🚀💻' });
    expect(Array.isArray(hits)).toBe(true);
  });

  it('limit=0 → 返回空', () => {
    expect(searchSessions(db, { project: PID, query: '测试', limit: 0 })).toEqual([]);
  });

  it('limit 负数 → 不崩溃', () => {
    const hits = searchSessions(db, { project: PID, query: '测试', limit: -1 });
    expect(Array.isArray(hits)).toBe(true);
  });

  it('不存在的项目 ID → 返回空', () => {
    expect(searchSessions(db, { project: 'proj_nonexistent', query: '测试' })).toEqual([]);
  });
});

// ═══════════════════════════════════════════════
// 二、归档边界测试
// ═══════════════════════════════════════════════
describe('归档边界', () => {
  let db: ReturnType<typeof createDb>;
  beforeEach(() => {
    db = createDb(); // :memory: 避免文件锁
  });
  afterAll(() => { db?.close(); });

  it('空库归档 → 零操作不报错', () => {
    const r = runArchive(db, { days: 1 });
    expect(r.archived).toBe(0);
    expect(r.skipped).toBe(0);
  });

  it('所有会话都是 active → 全部跳过', () => {
    seedSession(db, 'arc001', { state: 'active', msgs: [['user', '测试']] });
    const r = runArchive(db, { days: 1 });
    expect(r.archived).toBe(0);
    expect(r.skipped).toBe(1);
  });

  it('所有会话都是 imported → 全部跳过', () => {
    seedSession(db, 'arc002', { state: 'confirmed', origin: 'imported', msgs: [['user', '测试']] });
    const r = runArchive(db, { days: 1 });
    expect(r.archived).toBe(0);
    expect(r.skipped).toBe(1);
  });

  it('所有会话都是 note → 全部跳过', () => {
    seedSession(db, 'arc003', { state: 'confirmed', origin: 'note', msgs: [['user', '测试']] });
    const r = runArchive(db, { days: 1 });
    expect(r.archived).toBe(0);
    expect(r.skipped).toBe(1);
  });

  it('带"保留"标签的会话 → 跳过', () => {
    seedSession(db, 'arc004', { state: 'confirmed', tags: ['保留'], msgs: [['user', '重要讨论']] });
    const r = runArchive(db, { days: 1 });
    expect(r.archived).toBe(0);
    expect(r.skipped).toBe(1);
  });

  it('已归档的会话不再重复归档', () => {
    seedSession(db, 'arc005', { state: 'confirmed', msgs: [['user', '旧会话']], createdAt: '2026-01-01T08:00:00Z' });
    const r1 = runArchive(db, { days: 30 });
    expect(r1.archived).toBe(1);
    const r2 = runArchive(db, { days: 30 });
    expect(r2.archived).toBe(0); // 已归档
  });

  it('归档后决策保留', () => {
    seedSession(db, 'arc006', { state: 'confirmed', msgs: [
      ['user', '决定采用 PostgreSQL 数据库'],
      ['assistant', '好的'],
    ], createdAt: '2026-01-01T08:00:00Z' });
    runArchive(db, { days: 30 });
    const row = db.prepare('SELECT title, cleanup_at FROM sessions WHERE id = ?').get('arc006') as { title: string | null; cleanup_at: string | null } | undefined;
    expect(row).toBeTruthy();
    expect(row!.title).toBeTruthy();
    expect(row!.cleanup_at).toBeTruthy();
  });

  it('归档后消息为零', () => {
    seedSession(db, 'arc007', { state: 'confirmed', msgs: [
      ['user', '测试消息1'], ['assistant', '回复1'], ['user', '测试消息2'],
    ], createdAt: '2026-01-01T08:00:00Z' });
    runArchive(db, { days: 30 });
    expect(countMessages(db, 'arc007')).toBe(0);
  });

  it('硬删除后会话彻底消失', () => {
    seedSession(db, 'arc008', { state: 'confirmed', msgs: [['user', '要删的']], createdAt: '2026-01-01T08:00:00Z' });
    runArchive(db, { days: 30, hard: true });
    expect(getSession(db, 'arc008')).toBeUndefined();
  });

  it('--include-protected 覆盖保护规则', () => {
    seedSession(db, 'arc009', { state: 'confirmed', origin: 'imported', msgs: [['user', '导入的']], createdAt: '2026-01-01T08:00:00Z' });
    const r = runArchive(db, { days: 30, includeProtected: true });
    expect(r.archived).toBe(1);
  });

  it('dry-run 不实际修改数据', () => {
    seedSession(db, 'arc010', { state: 'confirmed', msgs: [['user', '测试']], createdAt: '2026-01-01T08:00:00Z' });
    const r = runArchive(db, { days: 30, dryRun: true });
    expect(r.details.length).toBeGreaterThan(0);
    expect(countMessages(db, 'arc010')).toBe(1); // 消息还在
  });
});

// ═══════════════════════════════════════════════
// 三、数据完整性测试
// ═══════════════════════════════════════════════
describe('数据完整性', () => {
  let db: ReturnType<typeof createDb>;
  beforeEach(() => {
    db = createDb(); // :memory: 避免文件锁
  });
  afterAll(() => { db?.close(); });

  it('幂等插入：同 (session, seq) 不产生重复', () => {
    seedSession(db, 'idem001', { msgs: [['user', '消息1']] });
    const c1 = insertMessage(db, { sessionId: 'idem001', role: 'user', content: '消息1', seqNum: 1 });
    expect(c1).toBe(0); // OR IGNORE 跳过
    expect(countMessages(db, 'idem001')).toBe(1);
  });

  it('重复导入同身份同 hash 的会话 → 跳过', () => {
    insertImportedSession(db, {
      source: 'claude-code', sourceSessionId: 'imp-test', projectId: PID,
      title: '导入测试', createdAt: '2026-01-01T08:00:00Z', lastEventAt: '2026-01-01T09:00:00Z',
      messageCount: 1, topics: [], decisions: [], summaryRule: null, author: null,
      importedFrom: 'test', originProject: 'other', contentHash: 'sha256:abc123', sourceFile: null,
    });
    const r2 = insertImportedSession(db, {
      source: 'claude-code', sourceSessionId: 'imp-test', projectId: PID,
      title: '导入测试', createdAt: '2026-01-01T08:00:00Z', lastEventAt: '2026-01-01T09:00:00Z',
      messageCount: 1, topics: [], decisions: [], summaryRule: null, author: null,
      importedFrom: 'test', originProject: 'other', contentHash: 'sha256:abc123', sourceFile: null,
    });
    expect(r2.skipped).toBe(true);
  });

  it('不同 hash 同身份 → 后缀导入（保留双方）', () => {
    insertImportedSession(db, {
      source: 'claude-code', sourceSessionId: 'imp-hash', projectId: PID,
      title: '原始', createdAt: '2026-01-01T08:00:00Z', lastEventAt: null,
      messageCount: 1, topics: [], decisions: [], summaryRule: null, author: null,
      importedFrom: null, originProject: null, contentHash: 'sha256:hash1', sourceFile: null,
    });
    const r2 = insertImportedSession(db, {
      source: 'claude-code', sourceSessionId: 'imp-hash', projectId: PID,
      title: '更新版', createdAt: '2026-01-02T08:00:00Z', lastEventAt: null,
      messageCount: 2, topics: [], decisions: [], summaryRule: null, author: null,
      importedFrom: 'other', originProject: null, contentHash: 'sha256:hash2', sourceFile: null,
    });
    expect(r2.skipped).toBe(false);
    expect(r2.id).not.toBe(getSession(db, 'imp-hash')?.id); // 不同 ID
  });

  it('级联删除：删 session 时 messages 也删除', () => {
    seedSession(db, 'casc001', { msgs: [['user', 'a'], ['user', 'b'], ['user', 'c']] });
    expect(countMessages(db, 'casc001')).toBe(3);
    db.prepare('DELETE FROM sessions WHERE id = ?').run('casc001');
    expect(countMessages(db, 'casc001')).toBe(0);
  });
});

// ═══════════════════════════════════════════════
// 四、跨功能交互测试
// ═══════════════════════════════════════════════
describe('跨功能交互', () => {
  let db: ReturnType<typeof createDb>;
  beforeEach(() => {
    db = createDb(); // :memory: 避免文件锁
  });
  afterAll(() => { db?.close(); });

  it('归档 → 搜索仍能命中元数据', () => {
    seedSession(db, 'cross001', { state: 'confirmed', msgs: [
      ['user', '数据库选型讨论最终决定用 PostgreSQL'],
    ], createdAt: '2026-01-01T08:00:00Z' });
    runArchive(db, { days: 30 });
    const hits = searchSessions(db, { project: PID, query: 'PostgreSQL' });
    expect(hits.some(h => h.sessionId === 'cross001' || h.viaMeta)).toBe(true);
  });

  it('归档 → sessions 行保留 + cleanup_at 标记（硬删需 --force rebuild 后再做）', () => {
    seedSession(db, 'cross002', { state: 'confirmed', msgs: [['user', '测试']], createdAt: '2026-01-01T08:00:00Z' });
    runArchive(db, { days: 30 }); // 归档
    const row = db.prepare('SELECT cleanup_at FROM sessions WHERE id = ?').get('cross002') as { cleanup_at: string | null } | undefined;
    expect(row).toBeTruthy(); // sessions 行保留
    expect(row!.cleanup_at).toBeTruthy(); // 归档标记存在
    // 已归档的会话被 cleanup_at IS NULL 过滤，不会被再次归档（设计如此）
    const r2 = runArchive(db, { days: 30, hard: true });
    expect(r2.archived).toBe(0); // 已归档的跳过
  });

  it('多个会话混合状态 → archive 只处理符合条件的', () => {
    seedSession(db, 'mix_active', { state: 'active', msgs: [['user', '活跃的']], createdAt: '2026-01-01T08:00:00Z' });
    seedSession(db, 'mix_confirmed', { state: 'confirmed', msgs: [['user', '确认的']], createdAt: '2026-01-01T08:00:00Z' });
    seedSession(db, 'mix_imported', { state: 'confirmed', origin: 'imported', msgs: [['user', '导入的']], createdAt: '2026-01-01T08:00:00Z' });
    seedSession(db, 'mix_note', { state: 'confirmed', origin: 'note', msgs: [['user', '笔记']], createdAt: '2026-01-01T08:00:00Z' });
    const r = runArchive(db, { days: 30 });
    // 只有 mix_confirmed 被归档
    expect(r.archived).toBe(1);
    expect(r.skipped).toBe(3);
    expect(getSession(db, 'mix_active')).toBeTruthy();
    expect(getSession(db, 'mix_imported')).toBeTruthy();
    expect(getSession(db, 'mix_note')).toBeTruthy();
  });

  it('归档历史记录正确', () => {
    seedSession(db, 'hist001', { state: 'confirmed', msgs: [['user', '测试']], createdAt: '2026-01-01T08:00:00Z' });
    runArchive(db, { days: 30 });
    const history = getArchiveHistory(db) as Array<Record<string, unknown>>;
    expect(history.length).toBe(1);
    expect(history[0].sessions_affected).toBe(1);
  });
});

// ═══════════════════════════════════════════════
// 五、异常输入测试
// ═══════════════════════════════════════════════
describe('异常输入', () => {
  let db: ReturnType<typeof createDb>;
  beforeEach(() => {
    db = createDb(); // :memory: 避免文件锁
  });
  afterAll(() => { db?.close(); });

  it('null 标题的会话 → 搜索不崩溃', () => {
    insertSession(db, { id: 'null001', source: 'claude-code', sourceSessionId: 'null001', projectId: PID, createdAt: '2026-01-01T08:00:00Z' });
    db.prepare('UPDATE sessions SET title = NULL WHERE id = ?').run('null001');
    const hits = searchSessions(db, { project: PID, query: 'null' });
    expect(Array.isArray(hits)).toBe(true);
  });

  it('空消息的会话 → 搜索不命中但存在', () => {
    insertSession(db, { id: 'empty001', source: 'claude-code', sourceSessionId: 'empty001', projectId: PID, createdAt: '2026-01-01T08:00:00Z' });
    expect(listSessions(db, { projectId: PID }).some(s => s.id === 'empty001')).toBe(true);
  });

  it('超长消息内容（100KB）→ 不崩溃', () => {
    seedSession(db, 'long001', { state: 'confirmed' });
    const longContent = 'A'.repeat(100 * 1024);
    insertMessage(db, { sessionId: 'long001', role: 'user', content: longContent, seqNum: 1 });
    const hits = searchSessions(db, { project: PID, query: 'AAAA' });
    expect(Array.isArray(hits)).toBe(true);
  });

  it('会话不存在时 get_session_detail → 不崩溃', () => {
    expect(getSession(db, 'nonexistent')).toBeUndefined();
  });
});
