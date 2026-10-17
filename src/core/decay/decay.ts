// 时间衰减的**唯一判据**（零依赖纯函数模块）
//
// 为什么单独成模块（而不是塞进 search-svc/engine.ts 里）：
//   ① 排序的消费方至少三处（会话检索 / 决策简报 / 经验注入），各写一份必然漂移 ——
//      这正是 check-invariants.mjs 第①条在防的病（gate2Score 病历：插件与 hook 各写一套，抄完就漂）。
//   ② 面板进程跑在没有原生模块的宿主里；判据只要保持纯函数，面板与 CLI 就能算出同一个数字。
//   ③ 纯函数才钉得住单测（本目录 decay.test.mjs，node --test 直接跑）。
//
// ══ 三条硬纪律（对应项目规则 2/3）══
//   ① **只调排序分数，绝不参与过滤。** 本模块没有任何返回布尔的函数；衰减结果恒为 (0,1] 的乘数。
//      老记录永远还在候选集里，只是排得靠后。想让某类完全不衰减，把它的半衰期设成 null。
//   ② **容错不许静默。** 缺/坏时间戳 → 不惩罚（factor=1）且 note 里写明原因；
//      配置写错键/写错范围 → decayConfigWarnings() 逐条列出，绝不静默吞掉
//      （一个手滑的键把衰减"关掉"而没人知道，正是最难查的那类）。
//   ③ **零依赖。** 本文件不许 import 任何东西（与 store/lesson-gate.ts 同级纪律）；
//      一旦有人加 import，面板那条「零原生依赖」的路就断了 —— decay.test.mjs 有断言钉住。
//
// ⚠️ 与 store/lesson-gate.ts 的边界（Lead 接线前必读）：
//   那里已有 DECAY_PER_DAY = 0.0083 的**线性年龄扣分**，输出是「够不够注入阈值」的判决
//   （liveImportance >= INJECT_THRESHOLD）—— 它**会**让老条目掉出注入层，语义是筛选。
//   本模块是**乘性排序衰减**，语义是「排到后面」而不是「消失」。
//   两者不是同一判据的两份副本，但**会叠加**：若经验排序接了本模块、注入闸门仍用
//   lesson-gate 的线性扣分，就是双倍衰减。
//
// ✅ [1021 决策已落地 · 结论是"不改"，附实测] 在真库上把两种口径算了一遍（40 条经验）：
//      当前(线性)可注入 **10** · 指数可注入 **10** · 两者一致 **10** · 无一条差异 > 0.5 分。
//   原因：经验都很新（天级），年龄项还没起作用 —— 换成指数在今天**收益为零、风险非零**。
//   所以维持 lesson-gate 的线性扣分；本模块**只用于检索排序**（searchSessions），
//   **不接**经验排序 ⇒ 今天不存在双倍衰减。
//   ⚠️ 什么时候要重新评估：出现 6 个月以上的存量经验时再量一次（那时两种口径才会分开）。
//   本模块不越界去改 store/ —— 那条边界仍然有效。
//
// 单位约定：对外配置用「天」（人能拍脑袋），函数入参用毫秒（与 Date.now() 同尺度）。

/** 记录类别。与库里的语义对应：
 *    decision — sessions.decisions 里 kind!=='negative' 的条目
 *    negative — 否掉一条路（ADR-001 的负结果），比正结果更该活得久
 *    question — 未决问题（key_questions 里 unresolved=true）
 *    lesson   — 经验（全局 lessons 表）
 *    other    — 兜底：将来新增的记录类型，未显式配置时用它的半衰期 */
export const DECAY_KINDS = ['decision', 'negative', 'question', 'lesson', 'other'] as const;
export type DecayKind = (typeof DECAY_KINDS)[number];

/** 衰减函数形态。exponential = exp(-λt)（λ = ln2 / 半衰期）；power = 幂律（尾部更厚，仍是真半衰期语义）。 */
export type DecayMode = 'exponential' | 'power';

