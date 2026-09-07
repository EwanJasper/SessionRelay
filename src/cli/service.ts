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

/**
 * 守护 CLI 入口（自审事故修复：绝不使用 import.meta.url）。
 * 打包后 import.meta.url 是带 hash 的 chunk 文件名——写入服务脚本后，
 * dist 一经重建（0.3.1 起构建先清空 dist）旧 chunk 即消失，开机脚本必然
 * MODULE_NOT_FOUND。必须解析稳定文件名 dist/srelay.js。
 */
export function resolveWatchEntry(): { entry: string; exists: boolean } {
  const isDev = import.meta.url.endsWith('.ts');
  if (isDev) {
    const entry = path.join(repoRoot(), 'src', 'bin', 'srelay.ts');
    return { entry, exists: fs.existsSync(entry) };
  }
  return resolveWatchEntryFrom(import.meta.url);
}

/**
 * prod 分支（参数化以便单测覆盖——本机 dev 形态永远走不到 prod，S7 盲区教训）：
 * chunk 与 srelay.js 同在 <pkg>/dist/ 下，稳定入口 = chunk 同目录的 srelay.js
 */
export function resolveWatchEntryFrom(moduleUrl: string): { entry: string; exists: boolean } {
  const chunkDir = path.dirname(fileURLToPath(moduleUrl));
  const entry = path.join(chunkDir, 'srelay.js');
  return { entry, exists: fs.existsSync(entry) };
}

/** 守护启动命令参数（dev=tsx loader / prod=dist/srelay.js 稳定入口） */
export function buildWatchArgs(root: string): string[] {
  const isDev = import.meta.url.endsWith('.ts');
  if (isDev) {
    const loader = path.join(repoRoot(), 'node_modules', 'tsx', 'dist', 'loader.mjs');
    const { entry } = resolveWatchEntry();
    return ['--import', pathToFileURLSafe(loader), entry, 'watch', '--foreground'];
  }
  return [resolveWatchEntry().entry, 'watch', '--foreground'];
}

function pathToFileURLSafe(p: string): string {
  return 'file:///' + p.replace(/\\/g, '/');
}

/** 守护日志（三平台统一）：服务化运行的输出落点，watch --status / doctor 展示尾部 */
export function watchLogPath(root: string): string {
  return path.join(relayDir(root), 'watch.log');
}

/**
 * 只读日志尾部（内存评估修复）：绝不 readFileSync 全量——5MB 日志全读进堆
 * 换 3 行输出是内存事故。seek 到 size-bytes 处读取，堆占用 O(bytes) 与文件大小无关。
 */
export function readLogTail(root: string, bytes = 2048): string {
  try {
    const f = watchLogPath(root);
    if (!fs.existsSync(f)) return '';
    const size = fs.statSync(f).size;
    const start = Math.max(0, size - bytes);
    const fh = fs.openSync(f, 'r');
    try {
      const buf = Buffer.alloc(Math.min(size, bytes));
      fs.readSync(fh, buf, 0, buf.length, start);
      return buf.toString('utf8');
    } finally { fs.closeSync(fh); }
  } catch { return ''; }
}

// ── macOS launchd ──

export function launchdPlistPath(root: string): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `com.sessionrelay.watch-${serviceId(root)}.plist`);
}

export function buildLaunchdPlist(root: string, nodeAbs: string, args: string[]): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const logFile = esc(watchLogPath(root));
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
  <key>StandardOutPath</key>
  <string>${logFile}</string>
  <key>StandardErrorPath</key>
  <string>${logFile}</string>
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
  const logFile = watchLogPath(root);
  return `[Unit]
Description=SessionRelay Watch (${root})

[Service]
WorkingDirectory=${root}
ExecStart=${execStart}
StandardOutput=append:${logFile}
StandardError=append:${logFile}
Restart=no

[Install]
WantedBy=default.target
`;
}

// ── 安装/卸载/状态（分平台执行） ──

function windowsRunScript(root: string): string {
  const nodeAbs = process.execPath;
  const args = buildWatchArgs(root).map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ');
  const logFile = watchLogPath(root);
  // 输出全部落盘：静默启动后报错必须可诊断（用户教训：闪框有信号，纯静默=故障不可见）
  return ['@echo off', `cd /d "${root}"`, `${nodeAbs} ${args} >> "${logFile}" 2>&1`, ''].join('\r\n');
}

/**
 * 日志轮转：>1MB 时只保留尾部 100KB（服务化输出无限追加，不自转就会慢慢吃盘）。
 * 在服务启动路径（cmdWatch 前台入口）调用——三平台统一由 node 自理，脚本不掺和。
 */
export function rotateWatchLog(root: string, maxBytes = 1_048_576, keepBytes = 102_400): boolean {
  try {
    const f = watchLogPath(root);
    if (!fs.existsSync(f)) return false;
    const size = fs.statSync(f).size;
    if (size <= maxBytes) return false;
    const fh = fs.openSync(f, 'r');
    const buf = Buffer.alloc(keepBytes);
    fs.readSync(fh, buf, 0, keepBytes, size - keepBytes);
    fs.closeSync(fh);
    const kept = buf.toString('utf8');
    const trimmed = kept.slice(kept.indexOf('\n') + 1); // 丢弃可能被截断的首行
    fs.writeFileSync(f, `...（日志超 1MB，已截断保留尾部）\n${trimmed}`);
    return true;
  } catch { return false; }
}

/** 静默启动器：Run 键指向 vbs（wscript 无窗），cmd 以隐藏窗口运行——消除开机闪黑框 */
export function windowsSilentVbs(cmdPath: string): string {
  return `CreateObject("Wscript.Shell").Run """${cmdPath}""", 0, False\r\n`;
}

export async function installWatchService(root: string): Promise<void> {
  fs.mkdirSync(relayDir(root), { recursive: true });
  // 入口预检（chunk-hash 事故防线）：守护入口必须是稳定存在文件——
  // 0.4.0 前这里写入带 hash 的 chunk 路径，dist 重建后开机即 MODULE_NOT_FOUND
  const { entry, exists } = resolveWatchEntry();
  if (!exists) {
    console.log(pc.red('✗ 守护入口不存在：') + entry);
    console.log(pc.dim('  先运行 srelay build（开发）或重装 npm 包（用户），再 install-service'));
    process.exit(1);
  }
  if (process.platform === 'win32') {
    const { REG_PATH, REG_NAME } = await import('./winregistry.js');
    const cmdPath = path.join(relayDir(root), 'watch-task.cmd');
    fs.writeFileSync(cmdPath, windowsRunScript(root), 'utf8');
    const vbsPath = path.join(relayDir(root), 'watch-task.vbs');
    fs.writeFileSync(vbsPath, windowsSilentVbs(cmdPath), 'utf8');
    try {
      await execFileP('powershell', ['-Command',
        `Set-ItemProperty -Path '${REG_PATH}' -Name '${REG_NAME}' -Value 'wscript.exe "${vbsPath}"'`]);
      console.log(pc.green('✓') + ' 守护已注册（登录自启动，静默无窗口，无需管理员）');
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

