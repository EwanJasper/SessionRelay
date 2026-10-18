// [1021 审查 #13/#14] MCP 检索范围契约 + 消息分页/字节上限回归（审查版本 881176fb 的两条 P2）。
//
// 审查版实测到的原病：
//   #13 decisions / unresolved 在 scope 装配**之前**就 return —— scope 只允许会话 A 时，
//       决策检索照样返回 A 和范围外的 B；limit / since 也被静默忽略。
//   #14 把 message_count（条数）当成默认结束序号 —— seq 有空洞（100/500）时默认返回 0 条；
//       message_id 的提前返回分支又不过 50KB 硬顶，max_chars 调大后 90,000 字节原样泄出。
// 修复落在 ea97ce6，本文件写于其后：不改实现，只把这两条行为钉死——
// 任何一处回退，这个文件会红，而不是等下一次外部审查来发现。
//
// 为什么用 InMemoryTransport 而不是 stdio 子进程：这两条判据全在工具处理函数里，
// 进程内仍走 registerTool / zod / guard 的完整 MCP 路径；子进程只会把失败原因埋进 stderr。
// （只有子进程才有的行为——根解析信号链——另有 test/mcp/serve-resolve.spec.ts。）
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer, type ServeCtx } from '../../src/mcp/server.js';
import { createDb, insertSession, insertMessage, type DB } from '../../src/store/db.js';
import { defaultConfig, saveConfig } from '../../src/shared/config.js';
import { dbFile, projectIdOf } from '../../src/shared/paths.js';
import { saveScopeFile, makeScopeFile } from '../../src/core/scope/scopeFile.js';

const TMP = path.resolve('test/.tmp/mcp-scope-pagination');
const PROJECT = path.join(TMP, 'app');
const PID = projectIdOf(PROJECT);
const NOW = new Date().toISOString();

// 16 字符 id（与真实适配器同形；findSessionByPrefix 按前缀解析）
const A = 'aaaaaaaaaaaaaaaa'; // scope 放行的会话
const B = 'bbbbbbbbbbbbbbbb'; // scope 之外的会话
const C = 'cccccccccccccccc'; // seq 有空洞：100 / 500
const D = 'dddddddddddddddd'; // 单条 90,000 字节

let db: DB;
let client: Client;
let hugeId: number;
const oldToolAllow = process.env.SRELAY_MCP_TOOLS;

const call = async <T>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
  const res = await client.callTool({ name, arguments: args });
  expect(res.isError ?? false).toBe(false);
  return JSON.parse((res.content as Array<{ type: string; text: string }>)[0].text) as T;
};

