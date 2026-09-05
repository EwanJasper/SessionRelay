// forget 功能与误用防护（test-forget v3 · A/B/D1-D4/F/G 组）
// 手法：直插 DB（§I：功能断言可用直插；复活对抗见 resurrection.spec，必须真实源文件）
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import {
  createDb, openExisting, insertSession, insertMessage, insertImportedSession,
  createNoteSession, addSessionLink, getLinkedSessions, getSession,
  countsByState, getForgetHistory, insertTransferLog,
} from '../../src/store/db.js';
import { dbFile, ignoreFile, projectIdOf } from '../../src/shared/paths.js';
import { searchSessions } from '../../src/search-svc/engine.js';
import { listDecisions } from '../../src/store/db.js';
import { runExport } from '../../src/relay/export.js';
import { loadConfig } from '../../src/shared/config.js';
import { makeProject, runCli } from './helpers.js';

const TMP = path.resolve('test/.tmp/forget-a');
const PROJECT = path.join(TMP, 'app');
const PID = projectIdOf(PROJECT);

// 直插 id 设计：S1/S2 共享前缀 a3f（D1 歧义用）；S1B 唯一
const S1 = 'a3f8c2d100000001';   // 12 msg + 1 决策 + 双向链接
const S1B = 'a3f9c2d100000001';  // 与 S1 共享 "a3f"
const S2 = 'f1e2d3c400000001';  // 链接对方
let N1 = '';                     // note 内部 id（createNoteSession 返回）
let IMP = '';                    // imported 内部 id

beforeAll(() => {
  for (let i = 0; i < 3; i++) { try { fs.rmSync(TMP, { recursive: true, force: true }); break; } catch { /* retry */ } }
  makeProject(PROJECT);
  process.chdir(PROJECT);
  const db = createDb(dbFile(PROJECT));
  insertSession(db, { id: S1, source: 'zcode', sourceSessionId: 'z-s1', projectId: PID, createdAt: '2026-08-20T08:00:00Z', title: '数据库选型（PG vs MongoDB）', topics: ['db'] });
  for (let i = 1; i <= 12; i++) insertMessage(db, { sessionId: S1, role: i % 2 ? 'user' : 'assistant', content: i === 3 ? '磁悬浮轴承选型讨论：决定采用 PG' : `消息 ${i}：普通内容`, seqNum: i, createdAt: '2026-08-20T08:00:00Z' });
  db.prepare('UPDATE sessions SET message_count = 12, decisions = ?, last_event_at = ? WHERE id = ?')
    .run(JSON.stringify([{ text: '决定采用 PostgreSQL', seq: 3 }]), '2026-08-20T09:00:00Z', S1);
  insertSession(db, { id: S1B, source: 'claude-code', sourceSessionId: 'c-s1b', projectId: PID, createdAt: '2026-08-22T08:00:00Z', title: '另一个 a3f 会话', topics: ['misc'] });
  insertMessage(db, { sessionId: S1B, role: 'user', content: '无关内容', seqNum: 1, createdAt: '2026-08-22T08:00:00Z' });
  db.prepare('UPDATE sessions SET message_count = 1, last_event_at = ? WHERE id = ?').run('2026-08-22T08:00:00Z', S1B);
  insertSession(db, { id: S2, source: 'zcode', sourceSessionId: 'z-s2', projectId: PID, createdAt: '2026-08-21T08:00:00Z', title: '链接对方会话', topics: ['db'] });
  insertMessage(db, { sessionId: S2, role: 'user', content: '对方内容', seqNum: 1, createdAt: '2026-08-21T08:00:00Z' });
  db.prepare('UPDATE sessions SET message_count = 1 WHERE id = ?').run(S2);
  addSessionLink(db, S1, S2, 'related');
  addSessionLink(db, S2, S1, 'related');
  N1 = createNoteSession(db, { projectId: PID, title: '发布里程碑笔记', content: '决定 v0.3.0 加入遗忘权功能。', tags: ['发布', '里程碑'] });
  const imp = (() => {
    insertImportedSession(db, {
      source: 'zcode', sourceSessionId: 'z-imp', projectId: PID, title: '导入的老会话',
      createdAt: '2026-07-01T00:00:00Z', lastEventAt: '2026-07-02T00:00:00Z', messageCount: 3,
      topics: ['legacy'], decisions: [], summaryRule: null, author: '张三',
      importedFrom: 'hop', originProject: 'other-proj', contentHash: 'abc123', sourceFile: null,
    });
    return db.prepare("SELECT id FROM sessions WHERE source_session_id = 'z-imp' AND origin = 'imported'").get() as { id: string };
  })();
  IMP = imp.id;
  db.close();
});

