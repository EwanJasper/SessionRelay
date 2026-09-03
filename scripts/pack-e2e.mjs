// pack-e2e：真实安装端到端验证 —— 模拟用户从 npm 安装后的完整路径。
// 与 test/smoke 的区别：smoke 测仓库内 dist/；本脚本先 npm pack 出真实 tarball，
// 在全新目录 npm install，再从 node_modules 里跑 —— 覆盖 files 清单、bin 链接、
// 依赖解析、原生模块预编译下载这条完整链路。
// 用法：node scripts/pack-e2e.mjs  （需要先 npm run build）
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));

if (!existsSync(path.join(ROOT, 'dist', 'srelay.js'))) {
  console.error('[pack-e2e] dist/srelay.js 不存在，先跑 npm run build');
  process.exit(1);
}

const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';
// Node >=22.12 拒绝无 shell 地 spawn .cmd（CVE-2024-37372 防护），Win 下必须 shell
const npmRun = (args, opts = {}) =>
  execFileSync(NPM, args, { encoding: 'utf-8', ...opts, shell: process.platform === 'win32' });
const log = (s) => console.log(`[pack-e2e] ${s}`);
const fail = (s) => { console.error(`[pack-e2e] ✗ ${s}`); process.exit(1); };

// 1) 打包真实 tarball
log('npm pack ...');
const tarOut = npmRun(['pack', '--json', '--loglevel=error'], { cwd: ROOT });
const tarball = path.join(ROOT, JSON.parse(tarOut)[0].filename);
log(`tarball = ${path.basename(tarball)}`);

// 2) 全新目录安装（真实解析依赖 + 原生模块预编译下载）
const tmp = mkdtempSync(path.join(os.tmpdir(), 'srelay-e2e-'));
const installedRoot = path.join(tmp, 'pkg-under-test');
mkdirSync(installedRoot, { recursive: true });
try {
  log('npm install tarball into fresh dir ...');
  npmRun(['install', '--no-fund', '--no-audit', '--loglevel=error', pathToFileURL(tarball).href], {
    cwd: installedRoot, stdio: 'pipe',
  });

  const pkgDir = path.join(installedRoot, 'node_modules', pkg.name);
  const entry = path.join(pkgDir, 'dist', 'srelay.js');
  if (!existsSync(entry)) fail(`安装产物缺入口：${entry}（files 清单或打包有问题）`);

  // 3) 用户路径①：bin 链接 + --version
  const bin = process.platform === 'win32'
    ? path.join(installedRoot, 'node_modules', '.bin', 'srelay.cmd')
    : path.join(installedRoot, 'node_modules', '.bin', 'srelay');
  if (!existsSync(bin)) fail(`bin 未链接：${bin}`);
  // Node >=22.12 无 shell 不能 spawn .cmd（同上），参数简单无注入面
  const runBin = (args, opts = {}) =>
    execFileSync(bin, args, { encoding: 'utf-8', ...opts, shell: process.platform === 'win32' });
  const ver = runBin(['--version']).trim();
  if (ver !== pkg.version) fail(`--version=${ver} ≠ package.json=${pkg.version}`);
  log(`bin --version ✓ (${ver})`);

  // 4) 用户路径②：全新项目 init → status（cwd 推断根；惰性建库）
  const proj = path.join(tmp, 'my-project');
  mkdirSync(proj, { recursive: true });
  runBin(['init', '--backfill', 'none'], {
    cwd: proj,
    env: { ...process.env, CI: '1', SRELAY_NO_DAEMON_SPAWN: '1' }, stdio: 'pipe',
  });
  runBin(['status'], { cwd: proj, stdio: 'pipe' });
  for (const f of ['.sessionrelay/config.json', '.sessionrelay/relay.sqlite', '.sessionrelayignore']) {
    if (!existsSync(path.join(proj, f))) fail(`init 产物缺失：${f}`);
  }
  log('init/status ✓');

  // 5) 用户路径③：MCP serve 真握手（用安装产物，非仓库 dist）
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry, 'serve'],
    env: { ...process.env, SRELAY_PROJECT_ROOT: proj, SRELAY_NO_DAEMON_SPAWN: '1' },
    stderr: 'ignore',
  });
  const client = new Client({ name: 'pack-e2e', version: '0.0.0' });
  await client.connect(transport);
  const si = client.getServerVersion();
  if (si.name !== 'sessionrelay' || si.version !== pkg.version) fail(`serverInfo=${JSON.stringify(si)} ≠ ${pkg.version}`);
  const tools = await client.listTools();
  if (tools.tools.length !== 15) fail(`工具数 ${tools.tools.length} ≠ 15`);
  const call = async (name, args = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const text = res.content?.[0]?.text ?? '{}';
    return JSON.parse(text);
  };
  // 6) 用户路径④（forget G4）：save_note 造一条 → CLI forget 彻底删除 → 审计可查
  const note = await call('save_note', { title: 'pack-e2e 遗忘验证', content: '决定验证 forget 真实安装路径后删除本笔记。' });
  if (!note.ok) fail(`save_note 失败：${JSON.stringify(note)}`);
  await client.close();
  log(`MCP 握手 ✓ (serverInfo ${si.name}@${si.version}, 15 tools)`);

  const pv = runBin(['forget', note.sessionId, '--json'], { cwd: proj, stdio: 'pipe' });
  const preview = JSON.parse(pv);
  if (preview.id !== note.sessionId || preview.barriers !== false) fail(`forget 预览异常：${pv}`);
  runBin(['forget', note.sessionId, '--yes'], { cwd: proj, stdio: 'pipe' });
  const hist = runBin(['forget', '--history', '--verbose'], { cwd: proj, stdio: 'pipe' });
  if (!hist.includes('note') || !hist.includes('1 会话')) fail(`forget --history 无删除记录：${hist}`);
  // 删除后 search 不命中
  const search = runBin(['search', '遗忘验证', '--json'], { cwd: proj, stdio: 'pipe' });
  if (JSON.parse(search).hits?.some?.((h) => h.sessionId === note.sessionId)) fail('forget 后 note 仍可被检索');
  log('forget save_note→预览→删除→审计 ✓');

  console.log(`\n[pack-e2e] ✓ 全部通过 —— 真实安装路径在本机（${process.platform}/node ${process.versions.node.split('.')[0]}）验证无误`);
} finally {
  // Windows 下 sqlite WAL 句柄延迟释放会 EBUSY，重试几轮仍失败就留给系统临时目录自清
  for (let i = 0; i < 4; i++) {
    try { rmSync(tmp, { recursive: true, force: true }); break; } catch { setTimeout(() => {}, 300); }
  }
  try { rmSync(tarball, { force: true }); } catch { /* 仓库内 tarball 残留无害，下轮 pack 覆盖 */ }
}
