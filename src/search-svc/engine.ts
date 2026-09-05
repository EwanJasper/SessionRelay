// 搜索引擎 Spike（方针 §6.3 / 技术方案 §六）：
// - 双索引面：messages_fts（正文主面）+ sessions_fts（meta 模式/元数据命中）
// - 会话级 AND 覆盖度：query 的每个单元都必须被会话覆盖（可跨消息，满足 C4）
// - AND 零命中 → OR 兜底（Spike 决策：满足 C2「认证方案」命中「用 JWT 做认证」这类
//   用户只记得部分关键词的真实查询；待回填技术方案 §6.1）
// - 合并确定性：messages 命中优先于 meta 命中（技术方案 T27）
import type { DB, } from '../store/db.js';
import { parseQuery, unitExpr } from '../core/tokenize/tokenizer.js';

export interface ExtraWhere {
  sql: string;
  params: unknown[];
}

export interface SearchHit {
  sessionId: string;
  score: number;
  snippet: string;
  viaMeta: boolean;
  coverage: number; // 覆盖的单元数 / 总单元数
  seq: number;      // 最佳命中消息序号（出处块的 msg#，D10）
  viaSemantic?: boolean; // 语义补充命中（design-semantic §3.2：B−A 追加，排序在 FTS 之后）
}

interface UnitHits {
  map: Map<string, { score: number; rid: number }>;
}

function queryUnit(db: DB, expr: string, project: string, extra?: ExtraWhere | null): UnitHits {
  const map = new Map<string, { score: number; rid: number }>();
  const rows = db.prepare(`
    SELECT m.session_id AS sid, messages_fts.rowid AS rid, -bm25(messages_fts) AS sc
    FROM messages_fts
    JOIN messages m ON m.id = messages_fts.rowid
    JOIN sessions s ON s.id = m.session_id
    WHERE messages_fts MATCH ? AND s.project_id = ?${extra ? ` AND ${extra.sql}` : ''}
  `).all(expr, project, ...(extra?.params ?? [])) as Array<{ sid: string; rid: number; sc: number }>;
  for (const r of rows) {
    const prev = map.get(r.sid);
    if (!prev || r.sc > prev.score) map.set(r.sid, { score: r.sc, rid: r.rid });
  }
  return { map };
}

function excerpt(db: DB, rid: number, firstToken: string): string {
  const row = db.prepare('SELECT content FROM messages WHERE id = ?').get(rid) as { content: string } | undefined;
  if (!row) return '';
  const idx = row.content.indexOf(firstToken);
  const start = Math.max(0, (idx === -1 ? 0 : idx) - 40);
  return row.content.slice(start, start + 120).replace(/\s+/g, ' ').trim();
}

function queryMetaUnits(db: DB, exprs: string[], project: string, extra?: ExtraWhere | null): Map<string, number> {
  const out = new Map<string, number>();
  for (const expr of exprs) {
    const rows = db.prepare(`
      SELECT s.id AS sid, -bm25(sessions_fts) AS sc
      FROM sessions_fts
      JOIN sessions s ON s.rowid = sessions_fts.rowid
      WHERE sessions_fts MATCH ? AND s.project_id = ?${extra ? ` AND ${extra.sql}` : ''}
    `).all(expr, project, ...(extra?.params ?? [])) as Array<{ sid: string; sc: number }>;
    for (const r of rows) out.set(r.sid, Math.max(out.get(r.sid) ?? 0, r.sc));
  }
  return out;
}

export interface SearchOptions {
  project: string;
  query: string;
  limit?: number;
  extraWhere?: ExtraWhere | null;
  /** 语义补充命中（调用方经 semanticSearch 预计算注入；不传/空 = 与纯 FTS 行为等价） */
  semanticHits?: Array<{ sessionId: string; score: number }> | null;
}

export function searchSessions(db: DB, opts: SearchOptions): SearchHit[] {
  const limit = opts.limit ?? 20;
  const { units } = parseQuery(opts.query);
  if (units.length === 0) return [];

  const unitHits = units.map((u) => queryUnit(db, unitExpr(u), opts.project, opts.extraWhere));

  // 会话级 AND：所有单元都被覆盖（跨消息）；零命中 → OR 兜底
  let sids: string[] = [];
  const andMap = new Map<string, number>();
  for (const uh of unitHits) {
    if (sids.length === 0 && andMap.size === 0) {
      for (const [sid, v] of uh.map) { sids.push(sid); andMap.set(sid, v.score); }
    } else {
      const next: string[] = [];
      for (const sid of sids) {
        const hit = uh.map.get(sid);
        if (hit) { next.push(sid); andMap.set(sid, (andMap.get(sid) ?? 0) + hit.score); }
      }
      sids = next;
    }
  }
  let viaFallback = false;
  if (sids.length === 0) {
    viaFallback = true;
    const union = new Map<string, number>();
    for (const uh of unitHits) for (const [sid, v] of uh.map) union.set(sid, (union.get(sid) ?? 0) + v.score);
    sids = [...union.keys()];
    for (const sid of sids) andMap.set(sid, union.get(sid)!);
  }

  // meta 面（C6：meta 模式会话无正文，仅 title/topics 可命中）
  const metaHits = queryMetaUnits(db, units.map(unitExpr), opts.project, opts.extraWhere);

  const hits: SearchHit[] = [];
  const coverageOf = (sid: string) => unitHits.filter((uh) => uh.map.has(sid)).length / units.length;
  const seqOf = (rid: number) => rid > 0
    ? ((db.prepare('SELECT seq_num AS n FROM messages WHERE id = ?').get(rid) as { n: number } | undefined)?.n ?? 0)
    : 0;
  for (const sid of sids) {
    const best = unitHits.find((uh) => uh.map.has(sid))?.map.get(sid);
    hits.push({
      sessionId: sid,
      score: andMap.get(sid) ?? 0,
      snippet: excerpt(db, best?.rid ?? 0, units[0].join('')),
      viaMeta: false,
      coverage: coverageOf(sid),
      seq: seqOf(best?.rid ?? 0),
    });
  }
  for (const [sid, sc] of metaHits) {
    if (hits.some((h) => h.sessionId === sid)) continue; // messages 优先（T27）
    hits.push({ sessionId: sid, score: sc * 0.5, snippet: '', viaMeta: true, coverage: coverageOf(sid), seq: 0 });
  }

  hits.sort((a, b) => b.score - a.score || b.coverage - a.coverage);
  if (viaFallback) {
    // 兜底模式下覆盖度高的排前（有更多关键词命中的更相关）
    hits.sort((a, b) => b.coverage - a.coverage || b.score - a.score);
  }

  // 语义补充（design-semantic §3.2：FTS 已命中的不重复计，B−A 追加在后，绝不替换/抑制 FTS 结果）
  if (opts.semanticHits && opts.semanticHits.length > 0) {
    const existing = new Set(hits.map((h) => h.sessionId));
    for (const sh of opts.semanticHits) {
      if (existing.has(sh.sessionId)) continue;
      const title = (db.prepare('SELECT title FROM sessions WHERE id = ?').get(sh.sessionId) as { title: string | null } | undefined)?.title;
      hits.push({ sessionId: sh.sessionId, score: sh.score, snippet: title ?? '', viaMeta: false, coverage: 0, seq: 0, viaSemantic: true });
    }
  }
  return hits.slice(0, limit);
}
