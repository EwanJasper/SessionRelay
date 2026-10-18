// ─────────── 压缩 L3：模型压缩（用**生成模型**把旧条目合成上级条目）───────────
//
// 依据 docs/1018-夜-模型压缩与语义档-建设方案.md §2。六条边界**逐条钉死**，改动前先回读该文档：
//
//   ① 原文永不删        —— 只写「折叠视图 + 审计」，原始条目保留且可回跳（ADR-003 D4）
//   ② 只在生命周期阶段跑 —— 绝不许进 prompt 组装热路径（压缩是离线批处理）
//   ③ 必须可审计 + 可回滚 —— 每次合并写 compress_log/compress_detail，能一键回到合并前
//   ④ 默认关 + 有配额    —— 默认档零模型是项目底线；配额**落库**（重启不重置）
//   ⑤ 抽不出证据就丢弃   —— 摘要必须能回指原文 id，回指不了的条目**不要**（宁缺勿滥）
//   ⑥ 掉召回整批回滚     —— 合并前后同一快照跑基准，hit@1 掉了就整批回滚（门禁在调用方）
//
// 为什么单独一个模块而不是塞进 compact/：L1（dedup）是**零损失确定性**的，本层是**有损 + 调模型**的。
// 两者的失败模式完全不同（L1 不可能掉召回，L3 可能），放一个文件里迟早有人把 L3 的默认值当 L1 的用。
//
// 与语义档的关系：**两套模型、两套配置**。semantic 是嵌入模型（管"找得到"），compress 是生成模型（管"存得省"）。
// 共用一套配置会让「换嵌入模型」意外改掉压缩行为（用户点名要求分开，见建设方案 §2.3）。

import { isNearDuplicate } from './dedup.js';
// 「实词」提取只有一份（dedup 的判据与冲突消解共用它）——这里复用，不另写一套关键词规则。
// 注意：model.ts 经 dedup 早已间接依赖 store/global（better-sqlite3），本 import 不新增依赖。
import { subjectTokens } from '../../store/global.js';

// ── 配置（判据的唯一来源是 config.compress；这里只放默认值）──

export interface CompressConfig {
  enabled?: boolean;
  /** 生成模型服务形态：openai = 任意 OpenAI 兼容端点（含本机 llama.cpp / vLLM / LM Studio）；ollama = 本机 ollama */
  provider?: 'openai' | 'ollama';
  model?: string;
  /** 端点根（不含 /chat/completions）。openai 默认读 OPENAI_BASE_URL；ollama 默认 127.0.0.1:11434/v1 */
  endpoint?: string;
  api_key?: string;
  timeout_ms?: number;
  /** 单轮最多调几次模型（硬闸，防一轮把额度打光） */
  max_calls_per_round?: number;
  /** 每小时最多调几次（**落库计数**，重启不重置） */
  max_calls_per_hour?: number;
  /** 一个簇至少几条才值得调模型（默认 3；2 条用 L1 就够了） */
  min_cluster?: number;
  /** 主题重叠阈值（默认 0.30）。**实测定的**，不是拍的：
   *  在真实语料上量「同主题不同说法」得 0.29/0.33/0.43，「不同主题」三组全是 0.00 ——
   *  分离度很干净，取 0.30 能覆盖同主题那三组里的两组、且不同主题零误合。
   *  比 L1 去重的 0.8 松得多，因为 L3 要的正是「同主题但说法不同」（L1 已经把逐字重复吃掉了）。 */
  topic_overlap?: number;
  /** 只压这个天数之前的条目（默认 7 天；新条目还在长，压了会丢上下文） */
  min_age_days?: number;
  /** 收益闸门：合并结果必须比原簇省够这个比例（0~1，默认 0.5），否则不落地。
   *  [1020 借鉴 memcore] 他们实测做法：卡片必须比原文省 >50% 才允许替换。
   *  我们此前**缺这一层** ⇒ 模型合出来的东西无论省多少都算「合并成功」，
   *  一堆「合了但没省」的白花调用被记成成果。这不是分簇问题，是**没有收益判据**。 */
  min_saved_ratio?: number;
  /** 收益闸门：原簇总字节小于此值就不调模型（默认 256）——太小合了也没意义 */
  min_utf8_bytes?: number;
  /** 项目库旧 decisions */
  projects?: boolean;
  /** 全局库旧 lessons */
  lessons?: boolean;
}