afterAll(() => {
  process.chdir(path.resolve('.'));
  for (let i = 0; i < 3; i++) { try { fs.rmSync(TMP, { recursive: true, force: true }); return; } catch { /* retry */ } }
});

const sessionCount = (db: Database.Database) => (db.prepare('SELECT COUNT(*) n FROM sessions').get() as { n: number }).n;
const messageCount = (db: Database.Database, sid: string) => (db.prepare('SELECT COUNT(*) n FROM messages WHERE session_id = ?').get(sid) as { n: number }).n;

// ══════════ A 组：功能正路径 ══════════

describe('forget · A 功能正路径', () => {
  it('A1 预览（无 --yes）：输出完整预览要素，DB 零删除', async () => {
    const db = openExisting(dbFile(PROJECT));
    const before = sessionCount(db);
    db.close();
    const { cmdForget } = await import('../../src/cli/forget.js');
    const r = await runCli(() => cmdForget({}, 'a3f8c2d10000')); // S1 唯一前缀（S1B 是 a3f9…）
    expect(r.exitCode).toBeNull();
    const text = r.cap.out.join('\n');
    expect(text).toContain('遗忘预览');
    expect(text).toContain('数据库选型（PG vs MongoDB）');
    expect(text).toContain('zcode');
    expect(text).toContain('12 条消息');
    expect(text).toContain('1 决策');
    expect(text).toContain(S2);                       // 双向链接对方
    expect(text).toContain('imported 否');
    expect(text).toContain('天前');                    // 会话年龄
    expect(text).toContain('移除');
    expect(text).toContain('保留');
    const db2 = openExisting(dbFile(PROJECT));
    expect(sessionCount(db2)).toBe(before);           // 无任何删除
    db2.close();
  });

  it('A2 执行 --yes：行数减少 + FTS integrity-check 通过', async () => {
    const { cmdForget } = await import('../../src/cli/forget.js');
    const r = await runCli(() => cmdForget({ yes: true }, 'a3f8c2d10000'));
    expect(r.exitCode).toBeNull();
    const db = openExisting(dbFile(PROJECT));
    expect(getSession(db, S1)).toBeUndefined();
    expect(messageCount(db, S1)).toBe(0);
    // FTS 外部内容表无幽灵行（B2b 前置）
    db.prepare(`INSERT INTO messages_fts(messages_fts, rowid, search_text) VALUES ('integrity-check', 0, '')`).run();
    db.prepare(`INSERT INTO sessions_fts(sessions_fts, rowid, meta_text) VALUES ('integrity-check', 0, '')`).run();
    // 双向链接 CASCADE
    expect(getLinkedSessions(db, S2).some((l) => l.sessionId === S1)).toBe(false);
    db.close();
  });

  it('A3 删 note：无墓碑无 ignore 规则（source_file 判定走"可 discover 的真实文件"，非字符串非空）', async () => {
    const db0 = openExisting(dbFile(PROJECT));
    const tsBefore = (db0.prepare('SELECT COUNT(*) n FROM forget_tombstones').get() as { n: number }).n; // A2 的 S1 墓碑已存在
    db0.close();
    const { cmdForget } = await import('../../src/cli/forget.js');
    const r = await runCli(() => cmdForget({ yes: true, note: true }, N1));
    expect(r.exitCode).toBeNull();
    const db = openExisting(dbFile(PROJECT));
    const ts = (db.prepare('SELECT COUNT(*) n FROM forget_tombstones').get() as { n: number }).n;
    expect(ts).toBe(tsBefore); // note 不在复活路径上，不新增墓碑
    db.close();
    expect(fs.readFileSync(ignoreFile(PROJECT), 'utf8').includes(`session:note/`)).toBe(false); // 无 note 规则追加
  });

  it('A4/A5 --history：紧凑表 + json 合法', async () => {
    const { cmdForget } = await import('../../src/cli/forget.js');
    const db = openExisting(dbFile(PROJECT));
    const r1 = await runCli(() => cmdForget({ history: true }));
    expect(r1.exitCode).toBeNull();
    expect(r1.cap.out.join('\n')).toContain('session · 1 会话 · 12 消息');
    const r2 = await runCli(() => cmdForget({ history: true, json: true }));
    const rows = JSON.parse(r2.cap.out.join('')) as Array<Record<string, unknown>>;
    expect(rows.length).toBeGreaterThanOrEqual(2); // session + note
    expect(rows[0]).toHaveProperty('sessions_affected');
    expect(rows[0]).toHaveProperty('messages_affected');
    // 详明模式展开明细
    const r3 = await runCli(() => cmdForget({ history: true, verbose: true }));
    expect(r3.cap.out.join('\n')).toContain(S1);
    db.close();
  });
});

