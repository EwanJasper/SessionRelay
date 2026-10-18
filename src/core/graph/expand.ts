// 查询扩展：查询词 → 命中标签 → 沿**共现边**扩到 1~2 跳 → 扩展词
//
// 这是「标签关系表」真正被用起来的地方，也是「轻量知识图谱」的查询侧：
//   用户搜「怎么省空间」→ 分词得 空间 → 命中标签 空间 → 共现边找到 归档/清理/压缩 → 一起检索。
//
// 三条纪律（与 engine.ts 里 rewrite/semantic 两条补充路保持一致，别各写一套）：
//   1) **只做加法**：扩展词只构成一条**补充路**，主路结果一条不删、分数一分不动；
//   2) **可解释**：每个扩展词都带着溯源链路（path）+ 分数，explain 能逐条打印「这个词是怎么来的」；
//   3) **可关**：engine 侧 opts.tagExpand 才启用；关掉后逐字等于旧行为。
//
// 为什么用 cosine 边权而不是共现次数：次数会让「到处都有的标签」跟谁都强关联（hub 效应），
// cosine 的分母 √(dfa·dfb) 自动把它们压下去 —— 罕见标签一起出现才是真信息。
import type { DB } from '../../store/db.js';

export interface ExpandOptions {
  /** 参与扩展的种子标签上限（查询词里最多认这么多个标签） */
  maxSeeds?: number;
  /** 扩展跳数（1~2；3 跳实测变成噪声放大器，见 scripts/graph-recall 的实测记录） */
  hops?: number;
  /** 最终交给检索的扩展词上限 */
  maxTerms?: number;
  /** 边的 cosine 权重下限（低于它视为「没有关系」） */
  minEdge?: number;
  /** 太常见的标签不参与扩展（df / 会话数 超过它的，全是「什么会话都沾」的通用词） */
  maxDfRatio?: number;
}

const DEFAULTS = {
  maxSeeds: 8,
  hops: 1,
  maxTerms: 4,
  minEdge: 0.08,
  maxDfRatio: 0.35,
} as const;

export interface SeedInfo {
  /** 查询词元 */
  token: string;
  /** 命中的标签名 */
  tag: string;
  kind: string;
  /** exact = 词元与标签同名；substring = 一个包含另一个 */
  how: 'exact' | 'substring';
  score: number;
}

export interface ExpansionTerm {
  name: string;
  kind: string;
  /** 溯源分数（种子分 × 边权 × 跳数衰减） */
  score: number;
  /** 溯源链路：seed 标签 → ... → 本词（可解释性的载体） */
  path: string[];
}

export interface QueryExpansion {
  tokens: string[];
  seeds: SeedInfo[];
  terms: ExpansionTerm[];
  /** 没扩出东西时的原因（**必须**写清楚：静默不扩展会让「开关开了却没用」无法排查） */
  why: string;
}

interface TagRow { id: number; name: string; kind: string; df: number }

/** 图谱是否已建好（没建就直说，别装样子返回空扩展） */
export function graphStatus(db: DB): { ready: boolean; tags: number; edges: number; sessions: number; why: string } {
  try {
    const tags = (db.prepare('SELECT COUNT(*) AS c FROM graph_tags').get() as { c: number }).c;
    const edges = (db.prepare('SELECT COUNT(*) AS c FROM graph_tag_edges').get() as { c: number }).c;
    const meta = db.prepare('SELECT session_count FROM graph_meta WHERE id = 1').get() as { session_count: number } | undefined;
    if (!tags) return { ready: false, tags: 0, edges: 0, sessions: 0, why: '标签图谱是空的（先跑 node scripts/graph-tag-build.mjs 建表）' };
    return { ready: true, tags, edges, sessions: meta?.session_count ?? 0, why: '' };
  } catch (e) {
    return { ready: false, tags: 0, edges: 0, sessions: 0, why: '标签图谱不可用：' + String((e as Error)?.message ?? e).slice(0, 120) };
  }
}

/**
 * 查询扩展（纯查询侧，零模型）。
 *
 * @param tokens 查询词元（来自 parseQuery，与主查询同源 —— 不要在这里另切一套）
 */
export function expandQueryTags(db: DB, tokens: string[], opts: ExpandOptions = {}): QueryExpansion {
  const cfg = { ...DEFAULTS, ...opts };
  const st = graphStatus(db);
  if (!st.ready) return { tokens, seeds: [], terms: [], why: st.why };

  const norm = tokens.map((t) => t.toLowerCase()).filter((t) => t.length >= 2);
  if (norm.length === 0) return { tokens, seeds: [], terms: [], why: '查询没有可用词元' };

  const seedOf = findSeeds(db, norm, cfg.maxSeeds);
  if (seedOf.length === 0) return { tokens, seeds: [], terms: [], why: '查询词没有命中任何标签（标签表里没有这些词）' };

  const terms = walkGraph(db, seedOf, cfg, st.sessions);
  return {
    tokens,
    seeds: seedOf,
    terms,
    why: terms.length === 0 ? '种子标签没有可用的共现邻居（边太弱或全是通用词）' : '',
  };
}

