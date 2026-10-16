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
export function isUnclaimableAncestor(start: string, dir: string): boolean {
  if (dir === start) return false;
  const d = path.resolve(dir).toLowerCase();
  if (isTransientRoot(d)) return true;
  const home = path.resolve(os.homedir()).toLowerCase();
  return d === home;
}

/**
 * 「这个目录算不算**已初始化的项目根**」——光有 `.sessionrelay` 目录是不够的。
 *
 * 病历（本轮 code review 抓到，长期存在）：全局经验库按设计住在 `~/.sessionrelay/global.sqlite`，
 * 于是 `~` 仅凭"有个 .sessionrelay 目录"就被认成**已初始化的项目** ——
 *   · guard G 长期把 `C:\Users\crx` 列成一个 0 会话/0 决策的"项目"；
 *   · 主目录也一直挂在项目注册表里（2026-10-16T08:41 那条），守护还会给它写 watch.log；
 *   · A-7 新增的诊断会对 `~` 下任何子目录说"祖先里有记忆库"——那不是项目库，是全局经验库。
 * 判据：目录里得有**真项目标记**（`relay.sqlite` 或 `config.json`）；两者都没有就不算项目根。
 * （`srelay init` 会同时建这两个，所以真项目不受影响；半删过的项目会退回"未初始化"，提示更准。）
 */
function hasProjectMarker(dir: string): boolean {
  const d = path.join(dir, '.sessionrelay');
  return existsSync(path.join(d, 'relay.sqlite')) || existsSync(path.join(d, 'config.json'));
}

export interface RootSearch {
  /** 可用的项目根（null = 没有） */
  root: string | null;
  /**
   * 沿途**看到但因"不许认领"而跳过**的记忆库（主目录 / 临时目录）。
   *
   * [1016 红队 A-7] 为什么要有它：判据（主目录/临时目录不算祖先）是对的，但"跳过即终点"会让
   * 老布局（库就建在 ~ 上）在子目录里的**所有只读命令**都报"未接入"，而且没有任何线索说明为什么。
   *   处置**不是**改回自动认领——那会重新把 ~ 下面的一切并进主目录，正是当初的事故
   *   （在 %TEMP% 里 init 却被 ~ 认领、回说"已初始化"而当前目录一个字节没建）。
   *   处置是**把跳过这件事报出来**（见 cli/ui.ts requireRoot）：静默失效 → 可操作的提示。
   */
  skipped: string[];
}

/** findRelayRoot 的完整结果（含被跳过的祖先）——排障与提示用 */
export function findRelayRootInfo(startDir: string): RootSearch {
  const start = path.resolve(startDir);
  const skipped: string[] = [];
  // [1016 · 同一 bug 的另一半] 与 inferProjectRoot 同因：**临时目录不许向上认领**。
  // 不修这里的话，%TEMP% 下的任何东西都会被认成"属于用户主目录那个项目"——
  // 实测：serve 的根解析用例会因为这个判定响亮失败（测试自己想抓住的就是这类污染）。
  if (isTransientRoot(start)) {
    return { root: hasProjectMarker(start) ? start : null, skipped };
  }
  let dir = start;
  for (;;) {
    if (hasProjectMarker(dir)) {
      if (!isUnclaimableAncestor(start, dir)) return { root: dir, skipped };
      skipped.push(dir);
    }
    const parent = path.dirname(dir);
    if (parent === dir) return { root: null, skipped };
    dir = parent;
  }
}

export function findRelayRoot(startDir: string): string | null {
  return findRelayRootInfo(startDir).root;
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
    // 与 findRelayRoot 同规：`.sessionrelay` 里得有真项目标记（全局经验库也住在这个目录名下）
    if ((hasProjectMarker(dir) || existsSync(path.join(dir, '.git'))) && !isUnclaimableAncestor(start, dir)) return dir;
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
// [1017 夜] 从 store/global.ts 提升到 paths（那里静态 import better-sqlite3，任何只要"路径"的
// 消费者都被拖上原生依赖 —— 面板宿主半就是这样的消费者）。global.ts 原样再导出，老调用点不变。
export const globalDbFile = (): string =>
  path.join(process.env.SRELAY_GLOBAL_HOME || path.join(os.homedir(), '.sessionrelay'), 'global.sqlite');

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