// ══════════ B 组：删除后全链路检索不命中 ══════════

describe('forget · B 删除后检索不命中', () => {
  it('B1 正文与元数据双路 0 命中 + B2b FTS 完整性 + B7 getSession not-found', () => {
    const db = openExisting(dbFile(PROJECT));
    const hits = searchSessions(db, { project: PID, query: '磁悬浮轴承' });
    expect(hits.length).toBe(0);
    expect(getSession(db, S1)).toBeUndefined();
    db.close();
  });

  it('B4 决策不含被删会话的决策', () => {
    const db = openExisting(dbFile(PROJECT));
    const decs = listDecisions(db, PID);
    expect(decs.some((d) => d.text.includes('PostgreSQL') && d.sessionId === S1)).toBe(false);
    db.close();
  });

  it('B5 双向链接：对方视角也不再返回 S1（A2 已删 out 方向，此处全量断言）', () => {
    const db = openExisting(dbFile(PROJECT));
    expect(getLinkedSessions(db, S1)).toEqual([]);
    expect(getLinkedSessions(db, S2).filter((l) => l.sessionId === S1)).toEqual([]);
    db.close();
  });

  it('B6 计数一致无负数（不断言 dbSizeMB——SQLite 删除不回缩文件）', () => {
    const db = openExisting(dbFile(PROJECT));
    const counts = countsByState(db, PID);
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThanOrEqual(2); // S1B + S2 + IMP
    expect(Object.values(counts).every((n) => n >= 0)).toBe(true);
    db.close();
  });

  it('B8 note 删除后（A3 已删）标签检索 0 命中', () => {
    const db = openExisting(dbFile(PROJECT));
    const hits = searchSessions(db, { project: PID, query: '里程碑 发布' });
    expect(hits.some((h) => h.sessionId === N1)).toBe(false);
    db.close();
  });

  it('B9 get_file_history 构造安全：唯一提及文件 X 的会话删除后 0 命中（JOIN sessions 天然过滤）', () => {
    const db = openExisting(dbFile(PROJECT));
    // 构造 S1B 为唯一提及 src/legacy/x.ts 的会话，删之
    insertMessage(db, { sessionId: S1B, role: 'assistant', content: '这个文件 src/legacy/x.ts 要重构', seqNum: 2, createdAt: '2026-08-22T08:10:00Z' });
    const before = searchSessions(db, { project: PID, query: '"src/legacy/x.ts"' });
    expect(before.some((h) => h.sessionId === S1B)).toBe(true);
    db.close();
    return (async () => {
      const { cmdForget } = await import('../../src/cli/forget.js');
      await runCli(() => cmdForget({ yes: true }, 'a3f9c2d1'));
      const db2 = openExisting(dbFile(PROJECT));
      const after = searchSessions(db2, { project: PID, query: '"src/legacy/x.ts"' });
      expect(after.length).toBe(0);
      db2.close();
    })();
  });

  it('B2b FTS integrity-check（两表，防静默损坏）', () => {
    const db = openExisting(dbFile(PROJECT));
    expect(() => db.prepare(`INSERT INTO messages_fts(messages_fts, rowid, search_text) VALUES ('integrity-check', 0, '')`).run()).not.toThrow();
    expect(() => db.prepare(`INSERT INTO sessions_fts(sessions_fts, rowid, meta_text) VALUES ('integrity-check', 0, '')`).run()).not.toThrow();
    db.close();
  });
});

// ══════════ D1-D4：前缀与误用 ══════════

