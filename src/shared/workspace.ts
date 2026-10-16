// 经验层的「工作区 / 领域」解析 —— **唯一权威处**。
//
// 为什么要有这个文件（红队 A-5 实测）：
//   同一条可见性规则此前被写了三遍（核心库 visibleWhere / DSH 插件里的一段 SQL /
//   ZCode hook 里的一段 SQL），而且两侧已经**漂移**：插件缺 domain 分支、hook 缺 workspace 分支
//   ⇒ `--scope domain` 的经验在两端**永远不出现**，且没有任何报错（本项目最嫌恶的静默失效）。
//
//   这里把「我是谁（workspace）/ 我属于哪个领域（domain）」做成一份实现，**三个面**共用：
//     核心库 CLI（lesson add/list/harvest/brief） · DSH 插件 · ZCode hook。
//   （MCP 面目前**没有**经验路径——serve 不查 global.sqlite，别按"四个面"去改这句话。）
//
// 两条实测出来的口径：
//   ① workspace = **项目根**，不是"调用时的 cwd"。
//      病历：在 `<root>/core/SessionRelay` 里 `lesson add --scope project`，条目存的是那个子目录；
//      回到项目根，这条经验再也看不见（写者与读者各拿各的 cwd）。改成统一走 findRelayRoot。
//   ② 比较时**大小写与分隔符都不算差异**（与 projectIdOf 同规：项目 id 本来就小写化）。
//      病历：Windows 上 `D:\proj` / `d:/proj` 是同一个目录，直接字符串相等会把同一项目劈成两个。
import fs from 'node:fs';
import path from 'node:path';
import { configFile, findRelayRoot } from './paths.js';

/** 路径比较键：分隔符统一 /、去掉尾分隔符、统一小写。**不解析 ..**（两侧同规即可） */
export function workspaceKey(p: string): string {
  return String(p ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
}

/**
 * 写入/查询用的工作区 id：项目根优先，其次当前目录（未初始化的目录只能是它自己）。
 * ⚠️ 写与读必须都走这里，否则就是上面 ① 那个病历。
 */
export function resolveWorkspaceId(startDir: string): string {
  return findRelayRoot(startDir) ?? path.resolve(startDir);
}

/**
 * 本项目的**领域标签**（scope=domain 的经验靠它对上号）。
 * 优先级：SRELAY_DOMAIN 环境变量 > `.sessionrelay/config.json` 的 domain 字段。
 * 没有标签就是 undefined —— 此时 domain 级经验对本项目不可见（**不猜**：猜错领域 = 把别的领域的经验注进来）。
 */
export function resolveDomain(root?: string): string | undefined {
  const env = (process.env.SRELAY_DOMAIN ?? '').trim();
  if (env) return env;
  if (!root) return undefined;
  try {
    const j = JSON.parse(fs.readFileSync(configFile(root), 'utf8')) as { domain?: unknown };
    const d = typeof j.domain === 'string' ? j.domain.trim() : '';
    return d || undefined;
  } catch { return undefined; }
}
