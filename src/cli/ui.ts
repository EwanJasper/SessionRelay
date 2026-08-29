// CLI 呈现助手（技术方案 §8）+ 懒启动（守护不在时自动拉起）
import pc from 'picocolors';
import { openExisting } from '../store/db.js';
import type { DB } from '../store/db.js';
import { findRelayRoot, dbFile } from '../shared/paths.js';
import { isDaemonAlive } from '../shared/lock.js';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export { pc };

export function die(msg: string, hint?: string): never {
  console.error(pc.red('✗ ') + msg);
  if (hint) console.error(pc.dim('  下一步：' + hint));
  process.exit(1);
}

export function requireRoot(): string {
  const root = findRelayRoot(process.cwd());
  if (!root) die('未找到 .sessionrelay（本项目尚未初始化）', '在项目根目录运行 srelay init');
  ensureDaemon(root);
  return root;
}

/** 只在只读命令中调用懒启动（search/list/status 等）；写命令（save/sync/archive）自身会做同步 */
export function requireRootWithDaemon(): string {
  const root = requireRoot();
  ensureDaemon(root);
  return root;
}

/**
 * 懒启动：检查守护是否在运行，不在则后台拉起（静默，不打扰用户）
 * 在所有读命令（search/list/show/decisions/status 等）的入口调用
 */
export function ensureDaemon(root: string): void {
  if (process.env.VITEST) return; // 测试环境不拉守护（避免 EBUSY 和竞态）
  const alive = isDaemonAlive(root);
  if (alive.alive) return; // 已在运行

  // 守护不在 → 后台拉起（detached，不阻塞当前命令）
  try {
    const isDev = import.meta.url.endsWith('.ts');
    let cmd: string;
    let args: string[];
    if (isDev) {
      // 开发模式：tsx loader
      const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
      const loader = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'loader.mjs');
      const cli = path.join(repoRoot, 'src/bin/srelay.ts');
      cmd = process.execPath;
      args = ['--import', `file:///${loader.replace(/\\/g, '/')}`, cli, 'watch', '--foreground'];
    } else {
      // 生产模式：直接用当前入口脚本（tsup 打包后 process.argv[1] 就是 dist/srelay.js）
      cmd = process.execPath;
      args = [process.argv[1], 'watch', '--foreground'];
    }
    const child = spawn(cmd, args, {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env },
      cwd: root,
    });
    child.unref(); // 父进程退出后子进程继续运行
  } catch {
    // 启动失败不阻塞当前命令——sync 兜底
  }
}

export function openRelayDb(root: string): DB {
  return openExisting(dbFile(root));
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function stateBadge(s: string): string {
  if (s === 'confirmed') return pc.green('confirmed');
  if (s === 'pending_end') return pc.yellow('pending');
  return pc.cyan('active');
}
