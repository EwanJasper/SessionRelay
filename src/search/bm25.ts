// BM25F（字段加权）+ BM25+（长文偏差修正）—— 打分阶段的两个零成本杠杆
//
// 依据：docs/research/2026-10-18-衍生方向总报告.md §1.5 建议 #1
//   · BM25 Wins at Scale（2607.26497）：约 10M token 以上 dense 才反超 BM25 —— 我们库 ~14MB，
//     远没到该换 embedding 的规模；
//   · BM25F（字段加权：标题/话题 > 正文）+ BM25+（长文偏差修正）是**两个零成本杠杆**。
//
// ⚠️ 与教科书定义的两处**偏差**（必须写明，否则下一个人会以为这里就是 Lucene 的 BM25F/BM25+）：
//   · 索引是 SQLite FTS5，两张 FTS 表都是**单列**（messages_fts(search_text) / sessions_fts(meta_text)）
//     ⇒ **拿不到字段级 tf**。BM25F 因此降级为「打分阶段的字段加权组合」：
//         score = w_body*bodyScore + w_meta*metaScore
//     真正的 BM25F 要按字段加权 tf **再饱和**，那需要多列 FTS + 重建索引（改 store/db.ts）——
//     14MB 的库撑不起那个风险，本轮**不做**。
//   · BM25+ 的 delta 项在数学上是**精确**的：FTS5 的 bm25() = idf·sat，
//     所以 BM25+ = bm25 + idf·delta（每个命中词项各加一次）。tf/dl 只影响 sat 那一半，FTS5 已经算好。
//     idf 用真实 df/N 算（Lucene 口径，见 idfOf）。
//
// 两个开关**默认都关** = 逐字旧行为（验收要求：能做单变量 A/B）。
// 打开方式（优先级 opts > env > 关）：
//   · SearchOptions.bm25f = true | <w_meta>        / 环境变量 SRELAY_BM25F=<w_meta>
//   · SearchOptions.bm25plus = true | <delta>      / 环境变量 SRELAY_BM25PLUS=<delta>
//   config.json 接线要改 src/shared/config.ts（不在本轮写区，清单见交付说明）。
import type { DB } from '../store/db.js';

