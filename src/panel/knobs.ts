// 可调旋钮的**唯一清单**（面板设置页的宿主端数据源）
//
// 为什么清单在核心库而不是前端：面板、CLI、未来的 ZCode 侧都要能改同一批值。
// 前端只负责渲染宿主发来的 spec —— 名单写在两处就一定会分叉（本项目反复吃这个亏）。
// 本文件**零依赖**（只 import 类型与 paths 的纯常量），面板宿主半可以单独加载。

import type { RelayConfig } from '../shared/config-merge.js';

export type KnobType = 'enum' | 'number' | 'boolean' | 'string' | 'string-list';

export interface KnobSpec {
  /** 点分路径，如 capture.mode */
  path: string;
  /** 人话标题（面板直接显示） */
  label: string;
  type: KnobType;
  /** enum 的候选值 */
  options?: string[];
  min?: number;
  max?: number;
  step?: number;
  /** 该旋钮的环境变量天窗（有值时优先于 config.json） */
  envVar?: string;
  /** 一句话解释（面板 hover / 副标题） */
  hint: string;
  /** 改完需要额外动作的警告（如换分词器必须重算） */
  warning?: string;
}

export const SOURCE_IDS = ['claude-code', 'zcode', 'codex', 'qoder', 'dsh'];

export const KNOB_SPECS: KnobSpec[] = [
  { path: 'capture.mode', label: '采集强度', type: 'enum', options: ['full', 'meta', 'off'],
    hint: 'full=存正文（检索最好）· meta=只存骨架（省空间）· off=完全停采' },
  { path: 'capture.idle_threshold_min', label: '空闲多久算一轮结束', type: 'number', min: 1, max: 1440, step: 1,
    hint: '单位分钟。会话静默超过它就认为这一轮结束，可以抽取了' },
  { path: 'capture.cooldown_hours', label: '同一会话冷却', type: 'number', min: 0, max: 720, step: 1,
    hint: '单位小时。同一会话两次采集之间的最短间隔（防抖）' },
  { path: 'capture.sources', label: '采哪些客户端', type: 'string-list', options: SOURCE_IDS,
    hint: '勾掉哪个就不采哪个；被忽略的源不会在体检里被报成故障' },
  { path: 'capture.ignore_sources', label: '有意忽略的源', type: 'string-list', options: SOURCE_IDS,
    hint: '和上一项的区别：这里是"明确不要"，doctor 会跳过它而不是报警' },
  { path: 'capture.claude_projects_dir', label: 'Claude 会话目录', type: 'string', envVar: 'CLAUDE_PROJECTS_DIR',
    hint: '默认 ~/.claude/projects' },
  { path: 'capture.zcode_db_path', label: 'ZCode 数据库', type: 'string', envVar: 'ZCODE_DB_PATH',
    hint: '默认 ~/.zcode/cli/db/db.sqlite' },
  { path: 'capture.codex_dir', label: 'Codex 目录', type: 'string', envVar: 'CODEX_DIR', hint: '默认 ~/.codex' },
  { path: 'capture.trae_dir', label: 'Trae 目录', type: 'string', envVar: 'TRAE_DIR', hint: '默认 %APPDATA%/Trae CN' },
  { path: 'capture.qoder_dir', label: 'Qoder 目录', type: 'string', envVar: 'QODER_DIR', hint: '默认 ~/.qoder-cn' },
  { path: 'capture.dsh_sessions_dir', label: 'DSH 会话目录', type: 'string', envVar: 'DSH_SESSIONS_DIR',
    hint: '默认 ~/.dsh/sessions' },
  { path: 'search.tokenizer', label: '中文分词器', type: 'enum', options: ['jieba', 'bigram'],
    hint: 'jieba=词级（准）· bigram=二字滑窗（快、无需词典）',
    warning: '换分词器后已入库的索引是旧词元，必须跑一次重算，否则搜索结果会变少且不报错' },
  { path: 'search.min_hits_hint', label: '最少命中提示', type: 'number', min: 0, max: 20, step: 1,
    hint: '命中数低于它时提示"可能记不得"，只是提示不影响召回' },
  { path: 'search.auto_days', label: '自动检索回溯天数', type: 'number', min: 0, max: 3650, step: 1,
    hint: '简报自动召回时最多往回看多少天' },
  { path: 'privacy.ignore_file', label: '隐私排除文件名', type: 'string',
    hint: '相对项目根的排除文件名（默认 .sessionrelayignore）。它同时作用于**采集**与**导出边界**；'
      + '改了之后库里已有内容不会被删，只是之后不再被采集、也不会被导出带走' },
  // [1021 审查 #08] 文案必须与实现一致：此前写"抹掉本机路径与密钥样式字符串"，
  // 但 redact.ts 里**没有**路径规则（只有密钥/令牌/连接串）—— 声称得比做得多，比不做更危险。
  { path: 'privacy.export_redact', label: '导出时脱敏', type: 'boolean',
    hint: '导出/分享前抹掉：AWS 密钥、PEM 私钥、Bearer/JWT 令牌、键值型凭据（password/api_key/token 等，'
      + '含 JSON 双引号、单引号、裸值三种写法）、带账号密码的数据库连接串。'
      + '**不覆盖**自定义键名的凭据、被切段/编码过的密钥，也不脱敏本机路径——它是默认脱敏，不是安全边界' },
  { path: 'identity.project_id', label: '项目 ID 覆盖', type: 'string',
    hint: '留空=按项目路径推导。改了等于换一个身份，历史数据不会自动跟过来' },
  { path: 'identity.author', label: '作者署名', type: 'string', hint: '写进会话记录，多人共用一个库时用于区分' },
  { path: 'semantic.enabled', label: '语义检索', type: 'boolean',
    hint: '可选增强。默认关；关掉时行为与纯关键词检索逐字节等价（拍板：不做神经路线）' },
  { path: 'semantic.model', label: '语义模型', type: 'string', hint: '语义档使用的本地模型名' },
  { path: 'semantic.threshold', label: '语义阈值', type: 'number', min: 0, max: 1, step: 0.01,
    hint: '相似度低于它不计入语义命中' },
  { path: 'semantic.reserve_slots', label: '语义保底槽位', type: 'number', min: 0, max: 10, step: 1,
    hint: '给语义命中预留的位置数（上限 floor(limit/3)）；0 = 旧行为：只追加不占位' },
  { path: 'semantic.idle_unload_min', label: '语义模型空闲卸载（分钟）', type: 'number', min: 0, max: 1440, step: 1,
    hint: '多久没用就把本地模型从内存里放掉；0 = 永不卸载。常驻进程（DSH 宿主/守护）用它把内存还给系统' },
  { path: 'semantic.top_k', label: '语义候选上限', type: 'number', min: 1, max: 50, step: 1,
    hint: '语义这一路最多产出几个候选（默认 5）。它与「保底槽位」是两套限量：这个定候选池，那个定进名额几条' },
  { path: 'semantic.dtype', label: '语义量化档', type: 'string',
    hint: 'fp32/fp16/q8/int8/q4/q4f16 等；留空=用模型档案默认档。注意 EmbeddingGemma 不支持 fp16' },
  { path: 'compress.enabled', label: 'L3 模型压缩', type: 'boolean',
    hint: '用生成模型把旧决策/旧经验合成上级条目。默认关；原文永不删、可审计可回滚；掉召回整批回滚' },
  { path: 'compress.provider', label: '压缩模型形态', type: 'string',
    hint: "openai = 任意 OpenAI 兼容端点（含本机 llama.cpp / LM Studio / vLLM）；ollama = 本机 ollama" },
  { path: 'compress.model', label: '压缩模型名', type: 'string',
    hint: '生成模型名（不是嵌入模型）。空 = 不可用，压缩会明说原因而不是静默跳过' },
  { path: 'compress.endpoint', label: '压缩模型端点', type: 'string',
    hint: '不含 /chat/completions 的根地址；openai 形态也可用环境变量 OPENAI_BASE_URL' },
  { path: 'compress.max_calls_per_round', label: '压缩单轮调用上限', type: 'number', min: 0, max: 500, step: 1,
    hint: '一轮最多调几次模型（硬闸，防一轮把额度打光）' },
  { path: 'compress.max_calls_per_hour', label: '压缩每小时调用上限', type: 'number', min: 0, max: 5000, step: 10,
    hint: '每小时上限；计数**落库**，重启不重置（配额不许靠内存变量）' },
  { path: 'compress.min_cluster', label: '压缩最小簇大小', type: 'number', min: 2, max: 20, step: 1,
    hint: '一个簇至少几条才值得调模型（默认 3；2 条用零模型的 L1 去重就够了）' },
  { path: 'compress.topic_overlap', label: '压缩主题重叠阈值', type: 'number', min: 0.1, max: 1, step: 0.01,
    hint: '比 L1 去重的 0.8 松（默认 0.30，实测定：同主题 0.29~0.43、不同主题 0.00）—— L3 要的正是「同主题但说法不同」' },
  { path: 'compress.min_age_days', label: '压缩最小条龄（天）', type: 'number', min: 0, max: 3650, step: 1,
    hint: '只压这个天数之前的条目（默认 7）；新条目还在长，压了会丢上下文' },
  { path: 'compress.min_saved_ratio', label: '压缩收益门槛（省多少才肯落地）', type: 'number', min: 0, max: 0.99, step: 0.01,
    hint: '合并结果必须比原簇省够这个比例（默认 0.5 = 省一半）。省不到就不落地 —— 没有这道闸门时，一堆「合了但没省」的白花调用会被记成成果' },
  { path: 'compress.min_utf8_bytes', label: '压缩最小簇体积（字节）', type: 'number', min: 0, max: 100000, step: 32,
    hint: '原簇总字节小于此值就不调模型（默认 256）——太小合了也没意义，白花一次调用' },
  { path: 'archive.enabled', label: '自动归档', type: 'boolean',
    hint: '打开后守护按窗口把老会话**正文**蒸发，结论/经验一条不删（原文仍在客户端那里，可重放）' },
  { path: 'archive.hot_days', label: '普通会话热窗（天）', type: 'number', min: 1, max: 365, step: 1,
    hint: '比这更新的正文绝不碰。ADR-003 拍板 30（原 60）；缩短后 agent1super 省 36.9%、music 省 69.3%' },
  { path: 'archive.workflow_days', label: '施工日志热窗（天）', type: 'number', min: 1, max: 90, step: 1,
    hint: 'origin=workflow 的会话用更短的窗（默认 7）——它们不进简报，正文留着没用' },
  { path: 'archive.check_every_min', label: '归档检查间隔（分钟）', type: 'number', min: 1, max: 1440, step: 1,
    hint: '守护多久检查一次归档' },
  { path: 'recompute.check_every_min', label: '重算检查间隔（分钟）', type: 'number', min: 1, max: 1440, step: 1,
    hint: '提取规则版本落后时的后台重算节奏（默认 360）' },
  // ── [1021] 时间衰减（模块 main/core/decay/，默认开）──
  { path: 'decay.enabled', label: '时间衰减', type: 'boolean',
    hint: '让「最近发生的事」在检索里排得更前。**只乘排序分数、不过滤** —— 老记录仍能搜到，只是排后面；floor 保底 0.25' },
  { path: 'decay.mode', label: '衰减曲线', type: 'string',
    hint: 'exponential = 指数衰减（默认，半衰期处正好减半）；power = 幂律衰减（更贴合人类遗忘，但尾巴更长）' },
  { path: 'decay.floor', label: '衰减保底系数', type: 'number', min: 0.05, max: 1, step: 0.05,
    hint: '再老的记录最多被打到几折。默认 0.25 = 2 个半衰期处的自然值；调到 1 = 等于关掉衰减' },
];

