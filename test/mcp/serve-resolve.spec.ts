// serve 根解析信号链测试（design-serve-resolve §7 R1-R9）
// StdioClientTransport 的 cwd 选项模拟 Qoder 的任意工作目录；
// SRELAY_REGISTRY_DIR 把注册表重定向到临时目录（绝不污染真实家目录）；
// 伪装存活守护 = 写 lock 文件（pid=测试进程 + 新鲜心跳）。
// 隔离三原则：每个用例独立 run 目录（serve 常驻持有句柄，跨用例复用路径会在 Windows 上删不掉）；
// afterEach 关闭客户端（杀掉 serve 子进程）；注册表用例先重置 REG。
// 注意：无信号 cwd（EMPTY）必须放在仓库之外——仓库根本身有 .sessionrelay（dogfood），
// 仓库内任何路径向上探测都会命中它；EMPTY 的祖先链必须干净，beforeAll 有预检。
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createDb } from '../../src/store/db.js';
import { defaultConfig, saveConfig } from '../../src/shared/config.js';
import { dbFile, projectIdOf, lockFile, findRelayRoot } from '../../src/shared/paths.js';
import { touchRegistry } from '../../src/shared/registry.js';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const TMP = path.resolve('test/.tmp/serve-resolve');
const REG = path.join(TMP, 'registry');            // SRELAY_REGISTRY_DIR
const EMPTY = fs.mkdtempSync(path.join(os.tmpdir(), 'srelay-empty-')); // 仓库外、祖先链干净
process.env.SRELAY_REGISTRY_DIR = REG;             // 测试进程内 registry 模块同步生效

const loader = ['--import', `file:///${path.join(REPO, 'node_modules/tsx/dist/loader.mjs').replace(/\\/g, '/')}`];
const bin = path.join(REPO, 'src/bin/srelay.ts');

/** 每个用例独立的项目目录：dir + projectId */
let runSeq = 0;
function freshProj(name: string): { dir: string; pid: string } {
  const dir = path.join(TMP, `run${++runSeq}`, name);
  fs.mkdirSync(path.join(dir, '.sessionrelay'), { recursive: true });
  const cfg = defaultConfig();
  cfg.identity.project_id = projectIdOf(dir);
  saveConfig(dir, cfg);
  createDb(dbFile(dir)).close();
  return { dir, pid: projectIdOf(dir) };
}

function resetRegistry(): void {
  fs.rmSync(REG, { recursive: true, force: true });
}

/** 伪装存活守护：isDaemonAlive 只看 pid 存活 + 心跳新鲜（<60s） */
function fakeAliveDaemon(dir: string): void {
  fs.writeFileSync(lockFile(dir), JSON.stringify({ pid: process.pid, heartbeat: Date.now(), at: new Date().toISOString() }));
}

interface SpawnOpts {
  cwd: string;
  env?: Record<string, string | undefined>;
  clientRoots?: string[];   // 提供则客户端声明 roots 能力并回报这些目录
}

async function startServe(o: SpawnOpts): Promise<Client> {
  const env: Record<string, string> = { ...process.env as Record<string, string>, SRELAY_NO_DAEMON_SPAWN: '1', SRELAY_REGISTRY_DIR: REG };
  delete env.SRELAY_PROJECT_ROOT;
  for (const [k, v] of Object.entries(o.env ?? {})) { if (v === undefined) delete env[k]; else env[k] = v; }
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [...loader, bin, 'serve'],
    cwd: o.cwd,
    env,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'serve-resolve-test', version: '0.0.0' },
    o.clientRoots ? { capabilities: { roots: { listChanged: false } } } : undefined);
  if (o.clientRoots) {
    client.setRequestHandler(ListRootsRequestSchema, async () => ({
      roots: o.clientRoots!.map((r) => ({ uri: pathToFileURL(r).href, name: path.basename(r) })),
    }));
  }
  await client.connect(transport);
  return client;
}

