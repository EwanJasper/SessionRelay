// MCP 契约测试（技术方案 §10.1 契约层）：
// 真实 stdio 握手 → 8 工具 schema → 出处强制 → Scope 交集语义 → 命中不足 hint → 热更新（T28）
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createDb, insertSession, insertMessage, confirmSession } from '../../src/store/db.js';
import { defaultConfig, saveConfig } from '../../src/shared/config.js';
import { dbFile, projectIdOf } from '../../src/shared/paths.js';

const REPO = fileURLToPath(new URL('../..', import.meta.url)); // 仓库根
const TMP = path.resolve('test/.tmp/mcp');
const PROJECT = path.join(TMP, 'app');
const PID = projectIdOf(PROJECT);

const daysAgo = (n: number) => new Date(Date.now() - n * 86400_000).toISOString();

beforeAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(path.join(PROJECT, '.sessionrelay'), { recursive: true });
  const cfg = defaultConfig();
  cfg.identity.project_id = PID;
  cfg.search.auto_days = 30; // A 档：近 30 天
  saveConfig(PROJECT, cfg);

  const db = createDb(dbFile(PROJECT));
  // sNew：10 天前（A 档窗口内）· topic db
  insertSession(db, { id: 'snew000000000001', source: 'zcode', sourceSessionId: 'z1', projectId: PID, createdAt: daysAgo(10), topics: ['db'], title: '数据库选型' });
  insertMessage(db, { sessionId: 'snew000000000001', role: 'user', content: '数据库怎么选？', seqNum: 1, createdAt: daysAgo(10) });
  insertMessage(db, { sessionId: 'snew000000000001', role: 'assistant', content: '决定采用 PostgreSQL，文件 src/db/schema.sql', seqNum: 2, createdAt: daysAgo(10) });
  db.prepare('UPDATE sessions SET last_event_at=? WHERE id=?').run(daysAgo(10), 'snew000000000001');
  // sOld：90 天前（A 档窗口外）
  insertSession(db, { id: 'sold0000000000001', source: 'claude-code', sourceSessionId: 'c1', projectId: PID, createdAt: daysAgo(90), topics: ['db'], title: '老会话：索引讨论' });
  insertMessage(db, { sessionId: 'sold0000000000001', role: 'user', content: '数据库索引策略', seqNum: 1, createdAt: daysAgo(90) });
  db.prepare('UPDATE sessions SET last_event_at=? WHERE id=?').run(daysAgo(90), 'sold0000000000001');
  // sAuth：近 · topic auth
  insertSession(db, { id: 'sauth0000000000001', source: 'zcode', sourceSessionId: 'z2', projectId: PID, createdAt: daysAgo(5), topics: ['auth'], title: '认证讨论' });
  insertMessage(db, { sessionId: 'sauth0000000000001', role: 'assistant', content: '认证方案定为 JWT', seqNum: 1, createdAt: daysAgo(5) });
  db.prepare('UPDATE sessions SET last_event_at=? WHERE id=?').run(daysAgo(5), 'sauth0000000000001');
  confirmSession(db, 'snew000000000001', daysAgo(9));
  confirmSession(db, 'sauth0000000000001', daysAgo(4));
  // fixture 直插消息需手动维护 message_count（真实流程由 sync 维护）
  db.prepare('UPDATE sessions SET message_count = 2 WHERE id = ?').run('snew000000000001');
  db.prepare('UPDATE sessions SET message_count = 1 WHERE id = ?').run('sauth0000000000001');
  db.close();
});

afterAll(() => { fs.rmSync(TMP, { recursive: true, force: true }); });

let client: Client;
let transport: StdioClientTransport;

beforeAll(async () => {
  transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', `file:///${path.join(REPO, 'node_modules/tsx/dist/loader.mjs').replace(/\\/g, '/')}`, path.join(REPO, 'src/bin/srelay.ts'), 'serve'],
    env: { ...process.env, SRELAY_PROJECT_ROOT: PROJECT } as Record<string, string>,
    stderr: 'ignore',
  });
  client = new Client({ name: 'srelay-contract-test', version: '0.0.0' });
  await client.connect(transport);
}, 30000);

