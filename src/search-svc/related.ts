// 相关会话推荐（design-related）：搜索是你带着词去找，推荐是库主动告诉你"这几个是一伙的"。
// 双轨：向量轨（semantic 已启用）+ 重叠轨（纯元数据降级）；融合 = 向量优先、重叠补足。
// 完全无状态：无新表、无 schema 变更、不写 session_links（推荐不产生持久关系，防回音室固化）。
import type { DB } from '../store/db.js';
import type { RelayConfig } from '../shared/config.js';
import { cachedSessionVectors, getEmbedder, semanticInputOf, DEFAULT_THRESHOLD } from './semantic.js';
import { segment } from '../core/tokenize/tokenizer.js';

export interface RelatedItem {
  sessionId: string;
  title: string | null;
  source: string;
  createdAt: string | null;
  state: string;
  score: number;
  reason: string;
  viaVector: boolean;
}

export interface RelatedOptions {
  projectId: string;
  anchorId: string;
  limit?: number;          // 默认 5，硬顶 10（§4 滥用防护）
  threshold?: number;      // 默认复用 semantic.threshold ?? 0.40
}

export const RELATED_HARD_CAP = 10;

function jarr(v: unknown): string[] {
  try { return v == null ? [] : JSON.parse(String(v)) as string[]; } catch { return []; }
}

function cos(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return -1;
  let d = 0;
  for (let i = 0; i < a.length; i++) d += a[i] * b[i];
  return d;
}

/** 标题分词去重（长度 ≥2）；重叠轨与"共享标题"信号共用 */
function titleTokens(title: string | null): Set<string> {
  return new Set(segment(title ?? '').filter((t) => t.length >= 2));
}

/** 重叠轨打分（v1 §3.2）：话题×3 + 标签×2 + 文件(≤3) + 标题分词(≤3)；0 分不进结果 */
function overlapScore(
  a: { topics: string[]; tags: string[]; files: string[]; tokens: Set<string> },
  b: { topics: string[]; tags: string[]; files: string[]; tokens: Set<string> },
): { score: number; reason: string } {
  const shT = a.topics.filter((t) => b.topics.includes(t));
  const shG = a.tags.filter((t) => b.tags.includes(t));
  const shF = a.files.filter((f) => b.files.includes(f));
  const shW = [...a.tokens].filter((t) => b.tokens.has(t));
  const score = shT.length * 3 + shG.length * 2 + Math.min(shF.length, 3) + Math.min(shW.length, 3);
  if (score === 0) return { score: 0, reason: '' };
  const parts: string[] = [];
  if (shT.length) parts.push(`共享话题：${shT.slice(0, 3).join('、')}`);
  if (shG.length) parts.push(`共享标签：${shG.slice(0, 3).join('、')}`);
  if (shF.length) parts.push(`共享文件：${shF.slice(0, 2).join('、')}`);
  if (parts.length === 0 && shW.length) parts.push(`标题相关：${shW.slice(0, 3).join('、')}`);
  return { score, reason: parts.slice(0, 2).join(' · ') };
}

interface CandidateRow {
  id: string; title: string | null; source: string; created_at: string | null; state: string;
  topics: string | null; files_mentioned: string | null; user_tags: string | null;
  first_user: string | null;
}

function loadCandidates(db: DB, projectId: string, excludeId: string, confirmedOnly: boolean): CandidateRow[] {
  return db.prepare(`
    SELECT s.id, s.title, s.source, s.created_at, s.state, s.topics, s.files_mentioned, s.user_tags,
      (SELECT content FROM messages m WHERE m.session_id = s.id AND m.role = 'user' ORDER BY m.seq_num LIMIT 1) AS first_user
    FROM sessions s WHERE s.project_id = ? AND s.id != ?${confirmedOnly ? " AND s.state = 'confirmed'" : ''}
  `).all(projectId, excludeId) as CandidateRow[];
}

