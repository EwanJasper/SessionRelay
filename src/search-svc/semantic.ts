// 语义检索（design-semantic v4）：FTS 之外的补充召回路——换词查询命中。
// 分层约定：engine.searchSessions 保持纯同步，语义命中由调用方预计算后经 opts.semanticHits 注入。
// 未 enable 时一切短路——与纯 FTS 行为逐字节等价（用户硬约束）。
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { DB } from '../store/db.js';
import type { RelayConfig } from '../shared/config.js';
import { loadSessionVectors, upsertSessionVector, vectorSignature, pendingSemanticTargets } from '../store/db.js';
import type { ExtraWhere } from './engine.js';
import { semanticCacheDir, readSemanticStatus, recordSemantic } from './semantic-status.js';

export const DEFAULT_MODEL = 'Xenova/bge-small-zh-v1.5';
export const DEFAULT_THRESHOLD = 0.4;
/** 语义候选上限的**默认值**（可被 config.semantic.top_k 覆盖，见 semanticTopKOf）。
 *  R4 原设计是写死当「语义错配限量防线」；[1017 夜] 改成可配 —— 参数扫描要求它能被单变量地改。 */
export const SEMANTIC_TOP_K = 5;
const MAX_INPUT_CHARS = 1200;    // R6：bge max_seq 512 token ≈ 中文 500 字，双侧截断

/** transformers.js 认得的量化档（写错就是静默按别的档加载，所以只认这张表） */
export const KNOWN_DTYPES = ['fp32', 'fp16', 'q8', 'int8', 'uint8', 'q4', 'q4f16', 'bnb4'] as const;
export type Dtype = typeof KNOWN_DTYPES[number];

export interface Embedder {
  model: string;
  dim: number;
  /** 检索侧查询前缀（文档侧不加）。非对称嵌入模型靠它把查询与文档放进同一子空间 */
  queryPrefix?: string;
  embed(text: string): Promise<Float32Array>; // 实现负责 L2 归一化（R2）
}

// ── FakeEmbedder：CI/测试专用（SRELAY_SEMANTIC_FAKE=1）——确定性，零下载零模型 ──
// 特征 = 字符 3-gram bag → hash 到固定维。同词文本余弦高；测的是管线不是语义。
export class FakeEmbedder implements Embedder {
  readonly model = 'fake-ci';
  readonly dim = 64;
  async embed(text: string): Promise<Float32Array> {
    const t = text.slice(0, MAX_INPUT_CHARS);
    const v = new Float32Array(this.dim);
    for (let i = 0; i + 3 <= t.length; i++) {
      const h = (t.charCodeAt(i) * 31 + t.charCodeAt(i + 1) * 131 + t.charCodeAt(i + 2) * 977) % this.dim;
      v[h] += 1;
    }
    return l2(v);
  }
}