beforeAll(async () => {
  for (let i = 0; i < 3; i++) { try { fs.rmSync(TMP, { recursive: true, force: true }); break; } catch { await new Promise((r) => setTimeout(r, 300)); } }
  fs.mkdirSync(path.join(PROJECT, '.sessionrelay'), { recursive: true });
  const cfg = defaultConfig();
  cfg.identity.project_id = PID;
  cfg.search.auto_days = 0; // 关掉 A 档：本文件的场景只由 B 档 scope.json + 调用参数决定
  saveConfig(PROJECT, cfg);

  db = createDb(dbFile(PROJECT));
  insertSession(db, { id: A, source: 'zcode', sourceSessionId: 'a', projectId: PID, createdAt: NOW, topics: ['db'], title: '会话 A' });
  insertSession(db, { id: B, source: 'claude-code', sourceSessionId: 'b', projectId: PID, createdAt: NOW, topics: ['auth'], title: '会话 B' });
  insertSession(db, { id: C, source: 'zcode', sourceSessionId: 'c', projectId: PID, createdAt: NOW, title: '空号会话' });
  insertSession(db, { id: D, source: 'zcode', sourceSessionId: 'd', projectId: PID, createdAt: NOW, title: '长消息会话' });
  db.prepare('UPDATE sessions SET decisions = ?, key_questions = ? WHERE id = ?').run(
    JSON.stringify([{ text: 'A 决定采用 PostgreSQL', seq: 1, at: NOW }]),
    JSON.stringify([{ q: 'A 未决：索引怎么建', at: NOW, unresolved: true }]), A);
  db.prepare('UPDATE sessions SET decisions = ?, key_questions = ? WHERE id = ?').run(
    JSON.stringify([{ text: 'B 决定采用 MySQL', seq: 1, at: NOW }]),
    JSON.stringify([{ q: 'B 未决：分库吗', at: NOW, unresolved: true }]), B);
  // C：真实适配器的 seq 是日志行号，会留空洞；message_count 只表示条数。
  insertMessage(db, { sessionId: C, role: 'user', content: 'C 的第一条', seqNum: 100, createdAt: NOW });
  insertMessage(db, { sessionId: C, role: 'assistant', content: 'C 的第二条', seqNum: 500, createdAt: NOW });
  db.prepare('UPDATE sessions SET message_count = 2 WHERE id = ?').run(C);
  // D：90,000 字节（中文 30,000 字）。审查版按 message_id 读它时整条泄出。
  insertMessage(db, { sessionId: D, role: 'assistant', content: '中'.repeat(30000), seqNum: 1, createdAt: NOW });
  db.prepare('UPDATE sessions SET message_count = 1 WHERE id = ?').run(D);
  hugeId = (db.prepare('SELECT id FROM messages WHERE session_id = ?').get(D) as { id: number }).id;

  // 白名单是进程级环境变量：测试进程里必须为空，否则工具不会注册（buildServer 读它）。
  delete process.env.SRELAY_MCP_TOOLS;
  const ctx: ServeCtx = { root: PROJECT, db, cfg, project: PID };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = buildServer(() => ctx);
  await server.connect(serverTransport);
  client = new Client({ name: 'mcp-scope-pagination', version: '0.0.0' });
  await client.connect(clientTransport);
});

beforeEach(() => {
  // 默认场景：scope 只放行 A（与审查复现一致）；需要别的 B 档的用例自己重写。
  saveScopeFile(PROJECT, makeScopeFile({ sessionIds: [A] }));
});

afterAll(async () => {
  try { await client?.close(); } catch { /* 幂等 */ }
  try { db?.close(); } catch { /* 幂等 */ }
  if (oldToolAllow === undefined) delete process.env.SRELAY_MCP_TOOLS; else process.env.SRELAY_MCP_TOOLS = oldToolAllow;
  for (let i = 0; i < 5; i++) { try { fs.rmSync(TMP, { recursive: true, force: true }); return; } catch { await new Promise((r) => setTimeout(r, 300)); } }
});

interface SessionListOut { count: number }
interface DecisionOut {
  count: number; not_applied?: string[]; note?: string;
  decisions: Array<{ text: string; provenance: { sessionId: string } }>;
}
interface UnresolvedOut {
  count: number; not_applied?: string[];
  unresolved: Array<{ q: string; provenance: { sessionId: string } }>;
}
interface ShowOut {
  found: boolean; returned: number; totalInDb: number; range: [number, number] | null;
  truncated?: boolean; totalBytesKB?: number;
  messages: Array<{ seq: number; msgId: string | number; role: string; content: string }>;
}

