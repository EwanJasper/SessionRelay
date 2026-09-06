// 守护服务注册（三平台）：Windows 注册表 Run 键 / macOS launchd / Linux systemd --user
// 行为对齐原则：三平台同为"登录自启一次"，不做崩溃重启（KeepAlive/Restart 均关）——
// 守护自身 30s 周期 + 懒启动兜底，崩溃重启交给用户重新登录或手动 sync。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { relayDir, pathSlug } from '../shared/paths.js';
import pc from 'picocolors';

const execFileP = promisify(execFile);

function repoRoot(): string {
  return fileURLToPath(new URL('../..', import.meta.url));
}

/** 服务标识（跨平台同名派生）：路径 slug 尾段，保证同项目三平台同名 */
export function serviceId(root: string): string {
  return pathSlug(root).slice(-40).replace(/-+/g, '-').replace(/^-/, '').slice(-30) || 'default';
}

/** 守护启动命令参数（dev=tsx loader / prod=dist 入口） */
export function buildWatchArgs(root: string): string[] {
  const isDev = import.meta.url.endsWith('.ts');
  if (isDev) {
    const loader = path.join(repoRoot(), 'node_modules', 'tsx', 'dist', 'loader.mjs');
    const cli = path.join(repoRoot(), 'src', 'bin', 'srelay.ts');
    return ['--import', pathToFileURLSafe(loader), cli, 'watch', '--foreground'];
  }
  return [fileURLToPath(import.meta.url), 'watch', '--foreground'];
}

function pathToFileURLSafe(p: string): string {
  return 'file:///' + p.replace(/\\/g, '/');
}

// ── macOS launchd ──

export function launchdPlistPath(root: string): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `com.sessionrelay.watch-${serviceId(root)}.plist`);
}

export function buildLaunchdPlist(root: string, nodeAbs: string, args: string[]): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.sessionrelay.watch-${esc(serviceId(root))}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${esc(nodeAbs)}</string>
${args.map((a) => `    <string>${esc(a)}</string>`).join('\n')}
  </array>
  <key>WorkingDirectory</key>
  <string>${esc(root)}</string>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
`;
}

// ── Linux systemd user ──

export function systemdUnitPath(root: string): string {
  return path.join(os.homedir(), '.config', 'systemd', 'user', `srelay-watch-${serviceId(root)}.service`);
}

export function buildSystemdUnit(root: string, nodeAbs: string, args: string[]): string {
  const execStart = [nodeAbs, ...args].map((s) => (s.includes(' ') ? `"${s}"` : s)).join(' ');
  return `[Unit]
Description=SessionRelay Watch (${root})

[Service]
WorkingDirectory=${root}
ExecStart=${execStart}
Restart=no