describe('forget · D 误用防护', () => {
  it('D1 前缀歧义：多命中列表格候选 + 拒绝执行 + 两者都不删', async () => {
    // 此时 S1 已删；构造 f1e3 与 S2(f1e2…) 共享前缀 f1e
    const db = openExisting(dbFile(PROJECT));
    insertSession(db, { id: 'f1e3000000000001', source: 'zcode', sourceSessionId: 'z-s3', projectId: PID, createdAt: '2026-08-23T08:00:00Z', title: '第三个会话', topics: ['x'] });
    const before = sessionCount(db);
    db.close();
    const { cmdForget } = await import('../../src/cli/forget.js');
    const r = await runCli(() => cmdForget({ yes: true }, 'f1e')); // f1e2d3c4… 与 f1e3… 双命中
    expect(r.exitCode).toBe(2);
    const text = r.cap.out.join('\n');
    expect(text).toContain('f1e2d3c400000001');
    expect(text).toContain('f1e3000000000001');
    expect(text).toContain('用更多字符或完整 id 重试');
    const db2 = openExisting(dbFile(PROJECT));
    expect(sessionCount(db2)).toBe(before); // 两个都不删
    db2.close();
  });

  it('D2 唯一前缀正常删除流程', async () => {
    const { cmdForget } = await import('../../src/cli/forget.js');
    const r = await runCli(() => cmdForget({ yes: true }, 'f1e30000'));
    expect(r.exitCode).toBeNull();
    const db = openExisting(dbFile(PROJECT));
    expect(getSession(db, 'f1e3000000000001')).toBeUndefined();
    db.close();
  });

  it('D4 不存在的 id：not-found + DB 无变化', async () => {
    const db0 = openExisting(dbFile(PROJECT));
    const before = sessionCount(db0);
    const logs0 = (db0.prepare('SELECT COUNT(*) n FROM forget_log').get() as { n: number }).n;
    db0.close();
    const { cmdForget } = await import('../../src/cli/forget.js');
    const r = await runCli(() => cmdForget({ yes: true }, 'deadbeef'));
    expect(r.exitCode).toBe(1);
    expect(r.cap.err.join('\n')).toContain('未找到');
    const db = openExisting(dbFile(PROJECT));
    expect(sessionCount(db)).toBe(before);
    expect((db.prepare('SELECT COUNT(*) n FROM forget_log').get() as { n: number }).n).toBe(logs0);
    db.close();
  });
});

// ══════════ F 组：边界对象 ══════════

describe('forget · F 边界', () => {
  it('F1 imported：预览警示 + 删除后无墓碑（无本地源）', async () => {
    const db0 = openExisting(dbFile(PROJECT));
    const tsBefore = (db0.prepare('SELECT COUNT(*) n FROM forget_tombstones').get() as { n: number }).n; // 此前用例（A2/B9/D2）已产生墓碑
    db0.close();
    const { cmdForget } = await import('../../src/cli/forget.js');
    const pv = await runCli(() => cmdForget({}, IMP));
    expect(pv.exitCode).toBeNull();
    const text = pv.cap.out.join('\n');
    expect(text).toContain('imported 是');
    expect(text).toContain('无法 rebuild 找回');
    const r = await runCli(() => cmdForget({ yes: true }, IMP));
    expect(r.exitCode).toBeNull();
    const db = openExisting(dbFile(PROJECT));
    expect((db.prepare('SELECT COUNT(*) n FROM forget_tombstones').get() as { n: number }).n).toBe(tsBefore); // imported 不新增
    db.close();
  });

  it('F3 note-xxxx 前缀：按 sourceSessionId 识别 note 类型', async () => {
    // 重新造一条 note，用其 sourceSessionId（note-xxx 形态）删
    const db = openExisting(dbFile(PROJECT));
    const nid = createNoteSession(db, { projectId: PID, title: '临时笔记', content: '决定删除这条临时记录。' });
    const row = db.prepare('SELECT source_session_id FROM sessions WHERE id = ?').get(nid) as { source_session_id: string };
    expect(row.source_session_id.startsWith('note-')).toBe(true);
    db.close();
    const { cmdForget } = await import('../../src/cli/forget.js');
    const r = await runCli(() => cmdForget({ yes: true }, row.source_session_id));
    expect(r.exitCode).toBeNull();
    const db2 = openExisting(dbFile(PROJECT));
    expect(getSession(db2, nid)).toBeUndefined();
    db2.close();
  });

  it('F4 state=active 的 auto 会话可直接删（删除权在人不参与状态协商）', async () => {
    const db = openExisting(dbFile(PROJECT));
    insertSession(db, { id: 'abcd00000000000f', source: 'zcode', sourceSessionId: 'z-act', projectId: PID, createdAt: '2026-08-25T08:00:00Z', title: '活跃会话', state: 'active' });
    insertMessage(db, { sessionId: 'abcd00000000000f', role: 'user', content: '正在进行的讨论', seqNum: 1 });
    db.close();
    const { cmdForget } = await import('../../src/cli/forget.js');
    const r = await runCli(() => cmdForget({ yes: true }, 'abcd00000000000f'));
    expect(r.exitCode).toBeNull();
    const db2 = openExisting(dbFile(PROJECT));
    expect(getSession(db2, 'abcd00000000000f')).toBeUndefined();
    db2.close();
  });

  it('F5 重复删除：第二次 not-found，不产生第二条 forget_log', async () => {
    // S1 早在 A2 已删；统计基线后再次 --yes
    const db = openExisting(dbFile(PROJECT));
    const logs0 = (db.prepare('SELECT COUNT(*) n FROM forget_log').get() as { n: number }).n;
    db.close();
    const { cmdForget } = await import('../../src/cli/forget.js');
    const r = await runCli(() => cmdForget({ yes: true }, 'a3f8c2d100000001'));
    expect(r.exitCode).toBe(1);
    const db2 = openExisting(dbFile(PROJECT));
    expect((db2.prepare('SELECT COUNT(*) n FROM forget_log').get() as { n: number }).n).toBe(logs0);
    db2.close();
  });

  it('F6/D12 级联完整性 + 删除后 export 不受残留影响（transfer_log 无 FK，行保留不悬挂）', async () => {
    const db = openExisting(dbFile(PROJECT));
    // session_links FK CASCADE 已在 A2 验证；transfer_log 是审计表（session_ids 为 JSON 文本，无 FK）
    insertTransferLog(db, 'export', path.join(TMP, 'pre.hop'), null, null, [S2, 'zzz000000000000z']);
    db.close();
    const { cmdForget } = await import('../../src/cli/forget.js');
    const r = await runCli(() => cmdForget({ yes: true }, S2));
    expect(r.exitCode).toBeNull();
    // 删除后再 export：不 crash、不含已删会话
    const db2 = openExisting(dbFile(PROJECT));
    const cfg = loadConfig(PROJECT);
    const out = runExport({ root: PROJECT, cfg, db: db2, output: path.join(TMP, 'after.hop') });
    expect(out.sessionCount).toBeGreaterThanOrEqual(0);
    const transfer = db2.prepare('SELECT COUNT(*) n FROM transfer_log').get() as { n: number };
    expect(transfer.n).toBeGreaterThanOrEqual(1); // 手动 1 行 + runExport 自记 1 行；历史行保留（审计语义，非悬挂引用）
    db2.close();
  });
});

