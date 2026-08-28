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
    /** 覆盖各源的默认存储路径（自定义安装位置时设置）。支持环境变量：CLAUDE_PROJECTS_DIR / ZCODE_DB_PATH / CODEX_DIR / TRAE_DIR */
    claude_projects_dir?: string;
    zcode_db_path?: string;
    codex_dir?: string;
    trae_dir?: string;
    qoder_dir?: string;
  };
  search: { tokenizer: 'jieba' | 'bigram'; min_hits_hint: number; auto_days: number };
  privacy: { ignore_file: string; export_redact: boolean };
  identity: { project_id?: string; author?: string };
}

export function defaultConfig(): RelayConfig {
  return {
    version: '1.0',
    capture: {
      mode: 'full',
      idle_threshold_min: 10,
      cooldown_hours: 6,
      sources: ['claude-code', 'zcode', 'codex'],
    },
    search: { tokenizer: 'jieba', min_hits_hint: 3, auto_days: 30 },
    privacy: { ignore_file: '.sessionrelayignore', export_redact: true },
    identity: {},
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

export function loadConfig(root: string): RelayConfig {
  const def = defaultConfig();
  const file = configFile(root);
  if (!fs.existsSync(file)) return def;
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return {
    ...def,
    ...raw,
    capture: { ...def.capture, ...(raw.capture ?? {}) },
    search: { ...def.search, ...(raw.search ?? {}) },
    privacy: { ...def.privacy, ...(raw.privacy ?? {}) },
    identity: { ...def.identity, ...(raw.identity ?? {}) },
  };
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
