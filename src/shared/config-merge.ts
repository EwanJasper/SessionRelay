// 项目配置的**纯模型**：类型 / 默认值 / 合并 / 读文件 / 写回。
//
// [1017 夜] 从 shared/config.ts 切出来的，理由只有一个但很硬：
//   config.ts 里的 applyTokenizer 会把 core/tokenize/tokenizer.js（连带 @node-rs/jieba 原生模块）
//   拖进**任何** import 它的 bundle。面板插件跑在没有原生模块的 DSH 进程里 ⇒ 一拖就是整块加载失败。
//   切完之后：本文件零副作用（只 import node 内置 + paths 常量），面板只 import 这里，
//   于是 dist/panel.js 里不再出现 better-sqlite3 / node-rs/jieba。判据仍然只有一份。
//
// 纪律：本文件不许 import config.ts（会成环），也不许 import 任何原生模块。
import fs from 'node:fs';
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
    /** [1017 夜] 空闲多久卸载 embedder（分钟；0 = 永不卸载，默认 10）。
     *  为什么要它：embedder 一旦装载就常驻内存（几百 MB 级的 ONNX 会话），
     *  而 DSH 宿主与守护都是常驻进程 —— 用完不还，用户机器上就一直占着。 */
    idle_unload_min?: number;
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
    // hot_days 60→30（2026-10-17，用户批准）：task-3 实测落盘系数 3.1× 正文、messages+FTS 占库 94~97%，
    // 缩短热窗可省 agent1super 36.9% / music 69.3%；结论与经验全保留，正文仍可从客户端会话文件重放。
    archive: { enabled: true, hot_days: 30, workflow_days: 7, check_every_min: 60 },
    recompute: { check_every_min: 360 },
  };
}

/** 默认值 + config.json 原始内容 → 生效配置（**纯**，不做任何 IO） */
export function mergeConfig(raw: Record<string, unknown> | null): RelayConfig {
  const def = defaultConfig();
  if (!raw) return def;
  return {
    ...def,
    ...raw,
    capture: { ...def.capture, ...((raw.capture ?? {}) as object) },
    search: { ...def.search, ...((raw.search ?? {}) as object) },
    privacy: { ...def.privacy, ...((raw.privacy ?? {}) as object) },
    identity: { ...def.identity, ...((raw.identity ?? {}) as object) },
    semantic: { ...((raw.semantic ?? {}) as object) },
    archive: { ...def.archive, ...((raw.archive ?? {}) as object) },
    recompute: { ...def.recompute, ...((raw.recompute ?? {}) as object) },
  } as RelayConfig;
}

export interface ConfigRead { raw: Record<string, unknown> | null; exists: boolean; error: string | null }

/** 读 config.json 并解析。**错误文案只有这一份**（doctor 把"config 可解析"当检查项，
 *  常规命令路径此前拿到的是裸堆栈）——面板与 CLI 报的是同一句话。 */
export function readConfigFile(root: string): ConfigRead {
  const file = configFile(root);
  if (!fs.existsSync(file)) return { raw: null, exists: false, error: null };
  try {
    return { raw: JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>, exists: true, error: null };
  } catch (e) {
    return { raw: null, exists: true, error: 'config.json 解析失败（' + file + '）：' + (e as Error).message + ' —— 修复该文件，或删除后 srelay init 重建' };
  }
}

export function saveConfig(root: string, cfg: RelayConfig): void {
  fs.mkdirSync(path.dirname(configFile(root)), { recursive: true });
  fs.writeFileSync(configFile(root), JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}