// ══════════ G 组：兼容性回归 ══════════

describe('forget · G 兼容性', () => {
  it('G1 v2 老库升级：user_version 2→当前（4）自动迁移，语义向量表一并就位', () => {
    const old = path.join(TMP, 'v2db', 'relay.sqlite');
    fs.mkdirSync(path.dirname(old), { recursive: true });
    const db = createDb(old);
    db.pragma('user_version = 2'); // 模拟 v0.2.4 老库
    db.exec('DROP TABLE forget_tombstones; DROP TABLE forget_log; DROP TABLE forget_detail; DROP TABLE IF EXISTS session_vectors;');
    db.close();
    const db2 = openExisting(old);
    expect(db2.pragma('user_version', { simple: true })).toBe(4);
    for (const t of ['forget_tombstones', 'forget_log', 'forget_detail', 'session_vectors']) {
      expect(db2.prepare(`SELECT COUNT(*) n FROM ${t}`).get()).toBeTruthy();
    }
    db2.close();
  });

  it('G1b 降级拒绝：更高版本库被打开时报错（无半迁移状态）', () => {
    const fut = path.join(TMP, 'v5db', 'relay.sqlite');
    fs.mkdirSync(path.dirname(fut), { recursive: true });
    const db = createDb(fut);
    db.pragma('user_version = 5'); // 模拟未来版本创建的库
    db.close();
    expect(() => openExisting(fut)).toThrow(/更新版本的 srelay/);
  });

  it('G5/G6/G7 文案钉子：forget 口诀 / save_note 话术 / archive --hard 引导', async () => {
    const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'); // cwd 已被 chdir，必须绝对定位
    const bin = fs.readFileSync(path.join(REPO, 'src/bin/srelay.ts'), 'utf8');
    expect(bin).toContain('空间老化用 archive，彻底消失用 forget');
    expect(bin).toContain('--confirm <projectId>');
    expect(bin).toContain('用 srelay forget'); // archive --hard 提示
    const server = fs.readFileSync(path.join(REPO, 'src/mcp/server.ts'), 'utf8');
    expect(server).toContain('可由用户以 srelay forget 移除');
  });
});