/** ① 种子：查询词元 ↔ 标签，先精确后子串（CJK 里子串关系很常见：空间 ⊂ 省空间） */
function findSeeds(db: DB, tokens: string[], maxSeeds: number): SeedInfo[] {
  const exact = db.prepare('SELECT id, name, kind, df FROM graph_tags WHERE name = ?');
  const containsTok = db.prepare('SELECT id, name, kind, df FROM graph_tags WHERE instr(name, ?) > 0 AND length(name) <= ? ORDER BY df ASC LIMIT 6');
  const insideTok = db.prepare('SELECT id, name, kind, df FROM graph_tags WHERE instr(?, name) > 0 AND length(name) >= 2 ORDER BY length(name) DESC LIMIT 4');
  const out = new Map<string, SeedInfo>();
  const push = (s: SeedInfo) => {
    const prev = out.get(s.tag);
    if (!prev || prev.score < s.score) out.set(s.tag, s);
  };
  for (const tok of tokens) {
    const hit = exact.get(tok) as TagRow | undefined;
    if (hit) { push({ token: tok, tag: hit.name, kind: hit.kind, how: 'exact', score: 1 }); continue; }
    // 子串：只对 (ge 2) 字的中文词/英文词做，且标签长度不能超出词元太多（否则「空」会匹配一大片）
    for (const r of containsTok.all(tok, tok.length + 2) as TagRow[]) {
      push({ token: tok, tag: r.name, kind: r.kind, how: 'substring', score: 0.6 });
    }
    for (const r of insideTok.all(tok) as TagRow[]) {
      push({ token: tok, tag: r.name, kind: r.kind, how: 'substring', score: 0.5 });
    }
  }
  return [...out.values()].sort((a, b) => b.score - a.score || a.tag.localeCompare(b.tag)).slice(0, maxSeeds);
}

/** ② 沿共现边 BFS（最多 hops 跳，逐跳衰减） */
function walkGraph(db: DB, seeds: SeedInfo[], cfg: Required<ExpandOptions>, sessions: number): ExpansionTerm[] {
  const idOf = new Map<string, TagRow>();
  const byName = db.prepare('SELECT id, name, kind, df FROM graph_tags WHERE name = ?');
  const byId = db.prepare('SELECT id, name, kind, df FROM graph_tags WHERE id = ?');
  const nbrOut = db.prepare('SELECT b AS nid, w FROM graph_tag_edges WHERE a = ? ORDER BY w DESC LIMIT 60');
  const nbrIn = db.prepare('SELECT a AS nid, w FROM graph_tag_edges WHERE b = ? ORDER BY w DESC LIMIT 60');
  const info = (id: number): TagRow | undefined => {
    if (idOf.has(String(id))) return idOf.get(String(id));
    const r = byId.get(id) as TagRow | undefined;
    if (r) idOf.set(String(id), r);
    return r;
  };

  const maxDf = Math.max(2, Math.floor(sessions * cfg.maxDfRatio));
  const best = new Map<string, ExpansionTerm>();
  let frontier: Array<{ name: string; score: number; path: string[] }> = [];
  for (const s of seeds) {
    const row = byName.get(s.tag) as TagRow | undefined;
    if (!row) continue;
    idOf.set(String(row.id), row);
    frontier.push({ name: s.tag, score: s.score, path: [s.tag] });
  }

  for (let hop = 1; hop <= cfg.hops && frontier.length > 0; hop++) {
    const next: Array<{ name: string; score: number; path: string[] }> = [];
    const damp = hop === 1 ? 1 : 0.5;
    for (const node of frontier) {
      const row = [...idOf.values()].find((r) => r.name === node.name);
      if (!row) continue;
      const edges = [...(nbrOut.all(row.id) as Array<{ nid: number; w: number }>), ...(nbrIn.all(row.id) as Array<{ nid: number; w: number }>)];
      for (const e of edges) {
        if (e.w < cfg.minEdge) continue;
        const nb = info(e.nid);
        if (!nb) continue;
        if (nb.df < 2 || nb.df > maxDf) continue;      // 孤词没有关系；通用词没有指认力
        const score = node.score * e.w * damp;
        const path = [...node.path, nb.name];
        const prev = best.get(nb.name);
        if (!prev || prev.score < score) best.set(nb.name, { name: nb.name, kind: nb.kind, score, path });
        next.push({ name: nb.name, score, path });
      }
    }
    frontier = next;
  }

  const seedNames = new Set(seeds.map((s) => s.tag));
  return [...best.values()]
    .filter((t) => !seedNames.has(t.name))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, cfg.maxTerms);
}

/** 可解释输出（排查「为什么扩展出这个词」时的唯一入口） */
export function formatExpansion(exp: QueryExpansion): string {
  if (exp.seeds.length === 0) return '（未命中标签：' + exp.why + '）' + (exp.tokens.length ? ' 词元=' + exp.tokens.join('/') : '');
  const lines = exp.seeds.map((s) => `  ${s.token} → 标签 ${s.tag}[${s.kind}] ${s.how} ${s.score.toFixed(2)}`);
  if (exp.terms.length === 0) lines.push('  扩展词：无（' + exp.why + '）');
  else {
    lines.push('  扩展词：' + exp.terms.map((t) => `${t.name}(${t.score.toFixed(2)})`).join(' '));
    for (const t of exp.terms) lines.push('    ' + t.name + ' ⇐ ' + t.path.join(' → '));
  }
  return lines.join('\n');
}
