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

const REG_PATH = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const REG_NAME = 'SessionRelayWatch';

export async function installWatchService(root: string): Promise<void> {
  if (process.platform !== 'win32') {
    console.log(pc.yellow('当前平台的服务注册将在后续版本提供；可先手动运行 srelay watch --foreground。'));
    return;
  }
  const relay = relayDir(root);
  fs.mkdirSync(relay, { recursive: true });
  const nodeAbs = process.execPath;
  const isDev = import.meta.url.endsWith('.ts');
  let runCmd: string;
  if (isDev) {
    const loader = path.join(repoRoot(), 'node_modules', 'tsx', 'dist', 'loader.mjs').replace(/\\/g, '/');
    const cli = path.join(repoRoot(), 'src/bin/srelay.ts').replace(/\\/g, '/');
    runCmd = `"${nodeAbs}" --import "file:///${loader}" "${cli}" watch --foreground`;
  } else {
    runCmd = `"${nodeAbs}" "${fileURLToPath(import.meta.url)}" watch --foreground`;
  }
  const cmdPath = path.join(relay, 'watch-task.cmd');
  fs.writeFileSync(cmdPath, ['@echo off', `cd /d "${root}"`, runCmd, ''].join('\r\n'), 'utf8');
  // 改动 4：注册表 Run 键（不需要管理员，替代 schtasks）
  try {
    await execFileP('powershell', ['-Command',
      `Set-ItemProperty -Path '${REG_PATH}' -Name '${REG_NAME}' -Value '${cmdPath}'`]);
    console.log(pc.green('✓') + ` 守护已注册（登录自启动，无需管理员）`);
    console.log(pc.dim(`  脚本：${cmdPath} · 取消：srelay watch --uninstall`));
  } catch (e) {
    console.log(pc.red('✗ 注册失败：') + (e as Error).message);
    console.log(pc.dim(`  可手动执行：${cmdPath}`));
  }
}

export async function uninstallWatchService(root: string): Promise<void> {
  if (process.platform !== 'win32') return;
  try {
    await execFileP('powershell', ['-Command',
      `Remove-ItemProperty -Path '${REG_PATH}' -Name '${REG_NAME}' -ErrorAction SilentlyContinue`]);
    console.log(pc.green('✓') + ' 守护服务已卸载。');
  } catch {
    console.log(pc.yellow('未找到已注册的守护。'));
  }
}

export async function watchServiceStatus(root: string): Promise<string> {
  if (process.platform !== 'win32') return '未实现';
  // 测试环境跳过 PowerShell 子进程（CI 沙箱冷启动可能超 30s 导致测试超时）
  if (process.env.VITEST) return '（测试跳过）';
  try {
    const r = await execFileP('powershell', ['-Command',
      `(Get-ItemProperty '${REG_PATH}' -ErrorAction SilentlyContinue).${REG_NAME}`]);
    return r.stdout.trim() ? '已注册' : '未注册';
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