/** 六条边界里"不许被配置绕过"的那条：原文永不删。字段留着是为了审计可读，**值恒为 true**。 */
export const KEEP_ORIGINAL_ALWAYS = true;

export function compressPolicyOf(cfg: { compress?: CompressConfig } | null | undefined) {
  const c = cfg?.compress ?? {};
  return {
    enabled: c.enabled === true,
    provider: c.provider ?? 'openai',
    model: c.model ?? '',
    endpoint: c.endpoint ?? (c.provider === 'ollama'
      ? 'http://127.0.0.1:11434/v1'
      : (process.env.OPENAI_BASE_URL ?? '')),
    apiKey: c.api_key ?? process.env.OPENAI_API_KEY ?? '',
    timeoutMs: Number(c.timeout_ms ?? 60_000),
    maxCallsPerRound: Number(c.max_calls_per_round ?? 20),
    maxCallsPerHour: Number(c.max_calls_per_hour ?? 200),
    minCluster: Math.max(2, Number(c.min_cluster ?? 3)),
    topicOverlap: Number(c.topic_overlap ?? 0.30),
    minAgeDays: Math.max(0, Number(c.min_age_days ?? 7)),
    // ── 收益闸门（1020 从 memcore 借鉴）：折叠前先量「省不省得够」──
    //   他们实测的做法：卡片必须比原文省 >50% 才允许替换，太小（<256B）根本不尝试。
    //   我们此前缺这一层 ⇒ 模型合出来的东西无论省多少都算「合并成功」，
    //   于是一堆「合了但没省」的白花调用被记成成果。这不是分簇问题，是**没有收益判据**。
    minSavedRatio: Math.min(0.99, Math.max(0, Number(c.min_saved_ratio ?? 0.5))),
    minUtf8Bytes: Math.max(0, Number(c.min_utf8_bytes ?? 256)),
    projects: c.projects !== false,
    lessons: c.lessons !== false,
  };
}

export type CompressPolicy = ReturnType<typeof compressPolicyOf>;

/** 为什么这一轮不能跑（**返回原因**，不是静默 return —— 铁律：容错不许静默） */
export function compressBlockedBy(p: CompressPolicy): string | null {
  if (!p.enabled) return '未启用（config.compress.enabled 默认 false —— 默认档零模型是项目底线）';
  if (!p.model) return '没配模型（config.compress.model）';
  if (!p.endpoint) return '没配端点（config.compress.endpoint；openai 形态也可用环境变量 OPENAI_BASE_URL）';
  return null;
}

// ── 模型提供方：只认 OpenAI 兼容的 /chat/completions ──
//
// 为什么只做这一种：本机 llama.cpp server、ollama、vLLM、LM Studio、以及各家云 API **都**提供它。
// 每多一种私有协议就多一份"换后端要改代码"的债（语义档那轮已经吃过一次：引擎换了要重做验收）。

export interface CompressProvider {
  name: string;
  complete(prompt: string, opts?: { maxTokens?: number; temperature?: number }): Promise<string>;
}

export function openAiCompatProvider(p: CompressPolicy): CompressProvider {
  const base = p.endpoint.replace(/\/+$/, '');
  return {
    name: 'openai-compat(' + base + '/' + p.model + ')',
    async complete(prompt, opts) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), p.timeoutMs);
      try {
        const res = await fetch(base + '/chat/completions', {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(p.apiKey ? { authorization: 'Bearer ' + p.apiKey } : {}) },
          body: JSON.stringify({
            model: p.model,
            messages: [{ role: 'user', content: prompt }],
            temperature: opts?.temperature ?? 0,
            max_tokens: opts?.maxTokens ?? 1200,
            stream: false,
          }),
          signal: ctl.signal,
        });
        if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + (await res.text()).slice(0, 200));
        const j = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
        const txt = j.choices?.[0]?.message?.content;
        if (typeof txt !== 'string' || !txt.trim()) throw new Error('模型返回空内容');
        return txt;
      } finally { clearTimeout(timer); }
    },
  };
}

