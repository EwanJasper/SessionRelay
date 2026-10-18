// 「哪些祖先目录不许被向上认领」—— 唯一实现来自核心库，这里只把它同步暴露出来。
//
// [1016 红队 A-10] 为什么需要这个文件：核心库 1016 修了 paths.ts 的两个向上探测
// （findRelayRoot / inferProjectRoot），而 DSH 插件里还有**第三个**自己写的：
// project-resolve.mjs 的 findGitRoot —— 它没有任何"主目录/临时目录不算祖先"的判据，
// 而 shouldAutoInit 的黑名单是查**目标目录**的，不是查**被认领的祖先**的。
// 于是只要 ~ 或 %TEMP% 恰好有 .git，自动接入就会在**主目录**上建库 ——
// 正是 cf4b90d 那个事故的原始形态，只是入口换了一个。
//
// 判据只有一份：核心库 dist/recall.js 的 isUnclaimableAncestor（与 CLI/MCP 同一份）。
// 引擎缺席时**保守兜底**：只认"起点自己就是根"，任何祖先一律不认领 ——
// 宁可让 monorepo 子目录退回"在 cwd 建库"（可逆、可删），也不越权在主目录建库。
import path from 'node:path';

let core = null;
try { core = await import('../vendor/dist/recall.js'); } catch { core = null; }
export const __rootRulesFromCore = !!core && typeof core.isUnclaimableAncestor === 'function';

export function isUnclaimableAncestor(start, dir) {
  if (__rootRulesFromCore) {
    try { return core.isUnclaimableAncestor(start, dir) === true; } catch { /* 回落保守判据 */ }
  }
  return path.resolve(start) !== path.resolve(dir);
}