export function l2(v: Float32Array): Float32Array {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  const n = Math.sqrt(s) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

// ── transformers.js 适配（不进 package.json——用户缓存目录动态解析，enable 时安装） ──

// [1017 夜] 家目录定义搬到 semantic-status.ts（那个模块零依赖，面板宿主半要读它）。
// 这里**原样再导出**，老调用点（cli/semantic.ts 等）一行不用改。
export { semanticCacheDir } from './semantic-status.js';

/** 解析用户缓存目录里的 transformers.js 入口；不可用返回 null（不抛——降级语义） */
export function resolveTransformersEntry(): string | null {
  try {
    const base = semanticCacheDir();
    const req = createRequire(path.join(base, 'noop.js'));
    const hit = req.resolve('@huggingface/transformers', { paths: [base] });
    return preferEsmEntry(hit);
  } catch {
    return null;
  }
}

/**
 * ⚠️ [1017 夜 · 真故障] `require.resolve` 走的是 package.json 的 **require 条件** ⇒ 拿到的是
 * `dist/transformers.node.cjs`。而我们随后用 `import()` 加载它 —— 对一个 CJS 文件做动态 import，
 * 具名导出要靠 cjs-module-lexer 静态识别；实测 @huggingface/transformers@3.8.1 的 `.cjs` 是打包产物，
 * **`mod.pipeline` 是 undefined**，于是 `pipe is not a function`。
 *
 * 症状的恶劣之处：**只有真跑 CLI/守护时才会现形**（走 tsx 的开发态按 import 条件解析到 .mjs，一切正常），
 * 而失败又被 getEmbedder 吞成「模型暂不可用」，用户看到的是「语义档开了但没效果」。
 * 修法两层：① 解析时优先换到 ESM 入口（.mjs）；② 加载后**同时认具名导出与 default 上的导出**，
 * 两层都拿不到就**抛**（不许再退回 null —— 那是静默降级）。
 */
function preferEsmEntry(hit: string): string {
  if (!hit.endsWith('.cjs')) return hit;
  const mjs = hit.slice(0, -4) + '.mjs';
  try { return fs.existsSync(mjs) ? mjs : hit; } catch { return hit; }
}

/** 从模块命名空间里取 pipeline：ESM 具名导出优先，其次 default（CJS interop） */
export function pipelineOf(mod: unknown): PipelineFn | null {
  const m = mod as { pipeline?: unknown; default?: { pipeline?: unknown } };
  const cand = [m?.pipeline, m?.default?.pipeline];
  for (const c of cand) if (typeof c === 'function') return c as PipelineFn;
  return null;
}

/** transformers.js 的 pipeline 工厂签名（只用到 feature-extraction 这一档） */
type PipelineFn = (task: string, model: string, opts?: Record<string, unknown>) => Promise<
  (input: string[], opts: Record<string, unknown>) => Promise<{ data: Float32Array | number[] }>>;
let transformersPipeline: PipelineFn | null = null;

async function getPipeline(model: string): Promise<PipelineFn> {
  if (transformersPipeline) return transformersPipeline;
  const entry = resolveTransformersEntry();
  if (!entry) throw new Error('transformers.js 未安装（srelay semantic enable 安装，或 npm i --prefix ~/.sessionrelay/semantic @huggingface/transformers）');
  const mod = (await import(pathToFileURL(entry).href)) as {
    env?: { allowRemoteModels?: boolean; remoteHost?: string; cacheDir?: string };
    default?: { env?: { allowRemoteModels?: boolean; remoteHost?: string; cacheDir?: string } };
  };
  // 国内镜像（transformers.js env；HF_ENDPOINT 由用户 shell 提供时透传）
  const env = mod.env ?? mod.default?.env;
  if (env && process.env.HF_ENDPOINT) env.remoteHost = process.env.HF_ENDPOINT;
  const pipe = pipelineOf(mod);
  if (!pipe) {
    throw new Error('transformers.js 加载成功但取不到 pipeline（入口 ' + entry + '）—— '
      + '典型成因：解析到了 CJS 产物而具名导出没被识别（1017 实测的 `pipe is not a function`）。'
      + '这条**必须**报出来，不许静默降级：否则语义档会一直「开着但没效果」。');
  }
  transformersPipeline = pipe;
  return transformersPipeline;
}

// ── 模型档案：pooling / 维度 / 量化档**必须与模型匹配** ──
//
// 病历（1017 夜调研，docs/research/2026-10-18-语义档引擎与模型选型.md §4/§5）：
// 这三样原先全是写死的 —— dtype 固定 'q8'、pooling 固定 'cls'、dim 写死 512。
// 于是**换一个 pooling 不同的模型（如 Qwen3-Embedding 要 last_token）会静默产出垃圾向量**：
// 装载成功、检索返回结果、分数看着正常，内容全错 —— 正是"看起来在工作"的一号故障模式。
//
// 判据：认识的模型用档案；**不认识的模型直接拒绝**（报错→降级纯 FTS），不再默默按 cls 跑。
/** BGE 中文系列的官方检索指令前缀（模型卡原文）；文档侧**不加** */
export const BGE_ZH_QUERY_PREFIX = '为这个句子生成表示以用于检索相关文章：';

export interface ModelProfile {
  pooling: 'cls' | 'mean' | 'last_token';
  dim: number;
  dtype: string;
  /**
   * 检索侧的**查询指令前缀**。
   *
   * ⚠️ [1017 夜 · 实测发现] BGE 中文系列是**非对称**模型：官方用法要求给**查询**加一句指令
   * （「为这个句子生成表示以用于检索相关文章：」），文档侧不加。不加前缀时查询与文档落在
   * 两个不同的子空间里，余弦整体偏低且区分度变差 —— 表现就是「语义臂跑了但一条都没救回来」。
   * 这条以前完全没做（代码里既没有前缀、档案里也没有这个字段）。
   */
  queryPrefix?: string;
}

export const MODEL_PROFILES: Record<string, ModelProfile> = {
  // 默认档：24M/512 维/MIT，q8 ONNX 约 22.9MB（C-MTEB 58.28，见调研件 §2）
  'Xenova/bge-small-zh-v1.5': { pooling: 'cls', dim: 512, dtype: 'q8', queryPrefix: BGE_ZH_QUERY_PREFIX },
};

/** 按模型名推断档案。**认不出返回 null** —— 调用方据此拒绝，不猜。 */
export function profileOf(model: string): ModelProfile | null {
  const hit = MODEL_PROFILES[model];
  if (hit) return hit;
  // 家族兜底：只对"公知且稳定"的族做推断，且都按 cls（bge 全系都是 cls）。
  if (/bge-small-zh/i.test(model)) return { pooling: 'cls', dim: 512, dtype: 'q8', queryPrefix: BGE_ZH_QUERY_PREFIX };
  if (/bge-base-zh/i.test(model)) return { pooling: 'cls', dim: 768, dtype: 'q8', queryPrefix: BGE_ZH_QUERY_PREFIX };
  if (/bge-large-zh/i.test(model)) return { pooling: 'cls', dim: 1024, dtype: 'q8', queryPrefix: BGE_ZH_QUERY_PREFIX };
  if (/bge-m3/i.test(model)) return { pooling: 'cls', dim: 1024, dtype: 'q8' };
  // Qwen3-Embedding 官方用法是**最后一个 token**的隐状态（last_token），不是 cls —— 这条推错就是垃圾向量。
  if (/qwen3-embedding/i.test(model)) return { pooling: 'last_token', dim: 1024, dtype: 'q8' };
  return null;
}

export async function createTransformersEmbedder(model: string, override?: { dtype?: string }): Promise<Embedder> {
  const prof = profileOf(model);
  if (!prof) {
    throw new Error('未知模型档案：' + model + ' —— 它的 pooling/维度/量化档没有登记，按默认 cls 跑会**静默产出垃圾向量**。'
      + '请先在 core/SessionRelay/src/search-svc/semantic.ts 的 MODEL_PROFILES 里登记（pooling 与维度查该模型官方用法）。');
  }
  const dtype = override?.dtype ?? prof.dtype;
  if (!(KNOWN_DTYPES as readonly string[]).includes(dtype)) throw new Error('未知量化档：' + dtype);
  const pipe = await getPipeline(model);
  const extractor = await pipe('feature-extraction', model, { dtype });
  return {
    model,
    dim: prof.dim,
    queryPrefix: prof.queryPrefix,
    async embed(text: string): Promise<Float32Array> {
      // transformers.js v3：pipeline 返回 Tensor（.data 为扁平 Float32Array，单输入 shape [1, dim]）
      // normalized 选项实测未生效（分数呈点积量级）→ 按设计 R2 在此强制 L2，保证余弦阈值可比
      const out = (await extractor([text.slice(0, MAX_INPUT_CHARS)], { pooling: prof.pooling })) as unknown as { data: Float32Array | number[] };
      const v = l2(Float32Array.from(out.data));
      // 维度自检：档案写 512 却出 768 ⇒ 档案错了（或模型换了），当场报而不是让垃圾向量进库
      if (v.length !== prof.dim) throw new Error('模型维度与档案不符：档案 ' + prof.dim + '，实际 ' + v.length + '（模型 ' + model + '）');
      return v;
    },
  };
}

// ── 语义上下文（开关 + embedder 惰性构建；任何失败 → null 短路，R3 降级不崩溃） ──

let cachedEmbedder: { model: string; e: Embedder } | null = null;
/** 空闲卸载计时器（unref，绝不把进程吊住） */
let idleTimer: ReturnType<typeof setTimeout> | null = null;

/** 空闲多久卸载（分钟）；0 或负数 = 永不卸载。取自 config.semantic.idle_unload_min，默认 10。 */
function idleUnloadMs(cfg: RelayConfig): number {
  const min = Number(cfg.semantic?.idle_unload_min ?? 10);
  return Number.isFinite(min) && min > 0 ? min * 60_000 : 0;
}

/** 释放 embedder 并记状态。空闲卸载与换模型都走这里（**唯一**的释放点）。 */
export function unloadSemantic(reason: 'idle' | 'swap' | 'manual' = 'manual'): boolean {
  const had = !!cachedEmbedder;
  cachedEmbedder = null;
  transformersPipeline = null;
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  if (had && reason === 'idle') recordSemantic({ state: 'unloaded', model: null });
  return had;
}

function touchIdleTimer(cfg: RelayConfig): void {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  const ms = idleUnloadMs(cfg);
  if (!ms || !cachedEmbedder) return;
  idleTimer = setTimeout(() => { unloadSemantic('idle'); }, ms);
  // unref：CLI 跑完就该退，绝不能因为一个计时器挂着不退出
  (idleTimer as unknown as { unref?: () => void }).unref?.();
}

export function semanticModelOf(cfg: RelayConfig): string {
  return cfg.semantic?.model ?? DEFAULT_MODEL;
}

/**
 * 语义候选上限 top-k（默认 SEMANTIC_TOP_K=5，可被 config.semantic.top_k 覆盖）。
 *
 * 为什么要可配：top-k 与 reserve_slots 是**两套限量**（一个决定候选池、一个决定进名额几条），
 * 参数扫描时必须能单独动其中一个，否则归因不可解（调研件 §4.3 R3）。
 * 上限 50：再大对「注入几条」没有任何影响（reserve 早就截断了），只是白算余弦。
 */
export function semanticTopKOf(cfg: RelayConfig): number {
  const k = Number(cfg.semantic?.top_k ?? SEMANTIC_TOP_K);
  return Number.isFinite(k) && k > 0 ? Math.min(Math.floor(k), 50) : SEMANTIC_TOP_K;
}

/** 量化档：模型档案给默认值，config.semantic.dtype 可覆盖（只认 KNOWN_DTYPES，写错当场报） */
export function dtypeOf(cfg: RelayConfig, prof: ModelProfile): string {
  const want = cfg.semantic?.dtype;
  if (!want) return prof.dtype;
  if (!(KNOWN_DTYPES as readonly string[]).includes(want)) {
    throw new Error('未知量化档：' + want + ' —— 只认 ' + KNOWN_DTYPES.join('/') + '（写错的代价是静默按别的档加载）');
  }
  return want;
}

/**
 * 取 embedder（惰性装载 + 空闲卸载）。
 *
 * ⚠️ [1017 夜] 失败**不再静默**：以前这里是 `catch { return null }`，于是"启用了但装载失败"
 * 和"根本没启用"在运行期完全分不清 —— 用户只会觉得"检索好像变差了"。
 * 现在失败原因写进跨进程的状态文件（semantic-status.ts），CLI / doctor / 面板 都能读到。
 * 返回 null 的语义不变（调用方照样降级纯 FTS），只是**同时留下了证据**。
 */
export async function getEmbedder(cfg: RelayConfig): Promise<Embedder | null> {
  if (cfg.semantic?.enabled !== true) return null;
  if (process.env.SRELAY_SEMANTIC_FAKE === '1') { touchIdleTimer(cfg); return new FakeEmbedder(); }
  const model = semanticModelOf(cfg);
  if (cachedEmbedder && cachedEmbedder.model === model) {
    touchIdleTimer(cfg);
    recordSemantic({ state: 'ready', model, usedAt: new Date().toISOString(), by: 'getEmbedder(reuse)' });
    return cachedEmbedder.e;
  }
  if (cachedEmbedder && cachedEmbedder.model !== model) unloadSemantic('swap');   // 换模型：先释放旧的
  try {
    const e = await createTransformersEmbedder(model, { dtype: dtypeOf(cfg, profileOf(model)!) });
    cachedEmbedder = { model, e };
    touchIdleTimer(cfg);
    recordSemantic({ state: 'ready', model, usedAt: new Date().toISOString(), by: 'getEmbedder' });
    return e;
  } catch (e) {
    const msg = String((e as Error)?.message ?? e).slice(0, 300);
    recordSemantic({ state: 'failed', model, error: msg, by: 'getEmbedder' });
    return null; // 仍然降级纯 FTS —— 但这次**留下了原因**
  }
}

// ── 向量缓存（R1：COUNT+MAX 签名失效，守护写/serve 读跨进程一致） ──

interface VectorCache { signature: string; vectors: Map<string, Float32Array> }
let vectorCache: VectorCache | null = null;

function vectorsOf(db: DB, model: string): Map<string, Float32Array> {
  const sig = vectorSignature(db, model);
  if (vectorCache && vectorCache.signature === sig) return vectorCache.vectors;
  const vectors = loadSessionVectors(db, model);
  vectorCache = { signature: sig, vectors };
  return vectors;
}

/** related 推荐（design-related）复用同一签名缓存——重复调用不重载向量 */
export const cachedSessionVectors = vectorsOf;

/** 测试辅助：清进程级缓存（向量直插后强制重载） */
export function resetSemanticCaches(): void {
  vectorCache = null;
  cachedEmbedder = null;
  transformersPipeline = null;
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
}

// ── 语义检索：返回余弦 top-K（null = 未启用/降级——调用方走纯 FTS） ──

export interface SemanticHit { sessionId: string; score: number }

export async function semanticSearch(
  db: DB, cfg: RelayConfig, query: string,
  opts: { project: string; extraWhere?: ExtraWhere | null; threshold?: number },
): Promise<SemanticHit[] | null> {
  const embedder = await getEmbedder(cfg);
  if (!embedder || !query.trim()) return null;
  try {
      // 检索侧套指令前缀（BGE 中文系列是非对称模型，不加前缀 = 查询与文档不在同一子空间）
    const qv = await embedder.embed((embedder.queryPrefix ?? '') + query);
    const threshold = opts.threshold ?? cfg.semantic?.threshold ?? DEFAULT_THRESHOLD;
    // 候选：scope/A 档 SQL 过滤后的 confirmed 会话（与 FTS 同一过滤面）
    const conds = ["s.project_id = ?", "s.state = 'confirmed'"];
    const params: unknown[] = [opts.project];
    if (opts.extraWhere) { conds.push(opts.extraWhere.sql); params.push(...opts.extraWhere.params); }
    const candidates = db.prepare(`SELECT s.id FROM sessions s WHERE ${conds.join(' AND ')}`).all(...params) as Array<{ id: string }>;
    const vectors = vectorsOf(db, embedder.model);
    const scored: SemanticHit[] = [];
    for (const { id } of candidates) {
      const v = vectors.get(id);
      if (!v || v.length !== qv.length) continue;
      let d = 0;
      for (let i = 0; i < qv.length; i++) d += qv[i] * v[i];
      if (d >= threshold) scored.push({ sessionId: id, score: d });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, semanticTopKOf(cfg));
  } catch (e) {
    // [1017 夜] 这里原先也是**静默**的（catch 里直接 return null）。它跟 getEmbedder 的失败不是同一类：
    // 那是「装载不了」，这是「装载好了、推理那一刻炸了」（模型文件损坏/内存不足/超长输入）。
    // 两条路都必须留痕 —— 否则用户看到的现象只有一个：「语义好像没效果」（铁律：容错不许静默）。
    recordSemantic({
      state: 'failed', model: embedder.model, by: 'semanticSearch',
      error: '语义推理失败：' + String((e as Error)?.message ?? e).slice(0, 300),
    });
    return null; // R3：降级纯 FTS —— 但这次**留下了证据**
  }
}

// ── digest：confirmed 且无（匹配模型）向量行的会话，限量补嵌（设计 §3.2） ──

export function semanticInputOf(title: string | null, bodyText: string): string {
  return `${title ?? ''}\n${bodyText}`.slice(0, MAX_INPUT_CHARS);
}

/** 毒丸自愈：嵌入失败的目标跳过（防阻塞队列头部），进程重启后自动重试 */
const failedSkip = new Set<string>();
const FAILED_SKIP_MAX = 1000;

/** 测试/运维钩子：手动把某会话标记为跳过（如内容稳定触发推理崩溃的目标） */
export function markSemanticFailed(sessionId: string): void {
  if (failedSkip.size < FAILED_SKIP_MAX) failedSkip.add(sessionId);
}

export async function digestSemantic(db: DB, cfg: RelayConfig, opts: { projectId?: string; limit?: number; log?: (s: string) => void }): Promise<{ embedded: number; failed: number }> {
  const embedder = await getEmbedder(cfg);
  if (!embedder) return { embedded: 0, failed: 0 };
  const limit = opts.limit ?? 20;
  // 毒丸不占名额（自审修复）：failedSkip 过滤若发生在 SQL 之后，排前的毒丸会吃光
  // 本周期 limit——新 confirmed 会话永远排不上。改为多取 2×limit 再过滤截断；
  // 毒丸占比超一半时本轮提前收工（下周期重试，重启清空后全量重试）。
  let targets = pendingSemanticTargets(db, embedder.model, failedSkip.size > 0 ? limit * 2 : limit, opts.projectId)
    .filter((t) => !failedSkip.has(t.id))
    .slice(0, limit);
  let embedded = 0, failed = 0;
  for (const t of targets) {
    try {
      // 正文在 SQLite 端限量截断（前 30 条 × 每条 200 字）：大会话不再全量拼接（内存审核 P1-1）
      const row = db.prepare(`
        SELECT
          (SELECT title FROM sessions WHERE id = ?) AS t,
          (SELECT group_concat(substr(content, 1, 200), ' ') FROM
            (SELECT content FROM messages WHERE session_id = ? ORDER BY seq_num LIMIT 30)) AS head,
          (SELECT group_concat(substr(content, 1, 200), ' ') FROM
            (SELECT content FROM messages WHERE session_id = ? ORDER BY seq_num DESC LIMIT 30)) AS tail,
          (SELECT COUNT(*) FROM messages WHERE session_id = ?) AS n
      `).get(t.id, t.id, t.id, t.id) as { t: string | null; head: string | null; tail: string | null; n: number };
      // [1017 夜 · 实测修复] 原先只嵌 title + **前 30 条**消息。对 600~2400 条消息的长会话，
      // 这等于用开头的寒暄代表整个会话 —— 实测：题面词落在前 30 条内时语义 hit@1 4.6%，
      // 落在 30 条之后时 **0.0%**（n=300）。长会话的向量与它自己的后段内容**根本不相关**。
      // 修法：头 30 条 + **尾 30 条**（近期结论通常在后段），再按 MAX_INPUT_CHARS 截断。
      // 实测（同一批 300 题）：hit@1 8.0% → 9.3%（方向一致，但 1.3pp 在 n=300 下**不显著**，
      // 所以这条是按"原实现明显不对"改的，不是按"分数涨了"改的）。
      const body = [row.head ?? '', row.tail ?? ''].filter(Boolean).join(' ');
      const vec = await embedder.embed(semanticInputOf(row.t, body));
      upsertSessionVector(db, t.id, embedder.model, vec);
      failedSkip.delete(t.id); // 曾失败后成功 → 解除跳过
      embedded++;
      opts.log?.(`${t.id} ✓`);
    } catch {
      failed++;
      if (failedSkip.size < FAILED_SKIP_MAX) failedSkip.add(t.id);
      opts.log?.(`${t.id} ✗（跳过，重启后重试）`);
    }
  }
  return { embedded, failed };
}