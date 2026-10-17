// 搜索引擎 Spike（方针 §6.3 / 技术方案 §六）：
// - 双索引面：messages_fts（正文主面）+ sessions_fts（meta 模式/元数据命中）
// - 会话级 AND 覆盖度：query 的每个单元都必须被会话覆盖（可跨消息，满足 C4）
// - AND 零命中 → OR 兜底（Spike 决策：满足 C2「认证方案」命中「用 JWT 做认证」这类
//   用户只记得部分关键词的真实查询；待回填技术方案 §6.1）
// - 合并确定性：messages 命中优先于 meta 命中（技术方案 T27）
import type { DB, } from '../store/db.js';
import { parseQuery, unitExpr, segment } from '../core/tokenize/tokenizer.js';
import { applyDecay, ageMsOf, type DecayConfig } from '../core/decay/decay.js';
import { rewriteQuery } from '../core/tokenize/rewrite.js';
import { expandQueryTags } from '../core/graph/expand.js';
import type { QueryExpansion, ExpansionTerm } from '../core/graph/expand.js';

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
  /** [1016] 子串路（不走分词器）命中 */
  viaLike?: boolean;
  /** [1016] 多路融合后**多路互证**的命中 */
  viaRRF?: boolean;
  /** [1017 夜 · 标签图谱] 由**标签共现扩展**补进来的命中（与语义路同构：只做加法，可标记可统计） */
  viaTag?: boolean;
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

/**
 * 语义命中保底槽位默认值（唯一一处；engine 与 CLI status 共用）。
 *
 * [1020 实测] **语义档默认关，且实测开它不划算** —— 用 978 道基准题面采 80 题量：
 *   · 语义开（保底 3 槽）：hit@10 = **40.0%**，单次检索 **610ms**
 *   · 语义开（保底 1 槽）：hit@10 = **43.8%**
 *   · 语义**关**          ：hit@10 = **45.0%**，单次检索 **284ms**
 * ⇒ 召回差异（40% vs 45%，n=80）**在统计噪声内**，但延迟差异 2.15 倍不是噪声。
 *   机制：保底槽位从 FTS 尾部**抢走**名额给语义结果，而语义选得不如 FTS。
 * 这与历史记录一致：交接 §15 记的「一代纯 RRF 已证否回滚」、语义臂参数扫描 hit@1 几乎没动
 *   （McNemar p=1.000）。**两次独立测量同向。**
 * 结论：保持默认关。要开的话把本值降到 1（实测比 3 好），别用 3。
 */
export const DEFAULT_RESERVE_SLOTS = 3;

export interface SearchOptions {
  project: string;
  query: string;
  limit?: number;
  extraWhere?: ExtraWhere | null;
  /**
   * [1021] 多单元按 **OR** 组合（默认 AND）。仅供**查询改写路**使用。
   *
   * 为什么必须单独有这个开关：`fusedSearch` 里补一句
   *   `// 补充路用 OR（避免 AND 把补充词也卡死）` —— 但实现是 `extraUnits.flat().join(' ')`，
   *   而 `parseQuery` 会把空格拆成**多个单元**、`searchOnce` 又做**会话级 AND**。
   *   ⇒ 注释说 OR、代码做 AND，**意图与实现不符**（这次实测把它抓出来了）。
   *   后果：「磁盘空间不足」的补充词被拼成「硬盘 盘 存储 容量 盘空」⇒ 五词全中才算命中 ⇒ 恒空
   *   ⇒ 改写路等于没工作，所以加族、加子词回退全都没效果。
   *   （实测佐证：「盘」单独搜时目标会话在 top-10；拼成五词 AND 就没了。）
   */
  orUnits?: boolean;
  /** [1021] 时间衰减配置（不传/未启用 = 与旧行为逐字等价）。由调用方从 cfg.decay 传入。 */
  decay?: import('../core/decay/decay.js').DecayConfig;
  /** 语义命中保底槽位数（默认 3；0 = 旧行为）。CLI 的 semantic status 也读它，避免两处各写一个 3。 */
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
  /**
   * [1016] 多路加权融合（二代）。**产品默认 = 不融合**（见 searchSessions 里那段闸门注释：
   * 2026-10-17 实测默认档 0/198 条查询走到融合 ⇒ 条件那条分支实际是死代码）。
   * 传 true 强制融合：只用于基准 A/B；传 false 逐字走改写补充。
   * 想重新启用条件融合，要先把判据改了再量（`scripts/recall-bench.ts --fusion 1` 是现成的对照臂）。
   */
  fusion?: boolean;
  /**
   * [1016 A5] 长度归一化：**默认开**（用户 2026-10-16 拍板）。`lengthNorm: false` 才关，用于 A/B。
   *
   * 它做什么：`score *= 1 / (1 + log10(1 + message_count / LEN_PENALTY_PIVOT))` —— 给"两三千条消息的巨无霸"降权。
   * 为什么必须在**打分阶段**做：那种会话什么词都碰得到，在每一条路上都是第一名；事后乘系数改不动这件事。
   *
   * 证据（两边都有，一并留档，别只引对自己有利的一半）：
   *   · 自然混合（129~143 题/臂，公平出题口径）：三臂 hit@1 全涨（K +6.2 / S +16.3 / M +21.7 个百分点），hit@10 也涨；
   *   · 20 问人类基准：关键词 15/16/20 不变；大白话 hit@1 10→11、hit@10 18→19；
   *   · **反向代价**：反向出题"答案恰好是那个巨无霸"时 hit@1 21.4%→9.5%；20 问里有一组短题面大白话 hit@1 −2。
   * 净判断：日常问法里"答案在巨型老会话里"是小概率，用户在 2026-10-16 明确选择开启；
   * 但如果以后发现某些问法变差，第一个该动的是**衰减曲线的常数**（改大 = 更温和），不是这条开关。
   * [1021] 那个常数已收敛为 `LEN_PENALTY_PIVOT`（见文件下方 lenPenaltyOf），别再内联写 300。
   */
  lengthNorm?: boolean;
  /**
   * [1017 夜 · 标签图谱] 查询扩展开关（**默认关**；实测数字与结论见 DEFAULT_TAG_EXPAND 注释）。
   *
   * 它做什么：查询词 → 命中标签 → 沿共现边扩 1~2 跳 → 扩展词构成**一条补充路**。
   * 只做加法：主路结果一条不删、分数一分不动（与 rewrite / semantic 两条补充路同一纪律）。
   */
  tagExpand?: boolean;
  /** 扩展路的保底槽位：0 = 只追加在尾部（主路不满 10 条时才有位置）；N = 从主路尾部腾 N 个 */
  tagReserve?: number;
  /** 扩展跳数（默认 1；2 跳实测变成噪声放大器） */
  tagHops?: number;
  /** 扩展词上限（默认 4） */
  tagMaxTerms?: number;
  /**
   * 扩展路走**加权融合**（进 fusedSearch 当一条权重 0.5 的路目）而不是追加。
   * 为什么需要这个选项：追加模式下主路满 10 条就结构性拿不到位置（与语义路同病），
   * 只有并进融合才可能靠分数挤进前列 —— A/B 要能把这两件事分开量。
   */
  tagInFusion?: boolean;
  /** 扩展明细（可解释）：传一个空对象进来，本次检索把它填满 —— 调用方「打印这个词扩成了哪些词」靠它 */
  tagTrace?: TagTrace | null;
}