function metaOf(r: CandidateRow) {
  return { topics: jarr(r.topics), tags: jarr(r.user_tags), files: jarr(r.files_mentioned), tokens: titleTokens(r.title) };
}

/**
 * 相关会话推荐（design-related §3）：
 * 1) 向量轨：anchor 有库内向量直接用；active 等无向量 anchor 用标题+首条用户消息即时嵌入（只算不入库）
 * 2) 重叠轨：无 embedder 或补足名额时启用
 * 融合：向量结果优先，重叠补足剩余名额去重
 */
export async function suggestRelated(db: DB, cfg: RelayConfig, opts: RelatedOptions): Promise<{ items: RelatedItem[]; viaVectorAny: boolean }> {
  const limit = Math.min(Math.max(1, opts.limit ?? 5), RELATED_HARD_CAP);
  const threshold = opts.threshold ?? cfg.semantic?.threshold ?? DEFAULT_THRESHOLD;
  const out: RelatedItem[] = [];
  let viaVectorAny = false;

  // ── 向量轨 ──
  const embedder = await getEmbedder(cfg);
  if (embedder) {
    try {
      const vectors = cachedSessionVectors(db, embedder.model);
      const anchorVec = vectors.get(opts.anchorId)
        ?? await embedder.embed(semanticInputOf(
          (db.prepare('SELECT title FROM sessions WHERE id = ?').get(opts.anchorId) as { title: string | null } | undefined)?.title ?? null,
          (db.prepare("SELECT content FROM messages WHERE session_id = ? AND role = 'user' ORDER BY seq_num LIMIT 1").get(opts.anchorId) as { content: string } | undefined)?.content ?? '',
        ));
      const scored: Array<{ id: string; score: number }> = [];
      for (const c of loadCandidates(db, opts.projectId, opts.anchorId, true)) {
        const v = vectors.get(c.id);
        if (!v) continue;
        const d = cos(anchorVec, v);
        if (d >= threshold) scored.push({ id: c.id, score: d });
      }
      scored.sort((a, b) => b.score - a.score);
      const briefs = db.prepare(`SELECT id, title, source, created_at, state FROM sessions WHERE project_id = ?`).all(opts.projectId) as Array<{ id: string; title: string | null; source: string; created_at: string; state: string }>;
      const byId = new Map(briefs.map((r) => [r.id, r]));
      for (const s of scored.slice(0, limit)) {
        const r = byId.get(s.id);
        if (!r) continue;
        out.push({ sessionId: r.id, title: r.title, source: r.source, createdAt: r.created_at, state: r.state, score: Number(s.score.toFixed(3)), reason: `向量相似 ${s.score.toFixed(2)}`, viaVector: true });
      }
      viaVectorAny = out.length > 0;
    } catch { /* 向量轨任何异常 → 重叠轨兜底（与 semantic R3 同款降级） */ }
  }

  // ── 重叠轨补足 ──
  if (out.length < limit) {
    const anchorRow = db.prepare('SELECT title, topics, files_mentioned, user_tags FROM sessions WHERE id = ?').get(opts.anchorId) as { title: string | null; topics: string | null; files_mentioned: string | null; user_tags: string | null } | undefined;
    if (anchorRow) {
      const a = { topics: jarr(anchorRow.topics), tags: jarr(anchorRow.user_tags), files: jarr(anchorRow.files_mentioned), tokens: titleTokens(anchorRow.title) };
      const rest = loadCandidates(db, opts.projectId, opts.anchorId, false)
        .map((c) => ({ row: c, hit: overlapScore(a, metaOf(c)) }))
        .filter((x) => x.hit.score > 0)
        .sort((x, y) => y.hit.score - x.hit.score);
      for (const { row, hit } of rest) {
        if (out.length >= limit) break;
        if (out.some((o) => o.sessionId === row.id)) continue;
        out.push({ sessionId: row.id, title: row.title, source: row.source, createdAt: row.created_at, state: row.state, score: hit.score, reason: hit.reason, viaVector: false });
      }
    }
  }
  return { items: out, viaVectorAny };
}