// ── 分簇：同主题但**不是**近重复（近重复是 L1 的活，L3 要的是"说法不同、主题相同"）──

export interface ClusterItem { id: string; text: string; at?: string | null }

export interface Cluster { key: string; items: ClusterItem[]; shared: string[] }

/**
 * 按主题重叠分簇。用 isNearDuplicate 的**同一个判据**但把阈值放低 —— 判据只有一份（铁律），
 * 只是参数不同；另写一套"主题相似度"必然与 L1 漂移。
 */
export function clusterByTopic(items: ClusterItem[], overlap: number, minCluster: number): Cluster[] {
  const sorted = items.slice().sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  const clusters: Cluster[] = [];
  for (const it of sorted) {
    if (!String(it.text || '').trim()) continue;
    let placed = false;
    for (const c of clusters) {
      const r = isNearDuplicate(c.items[0].text, it.text, overlap);
      if (r.dup) { c.items.push(it); c.shared = r.shared.length ? r.shared : c.shared; placed = true; break; }
    }
    if (!placed) clusters.push({ key: it.id, items: [it], shared: [] });
  }
  return clusters.filter((c) => c.items.length >= minCluster);
}

// ── 提示词：把"抽不出证据就丢弃"写进**模型侧的硬约束**（不能只靠后置校验）──

export function buildPrompt(items: ClusterItem[]): string {
  const lines = items.map((x, i) => '[' + (i + 1) + '] (id=' + x.id + (x.at ? ' at=' + String(x.at).slice(0, 10) : '') + ') ' + String(x.text).replace(/\s+/g, ' ').trim());
  return [
    '你是本地记忆库的压缩器。下面是一组**同主题**的历史条目，请把它们合并成 1~2 条上级条目。',
    '',
    '硬约束（违反任何一条，这条输出就算废）：',
    '1. 只许使用下面原文里**出现过**的信息。不许推断、不许补充、不许润色出新事实。',
    '2. 每条合并结果必须给出它依据的原文编号列表 evidence（例：["3","5"]）。',
    '3. **拿不出证据就不要输出那一条** —— 宁缺勿滥。',
    '4. 原文里的时间与来源（谁在什么时候拍的板）是信息，不能丢。',
    '5. 若这组条目其实不属于同一主题、或合并会丢掉关键差异，就输出 {"items":[]}。',
    '',
    '只输出 JSON，不要任何解释文字：',
    '{"items":[{"text":"合并后的条目","evidence":["1","3"]}]}',
    '',
    '原文：',
    ...lines,
  ].join('\n');
}

export interface MergedItem { text: string; evidence: string[] }

