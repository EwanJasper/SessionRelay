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

export const DEFAULT_MODEL = 'Xenova/bge-small-zh-v1.5';
export const DEFAULT_THRESHOLD = 0.4;
export const SEMANTIC_TOP_K = 5; // R4：写死，语义错配限量防线
const MAX_INPUT_CHARS = 1200;    // R6：bge max_seq 512 token ≈ 中文 500 字，双侧截断

export interface Embedder {
  model: string;
  dim: number;
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

// 注意：绝不能用 ~/.sessionrelay —— findRelayRoot 向上探测的是该目录名，
// 在家目录创建它会把用户主目录误判为"已初始化项目"，污染所有子目录的 init（实测踩过）
export const semanticCacheDir = (): string => path.join(os.homedir(), '.sessionrelay-semantic');

/** 解析用户缓存目录里的 transformers.js 入口；不可用返回 null（不抛——降级语义） */
export function resolveTransformersEntry(): string | null {
  try {
    const base = semanticCacheDir();
    const req = createRequire(path.join(base, 'noop.js'));
    return req.resolve('@huggingface/transformers', { paths: [base] });
  } catch {
    return null;
  }
}

let transformersPipeline: ((t: string, m: string, o?: Record<string, unknown>) => Promise<(input: string[], o: Record<string, unknown>) => Promise<Float32Array[][]>>) | null = null;

async function getPipeline(model: string) {
  if (transformersPipeline) return transformersPipeline;
  const entry = resolveTransformersEntry();
  if (!entry) throw new Error('transformers.js 未安装（srelay semantic enable 安装，或 npm i --prefix ~/.sessionrelay/semantic @huggingface/transformers）');
  const mod = (await import(pathToFileURL(entry).href)) as {
    pipeline: (t: string, m: string, o?: Record<string, unknown>) => Promise<(input: string[], o: Record<string, unknown>) => Promise<Float32Array[][]>>;
    env?: { allowRemoteModels?: boolean; remoteHost?: string };
  };
  // 国内镜像（transformers.js env；HF_ENDPOINT 由用户 shell 提供时透传）
  if (mod.env && process.env.HF_ENDPOINT) mod.env.remoteHost = process.env.HF_ENDPOINT;
  transformersPipeline = mod.pipeline;
  return transformersPipeline;
}

export async function createTransformersEmbedder(model: string): Promise<Embedder> {
  const pipe = await getPipeline(model);
  const extractor = await pipe('feature-extraction', model, { dtype: 'q8' });
  return {
    model,
    dim: 512, // bge-small-zh-v1.5 是 512 维（384 是英文版）；实际以 vec.length 落库，此声明仅文档性
    async embed(text: string): Promise<Float32Array> {
      // transformers.js v3：pipeline 返回 Tensor（.data 为扁平 Float32Array，单输入 shape [1, dim]）
      // normalized 选项实测未生效（分数呈点积量级）→ 按设计 R2 在此强制 L2，保证余弦阈值可比
      const out = (await extractor([text.slice(0, MAX_INPUT_CHARS)], { pooling: 'cls' })) as unknown as { data: Float32Array | number[] };
      return l2(Float32Array.from(out.data));
    },
  };
}

// ── 语义上下文（开关 + embedder 惰性构建；任何失败 → null 短路，R3 降级不崩溃） ──

let cachedEmbedder: { model: string; e: Embedder } | null = null;

export function semanticModelOf(cfg: RelayConfig): string {
  return cfg.semantic?.model ?? DEFAULT_MODEL;
}

export async function getEmbedder(cfg: RelayConfig): Promise<Embedder | null> {
  if (cfg.semantic?.enabled !== true) return null;
  if (process.env.SRELAY_SEMANTIC_FAKE === '1') return new FakeEmbedder();
  const model = semanticModelOf(cfg);
  if (cachedEmbedder && cachedEmbedder.model === model) return cachedEmbedder.e;
  try {
    const e = await createTransformersEmbedder(model);
    cachedEmbedder = { model, e };
    return e;
  } catch {
    return null; // 依赖损坏/离线：降级纯 FTS（doctor/status 负责显性提示）
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

/** 测试辅助：清进程级缓存（向量直插后强制重载） */
export function resetSemanticCaches(): void {
  vectorCache = null;
  cachedEmbedder = null;
  transformersPipeline = null;
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
    const qv = await embedder.embed(query);
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
    return scored.slice(0, SEMANTIC_TOP_K);
  } catch {
    return null; // R3：推理任何异常 → 降级
  }
}

// ── digest：confirmed 且无（匹配模型）向量行的会话，限量补嵌（设计 §3.2） ──

export function semanticInputOf(title: string | null, bodyText: string): string {
  return `${title ?? ''}\n${bodyText}`.slice(0, MAX_INPUT_CHARS);
}

export async function digestSemantic(db: DB, cfg: RelayConfig, opts: { projectId?: string; limit?: number; log?: (s: string) => void }): Promise<number> {
  const embedder = await getEmbedder(cfg);
  if (!embedder) return 0;
  const limit = opts.limit ?? 20;
  const targets = pendingSemanticTargets(db, embedder.model, limit, opts.projectId);
  for (const t of targets) {
    const row = db.prepare(`
      SELECT COALESCE((SELECT group_concat(content, ' ') FROM (SELECT content FROM messages WHERE session_id = ? ORDER BY seq_num LIMIT 200)), '') AS body,
             title AS t FROM sessions WHERE id = ?
    `).get(t.id, t.id) as { body: string; t: string | null };
    const vec = await embedder.embed(semanticInputOf(row.t, row.body));
    upsertSessionVector(db, t.id, embedder.model, vec);
    opts.log?.(`${t.id} ✓`);
  }
  return targets.length;
}