export const KNOB_BY_PATH = new Map(KNOB_SPECS.map((k) => [k.path, k]));

/** 按点分路径取值（不存在就 undefined） */
export function getPath(obj: unknown, dotted: string): unknown {
  let cur: unknown = obj;
  for (const seg of dotted.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** 按点分路径写值（就地改传入对象；只用于已知对象） */
export function setPath(obj: Record<string, unknown>, dotted: string, value: unknown): void {
  const segs = dotted.split('.');
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < segs.length - 1; i++) {
    const k = segs[i];
    if (cur[k] === null || typeof cur[k] !== 'object') cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  cur[segs[segs.length - 1]] = value;
}

/**
 * 校验一个旋钮值。返回 null = 通过，否则是**人话**的拒绝理由。
 * ⚠️ 这是唯一校验点：面板、CLI 都走它，别在前端再写一套（前端只渲染 min/max）。
 */
export function validateKnob(path: string, value: unknown): string | null {
  const spec = KNOB_BY_PATH.get(path);
  if (!spec) return '未知旋钮：' + path;
  switch (spec.type) {
    case 'boolean':
      return typeof value === 'boolean' ? null : '要 true/false，收到 ' + typeof value;
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '要是数字，收到 ' + JSON.stringify(value);
      if (spec.min !== undefined && value < spec.min) return '不能小于 ' + spec.min;
      if (spec.max !== undefined && value > spec.max) return '不能大于 ' + spec.max;
      return null;
    }
    case 'enum':
      return spec.options && spec.options.includes(String(value)) ? null
        : '只能是 ' + (spec.options ?? []).join(' / ') + '，收到 ' + JSON.stringify(value);
    case 'string':
      return typeof value === 'string' ? null : '要字符串，收到 ' + typeof value;
    case 'string-list': {
      if (!Array.isArray(value)) return '要字符串数组';
      const bad = value.filter((v) => typeof v !== 'string');
      if (bad.length) return '数组里有非字符串项';
      if (spec.options) {
        const unknown = value.filter((v) => !spec.options!.includes(v as string));
        if (unknown.length) return '不认识的取值：' + unknown.join(', ');
      }
      return null;
    }
    default:
      return '未知类型';
  }
}

export interface KnobState extends KnobSpec {
  value: unknown;
  /** 这个值是从哪一层来的：环境变量 > config.json > 默认值 */
  source: 'env' | 'config' | 'default';
  /** 环境变量层实际生效的原始文本（source=env 时） */
  envValue?: string;
}

/** 把"缺省值 + config.json 原始内容 + 环境"合成面板要展示的旋钮状态 */
export function knobStates(cfg: RelayConfig, raw: Record<string, unknown> | null, env: Record<string, string | undefined>): KnobState[] {
  const merged = cfg as unknown as Record<string, unknown>;
  return KNOB_SPECS.map((spec) => {
    const value = getPath(merged, spec.path);
    let source: KnobState['source'] = 'default';
    let envValue: string | undefined;
    if (spec.envVar && env[spec.envVar] !== undefined && env[spec.envVar] !== '') {
      source = 'env';
      envValue = env[spec.envVar];
    } else if (raw && getPath(raw, spec.path) !== undefined) {
      source = 'config';
    }
    return { ...spec, value, source, envValue };
  });
}
