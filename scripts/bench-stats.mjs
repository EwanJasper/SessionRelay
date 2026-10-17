// bench-stats.mjs —— 评测比较用的统计，唯一一份。
//
// 为什么单独成文件：bench-compare.mjs 里有 top-level 副作用（读 argv），没法单测；
//   而这三个函数恰恰最容易写错、又最容易被当成「反正跑出数字了」的地方。
//   抽出来，test/unit/bench-stats.spec.ts 就能用构造数据把它们逐个钉死。
//
// 本文件只认**配对**数据：同一道题在 A / B 两个配置下的结果。
//   绝对值正负 CI 那条路在本题集上走不通 —— 305 题只落在 105 个会话上，题间不独立。

/** 线性插值分位数（已排序数组）。 */
export function pct(sorted, p) {
  if (!sorted.length) return NaN;
  const i = (sorted.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

/**
 * 【旧口径】按**题**重采样的配对差值 bootstrap。
 *
 * 留着它不是因为它对，是因为它是**错的基线**：跑两种口径并排，才能看出
 *   「按题重采样」把 CI 压窄了多少。数据集独立时它对；本题集不独立。
 */
export function pairedDiffCI(a, b, iters = 10000, seed = 0xbeef) {
  const n = a.length;
  if (!n) return null;
  const d = a.map((x, i) => x - b[i]);
  const mean = d.reduce((s, x) => s + x, 0) / n;
  const rand = rng(seed);
  const out = new Array(iters);
  for (let t = 0; t < iters; t++) {
    let sum = 0;
    for (let k = 0; k < n; k++) sum += d[Math.floor(rand() * n)];
    out[t] = sum / n;
  }
  out.sort((x, y) => x - y);
  return { mean, lo: pct(out, 0.025), hi: pct(out, 0.975), unit: "question" };
}

/**
 * 【正确口径】按**簇（会话）**重采样的配对差值 bootstrap。
 *
 * 为什么必须按簇：本题集的 305 道题只落在 105 个会话上（同一会话最多 3 题），
 *   同一会话出的题高度相关 —— 答对一道，另一道也常常答对。按题独立重采样等于
 *   假装有 305 个独立样本，CI 会被系统性压窄（假窄），于是「改了 2pt 就说显著」。
 *   按簇重采样：抽一个会话，它名下的题**一起进出**，簇内相关性被如实带进方差。
 *
 * pairs: [{ target, a, b }]，a / b 是 0|1 或分数。
 */
export function clusterDiffCI(pairs, iters = 10000, seed = 0xc0ffee) {
  if (!pairs.length) return null;
  const groups = new Map();
  for (const p of pairs) {
    const key = p.target == null ? "" : String(p.target);
    let g = groups.get(key);
    if (!g) { g = { sum: 0, n: 0 }; groups.set(key, g); }
    g.sum += p.a - p.b;
    g.n += 1;
  }
  const cl = [...groups.values()];
  const N = cl.length;
  const mean = pairs.reduce((s, p) => s + (p.a - p.b), 0) / pairs.length;
  const rand = rng(seed);
  const out = new Array(iters);
  for (let t = 0; t < iters; t++) {
    let sum = 0, cnt = 0;
    for (let k = 0; k < N; k++) {
      const g = cl[Math.floor(rand() * N)];
      sum += g.sum; cnt += g.n;
    }
    out[t] = cnt ? sum / cnt : 0;
  }
  out.sort((x, y) => x - y);
  return { mean, lo: pct(out, 0.025), hi: pct(out, 0.975), clusters: N, unit: "cluster" };
}

/**
 * McNemar 精确检验（配对二分类）。
 *
 * 输入只用到两个数：b = 「A 对、B 错」的题数，c = 「B 对、A 错」的题数。
 *   两张都对的、都错的，对「谁更好」没有信息量，不进统计量 —— 这正是配对设计的全部好处。
 * 零假设：b 和 c 是同一个硬币的两面（各 1/2）。用**精确二项**而不是卡方近似：
 *   b+c 常常只有十几，卡方近似在这个量级不可靠。
 */
/** log(exp(a) + exp(b))，防止中间量上下溢。 */
function logAddExp(a, b) {
  const m = Math.max(a, b);
  if (m === -Infinity) return -Infinity;
  return m + Math.log(Math.exp(a - m) + Math.exp(b - m));
}

export function mcnemar(b, c) {
  const n = b + c;
  if (n === 0) return { b, c, n: 0, p: 1, delta: 0 };
  const k = Math.min(b, c);
  // ⚠️ 必须在**对数空间**累加：原实现用 Math.pow(0.5, n)，n ≥ 1075 时下溢成 0 ⇒ p 恒 0 ⇒
  //   任何比较都输出「★显著」。红队实测 (700,650) 应为 p=0.1823（不显著），实际给 0。
  //   题集从 94 扩到 305 走过一次，再扩一倍就会撞上；这种错不会报错，只会让人下错结论。
  let logTerm = -n * Math.LN2;    // log P(X = 0)
  let logCum = logTerm;
  for (let i = 1; i <= k; i++) {
    logTerm += Math.log((n - i + 1) / i);
    logCum = logAddExp(logCum, logTerm);
  }
  const p = Math.min(1, 2 * Math.exp(logCum));
  return { b, c, n, p, delta: (b - c) / n };
}
