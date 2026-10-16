// 路径与身份（技术方案 shared/paths.ts）
// - 项目根发现：向上找 .sessionrelay（已初始化）或 .git（待初始化的候选）
// - pathSlug 与 Claude Code 的 projects 目录命名规则一致（D:\a\b → D--a-b）
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { isTransientRoot } from './registry.js';

/**
 * [1016] 「祖先目录不该被自动认领」的共用判据。
 *
 * 两个真实事故（同一根因，被两个不同测试各抓到一次）：
 *   ① 在 %TEMP% 里 init → 一路向上走到 C:\Users\crx（主目录恰好有 .sessionrelay）⇒ 回说"已初始化"，当前目录一个字节没建；
 *   ② 插件自测在 ~/srelay-inittool-* 里 init → 同样被 ~ 认领 ⇒ 建库断言全红。
 *
 * 判据：**主目录与临时目录都不算"项目祖先"** —— 它们下面的一切不可能都属于它们。
 * 但**显式在它俩里面 init**（start === 该目录）仍然允许：那是明确意图，不是"顺路认领"。
 */
function isUnclaimableAncestor(start: string, dir: string): boolean {
  if (dir === start) return false;
  const d = path.resolve(dir).toLowerCase();
  if (isTransientRoot(d)) return true;
  const home = path.resolve(os.homedir()).toLowerCase();
  return d === home;
}

export function findRelayRoot(startDir: string): string | null {
  const start = path.resolve(startDir);
  // [1016 · 同一 bug 的另一半] 与 inferProjectRoot 同因：**临时目录不许向上认领**。
  // 不修这里的话，%TEMP% 下的任何东西都会被认成"属于用户主目录那个项目"——
  // 实测：serve 的根解析用例会因为这个判定响亮失败（测试自己想抓住的就是这类污染）。
  if (isTransientRoot(start)) return existsSync(path.join(start, '.sessionrelay')) ? start : null;
  let dir = start;
  for (;;) {
    if (existsSync(path.join(dir, '.sessionrelay')) && !isUnclaimableAncestor(start, dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * init 用：优先已初始化根，否则含 .git 的目录，否则用 cwd。
 *
 * [1016 · 真 bug 修复] **临时目录不许被「向上认领」**。
 *
 * 实测（本机）：在 %TEMP%\ses-t1 里跑 `srelay init`，它一路向上走到 C:\Users\crx ——
 * 而用户主目录恰好有 .git 与 .sessionrelay ⇒ 认成「本项目已初始化，执行增量同步」，
 * **回复说成功了，而当前目录一个字节都没建**。这正是本项目最嫌恶的「静默什么都不做」。
 *
 * 危害不止测试：整个 %TEMP%、以及主目录下的任何一次性沙盒，都会被悄悄并进主目录那个项目。
 * 与 registry 的 isTransientRoot（审计 P2）同一条意图：临时目录是一次性的，不该有归属。
 */
export function inferProjectRoot(startDir: string): string {
  const start = path.resolve(startDir);
  if (isTransientRoot(start)) return start;
  let dir = start;
  for (;;) {
    if ((existsSync(path.join(dir, '.sessionrelay')) || existsSync(path.join(dir, '.git'))) && !isUnclaimableAncestor(start, dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

export const relayDir = (root: string) => path.join(root, '.sessionrelay');
export const dbFile = (root: string) => path.join(relayDir(root), 'relay.sqlite');
export const configFile = (root: string) => path.join(relayDir(root), 'config.json');
export const lockFile = (root: string) => path.join(relayDir(root), 'lock');
export const statsFile = (root: string) => path.join(relayDir(root), 'stats.json');
// [fork 1011] 从 cli/service.ts 提升：capture 层（全局守护轮转）也要用，不许 cli←capture 反向依赖
export const watchLogPath = (root: string) => path.join(relayDir(root), 'watch.log');
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
