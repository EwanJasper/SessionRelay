#!/usr/bin/env node
// bench-bucket-ci.mjs —— 按臂（rewrite / cross-session / temporal）出指标 + 两种置信区间
//
// 为什么要有"两种 CI"：
//   题级 bootstrap 假设每题独立。但本批 94 题只落在 75 个会话上（temporal/cross 题与 rewrite 题共用会话），
//   同一会话的多道题**不独立** —— 题级 CI 会偏窄（=过度自信）。
//   所以这里同时给**会话级聚簇 bootstrap**（以 target 为单位重采样，整簇一起抽），
//   以它为准；题级数字列出来只为显示差多少。
//
// 用法：node scripts/bench-bucket-ci.mjs <result.json>
import fs from "node:fs";

const f = process.argv[2];
if (!f) { console.error("用法: node scripts/bench-bucket-ci.mjs <result.json>"); process.exit(2); }
const J = JSON.parse(fs.readFileSync(f, "utf8"));
const rows = J.rows || [];
if (!rows.length) { console.error("✗ 结果里没有 rows（跑分时加 --json 才会有）"); process.exit(3); }

const pct = (s, p) => { if (!s.length) return NaN; const i = (s.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i); return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo); };
const h1 = (r) => (r.lex === 0 ? 1 : 0);
const h10 = (r) => (r.lex >= 0 ? 1 : 0);
const mrr = (r) => (r.lex >= 0 ? 1 / (r.lex + 1) : 0);

/** 题级 bootstrap */
function bootQ(vals, iters = 10000, seed = 0x5eed) {
  const n = vals.length; if (!n) return null;
  const mean = vals.reduce((a, b) => a + b, 0) / n;
  let s = seed >>> 0; const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const m = new Array(iters);
  for (let t = 0; t < iters; t++) { let sum = 0; for (let k = 0; k < n; k++) sum += vals[Math.floor(rnd() * n)]; m[t] = sum / n; }
  m.sort((a, b) => a - b);
  return { mean, lo: pct(m, 0.025), hi: pct(m, 0.975) };
}
/** 会话级聚簇 bootstrap：整簇重采样，簇内所有题一起进出 */
function bootCluster(list, fn, iters = 10000, seed = 0xc1a5) {
  const bySess = new Map();
  for (const r of list) { if (!bySess.has(r.target)) bySess.set(r.target, []); bySess.get(r.target).push(r); }
  const clusters = [...bySess.values()];
  const n = clusters.length; if (!n) return null;
  const flat = list.map(fn);
  const mean = flat.reduce((a, b) => a + b, 0) / flat.length;
  let s = seed >>> 0; const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const m = new Array(iters);
  for (let t = 0; t < iters; t++) {
    let sum = 0, cnt = 0;
    for (let k = 0; k < n; k++) { const c = clusters[Math.floor(rnd() * n)]; for (const r of c) { sum += fn(r); cnt++; } }
    m[t] = sum / Math.max(1, cnt);
  }
  m.sort((a, b) => a - b);
  return { mean, lo: pct(m, 0.025), hi: pct(m, 0.975), clusters: n };
}

const fmt = (c) => c ? (c.mean * 100).toFixed(1) + "% [" + (c.lo * 100).toFixed(1) + ", " + (c.hi * 100).toFixed(1) + "]" : "-";
const ARMS = [["R", "rewrite"], ["X", "cross-session"], ["T", "temporal"]];

console.log("文件: " + f);
console.log("总题数 " + rows.length + " · 覆盖会话 " + new Set(rows.map((r) => r.target)).size);
console.log("");
console.log("臂            题数  会话  指标   点估计   题级 95%CI（偏窄）        会话级 95%CI（以此为准）");
for (const [arm, label] of ARMS) {
  const list = rows.filter((r) => r.arm === arm);
  if (!list.length) { console.log(label.padEnd(14) + "  0    （本批无此题）"); continue; }
  const nS = new Set(list.map((r) => r.target)).size;
  for (const [mname, fn] of [["hit@1", h1], ["hit@10", h10], ["MRR", mrr]]) {
    const q = bootQ(list.map(fn));
    const c = bootCluster(list, fn);
    console.log(label.padEnd(14) + String(list.length).padEnd(6) + String(nS).padEnd(6) + mname.padEnd(7)
      + (q.mean * 100).toFixed(1).padStart(5) + "%   " + fmt(q).padEnd(26) + "  " + fmt(c));
  }
  const lat = list.map((r) => r.ms).filter((x) => typeof x === "number").sort((a, b) => a - b);
  if (lat.length) console.log(label.padEnd(14) + "延迟 P50 " + pct(lat, 0.5).toFixed(1) + "ms · P95 " + pct(lat, 0.95).toFixed(1) + "ms · P99 " + pct(lat, 0.99).toFixed(1) + "ms");
  console.log("");
}
const all = rows;
console.log("合计           " + String(all.length).padEnd(6) + String(new Set(all.map((r) => r.target)).size).padEnd(6));
for (const [mname, fn] of [["hit@1", h1], ["hit@10", h10], ["MRR", mrr]]) {
  const q = bootQ(all.map(fn)); const c = bootCluster(all, fn);
  console.log("  " + mname.padEnd(7) + (q.mean * 100).toFixed(1).padStart(5) + "%   " + fmt(q).padEnd(26) + "  " + fmt(c));
}
const latAll = all.map((r) => r.ms).filter((x) => typeof x === "number").sort((a, b) => a - b);
if (latAll.length) console.log("  延迟 P50 " + pct(latAll, 0.5).toFixed(1) + "ms · P95 " + pct(latAll, 0.95).toFixed(1) + "ms · P99 " + pct(latAll, 0.99).toFixed(1) + "ms");