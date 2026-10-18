// 项目配置（技术方案 §8.6）：默认值 < 项目 config.json（测试可注入 override）
//
// [1017 夜] 切成两层：
//   · shared/config-merge.ts —— **纯模型**（类型/默认值/合并/读文件/写回），零副作用、零原生依赖；
//   · 本文件 —— 有副作用的加载（读文件 + 应用分词器）与各源目录解析。
// 为什么必须切：下面 applyTokenizer 里那句 require 会把 core/tokenize/tokenizer.js
// （连带 @node-rs/jieba 原生模块）拖进**任何** import 本文件的 bundle；而面板插件跑在
// 没有原生模块的 DSH 进程里，一拖就是整块加载失败（实测：dist/panel.js 里出现 import Jieba）。
// 纯模型部分在这里**原样再导出**，既有调用点（CLI / MCP / 插件 / hook）一行都不用改。
import os from 'node:os';
import path from 'node:path';

import { mergeConfig, saveConfig, readConfigFile } from './config-merge.js';
import type { RelayConfig, CaptureMode } from './config-merge.js';

export * from './config-merge.js';

export function loadConfig(root: string): RelayConfig {
  const r = readConfigFile(root);
  if (r.error) throw new Error(r.error);
  const cfg = mergeConfig(r.raw);
  applyTokenizer(cfg);
  return cfg;
}

/**
 * 把配置里的分词器应用到进程级单例（ADR-002）。
 *
 * 为什么放在 loadConfig 这个唯一收口处：分词器的消费者遍布 CLI search、MCP、
 * 守护的捕获写索引、recompute——逐个调用点接必漏一个，而漏掉的那个就是
 * "配了 bigram 但这条路径还在用 jieba"的静默分叉（索引与查询词元不一致，
 * 正是 tokenizer.ts 开头说的"中文检索最大的隐性 bug 源"）。
 *
 * ⚠️ 切换分词器后**必须重建索引**：已入库的 search_text 是旧分词器产的，
 * 旧词元与新查询词元对不上，表现为"改了配置搜索结果变少/变空"且不报错。
 * 用 srelay recompute 重算，或删库重建。
 */
function applyTokenizer(cfg: RelayConfig): void {
  try {
    // 动态 require 而非顶层 import：tokenizer.ts 只从本模块 import type（编译期擦除），
    // 但惰性加载能确保即便将来有人把它改成运行时 import 也不会形成循环依赖。
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { setTokenizer } = require('../core/tokenize/tokenizer.js') as typeof import('../core/tokenize/tokenizer.js');
    setTokenizer(cfg.search?.tokenizer ?? 'jieba');
  } catch { /* 分词器不可用时保持默认，不阻塞配置加载 */ }
}

export function setCaptureMode(root: string, mode: CaptureMode): RelayConfig {
  const cfg = loadConfig(root);
  cfg.capture.mode = mode;
  saveConfig(root, cfg);
  return cfg;
}

/** 路径解析优先级：环境变量 > config.json > 默认值 */
export function claudeProjectsDir(cfg: RelayConfig): string {
  return process.env.CLAUDE_PROJECTS_DIR
    ?? cfg.capture.claude_projects_dir
    ?? path.join(os.homedir(), '.claude', 'projects');
}

export function zcodeDbPath(cfg: RelayConfig): string {
  return process.env.ZCODE_DB_PATH
    ?? cfg.capture.zcode_db_path
    ?? path.join(os.homedir(), '.zcode', 'cli', 'db', 'db.sqlite');
}

export function codexDir(cfg: RelayConfig): string {
  return process.env.CODEX_DIR
    ?? cfg.capture.codex_dir
    ?? path.join(os.homedir(), '.codex');
}

export function traeDir(cfg: RelayConfig): string {
  return process.env.TRAE_DIR
    ?? cfg.capture.trae_dir
    ?? path.join(os.homedir(), 'AppData', 'Roaming', 'Trae CN');
}

export function qoderDir(cfg: RelayConfig): string {
  return process.env.QODER_DIR
    ?? cfg.capture.qoder_dir
    ?? path.join(os.homedir(), '.qoder-cn');
}

export function dshSessionsDir(cfg: RelayConfig): string {
  return process.env.DSH_SESSIONS_DIR
    ?? cfg.capture.dsh_sessions_dir
    ?? path.join(os.homedir(), '.dsh', 'sessions');
}

export const IGNORE_TEMPLATE = `# 会话接力隐私排除（语法：gitignore 子集）
# source:zcode            ← 排除某个 agent 来源的所有会话
# title:绩效               ← 标题含关键词的会话不入库
# *.tmp.jsonl             ← 匹配源文件路径的 glob
# secrets/                ← 目录前缀匹配
`;

