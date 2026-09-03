// forget 防复活对抗（test-forget v3 · C 组——本特性生死线）
// §I 纪律：本文件必须造真实源文件（JSONL + sqlite 源）——直插 DB 的会话 sync 根本不会发现，
// 复活对抗无从谈起。C5 两种源型分叉：JSONL 追加行（字节游标）/ zcode 源库 INSERT（rowid 游标）。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { runSync, captureSessions } from '../../src/capture/sync.js';
import { resetConn } from '../../src/adapters/zcode/index.js';
import { createDb, openExisting, listSessions, countMessages } from '../../src/store/db.js';
import { dbFile, ignoreFile, projectIdOf } from '../../src/shared/paths.js';
import { runRebuild } from '../../src/capture/rebuild.js';
import { loadConfig } from '../../src/shared/config.js';
import { makeProject, runCli } from './helpers.js';

const TMP = path.resolve('test/.tmp/forget-c');
const PROJECT = path.join(TMP, 'app');
const CLAUDE_BASE = path.join(TMP, 'claude-projects');
const ZCODE_DB = path.join(TMP, 'zcode', 'db.sqlite');
const PID = projectIdOf(PROJECT);

const claudeLine = (i: number, role: 'user' | 'assistant', text: string) =>
  JSON.stringify({ type: role, message: { role, content: text }, timestamp: `2026-08-2${Math.min(8, 1 + i % 8)}T10:00:00Z`, sessionId: 's', cwd: PROJECT, isSidechain: false });

function writeClaudeSession(id: string, lines: string[]): string {
  const slug = PROJECT.replace(/[\\/:]/g, '-');
  const dir = path.join(CLAUDE_BASE, slug);
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(fp, lines.join('\n') + '\n');
  return fp;
}

function buildFakeZcodeDb(): void {
  fs.mkdirSync(path.dirname(ZCODE_DB), { recursive: true });
  const z = new Database(ZCODE_DB);
  z.exec(`
    CREATE TABLE IF NOT EXISTS session (id text primary key, project_id text, directory text not null, title text not null,
                           time_created integer not null, time_updated integer not null);
    CREATE TABLE IF NOT EXISTS message (id text primary key, session_id text not null, time_created integer not null, data text not null, sequence integer);
    CREATE TABLE IF NOT EXISTS part (id text primary key, message_id text not null, session_id text not null,
                       time_created integer, time_updated integer, data text not null, sequence integer);
  `);
  z.prepare('INSERT OR REPLACE INTO session VALUES (?,?,?,?,?,?)').run('sess_z1', 'proj_x', PROJECT, 'zcode 会话：编排策略', 1787800000000, 1787800600000);
  const insM = z.prepare('INSERT INTO message VALUES (?,?,?,?,?)');
  const insP = z.prepare('INSERT INTO part VALUES (?,?,?,?,?,?,?)');
  insM.run('m1', 'sess_z1', 1787800000001, JSON.stringify({ role: 'user', time: { created: 1 } }), 1);
  insP.run('m1_p0', 'm1', 'sess_z1', 1, 1, JSON.stringify({ type: 'text', text: '编排策略怎么选' }), 0);
  z.close();
}

let S1_ID = ''; // claude 会话内部 id
let Z1_ID = ''; // zcode 会话内部 id

beforeAll(() => {
  for (let i = 0; i < 3; i++) { try { fs.rmSync(TMP, { recursive: true, force: true }); break; } catch { /* retry */ } }
  makeProject(PROJECT, { claude_projects_dir: CLAUDE_BASE, zcode_db_path: ZCODE_DB, sources: ['claude-code', 'zcode'] });
  process.chdir(PROJECT);
  writeClaudeSession('forget-target', [
    claudeLine(1, 'user', '隐私话题：删掉这条讨论'),
    claudeLine(2, 'assistant', '好的这条会被遗忘'),
  ]);
  buildFakeZcodeDb();
});

afterAll(() => {
  resetConn(); // 释放 zcode 缓存连接（Windows 删除锁）
  process.chdir(path.resolve('.'));
  for (let i = 0; 3 > i; i++) { try { fs.rmSync(TMP, { recursive: true, force: true }); return; } catch { /* retry */ } }
});