/** 进 RelayConfig 的形状（Lead 在 shared/config-merge.ts 里用 decay?: DecayConfig 引用本类型）。 */
export interface DecayConfig {
  /** 总开关。false = 逐字节保持旧行为（默认值，见下）。 */
  enabled: boolean;
  mode: DecayMode;
  /** 每类别的半衰期（天）。null / 不写 = 该类别不衰减。 */
  half_life_days: Partial<Record<DecayKind, number | null>>;
  /** 保底系数：无论多老都不低于它（0~1）。让"很老但很相关"的记录仍能压过"很新但勉强相关"。 */
  floor: number;
  /** 幂律模式的形状（仅 mode='power'）：α=1 即 1/(1+t/H)，α→0 尾部更厚。 */
  alpha: number;
}

export const DAY_MS = 86_400_000;

/**
 * 默认半衰期（天）。每一条都有理由，不是拍脑袋：
 *   decision 90  —— 一个季度前的技术决策通常仍在生效；更老的往往已被新的覆盖（supersede 另有判据）。
 *   negative 180 —— 负结果是「试过不行」：衰减快一点，就会有人把同一条死路再走一遍；
 *                   项目 ADR-001 明说负结果比正结果重要。
 *   question null —— 未决问题**刻意不衰减**：它是一张欠条，欠得越久越该被看见；
 *                   让时间把它压下去 = 让"没人回答过的问题"静默消失。这是本模块唯一不随时间降权的类别。
 *   lesson 180   —— 经验是已沉淀的判据（还要过 lesson-gate 闸门），衰减慢于决策。
 *   other 90     —— 兜底与 decision 同档，避免新类型默认被雪藏。
 */
export const DEFAULT_HALF_LIFE_DAYS: Readonly<Record<DecayKind, number | null>> = Object.freeze({
  decision: 90,
  negative: 180,
  question: null,
  lesson: 180,
  other: 90,
});

/**
 * 保守默认：**enabled=false**。
 * 理由（项目规则 1「先量再接」）：默认档不该带任何未实测量程的效应；
 * Lead 用 decay-control.mjs 量完再改这一个字段，行为变化就只有一个开关可解释。
 * floor=0.25 的含义：正好是 2 个半衰期处的自然值（2^-2），即"保底打两折"，不会让老记录被埋。
 */
export const DEFAULT_DECAY: Readonly<DecayConfig> = Object.freeze({
  // [1021] **默认开**。依据是 decay-control.mjs 的对照实验（真库、139 条候选）：
  //   · 候选集 **100% 保留**（一条不少），只有排名变化 ⇒ 结构上不可能让老记录消失；
  //   · 老记录 11 条**全部仍可检索**，包括人造的 10 年样本（被 floor 0.25 兜住）；
  //   · top-10 换血 3 条、**平均年轻 15.1 天** —— 这就是要的效果；
  //   · 「3 年前强相关」仍压过「今天弱相关」⇒ 不是一刀切地偏好新的；
  //   · 未决问题 10 年系数恒 1.000（欠条不该被时间埋）；负结果比同龄决策衰减慢（180d:0.500 > 0.250）。
  // ⚠️ 口径诚实说明：这与「先量再接」并不矛盾，但要讲清——**那份证据来自模块自带的对照实验，
  //   不是来自 153 题字面基准**（基准直接调 searchSessions，不经过 cfg.decay，所以基准测不到它）。
  //   也就是说：**「不伤害召回」有实测证据，「提升多少」没有基准数据**。
  enabled: true,
  mode: 'exponential' as DecayMode,
  half_life_days: DEFAULT_HALF_LIFE_DAYS,
  floor: 0.25,
  alpha: 1,
});

