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

function pct(s, p) {
  if (!s.length) return NaN;
  const i = (s.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo);
}
/** 配对差值 bootstrap：重采样**题**，每次算 mean(a)-mean(b)，取 2.5/97.5 分位 */
function pairedDiffCI(a, b, iters = 10000, seed = 0xbeef) {
  const n = a.length;
  if (!n) return null;
  const d = a.map((x, i) => x - b[i]);
  const mean = d.reduce((s, x) => s + x, 0) / n;
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const out = new Array(iters);
  for (let t = 0; t < iters; t++) {
    let sum = 0;
    for (let k = 0; k < n; k++) sum += d[Math.floor(rnd() * n)];
    out[t] = sum / n;
  }
  out.sort((x, y) => x - y);
  return { mean, lo: pct(out, 0.025), hi: pct(out, 0.975) };
}

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

console.log("分桶       题数    A hit@1      B hit@1      Δ hit@1 [95% CI]           判定");
for (const [name, pred] of BUCKETS) {
  const ra = [], rb = [];
  for (const k of common) { const x = MA.get(k), y = MB.get(k); if (pred(x) && pred(y)) { ra.push(x); rb.push(y); } }
  if (!ra.length) { console.log(name + "     0      （无此题）"); continue; }
  const va = ra.map(h1), vb = rb.map(h1);
  const d = pairedDiffCI(va, vb);
  const meanA = va.reduce((s, x) => s + x, 0) / va.length;
  const meanB = vb.reduce((s, x) => s + x, 0) / vb.length;
  const sig = !(d.lo <= 0 && d.hi >= 0);
  const verdict = Math.abs(d.mean) < 1e-9 ? "无变化" : (sig ? (d.mean > 0 ? "★ A 更好" : "★ B 更好") : "不显著");
  console.log((name + "     " + String(ra.length).padEnd(7) + f(meanA).padEnd(13) + f(meanB).padEnd(13)
    + (fs2(d.mean) + " [" + fs2(d.lo) + ", " + fs2(d.hi) + "]").padEnd(28) + verdict));
}

console.log("");
console.log("指标细表（A → B）");
for (const [name, pred] of BUCKETS) {
  const ra = [], rb = [];
  for (const k of common) { const x = MA.get(k), y = MB.get(k); if (pred(x) && pred(y)) { ra.push(x); rb.push(y); } }
  if (!ra.length) continue;
  const line = ["hit@1", "hit@10", "MRR"].map((m) => {
    const fn = m === "hit@1" ? h1 : m === "hit@10" ? h10 : mrr;
    const a = ra.map(fn), b = rb.map(fn);
    const ma = a.reduce((s, x) => s + x, 0) / a.length, mb = b.reduce((s, x) => s + x, 0) / b.length;
    const d = pairedDiffCI(a, b);
    const sig = !(d.lo <= 0 && d.hi >= 0);
    return m + " " + (mb * 100).toFixed(1) + "% [" + (d.mean >= 0 ? "+" : "") + (d.mean * 100).toFixed(1) + "pt" + (sig ? " ★" : "") + "]";
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