// ── 实测记录（1021 · **负结果**，如实登记；不许把'看起来会更好'写成收益）──
// 仪器：仓里现成的固定题面（`scripts/recall-bench.ts` 那套，只消费、不修改）
//   · 主样本 `scripts/bench-questions-clean-v3.json`：123 题 / 41 会话 / limit 10。
//     其中 **41.5%** 的 query 是目标会话原文摘抄（字面重合）⇒ 绝对分偏乐观，下表按「摘抄/非摘抄」拆开。
//   · 复验样本 `scripts/bench-questions-clean-v3-full.json`：153 题 / 51 会话（摘抄 39.2%）。
//   · 库：tmp/graph-bench-snapshot.sqlite（620 会话 / 30,701 消息）；产品默认档（rewrite on / fusion 条件 / lengthNorm on），
//     单变量、题面固定、同一进程内交错跑。
//
// 主样本（123 题）hit@10：
//   默认 48.0%（摘抄 58.8% / 非摘抄 40.3%）
//   只开 BM25F w=0.5  → 48.0%（**逐题零变化**：meta 面在 w=0.5 时小到改不动排序）
//   只开 BM25F w=1    → 51.2%（+3.2pt；配对 救回5/打掉1，McNemar p=0.219 —— **不显著**）
//   只开 BM25F w=2    → 50.4%（+2.4pt；+6/−3，p=0.508）
//   只开 BM25+ d=1    → 47.2%（−0.8pt；+3/−4，p=1.000）
//   两个都开(F=1+P=1) → 47.2%（+3/−4，p=1.000）—— **BM25+ 把 BM25F 的那点点数吃掉了**
// 复验样本（153 题）hit@10：默认 49.0% / F=1 49.7%（+0.7pt，+3/−2，p=1.000）/ P=1 49.7% / 两个都开 49.7%
//   ⇒ BM25F 的 +3.2pt 在第二个样本**没有复现**（只剩 +0.7pt）。两样本合看，全部落在噪声内（±1 题 = 0.8pt）。
//
// BM25+ 为什么接近 no-op（结构性，不是实现坏了）：
//   严格 AND 分支里所有候选命中**同一批**词项 ⇒ `Σidf·delta` 是同一个常数 ⇒ 不改变相对顺序；
//   唯一会动排序的是它与 lengthNorm 的乘法交互（长会话的 delta 被更狠地打折）——
//   实测表现为「top-10 集合动了 100+/123 题，但 hit@10 反而 −0.8pt」。
//   ⇒ 在我们「会话级取 max + 严格 AND」的架构里，BM25+ 没有着力点；
//     真要治长会话霸榜，现有的 lengthNorm（打分阶段乘性归一）才是对的那一刀。
//
// 延迟（交错 6 轮 × 123 题 = 738 次/臂，P50/P95 取各轮分位数的中位数）：
//   默认 4.49 / 91.2ms · F=1 4.46 / 85.9ms（−0.7% / −5.9%）· P=1 4.91 / 94.2ms（+9.5% / +3.2%）· 两个都开 4.41 / 90.6ms
//   ⚠️ 机器共享（其他组同时在跑测试），P95 抖动约 ±20%；BM25+ 的 +9.5% P50 来自它多一条聚合（60s 缓存一次），在噪声边缘。
//   **默认档（两个开关都关）与改动前逐题等价：123/123 题 top-10 完全一致 ⇒ 默认延迟零变化。**
//
// 结论：**两个杠杆都没有可复现的收益**。保持默认关；不推荐开（BM25+ 还有轻微负向）。
//   要再试的前提：题面扩到 ≥300 题（现在 +3.2pt 只是 4 道题）再谈，别拿这一轮的数字做产品决策。
// ── 默认值（bench 扫出来的，不是拍脑袋；扫描记录见交付说明）──
/** BM25F 的 meta 字段权重默认值。0.5 = 「meta 与『旧行为里 meta-only 命中』同权」，
 *  是唯一一个**不改变 meta-only 会话相对位置**的取值（旧行为：meta-only 得 score*0.5）。
 *  扫描区间 0.25 / 0.5 / 1 / 2（同一批 123 题、同一库、单变量）。
 *  实测 w=0.5 逐题零变化；w=1 是唯一略涨的档但**不显著**（见下方实测记录）。 */
export const BM25F_DEFAULT_META_WEIGHT = 0.5;
/** BM25+ 的 delta 默认值。1.0 是 BM25+ 论文常见区间（[0.5, 2]）中位数附近；
 *  bench 扫 0.5 / 1 / 2 后**没有一档优于基线**（见下方实测记录：接近结构性 no-op）——
 *  这个默认值只是「开关打开时用的那个数」，别读成「推荐打开」。 */
export const BM25PLUS_DEFAULT_DELTA = 1;

export interface Bm25Tuning {
  /** null = 关（逐字旧行为）；数值 = meta 字段权重 w（score = body + w*meta） */
  metaWeight: number | null;
  /** null = 关；数值 = BM25+ delta（score += idf·delta，按命中词项累加） */
  delta: number | null;
}

/** 读环境变量：给了但不是非数字 → **吼一声并按关闭处理**（容错不许静默，也不许悄悄改成别的默认值） */
function envNumber(name: string): number | null {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return null;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < 0) {
    console.warn('[bm25] 环境变量 ' + name + '=' + raw + ' 不是非负数，按**关闭**处理（排序逐字等于旧行为）');
    return null;
  }
  return v;
}