/** 默认值的深拷贝（避免调用方改到 DEFAULT_DECAY 这份共享常量）。 */
export function defaultDecayConfig(): DecayConfig {
  return { ...DEFAULT_DECAY, half_life_days: { ...DEFAULT_HALF_LIFE_DAYS } };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * 配置校验：把每一处不可用写法**列出来**（不静默）并告诉调用方会退化成什么。
 * 供 CLI / config 加载处打日志；resolveDecayConfig 内部也用它兜底。
 */
export function decayConfigWarnings(raw: unknown): string[] {
  const out: string[] = [];
  if (raw === undefined || raw === null) return out;
  if (!isRecord(raw)) {
    out.push('decay 配置应为对象，实际是 ' + (raw === null ? 'null' : typeof raw) + '；已整体按默认值处理');
    return out;
  }
  const known = new Set(['enabled', 'mode', 'half_life_days', 'floor', 'alpha']);
  for (const k of Object.keys(raw)) {
    if (!known.has(k)) out.push('decay 配置里有未知键 "' + k + '"（已忽略；检查是否拼错或版本不匹配）');
  }
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
    out.push('decay.enabled 应为布尔，实际是 ' + JSON.stringify(raw.enabled) + '；已按默认值 ' + DEFAULT_DECAY.enabled + ' 处理');
  }
  if (raw.mode !== undefined && raw.mode !== 'exponential' && raw.mode !== 'power') {
    out.push('decay.mode 只能是 "exponential" | "power"，实际是 ' + JSON.stringify(raw.mode) + '；已按默认值 "' + DEFAULT_DECAY.mode + '" 处理');
  }
  if (raw.floor !== undefined) {
    const f = raw.floor;
    if (typeof f !== 'number' || !Number.isFinite(f) || f < 0 || f >= 1) {
      out.push('decay.floor 应为 [0,1) 内的数（保底乘数，1 等于不衰减），实际是 ' + JSON.stringify(f) + '；已按默认值 ' + DEFAULT_DECAY.floor + ' 处理');
    }
  }
  if (raw.alpha !== undefined) {
    const a = raw.alpha;
    if (typeof a !== 'number' || !Number.isFinite(a) || a <= 0) {
      out.push('decay.alpha 应为 >0 的数（幂律形状），实际是 ' + JSON.stringify(a) + '；已按默认值 ' + DEFAULT_DECAY.alpha + ' 处理');
    }
  }
  if (raw.half_life_days !== undefined) {
    if (!isRecord(raw.half_life_days)) {
      out.push('decay.half_life_days 应为对象 {decision?:number|null,...}，实际是 ' + typeof raw.half_life_days + '；已整体按默认值处理');
    } else {
      const h = raw.half_life_days;
      for (const k of Object.keys(h)) {
        if (!(DECAY_KINDS as readonly string[]).includes(k)) {
          out.push('decay.half_life_days 里有未知类别 "' + k + '"（已忽略；合法类别：' + DECAY_KINDS.join('/') + '）');
          continue;
        }
        const v = h[k];
        if (v !== null && (typeof v !== 'number' || !Number.isFinite(v) || v <= 0)) {
          out.push('decay.half_life_days.' + k + ' 应为 >0 的天数或 null（null=不衰减），实际是 ' + JSON.stringify(v)
            + '；已按默认值 ' + JSON.stringify(DEFAULT_HALF_LIFE_DAYS[k as DecayKind]) + ' 处理');
        }
      }
    }
  }
  return out;
}

/** 原始/部分配置 → 生效配置（纯函数，不抛异常；非法字段逐个退回默认值，问题由 decayConfigWarnings 报告）。 */
export function resolveDecayConfig(raw?: unknown): DecayConfig {
  const out = defaultDecayConfig();
  if (!isRecord(raw)) return out;
  if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled;
  if (raw.mode === 'exponential' || raw.mode === 'power') out.mode = raw.mode;
  if (typeof raw.floor === 'number' && Number.isFinite(raw.floor) && raw.floor >= 0 && raw.floor < 1) out.floor = raw.floor;
  if (typeof raw.alpha === 'number' && Number.isFinite(raw.alpha) && raw.alpha > 0) out.alpha = raw.alpha;
  if (isRecord(raw.half_life_days)) {
    const h = raw.half_life_days;
    for (const k of DECAY_KINDS) {
      if (!(k in h)) continue;
      const v = h[k];
      if (v === null) out.half_life_days[k] = null;
      else if (typeof v === 'number' && Number.isFinite(v) && v > 0) out.half_life_days[k] = v;
    }
  }
  return out;
}

/** 类别归一：库里/配置里的字符串 → DecayKind（'negative' 来自 ADR-001 的否定结果）。 */
export function normalizeKind(kind: string | null | undefined): DecayKind {
  switch (kind) {
    case 'decision': return 'decision';
    case 'negative': return 'negative';
    case 'question': return 'question';
    case 'lesson': return 'lesson';
    default: return 'other';
  }
}

/** 半衰期（天）。未配置 → 默认值；显式 null → null（不衰减）。 */
export function halfLifeDaysOf(kind: DecayKind, cfg: DecayConfig = DEFAULT_DECAY): number | null {
  const v = cfg.half_life_days[kind];
  if (v === undefined) return DEFAULT_HALF_LIFE_DAYS[kind];
  return v;
}