afterAll(async () => {
  await client.close();
});

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const res = await client.callTool({ name, arguments: args });
  expect(res.isError ?? false).toBe(false);
  const text = (res.content as Array<{ type: string; text: string }>)[0].text;
  return JSON.parse(text) as Record<string, unknown>;
};

describe('P3 · MCP 契约（stdio 真握手）', () => {
  it('initialize + tools/list：8 个工具全部注册', async () => {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'get_decisions', 'get_file_history', 'get_session_detail', 'get_stats',
      'get_unresolved', 'list_sessions', 'search_sessions', 'set_scope',
    ]);
  });

  it('search_sessions：A 档 auto-scope 生效（老会话被裁剪）+ 出处块 + 命中不足 hint', async () => {
    const out = (await call('search_sessions', { query: '数据库' })) as {
      count: number; hits: Array<{ provenance: { sessionId: string; msg: number } }>; hint?: string;
    };
    expect(out.count).toBe(1); // sNew 命中；sOld 被 A 档（近30天）裁剪
    expect(out.hits[0].provenance.sessionId).toBe('snew000000000001');
    expect(typeof out.hits[0].provenance.msg).toBe('number'); // D10 出处
    expect(out.hint).toBeTruthy();
    expect(String(out.hint)).toContain('set_scope'); // 命中不足 → 放宽提示（验收）
  });

  it('B 档 scope.json 收窄：按提取出的 topic 过滤；CLI/MCP 共用契约', async () => {
    fs.writeFileSync(path.join(PROJECT, '.sessionrelay', 'scope.json'),
      JSON.stringify({ version: '1.0', mode: 'predicate', filters: { topics: ['认证'] }, issued_at: new Date().toISOString() }));
    const out = (await call('search_sessions', { query: '认证' })) as { count: number; hits: Array<{ sessionId: string }> };
    expect(out.count).toBe(1);
    expect(out.hits[0].sessionId).toBe('sauth0000000000001');
    const miss = (await call('search_sessions', { query: '数据库' })) as { count: number };
    expect(miss.count).toBe(0); // B 档交集：只能收窄（验收：scoped 语境不串台）
  });

  it('热更新 + 逃生口（T28/D5）：set_scope full 后老会话立即恢复可见', async () => {
    const out = (await call('set_scope', { mode: 'full' })) as { ok: boolean };
    expect(out.ok).toBe(true);
    const search = (await call('search_sessions', { query: '数据库' })) as { count: number; escaped: boolean; hits: Array<{ sessionId: string }> };
    expect(search.escaped).toBe(true);
    expect(search.count).toBe(2); // sNew + sOld（A 档随 full 解除）
    expect(search.hits.map((h) => h.sessionId).sort()).toEqual(['snew000000000001', 'sold0000000000001']);
  });

  it('get_session_detail：前缀解析 + 消息返回', async () => {
    const out = (await call('get_session_detail', { session_id: 'snew' })) as {
      found: boolean; messages: Array<{ seq: number; role: string }>; provenance: { sessionId: string };
    };
    expect(out.found).toBe(true);
    expect(out.messages).toHaveLength(2);
    expect(out.provenance.sessionId).toBe('snew000000000001');
  });

  it('get_decisions：决策含出处（msg 序号）', async () => {
    const out = (await call('get_decisions', {})) as {
      decisions: Array<{ text: string; provenance: { sessionId: string; msg: number } }>;
    };
    expect(out.decisions.length).toBeGreaterThanOrEqual(1);
    expect(out.decisions[0].provenance.msg).toBeGreaterThan(0);
  });

  it('get_stats：统计与当前 scope', async () => {
    const out = (await call('get_stats', {})) as { sessions: Record<string, number>; scope: { mode: string } | null };
    expect(out.sessions.total).toBe(3);
    expect(out.scope?.mode).toBe('full');
  });
});