/** 把一个开关的三种写法归一：false/0/未给 = 关；true = 默认值；正数 = 该数值 */
function knob(v: boolean | number | null | undefined, fallback: number): number | null {
  if (v === undefined || v === null || v === false) return null;
  if (v === true) return fallback;
  return Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * 解析本轮的打分开关。**唯一入口**（引擎/测试/基准都走这里，别在别处再写一份默认值）。
 * 优先级：显式 opts > 环境变量 > 关。
 */
export function resolveBm25Tuning(
  opts?: { bm25f?: boolean | number | null; bm25plus?: boolean | number | null } | null,
): Bm25Tuning {
  const fOpt = knob(opts?.bm25f, BM25F_DEFAULT_META_WEIGHT);
  const dOpt = knob(opts?.bm25plus, BM25PLUS_DEFAULT_DELTA);
  const fEnv = envNumber('SRELAY_BM25F');
  const dEnv = envNumber('SRELAY_BM25PLUS');
  return {
    metaWeight: fOpt !== null ? fOpt : (fEnv !== null && fEnv > 0 ? fEnv : null),
    delta: dOpt !== null ? dOpt : (dEnv !== null && dEnv > 0 ? dEnv : null),
  };
}

/** BM25F 的打分（字段加权组合）。w=0 时等于「只看正文」。 */
export function fieldWeightedScore(bodyScore: number, metaScore: number, w: number): number {
  const b = Number.isFinite(bodyScore) ? bodyScore : 0;
  const m = Number.isFinite(metaScore) ? metaScore : 0;
  return b + w * m;
}

/** 标准 BM25 的 idf（Lucene/BM25+ 口径）：log(1 + (N-df+0.5)/(df+0.5))，恒 ≥ 0。 */
export function idfOf(nDocs: number, df: number): number {
  const n = Math.max(1, Math.trunc(Number(nDocs) || 0));
  const d = Math.max(0, Math.min(Math.trunc(Number(df) || 0), n));
  return Math.max(0, Math.log(1 + (n - d + 0.5) / (d + 0.5)));
}

/** BM25+ 的 delta 项：Σ_{命中词项} idf·delta（delta 本身不做长度归一——这是 BM25+ 的定义） */
export function bm25PlusBoost(matchedIdfSum: number, delta: number): number {
  const s = Number.isFinite(matchedIdfSum) ? Math.max(0, matchedIdfSum) : 0;
  return Number.isFinite(delta) ? delta * s : 0;
}

export interface CorpusStats { nDocs: number }

/** N 的缓存时长：库在变，但 idf 对 N 的敏感性极低，60s 足够且省掉每题一条聚合 */
export const CORPUS_STATS_TTL_MS = 60_000;
const statsCache = new WeakMap<object, Map<string, { n: number; at: number }>>();

/**
 * 语料统计（只算 N = 本项目的消息数，供 idf 用）。
 *
 * ⚠️ 这是本模块**自己的独立聚合语句**：不改任何现有检索查询、不动 WHERE/superseded 过滤
 *   （那条在别的组手里）。只在 BM25+ 打开时才会被调用。
 */
export function corpusStatsOf(db: DB, project: string, now = Date.now()): CorpusStats {
  let byProject = statsCache.get(db as unknown as object);
  if (!byProject) { byProject = new Map(); statsCache.set(db as unknown as object, byProject); }
  const cached = byProject.get(project);
  if (cached && now - cached.at < CORPUS_STATS_TTL_MS) return { nDocs: cached.n };
  const row = db.prepare(
    'SELECT COUNT(*) AS n FROM messages m JOIN sessions s ON s.id = m.session_id WHERE s.project_id = ?',
  ).get(project) as { n: number } | undefined;
  const n = Number(row?.n ?? 0);
  byProject.set(project, { n, at: now });
  return { nDocs: n };
}

export const bm25Api = {
  resolveBm25Tuning, fieldWeightedScore, idfOf, bm25PlusBoost, corpusStatsOf,
  BM25F_DEFAULT_META_WEIGHT, BM25PLUS_DEFAULT_DELTA,
};