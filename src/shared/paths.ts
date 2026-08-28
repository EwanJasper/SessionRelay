// 路径与身份（技术方案 shared/paths.ts）
// - 项目根发现：向上找 .sessionrelay（已初始化）或 .git（待初始化的候选）
// - pathSlug 与 Claude Code 的 projects 目录命名规则一致（D:\a\b → D--a-b）
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export function findRelayRoot(startDir: string): string | null {
  let dir = path.resolve(startDir);
  for (;;) {
    if (existsSync(path.join(dir, '.sessionrelay'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** init 用：优先已初始化根，否则含 .git 的目录，否则 null（用 cwd） */
export function inferProjectRoot(startDir: string): string {
  let dir = path.resolve(startDir);
  for (;;) {
    if (existsSync(path.join(dir, '.sessionrelay')) || existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(startDir);
    dir = parent;
  }
}

export const relayDir = (root: string) => path.join(root, '.sessionrelay');
export const dbFile = (root: string) => path.join(relayDir(root), 'relay.sqlite');
export const configFile = (root: string) => path.join(relayDir(root), 'config.json');
export const lockFile = (root: string) => path.join(relayDir(root), 'lock');
export const statsFile = (root: string) => path.join(relayDir(root), 'stats.json');
export const ignoreFile = (root: string) => path.join(root, '.sessionrelayignore');
export const quarantineDir = (root: string) => path.join(relayDir(root), 'quarantine');

export function pathSlug(p: string): string {
  return p.replace(/[\\/:]/g, '-');
}

export function projectIdOf(root: string): string {
  return 'proj_' + pathSlug(path.resolve(root)).toLowerCase();
}

/** 内部会话 ID（方针 §7.1）：hash(source:sourceSessionId) 截断 */
export function sessionIdOf(source: string, sourceSessionId: string): string {
  return createHash('sha1').update(`${source}:${sourceSessionId}`).digest('hex').slice(0, 16);
}

/** 相对项目根、统一 / 分隔（技术方案 §7.3） */
export function toRelPosix(root: string, p: string): string {
  const rel = path.relative(root, p);
  return (rel === '' ? '.' : rel).replace(/\\/g, '/');
}
