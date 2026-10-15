// 项目配置（技术方案 §8.6）：默认值 < 项目 config.json（测试可注入 override）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configFile } from './paths.js';

export type CaptureMode = 'full' | 'meta' | 'off';

export interface RelayConfig {
  version: string;
  capture: {
    mode: CaptureMode;
    idle_threshold_min: number;
    cooldown_hours: number;
    sources: string[];
    /** 故意不采集的源 id（隐私/不需要）。doctor 的"采集源覆盖"检查会跳过它们，
     *  不会把用户的有意选择报成故障。 */
    ignore_sources?: string[];
    /** 覆盖各源的默认存储路径（自定义安装位置时设置）。支持环境变量：CLAUDE_PROJECTS_DIR / ZCODE_DB_PATH / CODEX_DIR / TRAE_DIR / DSH_SESSIONS_DIR */
    claude_projects_dir?: string;
    zcode_db_path?: string;
    codex_dir?: string;
    trae_dir?: string;
    qoder_dir?: string;
    dsh_sessions_dir?: string;
  };
  search: { tokenizer: 'jieba' | 'bigram'; min_hits_hint: number; auto_days: number };
  privacy: { ignore_file: string; export_redact: boolean };
  identity: { project_id?: string; author?: string };
  /** 语义检索（可选增强，v4 设计：未启用=行为与纯 FTS 逐字节等价） */
  semantic?: {
    enabled?: boolean; model?: string; threshold?: number;
    /** [1015 夜] 语义命中保底槽位（默认 3，上限 floor(limit/3)；0 = 旧行为：只追加不占位） */
    reserve_slots?: number;
  };
  /** [fork 1011] D26 自动归档：守护按窗口把旧会话正文蒸发（决策/话题骨架保留），增量式 VACUUM 回收空页 */
  archive?: {
    enabled?: boolean;
    hot_days?: number;
    workflow_days?: number;
    check_every_min?: number;
  };
  /** [fork 1013] 审计 P3：提取规则版本落后时的后台分批重算节奏（分钟，默认 6h） */
  recompute?: {
    check_every_min?: number;
  };
}

export function defaultConfig(): RelayConfig {
  return {
    version: '1.0',
    capture: {
      ignore_sources: [],
      mode: 'full',
      idle_threshold_min: 10,
      cooldown_hours: 6,
      sources: ['claude-code', 'zcode', 'codex', 'qoder', 'dsh'],
    },
    search: { tokenizer: 'jieba', min_hits_hint: 3, auto_days: 30 },
    privacy: { ignore_file: '.sessionrelayignore', export_redact: true },
    identity: {},
    archive: { enabled: true, hot_days: 60, workflow_days: 7, check_every_min: 60 },
    recompute: { check_every_min: 360 },
  };
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

export function loadConfig(root: string): RelayConfig {
  const def = defaultConfig();
  const file = configFile(root);
  if (!fs.existsSync(file)) { applyTokenizer(def); return def; }
  // [fork 0922] 配置损坏时给可读错误而非裸堆栈（doctor 把"config 可解析"当检查项，
  // 常规命令路径却拿不到指导信息——原实现 JSON.parse 直接抛）
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch (e) {
    throw new Error(`config.json 解析失败（${file}）：${(e as Error).message} —— 修复该文件，或删除后 srelay init 重建`);
  }
  const cfg: RelayConfig = {
    ...def,
    ...raw,
    capture: { ...def.capture, ...(raw.capture ?? {}) },
    search: { ...def.search, ...(raw.search ?? {}) },
    privacy: { ...def.privacy, ...(raw.privacy ?? {}) },
    identity: { ...def.identity, ...(raw.identity ?? {}) },
    semantic: { ...(raw.semantic ?? {}) },
    archive: { ...def.archive, ...(raw.archive ?? {}) },
    recompute: { ...def.recompute, ...(raw.recompute ?? {}) },
  };
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

export function saveConfig(root: string, cfg: RelayConfig): void {
  fs.mkdirSync(path.dirname(configFile(root)), { recursive: true });
  fs.writeFileSync(configFile(root), JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}

export function setCaptureMode(root: string, mode: CaptureMode): RelayConfig {
  const cfg = loadConfig(root);
  cfg.capture.mode = mode;
  saveConfig(root, cfg);
  return cfg;
}

export const IGNORE_TEMPLATE = `# 会话接力隐私排除（语法：gitignore 子集）
# source:zcode            ← 排除某个 agent 来源的所有会话
# title:绩效               ← 标题含关键词的会话不入库
# *.tmp.jsonl             ← 匹配源文件路径的 glob
# secrets/                ← 目录前缀匹配
`;
