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
    /** [1017 夜] 语义候选上限（默认 5）。与 reserve_slots 是两套限量：一个定候选池、一个定进名额几条。
     *  参数扫描要求它能被**单变量**地改（调研件 §4.3 R3）。 */
    top_k?: number;
    /** [1017 夜] 量化档覆盖（fp32/fp16/q8/int8/…；不给 = 用模型档案的默认档）。
     *  为什么要它：EmbeddingGemma **不支持 fp16**，写死一个档迟早静默出错（调研件 §3.6）。 */
    dtype?: string;
  };
  /** [fork 1011] D26 自动归档：守护按窗口把旧会话正文蒸发（决策/话题骨架保留），增量式 VACUUM 回收空页 */
  archive?: {
    enabled?: boolean;
    hot_days?: number;
    workflow_days?: number;
    check_every_min?: number;
  };
  /** 时间衰减（1021；模块见 core/decay/）。**默认关**，只乘排序分数不过滤。
   *  ⚠️ 经验（lesson）线别用它：store/lesson-gate.ts 已有线性年龄扣分，两套一起用 = 衰减两次。 */
  decay?: import('../core/decay/decay.js').DecayConfig;
  /** ═══ L3 模型压缩（docs/1018-夜-模型压缩与语义档-建设方案.md §2）═══
   *  用**生成模型**把旧条目合成上级条目。与 semantic 块**刻意分开**：
   *  嵌入模型管「找得到」，生成模型管「存得省」—— 共用一套配置会让换嵌入模型意外改掉压缩行为。
   *  默认关（默认档零模型是项目底线）；原文永不删；掉召回整批回滚。 */
  compress?: {
    enabled?: boolean;
    provider?: 'openai' | 'ollama';
    model?: string;
    endpoint?: string;
    api_key?: string;
    timeout_ms?: number;
    max_calls_per_round?: number;
    max_calls_per_hour?: number;
    min_cluster?: number;
    topic_overlap?: number;
    min_age_days?: number;
    /** 收益闸门：合并结果必须比原簇省够这个比例（0~1，默认 0.5），否则不落地。1020 从 memcore 借鉴。 */
    min_saved_ratio?: number;
    /** 收益闸门：原簇总字节小于此值就不调模型（默认 256）——太小合了也没意义。 */
    min_utf8_bytes?: number;
    projects?: boolean;
    lessons?: boolean;
  };
  /** ═══ L1b 跨会话近重复合并（1021 新增，模块见 core/compact/near-dup.ts）═══
   *  **默认开**。这个默认值是量出来的，不是拍脑袋：
   *    · 代表选择改 highest-trust 后，两个库的召回基准 hit@1/hit@3/hit@10 **逐格不变**
   *    · 而旧策略(newest)在 music 库上会让 **31 条用户拍板**被 workflow 转述吸收、从读路径隐形
   *    · 压缩量两者相同（46 组） ⇒ 修规则不花任何代价
   *  仍可关：设 compact.near_dup=false。写回有审计(compact_log)与回滚(rollbackNearDuplicates)。 */
  compact?: {
    near_dup?: boolean;
    /** 近重复阈值（默认 0.8；调低=合并更狠，调高=更保守） */
    threshold?: number;
  };
  /** 经验层（1021 新增）。harvest = 从项目记忆里**刨草稿**，默认开。
   *  之所以敢默认开：产出永远是 draft，而 draft 不进注入层（要 lesson confirm 才生效）。
   *  之前它只是手动命令，而 consolidate（衰减/退休）每小时在跑 ⇒ 经验库只减不增。 */
  lesson?: {
    /** 自动采集开关（默认 true） */
    harvest?: boolean;
    /** 回看多少天（默认 7） */
    harvest_days?: number;
  };
  /** [fork 1013] 审计 P3：提取规则版本落后时的后台分批重算节奏（分钟，默认 6h） */
  recompute?: {
    check_every_min?: number;
  };
}

import { defaultDecayConfig, resolveDecayConfig } from '../core/decay/decay.js';

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
    // ── 时间衰减（1021 新增，模块见 core/decay/）──
    //   **默认关**：先量再接。实测当前库最老的决策只有 66 天，而「三个月前」这个场景还没出现，
    //   所以线上开了差异也很小 —— 这不代表它没用，只代表现在还用不上。
    //   开关打开后只乘**排序分数**，不过滤：老记录仍能搜到，只是排得靠后。
    // ⚠️ 经验（lesson）这条线**不要用这里的衰减**：store/lesson-gate.ts 已有
    //   `DECAY_PER_DAY = 0.0083` 的线性年龄扣分（用于注入阈值判决，会真的过滤）。
    //   两处一起用 = 衰减两次。要么用 lesson-gate 那套，要么把它换成这里的指数项，二选一。
    decay: defaultDecayConfig(),
    // L1b 跨会话近重复合并：默认开（依据见 RelayConfig.compact 的注释）
    compact: { near_dup: true, threshold: 0.8 },
    lesson: { harvest: true, harvest_days: 7 },
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
    compress: { ...((raw.compress ?? {}) as object) },
    archive: { ...def.archive, ...((raw.archive ?? {}) as object) },
    decay: resolveDecayConfig(raw.decay),
    recompute: { ...def.recompute, ...((raw.recompute ?? {}) as object) },
    compact: { ...(def.compact ?? {}), ...((raw.compact ?? {}) as object) },
    lesson: { ...(def.lesson ?? {}), ...((raw.lesson ?? {}) as object) },
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