const syncOnce = async () => {
  const db = openExisting(dbFile(PROJECT));
  try {
    return await runSync({ projectRoot: PROJECT, config: loadConfig(PROJECT), db });
  } finally { db.close(); }
};

// ══════════ C 组：防复活对抗（顺序链） ══════════

describe('forget · C 防复活对抗（真实源文件）', () => {
  it('前置：首次 sync 捕获两条源会话', async () => {
    const s = await syncOnce();
    expect(s.newSessions).toBe(2);
    const db = openExisting(dbFile(PROJECT));
    const rows = listSessions(db, { projectId: PID });
    S1_ID = rows.find((r) => r.source === 'claude-code')!.id;
    Z1_ID = rows.find((r) => r.source === 'zcode')!.id;
    db.close();
  });

  it('C1 删除后增量 sync：ignore 规则挡住（主防线），blocked+1，不复活', async () => {
    const { cmdForget } = await import('../../src/cli/forget.js');
    const r = await runCli(() => cmdForget({ yes: true }, S1_ID));
    expect(r.exitCode).toBeNull();
    // ignore 规则已强制追加
    const ig = fs.readFileSync(ignoreFile(PROJECT), 'utf8');
    expect(ig).toContain('session:claude-code/forget-target');
    // 模拟文件变化：追加新行
    const slug = PROJECT.replace(/[\\/:]/g, '-');
    fs.appendFileSync(path.join(CLAUDE_BASE, slug, 'forget-target.jsonl'), claudeLine(3, 'user', '追加的新消息不应入库') + '\n');
    const s = await syncOnce();
    expect(s.blocked).toBeGreaterThanOrEqual(1);
    const db = openExisting(dbFile(PROJECT));
    expect(listSessions(db, { projectId: PID }).some((x) => x.id === S1_ID)).toBe(false);
    db.close();
  });

  it('C2 清空 ignore 文件后 sync：墓碑挡住（次级防线），不复活', async () => {
    fs.writeFileSync(ignoreFile(PROJECT), '# 用户清理了规则\n');
    const s = await syncOnce();
    expect(s.blocked).toBeGreaterThanOrEqual(1);
    const db = openExisting(dbFile(PROJECT));
    expect(listSessions(db, { projectId: PID }).some((x) => x.id === S1_ID)).toBe(false);
    db.close();
    // 还原 ignore 规则（C3 依赖）
    fs.appendFileSync(ignoreFile(PROJECT), 'session:claude-code/forget-target\n');
  });

  it('C3 rebuild --force：ignore 规则跨库存活，重建后不复活；新库墓碑为空', async () => {
    const cfg = loadConfig(PROJECT);
    const res = await runRebuild({ root: PROJECT, cfg, force: true });
    expect(res.autoSessions).toBe(1); // 只剩 zcode 会话
    const db = openExisting(dbFile(PROJECT));
    const rows = listSessions(db, { projectId: PID });
    expect(rows.some((x) => x.source === 'claude-code' && x.source_session_id === 'forget-target')).toBe(false);
    expect((db.prepare('SELECT COUNT(*) n FROM forget_tombstones').get() as { n: number }).n).toBe(0); // 新库无墓碑
    db.close();
    expect(fs.readFileSync(ignoreFile(PROJECT), 'utf8')).toContain('session:claude-code/forget-target'); // 规则原样保留
  });

  it('C4 双闸都拆：复活（预期行为——用户明确拆闸=撤回遗忘，开放点 1 默认裁决）', async () => {
    fs.writeFileSync(ignoreFile(PROJECT), ''); // C3 后新库无墓碑 → 只剩这一道闸
    const s = await syncOnce();
    expect(s.blocked).toBe(0);
    const db = openExisting(dbFile(PROJECT));
    const back = listSessions(db, { projectId: PID }).find((x) => x.source === 'claude-code' && x.source_session_id === 'forget-target');
    expect(back).toBeDefined(); // 复活 = 撤回遗忘
    db.close();
  });

  it('C5a JSONL 源（字节游标）：删除后向源文件追加行，session: 规则拦整个会话', async () => {
    const { cmdForget } = await import('../../src/cli/forget.js');
    const db0 = openExisting(dbFile(PROJECT));
    const again = listSessions(db0, { projectId: PID }).find((x) => x.source === 'claude-code')!;
    await runCli(() => cmdForget({ yes: true }, again.id));
    db0.close();
    const slug = PROJECT.replace(/[\\/:]/g, '-');
    fs.appendFileSync(path.join(CLAUDE_BASE, slug, 'forget-target.jsonl'), claudeLine(4, 'assistant', '再追加一条也不入库') + '\n');
    const s = await syncOnce();
    expect(s.blocked).toBeGreaterThanOrEqual(1);
    const db = openExisting(dbFile(PROJECT));
    expect(listSessions(db, { projectId: PID }).some((x) => x.source === 'claude-code')).toBe(false);
    db.close();
  });

  it('C5b SQLite 源（rowid 游标）：删除后向 zcode 源库 INSERT 新消息，不入库', async () => {
    const { cmdForget } = await import('../../src/cli/forget.js');
    await runCli(() => cmdForget({ yes: true }, Z1_ID));
    const ig = fs.readFileSync(ignoreFile(PROJECT), 'utf8');
    expect(ig).toContain('session:zcode/sess_z1');
    const z = new Database(ZCODE_DB);
    z.prepare('INSERT INTO message VALUES (?,?,?,?,?)').run('m99', 'sess_z1', 1787999999000, JSON.stringify({ role: 'user' }), 99);
    z.prepare('INSERT INTO part VALUES (?,?,?,?,?,?,?)').run('m99_p0', 'm99', 'sess_z1', 1, 1, JSON.stringify({ type: 'text', text: 'rowid 水位后的新消息' }), 0);
    z.close();
    const s = await syncOnce();
    expect(s.blocked).toBeGreaterThanOrEqual(1);
    const db = openExisting(dbFile(PROJECT));
    expect(listSessions(db, { projectId: PID }).some((x) => x.source === 'zcode')).toBe(false);
    db.close();
  });

  it('C6 captureSessions 注入入口（save/导入路径）：不复活', async () => {
    const db = openExisting(dbFile(PROJECT));
    const result = await captureSessions({
      projectRoot: PROJECT, config: loadConfig(PROJECT), db,
      sessions: [{
        source: 'claude-code', sourceSessionId: 'forget-target',
        sourceFile: path.join(CLAUDE_BASE, PROJECT.replace(/[\\/:]/g, '-'), 'forget-target.jsonl'),
        title: '注入的隐私会话', sizeBytes: 100, mtimeMs: Date.now(),
      }],
    });
    expect(result.blocked).toBe(1);
    expect(result.newSessions).toBe(0);
    db.close();
  });

  it('C7 save 主动重存被遗忘会话：拦截 + 非静默提示（双向语义）', async () => {
    const db = openExisting(dbFile(PROJECT));
    const result = await captureSessions({
      projectRoot: PROJECT, config: loadConfig(PROJECT), db,
      sessions: [{
        source: 'claude-code', sourceSessionId: 'forget-target',
        sourceFile: path.join(CLAUDE_BASE, PROJECT.replace(/[\\/:]/g, '-'), 'forget-target.jsonl'),
        title: '用户想重新存的会话', sizeBytes: 100, mtimeMs: Date.now(),
      }],
    });
    expect(result.blocked).toBe(1);
    // 必须有非静默提示（墓碑语义），禁止静默 0
    expect(result.warnings.join('\n')).toContain('forget');
    db.close();
  });

  it('C7b 幂等：重复 forget / 重复导入不堆叠 ignore 规则', async () => {
    const ig = fs.readFileSync(ignoreFile(PROJECT), 'utf8');
    const count = (ig.match(/session:claude-code\/forget-target/g) ?? []).length;
    expect(count).toBe(1);
    void countMessages;
  });
});