[Install]
WantedBy=default.target
`;
}

// ── 安装/卸载/状态（分平台执行） ──

function windowsRunScript(root: string): string {
  const nodeAbs = process.execPath;
  const args = buildWatchArgs(root).map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ');
  return ['@echo off', `cd /d "${root}"`, `${nodeAbs} ${args}`, ''].join('\r\n');
}

export async function installWatchService(root: string): Promise<void> {
  fs.mkdirSync(relayDir(root), { recursive: true });
  if (process.platform === 'win32') {
    const { REG_PATH, REG_NAME } = await import('./winregistry.js');
    const cmdPath = path.join(relayDir(root), 'watch-task.cmd');
    fs.writeFileSync(cmdPath, windowsRunScript(root), 'utf8');
    try {
      await execFileP('powershell', ['-Command',
        `Set-ItemProperty -Path '${REG_PATH}' -Name '${REG_NAME}' -Value '${cmdPath}'`]);
      console.log(pc.green('✓') + ' 守护已注册（登录自启动，无需管理员）');
      console.log(pc.dim(`  脚本：${cmdPath} · 取消：srelay watch --uninstall`));
    } catch (e) {
      console.log(pc.red('✗ 注册失败：') + (e as Error).message);
      console.log(pc.dim(`  可手动执行：${cmdPath}`));
    }
    return;
  }
  if (process.platform === 'darwin') {
    const nodeAbs = process.execPath;
    const plist = launchdPlistPath(root);
    fs.mkdirSync(path.dirname(plist), { recursive: true });
    fs.writeFileSync(plist, buildLaunchdPlist(root, nodeAbs, buildWatchArgs(root)), 'utf8');
    try {
      await execFileP('launchctl', ['unload', plist]).catch(() => {}); // 覆盖重装
      await execFileP('launchctl', ['load', plist]);
      console.log(pc.green('✓') + ' 守护已注册（launchd 登录自启动）');
      console.log(pc.dim(`  plist：${plist} · 取消：srelay watch --uninstall`));
    } catch (e) {
      console.log(pc.red('✗ launchctl load 失败：') + (e as Error).message);
      console.log(pc.dim(`  可手动：launchctl load ${plist}`));
    }
    return;
  }
  // linux：systemd user unit
  const nodeAbs = process.execPath;
  const unit = systemdUnitPath(root);
  fs.mkdirSync(path.dirname(unit), { recursive: true });
  fs.writeFileSync(unit, buildSystemdUnit(root, nodeAbs, buildWatchArgs(root)), 'utf8');
  try {
    await execFileP('systemctl', ['--user', 'daemon-reload']);
    await execFileP('systemctl', ['--user', 'enable', '--now', path.basename(unit)]);
    // linger：注销后继续运行（可选，失败不阻塞）
    await execFileP('loginctl', ['enable-linger']).catch(() => {});
    console.log(pc.green('✓') + ' 守护已注册（systemd user，登录自启动）');
    console.log(pc.dim(`  unit：${unit} · 取消：srelay watch --uninstall`));
    console.log(pc.dim('  提示：注销后仍运行需 linger 权限（loginctl enable-linger 失败时仅登录期间运行）'));
  } catch (e) {
    console.log(pc.red('✗ systemctl 失败：') + (e as Error).message);
    console.log(pc.dim(`  unit 已生成：${unit}（需图形会话/用户 systemd 可用）`));
  }
}

export async function uninstallWatchService(root: string): Promise<void> {
  if (process.platform === 'win32') {
    const { REG_PATH, REG_NAME } = await import('./winregistry.js');
    try {
      await execFileP('powershell', ['-Command',
        `Remove-ItemProperty -Path '${REG_PATH}' -Name '${REG_NAME}' -ErrorAction SilentlyContinue`]);
      console.log(pc.green('✓') + ' 守护服务已卸载。');
    } catch {
      console.log(pc.yellow('未找到已注册的守护。'));
    }
    return;
  }
  if (process.platform === 'darwin') {
    const plist = launchdPlistPath(root);
    await execFileP('launchctl', ['unload', plist]).catch(() => {});
    try { fs.rmSync(plist, { force: true }); console.log(pc.green('✓') + ' 守护服务已卸载。'); }
    catch { console.log(pc.yellow('卸载失败（plist 权限）。')); }
    return;
  }
  const unit = systemdUnitPath(root);
  try {
    await execFileP('systemctl', ['--user', 'disable', '--now', path.basename(unit)]).catch(() => {});
    fs.rmSync(unit, { force: true });
    await execFileP('systemctl', ['--user', 'daemon-reload']).catch(() => {});
    console.log(pc.green('✓') + ' 守护服务已卸载。');
  } catch {
    console.log(pc.yellow('卸载失败（用户 systemd 不可用？可手动删除 unit 文件）。'));
  }
}

export async function watchServiceStatus(root: string): Promise<string> {
  // VITEST 跳过仅限 Windows：PowerShell 子进程在 CI 沙箱冷启动可能超时（历史教训）；
  // darwin/linux 子进程轻量，S6 真装循环依赖真实状态，不跳
  if (process.env.VITEST && process.platform === 'win32') return '（测试跳过）';
  try {
    if (process.platform === 'win32') {
      const { REG_PATH, REG_NAME } = await import('./winregistry.js');
      const r = await execFileP('powershell', ['-Command',
        `(Get-ItemProperty '${REG_PATH}' -ErrorAction SilentlyContinue).${REG_NAME}`]);
      return r.stdout.trim() ? '已注册' : '未注册';
    }
    if (process.platform === 'darwin') {
      const r = await execFileP('launchctl', ['list']);
      return r.stdout.includes(`com.sessionrelay.watch-${serviceId(root)}`) ? '已注册' : '未注册';
    }
    const r = await execFileP('systemctl', ['--user', 'is-enabled', `srelay-watch-${serviceId(root)}.service`]);
    return r.stdout.trim() === 'enabled' ? '已注册' : '未注册';
  } catch {
    return process.platform === 'win32' ? '未注册' : '未注册（或用户 systemd/launchd 不可用）';
  }
}