/** 解析模型输出：只认 JSON；带 markdown 围栏时剥掉围栏（小模型很爱加）。解析不出就返回空数组。 */
export function parseMerged(raw: string): MergedItem[] {
  const s = String(raw || '').trim();
  const fenced = /\`\`\`(?:json)?\s*([\s\S]*?)\`\`\`/i.exec(s);
  const body = (fenced ? fenced[1] : s).trim();
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return [];
  let j: unknown;
  try { j = JSON.parse(body.slice(start, end + 1)); } catch { return []; }
  const arr = (j as { items?: unknown }).items;
  if (!Array.isArray(arr)) return [];
  const out: MergedItem[] = [];
  for (const x of arr) {
    const t = (x as { text?: unknown }).text;
    const ev = (x as { evidence?: unknown }).evidence;
    if (typeof t !== 'string' || !t.trim()) continue;
    out.push({ text: t.trim(), evidence: Array.isArray(ev) ? ev.map(String) : [] });
  }
  return out;
}

export interface EvidenceCheck {
  text: string;
  evidenceIds: string[];
  /**
   * 本层**只**校验了「编号/ID 能否映射到原文 id」——**没有**校验结论是否受原文支持
   * （那需要语义判定或模型，而本项目的卖点就是零模型）。所以这个字段的类型/取值是**闭死的**：
   * 就只能是 'ids-only'，不给调用方一个能误解成"已核实"的值。
   *
   * [1021 红队 #额外] 病历：把一条假结论配上两个有效 ID，本层照样判定通过。
   * 这不是"校验有 bug"，是**这一层根本没有这个能力**却让人以为有。
   * 处置：把边界写进返回值（本字段 + overlap），调用方/审计能看见"验到哪一步"。
   * ⚠️ 产品文案里"不产生新事实 / 不让模型编"之类承诺**超出了本实现的能力**，
   * 需要改 README/docs（不在本文件作用域内）——本文件的职责是不再假装验过内容支持。
   */
  support: 'ids-only';
  /** 弱信号：合并文本与本条所引原文的**实词重合率**（0~1）。
   *  低 ≠ 结论错，只表示"没测到支持"；用于审计排序/抽样复核。
   *  要把它当硬判据，请显式传 opts.minOverlap（默认不开，避免误杀正常改写）。 */
  overlap: number;
}

/**
 * 证据校验 —— 边界⑤的**唯一执行点**。
 * 模型给的 evidence 是编号（"1"/"3"）或 id，两种都认；**认不出的编号直接丢弃该条**。
 * 返回 null 表示"这条没有可用证据，丢弃"。
 *
 * **能力边界（不许含混）**：这里只验「出处可映射」，不验「内容支持」。
 * 返回值的 support 恒为 'ids-only'，overlap 是弱信号（可选用 minOverlap 当闸）。
 */
export function validateEvidence(
  m: MergedItem, items: ClusterItem[], opts: { minOverlap?: number } = {},
): EvidenceCheck | null {
  const byIndex = new Map<string, string>();
  items.forEach((x, i) => byIndex.set(String(i + 1), x.id));
  const ids: string[] = [];
  for (const e of m.evidence) {
    const k = String(e).trim().replace(/^\[|\]$/g, '');
    const id = byIndex.get(k) ?? (items.some((x) => x.id === k) ? k : null);
    if (id && !ids.includes(id)) ids.push(id);
  }
  if (ids.length === 0) return null;          // 抽不出证据就丢弃
  if (ids.length < 2) return null;            // 只回指一条 = 没合并，没意义
  // 弱信号：合并文本的实词有多少能在所引原文里找到（**只**说明"词面上有交集"）
  const mt = subjectTokens(m.text);
  const src = new Set<string>();
  for (const id of ids) {
    const it = items.find((x) => x.id === id);
    if (it) for (const t of subjectTokens(String(it.text ?? ''))) src.add(t);
  }
  const shared = [...mt].filter((t) => src.has(t)).length;
  const overlap = mt.size === 0 ? 0 : shared / mt.size;
  // 可选弱闸：默认关（模型改写常换说法，硬卡会误杀）。开了就与"抽不出证据"同样丢弃。
  if (typeof opts.minOverlap === 'number' && overlap < opts.minOverlap) return null;
  return { text: m.text, evidenceIds: ids, support: 'ids-only', overlap: Number(overlap.toFixed(3)) };
}

// ── 合并内容（纯函数，便于单测；不做任何 IO）──

export interface MergeOutcome {
  merged: EvidenceCheck[];
  discarded: number;
  /** 被可选 minOverlap 弱闸拦掉的条数（0 = 没开弱闸，或全都过了） */
  weakRejected: number;
  /** 本次合并的能力边界，**随结果一起回给调用方**：
   *  只验了"证据能映射回原文 id"，没验"结论受原文支持"。
   *  调用方要打印/落盘审计时请把它带上，别让读者以为事实已被核实。 */
  supportBoundary: 'ids-only';
}

export function mergeCluster(items: ClusterItem[], raw: string, opts: { minOverlap?: number } = {}): MergeOutcome {
  const parsed = parseMerged(raw);
  const merged: EvidenceCheck[] = [];
  let discarded = 0;
  let weakRejected = 0;
  for (const m of parsed) {
    const mapped = validateEvidence(m, items);       // 只映射，不开弱闸
    if (!mapped) { discarded++; continue; }          // 抽不出/不足两条证据
    if (typeof opts.minOverlap === 'number' && mapped.overlap < opts.minOverlap) { weakRejected++; continue; }
    merged.push(mapped);
  }
  return { merged, discarded, weakRejected, supportBoundary: 'ids-only' };
}
