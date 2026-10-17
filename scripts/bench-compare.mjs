#!/usr/bin/env node
// bench-compare.mjs —— 两份 recall-bench 结果的分桶对比（带置信区间）
//
// 为什么单独一个脚本：recall-bench.ts 是仪器本体，接口要稳（别的分支会只读调用）；
// 对比是**阅读工具**，放这里改坏了不影响跑分。
//
// 用法：node scripts/bench-compare.mjs <A.json> <B.json> [--labelA xxx] [--labelB yyy]
//
// ⚠️ 判据（不许含糊）：
//   配对题集用**配对 bootstrap 差值 CI**，不是比两个边际 CI 有没有重叠 ——
//   后者在配对数据上过于保守（同样的数据，配对能检出、独立比会漏掉）。
//   差值 CI 跨 0 ⇒ **没显著**，报告里不许写成"提升"。
import fs from "node:fs";
// 统计只许一份：实现在 scripts/bench-stats.mjs，判据在 test/unit/bench-stats.spec.ts。
// 本脚本只做「读两份结果 + 排版」，不做任何统计推导。
import { pct, pairedDiffCI, clusterDiffCI, mcnemar } from "./bench-stats.mjs";

const args = process.argv.slice(2);
const files = args.filter((a) => !a.startsWith("--"));
const opt = (n, d) => { const i = args.indexOf("--" + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
if (files.length < 2) {
  console.error("用法: node scripts/bench-compare.mjs <A.json> <B.json> [--labelA x] [--labelB y]");
  process.exit(2);
}
const A = JSON.parse(fs.readFileSync(files[0], "utf8"));
const B = JSON.parse(fs.readFileSync(files[1], "utf8"));
const LABA = opt("labelA", files[0].split(/[\\/]/).pop());
const LABB = opt("labelB", files[1].split(/[\\/]/).pop());



const h1 = (r) => (r.lex === 0 ? 1 : 0);
const h10 = (r) => (r.lex >= 0 ? 1 : 0);
const mrr = (r) => (r.lex >= 0 ? 1 / (r.lex + 1) : 0);

// 按 query 配对（两份题集必须同源；不同源直接拒绝，别让它悄悄比错东西）
const keyRows = (x) => {
  const m = new Map();
  for (const r of x.rows || []) m.set(r.query + "\u0000" + r.target, r);
  return m;
};
const MA = keyRows(A), MB = keyRows(B);
const common = [...MA.keys()].filter((k) => MB.has(k));
if (common.length === 0) {
  console.error("✗ 两份结果没有共同题目 —— 不是同一批题面，不能比。");
  process.exit(3);
}

console.log("A = " + LABA);
console.log("B = " + LABB);
console.log("共同题目 " + common.length + " 条（只比共同的；各自独有的题不参与）");
if (A.rows?.length !== B.rows?.length) {
  console.log("⚠️ 题数不同（A " + (A.rows?.length ?? 0) + " / B " + (B.rows?.length ?? 0) + "），只比交集");
}
console.log("");

const BUCKETS = [
  ["全部", () => true],
  ["literal ", (r) => r.lit === true],
  ["semantic", (r) => r.lit === false],
];
const f = (x) => (x * 100).toFixed(1) + "%";
const fs2 = (x) => (x >= 0 ? "+" : "") + (x * 100).toFixed(1) + "pt";

// ── 两种口径并排 ──
//   题级（旧）：把 305 道题当 305 个独立样本 ⇒ 同一会话的题被当成互不相关的证据，CI 假窄。
//   簇级（正确）：按会话整簇重采样 ⇒ 簇内相关性如实进方差。**结论一律以簇级为准。**
//   两种都打出来不是为了给人挑顺眼的那个，是为了让「差多少」可见。
console.log("分桶       题数/簇数   A hit@1      B hit@1      Δ hit@1（题级，仅供参考）       Δ hit@1（簇级 = 结论）");
let anyFlip = false;
for (const [name, pred] of BUCKETS) {
  const ra = [], rb = [], pairs = [];
  for (const k of common) {
    const x = MA.get(k), y = MB.get(k);
    if (pred(x) && pred(y)) { ra.push(x); rb.push(y); pairs.push({ target: x.target, a: h1(x), b: h1(y) }); }
  }
  if (!ra.length) { console.log(name + "     0      （无此题）"); continue; }
  const va = ra.map(h1), vb = rb.map(h1);
  const dq = pairedDiffCI(va, vb);
  const dc = clusterDiffCI(pairs);
  const meanA = va.reduce((s, x) => s + x, 0) / va.length;
  const meanB = vb.reduce((s, x) => s + x, 0) / vb.length;
  // McNemar 只用两个数：b = A对B错，c = B对A错；两张都对/都错的不含「谁更好」的信息
  let mb = 0, mc = 0;
  for (let i = 0; i < va.length; i++) { if (va[i] === 1 && vb[i] === 0) mb++; else if (va[i] === 0 && vb[i] === 1) mc++; }
  const mcn = mcnemar(mb, mc);
  const sigQ = !(dq.lo <= 0 && dq.hi >= 0);
  const sigC = !(dc.lo <= 0 && dc.hi >= 0);
  if (sigQ !== sigC) anyFlip = true;
  const verdict = Math.abs(dc.mean) < 1e-9 ? "无变化"
    : (sigC ? (dc.mean > 0 ? "★ A 更好" : "★ B 更好") : "未测出差异");
  const tie = sigQ !== sigC ? "  ← 题级说显著、簇级说没测出，以簇级为准" : "";
  console.log((name + "     " + (String(ra.length) + "/" + String(dc.clusters)).padEnd(10) + f(meanA).padEnd(13) + f(meanB).padEnd(13)
    + (fs2(dq.mean) + " [" + fs2(dq.lo) + "," + fs2(dq.hi) + "]").padEnd(31)
    + (fs2(dc.mean) + " [" + fs2(dc.lo) + "," + fs2(dc.hi) + "]").padEnd(29) + verdict + tie));
  console.log("             McNemar: A对B错=" + mb + " · B对A错=" + mc + " · p=" + mcn.p.toFixed(4)
    + (mcn.p < 0.05 ? "  ★显著" : "  不显著") + (mcn.p < 0.05 && !sigC ? "（与簇级 CI 不一致，需重跑更多题再下结论）" : ""));
}
if (anyFlip) {
  console.log("");
  console.log("⚠️ 有分桶出现「题级显著、簇级不显著」—— 这是本数据集最容易骗人的形态：");
  console.log("   305 题只落在 105 个会话上，按题算等于把同一段对话数了 3 遍。结论一律用簇级。");
}

console.log("");
console.log("指标细表（A → B，一律按簇重采样；括号里是簇级 95% CI）");
for (const [name, pred] of BUCKETS) {
  const ra = [], rb = [];
  for (const k of common) { const x = MA.get(k), y = MB.get(k); if (pred(x) && pred(y)) { ra.push(x); rb.push(y); } }
  if (!ra.length) continue;
  const line = ["hit@1", "hit@10", "MRR"].map((m) => {
    const fn = m === "hit@1" ? h1 : m === "hit@10" ? h10 : mrr;
    const pairs = ra.map((x, i) => ({ target: x.target, a: fn(x), b: fn(rb[i]) }));
    const mb = rb.map(fn).reduce((s, x) => s + x, 0) / rb.length;
    const d = clusterDiffCI(pairs);
    const sig = !(d.lo <= 0 && d.hi >= 0);
    return m + " " + (mb * 100).toFixed(1) + "% [" + (d.mean >= 0 ? "+" : "") + (d.mean * 100).toFixed(1) + "pt"
      + (sig ? " ★" : "") + " ±" + ((d.hi - d.lo) / 2 * 100).toFixed(1) + "]";
  });
  console.log("  " + name.trim().padEnd(9) + line.join("   "));
}

console.log("");
const lat = (rows) => { const v = rows.map((r) => r.ms).filter((x) => typeof x === "number").sort((a, b) => a - b); return v.length ? "P50 " + pct(v, 0.5).toFixed(1) + "ms · P95 " + pct(v, 0.95).toFixed(1) + "ms" : "无延迟数据"; };
const raAll = common.map((k) => MA.get(k)), rbAll = common.map((k) => MB.get(k));
console.log("延迟  A: " + lat(raAll));
console.log("      B: " + lat(rbAll));
console.log("");
console.log("★ = 配对差值 95% CI 不跨 0（显著）。没 ★ 的一律写成「未测出差异」，不许写成「提升」。");