const parse = (res: { content?: Array<{ type: string; text: string }> }) => JSON.parse(res.content![0].text) as Record<string, unknown>;

/** 等待 serve 的 deferred 解析完成（roots/注册表在 connect 之后进行，早到调用会拿指导载荷） */
async function callResolved(client: Client, args: Record<string, unknown> = {}, timeoutMs = 10000) {
  const t0 = Date.now();
  for (;;) {
    const res = await client.callTool({ name: 'get_stats', arguments: args });
    if (!res.isError) return parse(res);
    if (Date.now() - t0 > timeoutMs) throw new Error(`serve 未在 ${timeoutMs}ms 内解析项目：${String(res.content?.[0]?.text)}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

/** 取指导载荷（等 tried 稳定：roots/registry 至少一个离开 skip 态） */
async function callGuidance(client: Client) {
  const t0 = Date.now();
  for (;;) {
    const res = await client.callTool({ name: 'get_stats', arguments: {} });
    const p = parse(res);
    const tried = p.tried as Record<string, string>;
    if (res.isError && tried && tried.roots !== 'skip' && tried.registry !== 'skip') return p;
    if (Date.now() - t0 > 10000) throw new Error(`未拿到稳定指导载荷：${String(res.content?.[0]?.text)}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

const clients: Client[] = [];
beforeAll(() => {
  for (let i = 0; i < 3; i++) { try { fs.rmSync(TMP, { recursive: true, force: true }); break; } catch { /* retry */ } }
  // 环境预检：EMPTY 的祖先链混入 .sessionrelay 时，cwd 信号类用例会误解析——宁可响亮失败
  if (findRelayRoot(EMPTY) !== null) throw new Error(`测试环境被污染：${EMPTY} 的祖先链存在 .sessionrelay（${findRelayRoot(EMPTY)}），cwd 信号用例不可用`);
});
afterEach(async () => {
  while (clients.length) { const c = clients.pop()!; try { await c.close(); } catch { /* 幂等 */ } }
});
afterAll(async () => {
  try { fs.rmSync(EMPTY, { recursive: true, force: true }); } catch { /* 系统临时目录，允许残留 */ }
  for (let i = 0; i < 5; i++) { try { fs.rmSync(TMP, { recursive: true, force: true }); return; } catch { await new Promise((r) => setTimeout(r, 300)); } }
});

describe('serve 根解析信号链（design-serve-resolve）', () => {
  it('R1 env 命中：cwd 无关也能解析（钉死 0.4.x 行为）', async () => {
    const a = freshProj('a');
    const c = await startServe({ env: { SRELAY_PROJECT_ROOT: a.dir }, cwd: EMPTY });
    clients.push(c);
    expect((await callResolved(c)).project).toBe(a.pid);
  }, 30000);

  it('R1b env 指向坏库：干净 stderr 报错 + 握手前退出（非堆栈）', async () => {
    const a = freshProj('a');
    fs.writeFileSync(dbFile(a.dir), 'this is not a sqlite database');
    const env: Record<string, string> = { ...process.env as Record<string, string>, SRELAY_NO_DAEMON_SPAWN: '1', SRELAY_REGISTRY_DIR: REG, SRELAY_PROJECT_ROOT: a.dir };
    const transport = new StdioClientTransport({ command: process.execPath, args: [...loader, bin, 'serve'], cwd: EMPTY, env, stderr: 'pipe' });
    const client = new Client({ name: 't', version: '0' });
    const errText: string[] = [];
    transport.stderr?.on('data', (d: Buffer) => errText.push(d.toString()));
    await expect(client.connect(transport)).rejects.toThrow();
    expect(errText.join('')).toContain('无法打开记忆库');
  }, 30000);

  it('R2 cwd 命中：无 env 时向上探测（钉死 0.4.x 行为）', async () => {
    const a = freshProj('a');
    const c = await startServe({ cwd: a.dir });
    clients.push(c);
    expect((await callResolved(c)).project).toBe(a.pid);
  }, 30000);

  it('R3 MCP roots：客户端声明能力并回报唯一有效根 → 自动选中', async () => {
    resetRegistry();
    const a = freshProj('a');
    const c = await startServe({ cwd: EMPTY, clientRoots: [a.dir] });
    clients.push(c);
    expect((await callResolved(c)).project).toBe(a.pid);
  }, 30000);

  it('R4 注册表：不支持 roots + 恰一个存活守护项目 → 自动选中', async () => {
    resetRegistry();
    const a = freshProj('a');
    fakeAliveDaemon(a.dir);
    touchRegistry(a.dir);
    const c = await startServe({ cwd: EMPTY });
    clients.push(c);
    expect((await callResolved(c)).project).toBe(a.pid);
  }, 30000);

  it('R5 多个存活候选：指导载荷 → project 参数选择 → 连接记住 → 可再切换', async () => {
    resetRegistry();
    const a = freshProj('a');
    const b = freshProj('b');
    fakeAliveDaemon(a.dir);
    fakeAliveDaemon(b.dir);
    touchRegistry(a.dir);
    touchRegistry(b.dir);
    const c = await startServe({ cwd: EMPTY });
    clients.push(c);
    const g = await callGuidance(c);
    expect(g.error).toBe('unresolved_project');
    expect(g.tried).toMatchObject({ env: 'unset', roots: 'unsupported', registry: 'multiple_alive' });
    expect(g.candidates as Array<{ root: string }>).toHaveLength(2);
    // 显式选择 A
    expect((parse(await c.callTool({ name: 'get_stats', arguments: { project: a.dir } }))).project).toBe(a.pid);
    // 不带参 → 连接记住 A
    expect((await callResolved(c)).project).toBe(a.pid);
    // 再切到 B（连接内切换合法）
    expect((parse(await c.callTool({ name: 'get_stats', arguments: { project: b.dir } }))).project).toBe(b.pid);
  }, 30000);

  it('R6 零信号零候选：指导性错误 + howTo 提到 init / 环境变量（连接保持、16 工具照常列出）', async () => {
    resetRegistry();
    const c = await startServe({ cwd: EMPTY });
    clients.push(c);
    const g = await callGuidance(c);
    expect(g.error).toBe('unresolved_project');
    expect(g.tried).toMatchObject({ env: 'unset', cwd: 'miss', registry: 'empty' });
    expect(g.candidates).toEqual([]);
    const howTo = String(g.howTo);
    expect(howTo).toContain('srelay init');
    expect(howTo).toContain('SRELAY_PROJECT_ROOT');
    // deferred 模式契约不变：16 个工具照常可列出
    const tools = await c.listTools();
    expect(tools.tools).toHaveLength(16);
  }, 30000);

  it('R7 注册表损坏：视为空不 crash，走零候选路径', async () => {
    resetRegistry();
    fs.mkdirSync(REG, { recursive: true });
    fs.writeFileSync(path.join(REG, 'projects.json'), '{not json');
    const c = await startServe({ cwd: EMPTY });
    clients.push(c);
    const g = await callGuidance(c);
    expect(g.error).toBe('unresolved_project');
    expect(g.tried).toMatchObject({ registry: 'empty' });
  }, 30000);

  it('R9 已解析模式显式切换：get_stats 的 project 随 project 参数变化', async () => {
    const a = freshProj('a');
    const b = freshProj('b');
    const c = await startServe({ cwd: EMPTY, env: { SRELAY_PROJECT_ROOT: a.dir } });
    clients.push(c);
    expect((await callResolved(c)).project).toBe(a.pid);
    expect((parse(await c.callTool({ name: 'get_stats', arguments: { project: b.dir } }))).project).toBe(b.pid);
    // 切回 A（session 前缀解析随 project 走，design §6）
    expect((parse(await c.callTool({ name: 'get_stats', arguments: { project: a.dir } }))).project).toBe(a.pid);
  }, 30000);
});