describe('审查 #13：检索分支必须走同一套 scope/限量装配', () => {
  it('scope 只允许会话 A 时，decisions 和 unresolved 都不得返回范围外的 B', async () => {
    // 基线：list_sessions 与检索共用同一份 scope，先证明 scope 真的只放行 A。
    const list = await call<SessionListOut>('list_sessions');
    expect(list.count).toBe(1);

    // 原病：decisions 在装配之前 return —— 实测返回 A + B 两条（scope 越界）。
    const dec = await call<DecisionOut>('srelay_search', { query: '一个绝不存在的词', kind: 'decisions' });
    expect(dec.count).toBe(1);
    expect(dec.decisions.map((d) => d.provenance.sessionId)).toEqual([A]);

    // 原病：unresolved 同样绕过装配 —— 实测也返回两条。
    const un = await call<UnresolvedOut>('srelay_search', { query: '一个绝不存在的词', kind: 'unresolved' });
    expect(un.count).toBe(1);
    expect(un.unresolved.map((u) => u.provenance.sessionId)).toEqual([A]);
  });

  it('query 不支持时明确 not_applied；limit 与 since 真的收窄结果（原先被静默忽略）', async () => {
    // 放开 B 档，让结果只受调用参数约束（两条决策都在 scope 内）。
    saveScopeFile(PROJECT, makeScopeFile({}));

    // 原病：limit=1 仍返回 2 条 —— 数量限制被忽略。
    const limited = await call<DecisionOut>('srelay_search', { query: '一个绝不存在的词', kind: 'decisions', limit: 1 });
    expect(limited.count).toBe(1);
    // 原病：query 在这条分支没有词法含义，却被静默吞掉 —— 现在必须明说。
    expect(limited.not_applied).toContain('query');
    expect(String(limited.note ?? '')).toContain('query');

    // 原病：未来日期仍返回全部 —— 日期从未进入装配。现在应把 A 档/调用档一起收窄到 0 条。
    const future = await call<DecisionOut>('srelay_search', { query: '一个绝不存在的词', kind: 'decisions', since: '2999-01-01T00:00:00.000Z' });
    expect(future.count).toBe(0);

    // unresolved 走同一套装配：limit=1 只回一条，并同样明说 query 不适用。
    const un = await call<UnresolvedOut>('srelay_search', { query: '一个绝不存在的词', kind: 'unresolved', limit: 1 });
    expect(un.count).toBe(1);
    expect(un.not_applied).toContain('query');
  });
});

describe('审查 #14：消息分页按真实序号、所有返回分支统一执行 50KB 硬顶', () => {
  it('seq 有空洞（100/500）时默认按真实序号分页，返回全部而不是 0 条', async () => {
    // 原病：默认 from=1、to=message_count=2，查 seq 1..2 → 0 条且不报错。
    const out = await call<ShowOut>('srelay_show', { session_id: C });
    expect(out.found).toBe(true);
    expect(out.totalInDb).toBe(2);            // 条数
    expect(out.returned).toBe(2);
    expect(out.range).toEqual([100, 500]);      // 序号（不是条数）
    expect(out.messages.map((m) => m.seq)).toEqual([100, 500]);

    // 显式区间仍是 seq 的闭区间语义（审查报告里唯一能取到数的那条路径）。
    const one = await call<ShowOut>('srelay_show', { session_id: C, start_msg: 100, end_msg: 100 });
    expect(one.returned).toBe(1);
    expect(one.range).toEqual([100, 100]);
    expect(one.messages[0].seq).toBe(100);
  });

  it('message_id 单条回查也受 50KB 硬顶约束，并给出截断提示', async () => {
    // 原病：这条提前返回分支只按 max_chars 截字、没有字节硬顶；
    // max_chars=90000 时 90,000 字节原样返回（声明上限 51,200）。
    const out = await call<ShowOut>('srelay_show', { session_id: D, message_id: hugeId, max_chars: 90000 });
    expect(out.found).toBe(true);
    expect(out.returned).toBe(1);
    expect(out.messages[0].msgId).toBe(hugeId);
    expect(out.messages[0].seq).toBe(1);

    const bytes = Buffer.byteLength(String(out.messages[0].content), 'utf8');
    expect(bytes).toBeLessThanOrEqual(50 * 1024);
    expect(bytes).toBeGreaterThan(10 * 1024); // 预算内尽量给，不是一句空话
    expect(out.truncated).toBe(true);
    expect(String(out.messages[0].content)).toContain('截断'); // 提示随内容一起给，不许静默
  });

  it('主分支（不指定 message_id）同样执行 50KB 硬顶，不只 msgId 分支', async () => {
    const out = await call<ShowOut>('srelay_show', { session_id: D, max_chars: 90000 });
    expect(out.returned).toBe(1);
    const bytes = Buffer.byteLength(String(out.messages[0].content), 'utf8');
    expect(bytes).toBeLessThanOrEqual(50 * 1024);
    expect(out.truncated).toBe(true);
    expect(String(out.messages[0].content)).toContain('截断');
  });
});
