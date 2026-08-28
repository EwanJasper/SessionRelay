// srelay watch：守护 + Windows 服务注册（方针 Review #3 / D20，技术方案 §3.7）
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../shared/config.js';
import { relayDir, pathSlug } from '../shared/paths.js';
import { isDaemonAlive } from '../shared/lock.js';
import { runWatch } from '../capture/watch.js';
import { pc } from './ui.js';

const execFileP = promisify(execFile);

function repoRoot(): string {
  // src/cli/watch.ts → 仓库根
  return fileURLToPath(new URL('../..', import.meta.url));
}

function taskName(root: string): string {
  return `SessionRelay-Watch-${pathSlug(root).slice(-40).replace(/-+/g, '-').slice(-30)}`;
}

export async function installWatchService(root: string): Promise<void> {
  if (process.platform !== 'win32') {
    console.log(pc.yellow('当前平台的服务注册将在后续版本提供；可先手动运行 srelay watch --foreground。'));
    return;
  }
  const relay = relayDir(root);
  fs.mkdirSync(relay, { recursive: true });
  const nodeAbs = process.execPath;
  const loader = path.join(repoRoot(), 'node_modules', 'tsx', 'dist', 'loader.mjs').replace(/\\/g, '/');
  const cli = path.join(repoRoot(), 'src', 'bin', 'srelay.ts').replace(/\\/g, '/');
  const cmdPath = path.join(relay, 'watch-task.cmd');
  fs.writeFileSync(cmdPath, [
    '@echo off',
    `cd /d "${root}"`,
    `"${nodeAbs}" --import "file:///${loader}" "${cli}" watch --foreground`,
    '',
  ].join('\r\n'), 'utf8');
  const tn = taskName(root);
  try {
    await execFileP('schtasks', ['/Create', '/F', '/TN', tn, '/SC', 'ONLOGON', '/TR', `"${cmdPath}"`]);
    console.log(pc.green('✓') + ` 守护服务已注册（登录自启）：${pc.dim(tn)}`);
    console.log(pc.dim(`  任务脚本：${cmdPath} · 取消：srelay watch --uninstall`));
  } catch (e) {
    console.log(pc.red('✗ 服务注册失败：') + (e as Error).message);
    console.log(pc.dim(`  可手动执行：${cmdPath}`));
  }
}

export async function uninstallWatchService(root: string): Promise<void> {
  if (process.platform !== 'win32') return;
  try {
    await execFileP('schtasks', ['/Delete', '/F', '/TN', taskName(root)]);
    console.log(pc.green('✓') + ' 守护服务已卸载。');
  } catch {
    console.log(pc.yellow('未找到已注册的服务任务。'));
  }
}

export async function watchServiceStatus(root: string): Promise<string> {
  if (process.platform !== 'win32') return '未实现';
  try {
    await execFileP('schtasks', ['/Query', '/TN', taskName(root)]);
    return '已注册';
  } catch {
    return '未注册';
  }
}

export async function cmdWatch(opts: { foreground?: boolean; installService?: boolean; uninstall?: boolean; status?: boolean }): Promise<void> {
  // watch 默认前台运行（服务与手动皆同路径）
  const root = process.cwd();
  if (opts.uninstall) return uninstallWatchService(root);
  if (opts.status) {
    const alive = isDaemonAlive(root);
    console.log(`守护：${alive.alive ? pc.green(`运行中 (pid ${alive.pid})`) : pc.red('未运行')} · 服务：${await watchServiceStatus(root)}`);
    return;
  }
  if (opts.installService) return installWatchService(root);
  // 前台守护：要求已初始化
  const { findRelayRoot } = await import('../shared/paths.js');
  const rr = findRelayRoot(root);
  if (!rr) {
    console.log(pc.red('✗ 未找到 .sessionrelay，请先 srelay init'));
    process.exit(1);
  }
  await runWatch({ projectRoot: rr, config: loadConfig(rr) });
}