/** 一次查询扩展的溯源信息（**排查「为什么扩成这些词」的唯一入口**） */
export interface TagTrace {
  query: string;
  tokens: string[];
  seeds: Array<{ token: string; tag: string; kind: string; how: string; score: number }>;
  terms: Array<{ name: string; kind: string; score: number; path: string[] }>;
  /** 扩展路自己召回了多少会话 */
  pathHits: number;
  /** 没扩出东西的原因（空串 = 正常扩展） */
  why: string;
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

  // ── [1021] 子词回退（治「换说法搜不到」的**第二个机制**）──
  //   实测背景：查询「磁盘空间不足怎么办」找不到标题「我他妈C盘他妈爆炸，就他妈三个G了」的那场。
  //   逐词拆开看（目标会话内实测）：
  //     「空间」   → 命中 1 条消息  ✓ 找得到
  //     「磁盘空间」→ 命中 0 条      ✗ 分词器把「空间」吞进了「磁盘空间」
  //     「不足」   → 命中 0 条      ✗
  //   ⇒ 三个单元**全部零命中** ⇒ 掉进 OR 兜底 ⇒ 被「怎么/办」这类虚词匹配的垃圾淹没。
  //   **目标本来能被「空间」找到，但那个词从来没被查过** —— 这不是语义问题，是分词粒度问题。
  //   修法（经典 IR 的 backoff）：**整个 AND 结果为空**时（不是「某单元零命中」——
  //     实测「磁盘空间/不足/怎么办」三个单元**各自都有几十条命中**，只是三者交集为空），
  //     把长中文单元拆成 2 字滑窗，命中的子词并进 OR 兜底池。
  //   ⚠️ 触发条件必须是「AND 为空」：这样正常情况下**一个字都不会多查**，零回归。
  //   只拆长度 ≥3 的纯中文串（「磁盘空间」→ 磁盘/盘空/空间）；长度 2 拆了只剩单字，噪声太大不做。
  const backoffHits: Array<Map<string, { score: number; rid: number }>> = [];
  const AND_EMPTY = (() => {
    if (units.length === 0) return true;
    let cur: Set<string> | null = null;
    for (const uh of unitHits) {
      const keys: Set<string> = new Set<string>(Array.from(uh.map.keys()) as string[]);
      if (cur === null) { cur = keys; } else {
        const prev: Set<string> = cur;
        cur = new Set<string>(Array.from(prev).filter((k: string) => keys.has(k)));
      }
      if (cur.size === 0) return true;
    }
    return (cur?.size ?? 0) === 0;
  })();
  if (TOKEN_BACKOFF && AND_EMPTY) {
    for (const u of units) {
      const cjk = u.join('');
      if (!/^[\u4e00-\u9fff]{3,}$/.test(cjk)) continue;    // 只拆纯中文长串
      const subs = new Set<string>();
      for (let k = 0; k + 2 <= cjk.length; k++) subs.add(cjk.slice(k, k + 2));
      for (const sub of subs) {
        const h = queryUnit(db, unitExpr([sub]), opts.project, opts.extraWhere);
        if (h.map.size > 0) backoffHits.push(h.map as never);
      }
    }
  }

