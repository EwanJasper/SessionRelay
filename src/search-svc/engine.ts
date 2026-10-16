// 搜索引擎 Spike（方针 §6.3 / 技术方案 §六）：
// - 双索引面：messages_fts（正文主面）+ sessions_fts（meta 模式/元数据命中）
// - 会话级 AND 覆盖度：query 的每个单元都必须被会话覆盖（可跨消息，满足 C4）
// - AND 零命中 → OR 兜底（Spike 决策：满足 C2「认证方案」命中「用 JWT 做认证」这类
//   用户只记得部分关键词的真实查询；待回填技术方案 §6.1）
// - 合并确定性：messages 命中优先于 meta 命中（技术方案 T27）
import type { DB, } from '../store/db.js';
import { parseQuery, unitExpr, segment } from '../core/tokenize/tokenizer.js';
import { rewriteQuery } from '../core/tokenize/rewrite.js';

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
  /** [1016] 零模型查询改写补充命中（同义家族 / CJK bigram 展开）——**只做加法**，排在主路之后 */
  viaRewrite?: boolean;
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
  /**
   * 语义命中的保底槽位数（默认 3，上限 floor(limit/3)；0 = 逐字回旧行为）。
   *
   * 为什么需要它：语义命中原先只 push 在 sort 之后、最后再 slice(0, limit)，
   * 于是 FTS 命中一旦 ≥ limit 就被整段切掉——「换一种说法也能命中」在默认 limit 下结构性不可达。
   * 保底只从 **FTS 尾部**（分数最低的几条）腾，绝不挤掉 FTS 头部。
   */
  semanticReserve?: number;
  /**
   * 零模型查询改写补充（默认开）。主路命中不足 rewriteBelow 条时，用改写后的补充词再搜一遍，
   * 结果**追加在主路之后**（不替换、不压分、可标记 viaRewrite）。
   * 关掉它 = 逐字回到旧行为（便于 A/B 对比）。
   */
  rewrite?: boolean;
  /** 主路命中少于这个数才启用改写补充（默认 3；设 0 = 永远启用） */
  rewriteBelow?: number;
}

/**
 * 主检索（原实现，一字未动）。
 * 查询改写补充在 searchSessions 里做——**只做加法**：先拿主路结果，不足才补，
 * 补进来的排在主路之后。这样即使改写很烂，也不会把原本对的挤下去。
 */
function searchOnce(db: DB, opts: SearchOptions): SearchHit[] {
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
  //
  // [1015 夜 · 槽位保底] 原实现只在 sort 之后 push、最后再 slice(0, limit)——于是只要 FTS
  // 命中数已 ≥ limit，语义命中就被同一次 slice 整段切掉（分数给到 999 也进不来），
  // 「换一种说法也能命中」在默认 limit 下结构性不可达（实测 test/fork/semantic-slot-starvation.spec.ts）。
  // 修法：语义命中保底占 min(reserve, floor(limit/3)) 个槽位，从 **FTS 尾部** 腾，头部一条不动；
  // reserve=0 逐字回到旧行为（config: semantic.reserve_slots）。
  if (opts.semanticHits && opts.semanticHits.length > 0) {
    const existing = new Set(hits.map((h) => h.sessionId));
    const extra: SearchHit[] = [];
    for (const sh of opts.semanticHits) {
      if (existing.has(sh.sessionId)) continue;
      const title = (db.prepare('SELECT title FROM sessions WHERE id = ?').get(sh.sessionId) as { title: string | null } | undefined)?.title;
      extra.push({ sessionId: sh.sessionId, score: sh.score, snippet: title ?? '', viaMeta: false, coverage: 0, seq: 0, viaSemantic: true });
    }
    const reserve = Math.min(opts.semanticReserve ?? 3, Math.floor(limit / 3));
    if (extra.length > 0 && reserve > 0) {
      const take = Math.min(extra.length, reserve);
      return [...hits.slice(0, Math.max(0, limit - take)), ...extra.slice(0, take)].slice(0, limit);
    }
    if (extra.length > 0) hits.push(...extra);
  }
  return hits.slice(0, limit);
}

/**
 * 对外入口 = 主检索 + （可选）零模型查询改写补充。
 *
 * [1016 竞品调研借鉴点 ②] 我们的短板是「换个说法就不认」（关键词 20/20 进 top-10、
 * 大白话 top-1 只有 10/20）。改写做三件事，全零模型：同义家族命中即补同族词、
 * CJK 长词切 bigram、问句外壳词不进补充词。
 *
 * 三条纪律：
 *   1) **只做加法**：主路结果一条不删、分数一分不动；补充命中追加在后并标 viaRewrite；
 *   2) **只在主路不足时才补**（默认不足 3 条），避免日常查询被噪声稀释；
 *   3) **可一键关**（opts.rewrite === false）：关掉后逐字等于旧行为，便于 A/B 与回归。
 */
export function searchSessions(db: DB, opts: SearchOptions): SearchHit[] {
  const hits = searchOnce(db, opts);
  if (opts.rewrite === false) return hits;

  const limit = opts.limit ?? 20;
  const below = opts.rewriteBelow ?? 3;
  // 触发判据 = **主路不够硬**，不是"条数不够"。
  // 第一版写成「命中满 limit 就跳过」，实测几乎永不触发——FTS 对任何查询都能凑满 10 条，
  // 于是改写约等于没开（大白话 hit@10 只从 17 涨到 18）。改成看**覆盖度**：
  //   主路 top-1 覆盖了全部查询单元（coverage >= 1）= 硬信号 → 不改写；
  //   否则（拆词拆坏 / 问句外壳词多 / 只覆了一半）→ 补一路。
  // ⚠️ 先判空：limit 可以是 0，或者查询零命中 —— 直接读 hits[0].coverage 会炸
  //   （实测：test/integration/deep.spec.ts 用 limit:0 打过这条路）。
  const strong = hits.length > 0 && hits.length >= Math.min(limit, below) && hits[0].coverage >= 1;
  if (strong) return hits;

  const primary = parseQuery(opts.query);
  const tokens = primary.units.flat();
  if (tokens.length === 0) return hits;

  const rw = rewriteQuery(tokens, (t) => segment(t, { keepSingles: false }));
  if (rw.extraUnits.length === 0) return hits;

  // 补充路用 OR（避免 AND 把补充词也卡死）
  const extraQuery = rw.extraUnits.flat().join(' ');
  const extra = searchOnce(db, { ...opts, query: extraQuery, rewrite: false, limit });
  const existing = new Set(hits.map((h) => h.sessionId));
  const merged = hits.slice();
  for (const h of extra) {
    if (existing.has(h.sessionId)) continue;   // 主路已命中的不重复计
    existing.add(h.sessionId);
    // 补充命中可信度低于主路：分数打五折 → 排在主路之后，但不至于垫底
    merged.push({ ...h, score: h.score * 0.5, viaRewrite: true });
  }
  return merged.slice(0, limit);
}