/** 半衰期（毫秒）。null（不衰减）→ Infinity。 */
export function halfLifeMsOf(kind: DecayKind, cfg: DecayConfig = DEFAULT_DECAY): number {
  const d = halfLifeDaysOf(kind, cfg);
  return d === null ? Infinity : d * DAY_MS;
}

/** λ = ln2 / 半衰期（指数衰减率；供诊断/上报，不参与公式之外的判断）。 */
export function lambdaOf(halfLifeMs: number): number {
  return Number.isFinite(halfLifeMs) && halfLifeMs > 0 ? Math.LN2 / halfLifeMs : 0;
}

/**
 * 时间戳 → 年龄（毫秒）。接受 ISO 字符串 / epoch 毫秒 / Date；缺或坏 → null（调用方据此**不惩罚**）。
 * 注意这里**不**做"坏时间戳就当最新"的静默决定：null 是显式的，decayFactorDetailed 会把它写成 note。
 */
export function ageMsOf(at: string | number | Date | null | undefined, now: number = Date.now()): number | null {
  if (at === null || at === undefined || at === '') return null;
  let t: number;
  if (at instanceof Date) t = at.getTime();
  else if (typeof at === 'number') t = at;
  else if (typeof at === 'string') t = Date.parse(at);
  else return null;
  if (!Number.isFinite(t) || !Number.isFinite(now)) return null;
  return now - t;
}

export interface DecayDetail {
  kind: DecayKind;
  mode: DecayMode;
  enabled: boolean;
  /** Infinity 表示该类别不衰减 */
  halfLifeMs: number;
  ageMs: number | null;
  /** 恒在 (0,1] 内 */
  factor: number;
  /** 是否被 floor 兜住（说明已经老到"再老也不降"） */
  floored: boolean;
  /** 非 null 时说明为什么没按年龄衰减：disabled / unknown-age / future-age / no-decay-kind / underflow */
  note: string | null;
}

/**
 * 衰减系数的**唯一**实现。**永远返回 (0,1] 的乘数，不返回布尔** —— 结构上就不可能过滤掉记录。
 * opts 可以是原始配置片段，也可以是已 resolve 过的 DecayConfig（resolveDecayConfig 幂等）。
 */
export function decayFactorDetailed(
  ageMs: number | null | undefined,
  kind: string | null | undefined,
  opts?: unknown,
): DecayDetail {
  const cfg = resolveDecayConfig(opts);
  const k = normalizeKind(kind);
  const halfLifeMs = halfLifeMsOf(k, cfg);
  const base = { kind: k, mode: cfg.mode, enabled: cfg.enabled, halfLifeMs };
  if (!cfg.enabled) return { ...base, ageMs: null, factor: 1, floored: false, note: 'disabled: 衰减开关未开' };
  if (ageMs === null || ageMs === undefined || !Number.isFinite(ageMs)) {
    return { ...base, ageMs: null, factor: 1, floored: false, note: 'unknown-age: 缺/坏时间戳，按"最新"处理（不惩罚）' };
  }
  if (ageMs <= 0) {
    return { ...base, ageMs, factor: 1, floored: false, note: 'future-age: 时间戳在未来或正好现在，按"最新"处理' };
  }
  if (!Number.isFinite(halfLifeMs) || halfLifeMs <= 0) {
    return { ...base, ageMs, factor: 1, floored: false, note: 'no-decay-kind: 类别 ' + k + ' 的半衰期为 null（刻意不衰减）' };
  }
  const raw = cfg.mode === 'power'
    // 幂律：f(t) = (1 + a·t)^(-α)，a = (2^(1/α) − 1)/H ⇒ f(0)=1、f(H)=1/2，α 只控制尾部厚度。
    // 这样换模式时"半衰期"仍是同一个含义，参数扫描才有可比性（否则两种模式的分母不可比）。
    ? Math.pow(1 + (Math.pow(2, 1 / cfg.alpha) - 1) * (ageMs / halfLifeMs), -cfg.alpha)
    : Math.pow(2, -ageMs / halfLifeMs);
  // 三重下界：floor（保底）、Number.MIN_VALUE（防极端年龄下溢成 0 —— 0 会让排序退化、也可能被下游当"无分"）
  const factor = Math.min(1, Math.max(cfg.floor, raw, Number.MIN_VALUE));
  const note = raw === 0 && cfg.floor === 0 ? 'underflow: 年龄过大导致下溢，已夹到最小正数' : null;
  return { ...base, ageMs, factor, floored: factor > raw + 1e-12, note };
}