  // 会话级 AND：所有单元都被覆盖（跨消息）；零命中 → OR 兜底
  // [1021] `opts.orUnits` 时**直接走并集**（改写路用，见 SearchOptions.orUnits 的说明）
  let sids: string[] = [];
  const andMap = new Map<string, number>();
  if (opts.orUnits) {
    for (const uh of unitHits) for (const [sid, v] of uh.map) andMap.set(sid, (andMap.get(sid) ?? 0) + v.score);
    sids = [...andMap.keys()];
  } else for (const uh of unitHits) {
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
    // [1021] 子词回退池也并进来（见上方 TOKEN_BACKOFF 说明）。
    //   注意用**较低的权重**（×0.6）：整词命中永远优先于拆出来的子词，
    //   否则「空间」会把所有含「空间」的会话都顶上来，压过真正按整词命中的那些。
    for (const m of backoffHits) for (const [sid, v] of m) union.set(sid, (union.get(sid) ?? 0) + v.score * 0.6);
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
  // ── [1021] meta 双路命中加分（此前被**整个丢弃**）──
  //   原实现：`if (hits.some(sid)) continue;` —— 会话只要在 messages 路出现过，
  //   meta 路（标题/决策/话题）的命中就**完全不参与打分**，只用于捞 messages 路没找到的会话。
  //   后果：一个会话「正文里只是擦边提了一句、但标题或决策里就是主题」时，
  //   它拿到的仍是那个擦边的弱分，然后被别的会话挤出 top-10。
  //   这正是「词明明在会话里却排不进前 10」最可能的成因之一（另一种是 BM25 本身）。
  //   修法：双路都命中 ⇒ 在既有分上**再加** meta 分（权重 META_BOOST）。
  //   ⚠️ 保留「messages 路已有的 snippet/seq」不动 —— 只是加分，不换代表消息。
  //   ⚠️ 这是**默认关**的实验旋钮：先量再接（见 META_BOOST 常量处的说明）。
  for (const [sid, sc] of metaHits) {
    const existing = hits.find((h) => h.sessionId === sid);
    if (existing) {
      // 双路命中：加分（META_BOOST=0 时等于旧行为）
      if (META_BOOST > 0) { existing.score += sc * META_BOOST; existing.viaMeta = true; }
      continue;
    }
    hits.push({ sessionId: sid, score: sc * 0.5, snippet: '', viaMeta: true, coverage: coverageOf(sid), seq: 0 });
  }

  // [1016 A5] 长度归一化：BM25 的 b 参数思想——长文档天然容易命中更多词，不打折就会霸榜。
  // 实测依据：20 问基准里 9/20 的 top1 落在两三千条消息的会话上；且大样本里 RRF 融合
  // 也栽在这（每条路它都第一）⇒ 必须**在打分阶段**压，而不是事后乘系数。
  // 默认开（`lengthNorm: false` 才关）。⚠️ 原先这里把 SQL 写成一串 String.fromCharCode —— 那是
  // "别用字符串拼接生成代码"那条教训被过度执行的产物，可读性为零；直接写字面量与参数绑定就够了。
  // ── [1021] 覆盖率加权（治「换说法搜不到」的**机制**问题）──
  //   实测背景：换说法题 15 条 hit@10 只有 4/15 = 26.7%。
  //   拆开看，最典型的失败是「磁盘空间不足怎么办」找不到标题为「所有盘都爆炸了没空间了」的那场 ——
  //   两者**共享『空间』**，本该命中。
  //   根因在 186-208 行的组合语义：多词走**严格 AND**（所有词都要覆盖），零命中才**OR 兜底**；
  //   而兜底里 `score` 只是各词 BM25 相加 —— **命中 1 个词和命中 3 个词的会话，分数量级接近**，
  //   于是被「怎么/办」这类高频虚词匹配到的垃圾会话挤进 top-10。
  //   `coverage`（覆盖了几个词）**本来就算好了**，但只当排序 tiebreaker，不参与打分 —— 白算。
  //   修法：score *= (1 + COVERAGE_BOOST * coverage²)，覆盖越多加权越猛（平方是为了拉开差距：
  //   覆盖 1/3 加 0.4×，覆盖 2/3 加 1.6×，覆盖 3/3 加 3.6×）。零模型、纯算术、无额外查询。
  //   COVERAGE_BOOST=0 时等于旧行为，便于单变量 A/B。
  if (COVERAGE_BOOST > 0 && hits.length > 0) {
    for (const h of hits) {
      const cov = Math.max(0, Math.min(1, h.coverage ?? 0));
      h.score *= 1 + COVERAGE_BOOST * cov * cov;
    }
  }

  if (opts.lengthNorm !== false && hits.length > 0) {
    const ids = hits.map((h) => h.sessionId);
    const ph = ids.map(() => '?').join(',');
    try {
      const rows = db.prepare('SELECT id, message_count AS c FROM sessions WHERE id IN (' + ph + ')').all(...ids);
      const pen = new Map();
      // 用唯一实现 lenPenaltyOf()，不再内联一份（见函数定义处的 R10 说明）
      for (const r of rows as Array<{ id: string; c: number }>) pen.set(r.id, lenPenaltyOf(Number(r.c || 0)));
      for (const h of hits) h.score = h.score * (pen.get(h.sessionId) || 1);
    } catch { /* 取不到就不惩罚 */ }
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
    const extra: SearchHit[] = [];
    const existing = new Set(hits.map((h) => h.sessionId));
    for (const sh of opts.semanticHits) {
      if (existing.has(sh.sessionId)) continue;
      existing.add(sh.sessionId);
      const title = (db.prepare('SELECT title FROM sessions WHERE id = ?').get(sh.sessionId) as { title: string | null } | undefined)?.title;
      extra.push({ sessionId: sh.sessionId, score: sh.score, snippet: title ?? '', viaMeta: false, coverage: 0, seq: 0, viaSemantic: true });
    }
    const reserve = Math.min(opts.semanticReserve ?? DEFAULT_RESERVE_SLOTS, Math.floor(limit / 3));
    return mergeAdditive(hits, extra, reserve, limit);
  }
  return hits.slice(0, limit);
}

/**
 * 补充路的**唯一**合并判据（语义路、标签图谱路都走这里；不许谁再抄一份）。
 *
 * 三条都由病历逼出来：
 *   ① 主路结果**一条不删、顺序不动** —— 补充路的判断力一定不如主路，它只许「填空」；
 *   ② reserve = 保底槽位：主路已满 limit 时补充路结构性进不来（语义那次实测过），所以从**尾部**腾位；
 *      取 0 = 只追加，等于「主路不满时才有位置」，是 A/B 的对照组口径；
 *   ③ 去重要连**补充路内部**也去（原先只跟主路比，同一条补充命中出现两次会占两个槽位）。
 */
function mergeAdditive(hits: SearchHit[], extra: SearchHit[], reserve: number, limit: number): SearchHit[] {
  const seen = new Set(hits.map((h) => h.sessionId));
  const fresh: SearchHit[] = [];
  for (const h of extra) {
    if (seen.has(h.sessionId)) continue;
    seen.add(h.sessionId);
    fresh.push(h);
  }
  if (fresh.length === 0) return hits.slice(0, limit);
  const take = Math.min(fresh.length, Math.max(0, reserve));
  if (take > 0) return [...hits.slice(0, Math.max(0, limit - take)), ...fresh.slice(0, take)].slice(0, limit);
  return [...hits, ...fresh].slice(0, limit);
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
/**
 * 把时间衰减乘到已排序的命中上（1021 接线用）。
 *
 * · 只乘分数、**不删行** —— 老记录必须还能搜到（decay.ts 的 decayFactor 恒返回 (0,1]，
 *   结构上就不可能过滤，这正是当初选「乘性」而不是「布尔」的原因）。
 * · 年龄取 `last_event_at ?? created_at`：一次 IN 查询批量取，不做 N+1。
 * · 类别固定用 `decision`（检索命中的是会话级记录；未决/经验各有自己的通道，不走这条）。
 */
function applyDecayToHits(db: DB, hits: SearchHit[], cfg: DecayConfig): SearchHit[] {
  const ids = hits.map((h) => h.sessionId);
  const ph = ids.map(() => '?').join(',');
  const ages = new Map<string, string | null>();
  try {
    const rows = db.prepare('SELECT id, COALESCE(last_event_at, created_at) AS at FROM sessions WHERE id IN (' + ph + ')').all(...ids) as Array<{ id: string; at: string | null }>;
    for (const r of rows) ages.set(r.id, r.at);
  } catch { return hits; }   // 取不到就不衰减（宁可不做，也不猜一个年龄出来）
  const now = Date.now();
  // ⚠️ [1021 红队 T10] 原来这里写的是 `h.score * decayFactor(...)` —— **内联乘法**，
  //   绕过了 `decay.ts` 的 `applyDecay()` 守卫（它在 score 非有限/≤0 时**原样返回**）。
  //   于是「判据」又散成了两份：decay.ts 一份、engine.ts 一份，改一处忘一处就分叉。
  //   现在统一走 `applyDecay()` —— 它是这条链上唯一该做乘法的地方。
  return hits
    .map((h) => ({ ...h, score: applyDecay(h.score, ageMsOf(ages.get(h.sessionId), now), 'decision', cfg) }))
    .sort((a, b) => b.score - a.score || (b.coverage ?? 0) - (a.coverage ?? 0));
}

export function searchSessions(db: DB, opts: SearchOptions): SearchHit[] {
  let hits = searchCore(db, opts);
  // ── [1021] 时间衰减接线（模块早就有，但**一直没接进任何检索路径** —— 所以「没有时间衰减」
  //   这句话到此刻为止仍然是真的。本轮把它接上。）
  //   位置选在 searchSessions 出口而不是 searchOnce 里：
  //     子路（改写路/扩展路/融合路）都会调 searchOnce，放在里面会**重复衰减**；
  //     放在出口 = 全部合并完之后乘一次 ⇒ 单一变量，A/B 干净。
  //   语义：只乘排序分数、不过滤（floor 保底 0.25），老记录仍能搜到只是排后面。
  //   默认仍关（见 DEFAULT_DECAY 的理由：本库最老记录只有 66 天，量程外的效应不该进默认档）。
  if (opts.decay?.enabled === true && hits.length > 0) {
    hits = applyDecayToHits(db, hits, opts.decay);
  }
  // [1017 夜 · 标签图谱] 追加式扩展：**在既有全部逻辑之后**再叠加一条补充路。
  // 放在这里而不是塞进 searchCore 里，是为了让「扩展」严格等于「旧行为 + 一条路」——
  // 单一变量，A/B 才干净（历史教训：融合闸门那次对照组是脏的，见 lengthNorm 注释）。
  // 默认值只认 DEFAULT_TAG_EXPAND 这一处（别在调用点再写一个 false —— 那会让「默认是什么」散成 N 份）
  if ((opts.tagExpand ?? DEFAULT_TAG_EXPAND) !== true) return hits;
  if (opts.tagInFusion === true) return hits;   // 融合模式已在 fusedSearch 内部并过路了
  return tagExpandPath(db, opts, hits);
}

/** 原 searchSessions 主体，逐字未改（仅改名）—— 对外行为经 searchSessions 包装后保持不变 */
function searchCore(db: DB, opts: SearchOptions): SearchHit[] {
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
  // [1016] 多路加权融合（第二代；一代 RRF 已证否回滚，见交接 §15）。
  //
  // ⚠️ [1017 夜 实测 · 后被 07:3x 更大样本推翻并订正] 这条闸门**几乎恒真、但不是恒真**：
  //   判据是「主路够硬就不融合」，而「硬」= top-1 覆盖了全部查询单元（coverage≥1）。
  //   主路的 AND 分支**本身就要求每个单元都被覆盖** ⇒ coverage 在绝大多数查询里恒为 1 ⇒ 闸门恒真。
  //   但它**并非数学上恒真**：命中数不足（hits.length < min(limit, below)）时会放行融合。
  //
  // 实测口径（scripts/recall-bench.ts，agent1super 库）：
  //   · 198 条查询（1017 夜）：默认 vs 关掉融合 结果不同 **0/198（0.0%）** ⇒ 当时据此写「死代码」；
  //   · 978 条题面（1017 07:3x，同一脚本、同一库）：**不同 15/978（1.5%）** ⇒ **「死代码」是错的口径**，
  //     正确说法是「**极罕见**（约 1.5% 的查询会真的走融合）」。样本量差 5 倍，结论就变了 ——
  //     这正是「数字必须绑样本与口径」那条纪律的现实教材。
  //   · 另：默认 vs 强制融合 结果不同 **889/978（90.9%）** ⇒ 融合算法本身会大幅改排序，只是默认闸门几乎不放行。
  //   叠加长度归一化（默认开）已把「巨无霸霸榜」从打分源头治了 —— 融合当初要治的正是那个病。
  //   结论：**保留**；若要删或改判据须单独一拍，先过更大样本基准。
  //
  // [复审 C3 后订正措辞] 独立复审指出：15 条里有「条数没变、只是排序变了」的情形，
  //   与我原先写的「有价值的**召回**」有张力。逐条归因（978 条全跑，limit=10，两臂同档）：
  //     完全相同 964 · 纯重排 2 · **既补回又重排 12** · 纯补回 0
  //   ⇒ 准确说法：这 1.5% 的查询**确实走到了融合路径**，效果以「补回 + 重排同时发生」为主（12/14），
  //     纯重排 2 条、纯补回 0 条。**既不是单纯召回增益，也不该当成纯排序副作用** ——
  //     要分清哪一面更重要需单独量 hit@k；当前这条探针只量了「两臂是否不同」。口径如实写明。
  //   下面三条语义不变（fusion:true 仍是基准用的强制臂）：
  //   fusion === true   → **强制融合**（不受闸门限制，用于基准 A/B）：
  //                       否则单/双词查询的 top-1 天然 coverage=1 ⇒ 永远不触发，
  //                       两臂会跑出逐位相同的数字（实测踩过，387 条样本一模一样）。
  //   fusion 默认（未指定）→ 主路不硬时融合；主路够硬（coverage≥1）时逐字不动 ⇒ 关键词查询零回归
  //   fusion === false  → 逐字回旧行为（改写补充那版），供 A/B 与回归
  if (opts.fusion === true) return fusedSearch(db, opts, hits);
  // [1017 夜 · 标签图谱] 扩展路要「并进融合」时才强制走融合：闸门在 main 够硬时不放行，
  // 不强制的话 tag 路在绝大多数查询上根本跑不到（等于开关开着却没生效——最坏的一种失败）。
  if (opts.tagExpand === true && opts.tagInFusion === true) return fusedSearch(db, opts, hits);

  const strong = hits.length > 0 && hits.length >= Math.min(limit, below) && hits[0].coverage >= 1;
  if (strong) return hits;
  if (opts.fusion !== false) return fusedSearch(db, opts, hits);

  const primary = parseQuery(opts.query);
  const tokens = primary.units.flat();
  if (tokens.length === 0) return hits;

  const rw = rewriteQuery(tokens, (t) => segment(t, { keepSingles: false }));
  if (rw.extraUnits.length === 0) return hits;

  // 补充路用 OR（避免 AND 把补充词也卡死）
  // [1021 修复] 原来这里只 join(' ') —— 而 parseQuery 会把空格拆成多个单元、searchOnce 做会话级 AND，
  //   所以「说 OR 做 AND」。实测后果：「磁盘空间不足」的 5 个补充词要求全中 ⇒ 恒空 ⇒ 改写路等于没工作。
  //   现在显式传 `orUnits: true`，才是真的 OR。
  const extraQuery = rw.extraUnits.flat().join(' ');
  const extra = searchOnce(db, { ...opts, query: extraQuery, rewrite: false, orUnits: true, limit });
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

/**
 * [1017 夜 · 标签图谱] 查询扩展的**默认值：关**。这不是保守，是量出来的（978 题配对 A/B，同一库快照、同一批题面、limit=10）：
 *
 *   · 基线（产品默认档）      hit@10 = 552/978 = **56.44%**，单次 12.8ms
 *   · 扩展·追加（reserve 0） hit@10 = 552/978 = **56.44%**（**978/978 题名次完全相同**），14.9ms（1.16x）
 *   · 扩展·保底 3 槽          hit@10 = 540/978 = **55.01%**（逐题 +14 / −26，McNemar p=0.081），14.0ms
 *   · 强制融合 + 扩展路并进融合  hit@10 = 552/978，相对「只强制融合」的 553/978 **−0.1pt**（+16/−17，p=1.000）
 *   · hit@1 在**所有**扩展臂上都一动不动（+0/−0，p=1.000）
 *
 * 机制（两条，都是结构性的，不是「参数再调调」能救的）：
 *   ① **追加式在主路满 10 条时结构性拿不到位置** —— 主路只要凑满 limit，后来者一律被 slice 掉，于是 978 题名次
 *      一模一样。这与语义路当初的病历同型（见 DEFAULT_RESERVE_SLOTS 注释），当时也是靠「保底槽位」才让它可见。
 *   ② **保底槽位是把好结果换下去**：从主路尾部腾 3 个槽，换进来 14 条、挤掉 26 条 —— 因为 FTS 的尾部队列
 *      依然比「共现邻居」更准。同一现象在语义路上也出现过（保底 3 槽 → 40.0%，关掉 → 45.0%）。
 *
 * 更根本的一条：**共现边编码的是「同一份文档/同一个项目」，不是「同义/上位」**。实测证据（同一库）：
 *   · 归档 的邻居是 pipeline.py / ai_judge.py / render_queue.json / 队列 —— 同项目文件，不是「省空间」这类同义说法；
 *   · 空间 只出现在 1 个会话（df=1）⇒ 没有边；而「空间 + 归档」**同会话出现 0 次** ⇒
 *     用户搜「怎么省空间」想找「归档机制」这个 motivating example，**在本库数据上结构性无解**，不是实现不够好。
 *
 * 所以：**保留实现 + 开关默认关**（成本只有一张可重建的表，不影响任何现有路径），不硬上。
 * 要重开只需传 tagExpand: true；若将来要再试，先用 scripts/recall-bench.ts --expand 1 复量，别凭直觉。
 * 唯一的正收益在**可解释的线索发现**上（graph-explain 能打印「这个词扩成了哪些词、怎么来的」），
 * 那是给人看的探索工具，不是召回手段。
 */
export const DEFAULT_TAG_EXPAND = false;
/** 会话长度惩罚：把「两三千条消息的巨无霸」压下去（它什么词都碰得到，是所有路的天然第一名） */
/**
 * 长度惩罚的**唯一实现**（1021 红队 R10 修复）。
 *
 * 原来这条公式在本文件里写了**两遍**：searchOnce 里内联一次、lengthPenalty 里又一次，
 * 常数 300 也各写一遍。这正是之前 A-11 事故的复发现场 —— 当时的教训是
 * 「长度惩罚由**融合**这一步统一做，子路必须关掉 searchOnce 的那次，否则二次乘罚」，
 * 但公式本身仍是两份：改一处忘一处，主路和融合路就会用不同的曲线。
 *
 * 现在收敛到这一个函数 + 一个常量：
 *   `score *= 1 / (1 + log10(1 + message_count / 300))`
 * 给「两三千条消息的巨无霸」降权。常数 300 越小越激进；要调只改 `LEN_PENALTY_PIVOT`。
 */
export const LEN_PENALTY_PIVOT = 300;

/**
 * meta 双路命中加分权重（1021 新增，**默认 0 = 旧行为**）。
 *
 * 背景：`queryMetaUnits` 那条路查的是标题/决策/话题（`sessions.meta_text`），
 * 而原实现里，只要会话已经在 messages 路出现过，meta 命中就**被整个丢弃**（`continue`）。
 * 于是「正文擦边提了一句、但标题就是主题」的会话拿不到它应得的加分。
 *
 * 取值：`score += metaScore * META_BOOST`。0=关（旧行为）；0.5 = 与「只走 meta」同权；
 * 1.0 = 双路等价。用环境变量 `SRELAY_META_BOOST` 覆盖，便于基准做单变量 A/B。
 *
 * ⚠️ **先量再接**：这个值必须先跑基准再定，不要拍脑袋改默认。
 */
/**
 * 覆盖率加权系数（1021 新增，**默认 1.0**）。
 *
 * 意图：多词查询零命中时会走 OR 兜底，而兜底里「命中了几个词」（coverage）原本不参与打分，
 * 于是命中 1 个虚词的会话可能挤掉命中 2-3 个实词的。这里把它乘进去：
 * `score *= 1 + COVERAGE_BOOST * coverage²`。
 * 用环境变量 `SRELAY_COVERAGE_BOOST` 覆盖，便于单变量 A/B。
 *
 * ── ⚠️ [1021 红队 T2 复核后**降级**了这条的结论，务必读完再用] ──
 *   · 我最初测到「换说法 15 题 4/15 → 6/15」，**现在不可复现**。复验（同一批题、当前代码）：
 *        B=0 → 4/15，B=1 → **5/15**，B=10 → **5/15**。
 *     差 1 道题 = 噪声级；而且那次测量是在**时间衰减接入之前**做的，基线已经变了。
 *   · 红队另外指出它是「结构性弱效」：兜底分支里 `score` 本来就大致随 coverage 单调，
 *     `1 + B·cov²` 是 cov 的单变量函数 ⇒ 在许多情况下只是同比例放大，改不动层内顺序。
 *     （不完全等于 no-op —— B 足够大时确实能翻转，实测 B=10 也没多救回来，说明本库数据上用处有限。）
 *   · **结论：这条的价值是「有理论依据、零成本、实测零回归」，不是「显著提升了召回」。**
 *     保留默认开是因为它**没有任何下行的实测证据**（字面 153 题零回归），但我**不再声称**它把换说法救回来了一半。
 *   · 字面基准 153 题：K/S/M 三臂 hit@1/@3/@10 与关闭时完全相同（coverage 恒 1，加权不动）。
 *   · 成本：一次数组遍历 + 两次乘法，零模型零额外查询。
 */
/**
 * 子词回退开关（1021 新增，默认开）。
 *
 * 治的是**分词粒度**问题，不是语义：中文分词会把「空间」吞进「磁盘空间」，
 * 于是查询里那个真正能命中的词**从来没被查过**。
 * 只在某单元**整词零命中**时才拆 2 字滑窗 —— 整词命中过的原样不动，所以零回归。
 * `SRELAY_TOKEN_BACKOFF=1` 可开，便于 A/B。
 *
 * ── 实测结论：**默认关**（负结果，2021 手写换说法 23 题）──
 *   开了与不开 **完全一样**（6/23 → 6/23，命中集合逐条相同）。
 *   排查后确认**不是回退没触发**，而是触发了也没用：
 *     以「磁盘空间不足怎么办」→ 目标「我他妈C盘他妈爆炸」为例，
 *     回退确实把「磁盘空间」拆出「空间」并查了（316 条消息命中），
 *     但**目标会话靠「空间」单独搜也进不了前 10**（实测「空间」的 top-10 里没有它）——
 *     那场只有**一处**顺带提到「空间」，在长对话里按 BM25 排不上来。
 *   ⇒ 这是**真实的检索难度**，不是分词粒度问题；再拆下去也救不回来。
 *   保留代码（默认关）是因为它对**短查询 + 长整词**的场景理论上仍成立，只是本库数据验证不到。
 */
const TOKEN_BACKOFF = process.env.SRELAY_TOKEN_BACKOFF === '1';

const COVERAGE_BOOST = (() => {
  const v = Number(process.env.SRELAY_COVERAGE_BOOST ?? 1.0);
  return Number.isFinite(v) && v >= 0 ? v : 0;
})();

const META_BOOST = (() => {
  const v = Number(process.env.SRELAY_META_BOOST ?? 0);
  return Number.isFinite(v) && v >= 0 ? v : 0;
})();

export function lenPenaltyOf(messageCount: number): number {
  return 1 / (1 + Math.log10(1 + Math.max(0, messageCount) / LEN_PENALTY_PIVOT));
}

function lengthPenalty(db: DB, sids: string[]): Map<string, number> {
  const out = new Map<string, number>();
  if (sids.length === 0) return out;
  const ph = sids.map(() => '?').join(',');
  try {
    const rows = db.prepare('SELECT id, message_count AS c FROM sessions WHERE id IN (' + ph + ')').all(...sids) as Array<{ id: string; c: number }>;
    for (const r of rows) out.set(r.id, lenPenaltyOf(Number(r.c ?? 0)));
  } catch { /* 取不到就不惩罚 */ }
  return out;
}

/** P3 子串路：不走分词器的 LIKE 匹配（jieba 切坏时这条能救） */
function likeHits(db: DB, tokens: string[], project: string, extra: ExtraWhere | null | undefined, limit: number): SearchHit[] {
  const toks = [...new Set(tokens.filter((t) => t.length >= 2))].slice(0, 6);
  if (toks.length === 0) return [];
  const acc = new Map<string, { n: number; c: number; rid: number }>();
  const where = extra ? (' AND ' + extra.sql) : '';
  const params = extra && Array.isArray(extra.params) ? extra.params : [];
  for (const t of toks) {
    const sql = 'SELECT m.session_id AS sid, COUNT(*) AS c, MIN(m.id) AS rid'
      + ' FROM messages m JOIN sessions s ON s.id = m.session_id'
      + ' WHERE m.content LIKE ? AND s.project_id = ?' + where
      + ' GROUP BY m.session_id ORDER BY c DESC LIMIT ?';
    const rows = db.prepare(sql).all('%' + t + '%', project, ...params, Math.max(limit * 3, 30)) as Array<{ sid: string; c: number; rid: number }>;
    for (const r of rows) {
      const prev = acc.get(r.sid);
      acc.set(r.sid, { n: (prev ? prev.n : 0) + 1, c: (prev ? prev.c : 0) + Number(r.c), rid: prev ? prev.rid : r.rid });
    }
  }
  return [...acc.entries()]
        .filter(([, v]) => v.n >= toks.length)
    .sort((a, b) => b[1].n - a[1].n || b[1].c - a[1].c)
    .slice(0, limit)
    .map(([sid, v]) => ({ sessionId: sid, score: v.n, snippet: excerpt(db, v.rid, toks[0]), viaMeta: false, coverage: 0, seq: 0, viaLike: true }));
}


/**
 * [1017 夜 · 标签图谱] 查询扩展路：把扩展词各自搜一遍，按「命中几个扩展词」聚合。
 *
 * 为什么不做成一条多词 AND/OR 查询：扩展词之间是**并列**关系（cpu 的邻居 bm25 / gguf 任一个
 * 命中都算线索），AND 会把它们卡死；OR 又会把「碰巧含一个词」的会话全拉进来。所以按单元分别检索、
 * 再用「互证数」排序 —— 与 fusedSearch 的互证加分同一个思路，但这里只需要名次。
 */
function tagTermHits(db: DB, terms: ExpansionTerm[], opts: SearchOptions): SearchHit[] {
  const limit = opts.limit ?? 20;
  const acc = new Map<string, { n: number; sc: number; rid: number }>();
  for (const t of terms) {
    let uh: UnitHits;
    try {
      uh = queryUnit(db, unitExpr([t.name]), opts.project, opts.extraWhere);
    } catch (e) {
      // 容错不许静默：单个扩展词搜不动只跳过它，但必须说出来
      console.warn('[tag-expand] 扩展词检索失败，已跳过：' + t.name + ' —— ' + String((e as Error)?.message ?? e).slice(0, 120));
      continue;
    }
    for (const [sid, v] of uh.map) {
      const prev = acc.get(sid) ?? { n: 0, sc: 0, rid: v.rid };
      prev.n += 1;
      prev.sc += v.score;
      acc.set(sid, prev);
    }
  }
  const pen = opts.lengthNorm !== false ? lengthPenalty(db, [...acc.keys()]) : new Map<string, number>();
  const ranked = [...acc.entries()].sort((a, b) => {
    if (b[1].n !== a[1].n) return b[1].n - a[1].n;
    return b[1].sc * (pen.get(b[0]) ?? 1) - a[1].sc * (pen.get(a[0]) ?? 1);
  }).slice(0, limit);
  const titleOf = db.prepare('SELECT title FROM sessions WHERE id = ?');
  return ranked.map(([sid, v]) => ({
    sessionId: sid,
    score: v.n + Math.min(1, v.sc * (pen.get(sid) ?? 1) / 10),
    snippet: (titleOf.get(sid) as { title: string | null } | undefined)?.title ?? '',
    viaMeta: false,
    coverage: 0,
    seq: 0,
    viaTag: true,
  }));
}

/** 把一次扩展的溯源信息写进调用方给的 trace 对象（可解释性出口） */
function fillTrace(trace: TagTrace, query: string, tokens: string[], exp: QueryExpansion, pathHits: number): void {
  trace.query = query;
  trace.tokens = tokens;
  trace.seeds = exp.seeds.map((s) => ({ token: s.token, tag: s.tag, kind: s.kind, how: s.how, score: s.score }));
  trace.terms = exp.terms.map((t) => ({ name: t.name, kind: t.kind, score: t.score, path: t.path }));
  trace.pathHits = pathHits;
  trace.why = exp.why;
}

/** 追加式扩展：主路结果原样在前，扩展路命中追加（或按 reserve 从尾部腾位） */
function tagExpandPath(db: DB, opts: SearchOptions, hits: SearchHit[]): SearchHit[] {
  const limit = opts.limit ?? 20;
  const tokens = parseQuery(opts.query).units.flat();
  const exp = expandQueryTags(db, tokens, { hops: opts.tagHops ?? 1, maxTerms: opts.tagMaxTerms ?? 4 });
  const pathHits = exp.terms.length > 0 ? tagTermHits(db, exp.terms, opts) : [];
  if (opts.tagTrace) fillTrace(opts.tagTrace, opts.query, tokens, exp, pathHits.length);
  if (pathHits.length === 0) return hits;
  return mergeAdditive(hits, pathHits, Math.min(opts.tagReserve ?? 0, Math.floor(limit / 3)), limit);
}
/**
 * 多路加权融合（第二版；第一版纯 RRF 实测**负结果**已回滚）。
 *
 * 与第一版的三个关键差别（都是被实测逼出来的）：
 *   ① **不用纯名次，用归一化分数**：(N-i)/N —— 纯 RRF 只看名次，分数是白算的；
 *   ② **长度惩罚进到每条路内部**，而不是融合完再乘：巨无霸在**每一条路**上都是第一名，
 *      事后乘系数改不动这个事实（第一版就栽在这）；
 *   ③ **互证加分削弱**（0.05/条，上限 0.1）：第一版给 0.08/条，等于给巨无霸发奖金。
 */
function fusedSearch(db: DB, opts: SearchOptions, main: SearchHit[]): SearchHit[] {
  const limit = opts.limit ?? 20;
  const tokens = parseQuery(opts.query).units.flat();
  const paths: Array<{ w: number; hits: SearchHit[] }> = [{ w: 1.0, hits: main }];
  const rw = rewriteQuery(tokens, (t) => segment(t, { keepSingles: false }));
  if (rw.extraUnits.length > 0) {
    // [红队 A-11] 长度惩罚由**融合这一步统一做**（见下面的 pen），所以子路必须关掉 searchOnce 的那次，
    // 否则二次乘罚。
    const ex = searchOnce(db, { ...opts, query: rw.extraUnits.flat().join(' '), rewrite: false, limit, lengthNorm: false });
    if (ex.length > 0) paths.push({ w: 0.6, hits: ex });
  }
// ⚠️ 查询里有**短语单元**（带引号的多词）时不加子串路：
  // LIKE 只看「字面包含」，分不出 按月分区 与「先按月再分区」——
  // 实测它把词序不符的会话拉进了结果，违反 C5 短语验收。短语要的是顺序，不是包含。
  const hasPhrase = parseQuery(opts.query).units.some((u) => u.length > 1);
  if (!hasPhrase) {
    try {
      const lk = likeHits(db, tokens, opts.project, opts.extraWhere, limit);
      if (lk.length > 0) paths.push({ w: 0.4, hits: lk });
    } catch { /* LIKE 路失败不影响主路 */ }
  }
  // [1017 夜 · 标签图谱] 扩展路并进融合：权重 0.5（主路 1.0、改写路 0.6、子串路 0.4 之间）。
  // 并进融合而不是追加，是因为追加在主路满 10 条时结构性拿不到位置（语义那次的老病历）。
  if (opts.tagExpand === true) {
    const exp = expandQueryTags(db, tokens, { hops: opts.tagHops ?? 1, maxTerms: opts.tagMaxTerms ?? 4 });
    const tp = exp.terms.length > 0 ? tagTermHits(db, exp.terms, opts) : [];
    if (opts.tagTrace) fillTrace(opts.tagTrace, opts.query, tokens, exp, tp.length);
    if (tp.length > 0) paths.push({ w: 0.5, hits: tp });
  }
  const all: string[] = [];
  const seenSid = new Set<string>();
  for (const p of paths) for (const h of p.hits) if (!seenSid.has(h.sessionId)) { seenSid.add(h.sessionId); all.push(h.sessionId); }
  // [复审 C-4] 融合路也必须认 `lengthNorm` 这个开关，且**口径与主路一致**（默认开、false 才关）。
  // 病历：这里原先无条件惩罚 ⇒ `--lengthnorm 0` 只关了主路、没关融合路，A/B 对照组是脏的
  // （复核实测：只改 message_count，fusion:true 的排序会变，而 fusion:false 不变）。
  const pen = opts.lengthNorm !== false ? lengthPenalty(db, all) : new Map<string, number>();
  const score = new Map<string, number>();
  const nPaths = new Map<string, number>();
  const first = new Map<string, SearchHit>();
  for (const p of paths) {
    const N = Math.max(1, p.hits.length);
    p.hits.forEach((h, i) => {
      const norm = (N - i) / N;
      const w = p.w * norm * (pen.get(h.sessionId) ?? 1);
      score.set(h.sessionId, (score.get(h.sessionId) ?? 0) + w);
      nPaths.set(h.sessionId, (nPaths.get(h.sessionId) ?? 0) + 1);
      if (!first.has(h.sessionId)) first.set(h.sessionId, h);
    });
  }
  const out: SearchHit[] = [];
  for (const [sid, sc] of score) {
    const n = nPaths.get(sid) ?? 1;
    const h = first.get(sid)!;
    out.push({ ...h, score: sc + Math.min(0.1, 0.05 * (n - 1)), viaRRF: n > 1 });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}