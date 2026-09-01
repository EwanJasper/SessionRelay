// P4 · 发布产物冒烟测试
// 测的是 dist/srelay.js —— 用户从 npm 安装后真实运行的文件，而非 src/ 源码。
// 起因：serverInfo 硬编码 0.1.0 / --version 硬编码 0.2.0 漂移数版无人发现，
// 因为既有 125 个测试全部经 tsx 加载源码，从未接触构建产物。
// 本文件就是那道缺失的防线：本地未构建时跳过，发布链路（先 build 后 test）必跑。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const DIST = path.join(REPO, 'dist', 'srelay.js');
const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf-8'));

// 注意：CLI 子命令按 cwd 推断项目根（SRELAY_PROJECT_ROOT 仅 serve 支持），
// 所以这里必须用 cwd 而非 env 控制目标目录——这本身就是被本测试抓住的一个约定。
const run = (args: string[], cwd: string, env: Record<string, string> = {}) =>
  execFileSync(process.execPath, [DIST, ...args], {
    encoding: 'utf-8',
    cwd,
    env: { ...process.env, CI: '1', ...env },
  }).trim();

(fs.existsSync(DIST) ? describe : describe.skip)('P4 · 发布产物冒烟（dist/srelay.js）', () => {
  let tmp: string;
  let client: Client;

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'srelay-smoke-'));
    // 用户第一步：在全新目录 init（非交互、不回填、不拉起守护进程）
    run(['init', '--backfill', 'none'], tmp, { SRELAY_NO_DAEMON_SPAWN: '1' });
    // 用户第二步：status —— 兼作惰性建库触发（init 不建库，库在首个数据命令时创建）
    run(['status'], tmp);
  }, 60000);

  afterAll(async () => {
    try { await client?.close(); } catch { /* already closed */ }
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('bin 入口可执行且 --version 与 package.json 一致（防硬编码漂移）', () => {
    expect(run(['--version'], tmp)).toBe(pkg.version);
  });

  it('init 产物完整：.sessionrelay/config.json + .sessionrelayignore + 惰性库已建', () => {
    expect(fs.existsSync(path.join(tmp, '.sessionrelay', 'config.json'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, '.sessionrelayignore'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, '.sessionrelay', 'relay.sqlite'))).toBe(true);
  });

  it('MCP 握手：serverInfo 与 package.json 一致 + 15 工具全部注册', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [DIST, 'serve'],
      env: {
        ...process.env,
        SRELAY_PROJECT_ROOT: tmp,
        SRELAY_NO_DAEMON_SPAWN: '1',
      } as Record<string, string>,
      stderr: 'ignore',
    });
    client = new Client({ name: 'smoke-verify', version: '0.0.0' });
    await client.connect(transport);
    expect(client.getServerVersion()).toEqual({ name: 'sessionrelay', version: pkg.version });
    const tools = await client.listTools();
    expect(tools.tools).toHaveLength(15);
  }, 30000);
});