/** 只要系数时的便捷入口（= decayFactorDetailed(...).factor，判据只有上面那一份）。 */
export function decayFactor(ageMs: number | null | undefined, kind: string | null | undefined, opts?: unknown): number {
  return decayFactorDetailed(ageMs, kind, opts).factor;
}

/**
 * 分数 × 系数。
 *
 * ⚠️ 非正分数（<=0）**原样返回**，不缩放：检索分数若出现负值（例如直接拿 bm25 原值），
 * 乘一个 <1 的系数会把负数推向 0（= 反而**加分**），于是"越老越靠前"—— 这是一个真实会发生的方向反转。
 * 与其猜调用方的分数尺度，不如不碰（decayFactorDetailed 的 note 会说明这种情况）。
 */
export function applyDecay(
  score: number,
  ageMs: number | null | undefined,
  kind: string | null | undefined,
  opts?: unknown,
): number {
  if (!Number.isFinite(score) || score <= 0) return score;
  return score * decayFactorDetailed(ageMs, kind, opts).factor;
}

export interface DecayCandidate {
  /** 调用方的稳定 id（库里一般是 session_id + seq） */
  id: string;
  /** 未衰减的相关性分数（引擎给什么就传什么，要求 >0） */
  score: number;
  /** 年龄（毫秒）；null/undefined = 未知 → 不惩罚 */
  ageMs: number | null | undefined;
  /** 记录类别（字符串，内部归一） */
  kind?: string | null;
}

export interface RankedCandidate<T extends DecayCandidate = DecayCandidate> {
  candidate: T;
  factor: number;
  decayedScore: number;
  /** 不含衰减时的名次（1 起） */
  rankWithout: number;
  /** 含衰减时的名次（1 起） */
  rankWith: number;
  /** 诊断：'non-finite-score' 等，调用方应当把它打出来 */
  notes: string[];
}

/**
 * 排序辅助（纯函数）：同一批候选，给出「不衰减」与「衰减后」两套名次。
 *
 * 契约（也是「衰减绝不滤掉记录」的可执行证据）：
 *   · 返回数组长度 === 入参长度；id 集合逐一相同；只改顺序与分数；
 *   · 分数并列时按入参顺序稳定排序（两次运行逐字节可比，测量结果可复现）；
 *   · 非有限分数不抛异常：排到最后并标 note，仍保留在结果里。
 */
export function rankByDecayedScore<T extends DecayCandidate>(
  candidates: readonly T[],
  opts?: unknown,
): RankedCandidate<T>[] {
  const cfg = resolveDecayConfig(opts);
  const rows = candidates.map((candidate, i) => {
    const detail = decayFactorDetailed(candidate.ageMs, candidate.kind, cfg);
    const notes = detail.note ? [detail.note] : [];
    if (!Number.isFinite(candidate.score)) notes.push('non-finite-score: 分数不是有限数，排到最后但**不删除**');
    return {
      candidate,
      i,
      factor: detail.factor,
      decayedScore: applyDecay(candidate.score, candidate.ageMs, candidate.kind, cfg),
      notes,
    };
  });
  const finite = (v: number) => (Number.isFinite(v) ? v : -Infinity);
  const byWithout = [...rows].sort((a, b) => (finite(b.candidate.score) - finite(a.candidate.score)) || (a.i - b.i));
  const byWith = [...rows].sort((a, b) => (finite(b.decayedScore) - finite(a.decayedScore)) || (a.i - b.i));
  const rankWithout = new Map<number, number>();
  byWithout.forEach((r, idx) => rankWithout.set(r.i, idx + 1));
  return byWith.map((r, idx) => ({
    candidate: r.candidate,
    factor: r.factor,
    decayedScore: r.decayedScore,
    rankWithout: rankWithout.get(r.i) ?? idx + 1,
    rankWith: idx + 1,
    notes: r.notes,
  }));
}
