#!/usr/bin/env node
// 时间衰减对照实验：**同一批候选，加衰减前后是否仍能被检索到**（只允许排名变化）
//
// 用法：
//   node src/core/decay/decay-control.mjs                 # 用 agent1super 的库 + 默认查询代理
//   node src/core/decay/decay-control.mjs "面板 bug"       # 换查询
//   SRELAY_DB=其他/relay.sqlite node ... decay-control.mjs
//
// ⚠️ 口径诚实声明：这里的"相关性分数"是**查询 bigram 命中数的代理**，不是生产环境里的
//   SQLite bm25（引擎在 SQL 里算，重放它就要重建 FTS，那是接线测试的事）。
//   本脚本要证明的不是"分数有多准"，而是**衰减的作用范围**：
//     ① 候选集在衰减前后逐一相同（一条都不少）—— 这是"只调排序、绝不过滤"的可执行证据；
//     ② 排序确实变了（老记录名次下沉、新记录上浮）；
//     ③ 人造长龄样本（180/365/1095/3650 天）里，强相关的老记录依然在结果里，且仍能压过"新但弱"的记录。
//
// 退出码：0 = 全部不变量成立；1 = 有断言失败（可直接当守门用例）。
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DAY_MS, DEFAULT_DECAY, DEFAULT_HALF_LIFE_DAYS, ageMsOf, decayFactor, rankByDecayedScore, resolveDecayConfig } from './decay.ts';

const DB_DEFAULT = path.join('D:', 'agent1super', '.sessionrelay', 'relay.sqlite');
const dbPath = process.env.SRELAY_DB || DB_DEFAULT;
const query = process.argv[2] || 'sqlite';
const NOW = Date.now();
const TOP = 10;
const OLD_DAYS = 60;

const fail = [];
const check = (ok, msg) => { console.log((ok ? '  ✅ ' : '  🔴 ') + msg); if (!ok) fail.push(msg); };
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const fmt = (n, d = 1) => Number(n).toFixed(d);

// ── 查询代理：查询的 bigram 在文本里出现的次数 ────────────────────────────────
function bigrams(s) {
  const t = String(s).toLowerCase();
  const out = [];
  for (let i = 0; i < t.length - 1; i++) out.push(t.slice(i, i + 2));
  return [...new Set(out)];
}
function occurrences(text, g) {
  let n = 0;
  let at = text.indexOf(g);
  while (at !== -1) { n++; at = text.indexOf(g, at + 1); }
  return n;
}
const QB = bigrams(query);
function proxyScore(text) {
  const t = String(text || '').toLowerCase();
  let s = 0;
  for (const g of QB) s += occurrences(t, g);
  return s;
}

// ── 读库（只读；缺库/坏 JSON 都明说，不静默）────────────────────────────────
if (!fs.existsSync(dbPath)) {
  console.error('库不存在：' + dbPath + '（可用 SRELAY_DB 指定）');
  process.exit(1);
}
const candidates = [];
let sessions = 0;
const db = new DatabaseSync(dbPath, { readOnly: true });
try {
  const rows = db.prepare(
    "SELECT id, created_at, decisions, key_questions FROM sessions "
    + "WHERE (decisions IS NOT NULL AND decisions != '[]') OR (key_questions IS NOT NULL AND key_questions != '[]')",
  ).all();
  sessions = rows.length;
  let badJson = 0;
  for (const r of rows) {
    let decs = [];
    let qs = [];
    try { decs = JSON.parse(r.decisions || '[]'); } catch (e) { badJson++; console.error('坏 decisions JSON：' + r.id + '：' + e.message); }
    try { qs = JSON.parse(r.key_questions || '[]'); } catch (e) { badJson++; console.error('坏 key_questions JSON：' + r.id + '：' + e.message); }
    if (!Number.isFinite(Date.parse(r.created_at))) console.error('坏 created_at：' + r.id + ' = ' + JSON.stringify(r.created_at));
    for (const d of decs) {
      const text = String(d.text || '');
      const score = proxyScore(text);
      if (!score) continue;
      candidates.push({
        id: 'd:' + r.id + ':' + d.seq,
        score,
        ageMs: ageMsOf(d.at, NOW) ?? ageMsOf(r.created_at, NOW),
        kind: d.kind === 'negative' ? 'negative' : 'decision',
        text,
      });
    }
    for (const q of qs) {
      if (q.unresolved !== true) continue;
      const text = String(q.q || '');
      const score = proxyScore(text);
      if (!score) continue;
      candidates.push({
        id: 'q:' + r.id + ':' + q.seq,
        score,
        ageMs: ageMsOf(q.at, NOW) ?? ageMsOf(r.created_at, NOW),
        kind: 'question',
        text,
      });
    }
  }
  if (badJson) console.error('（以上 ' + badJson + ' 处 JSON 坏行已跳过，但已逐条打印原因）');
} finally {
  db.close();
}

// 经验库（可选；不存在不算失败）
const globalDb = path.join(os.homedir(), '.sessionrelay', 'global.sqlite');
let lessons = 0;
if (fs.existsSync(globalDb)) {
  const g = new DatabaseSync(globalDb, { readOnly: true });
  try {
    for (const l of g.prepare("SELECT id, text, created_at FROM lessons WHERE status != 'retired'").all()) {
      const score = proxyScore(l.text);
      if (!score) continue;
      lessons++;
      candidates.push({ id: 'l:' + l.id, score, ageMs: ageMsOf(l.created_at, NOW), kind: 'lesson', text: String(l.text || '') });
    }
  } finally {
    g.close();
  }
} else {
  console.log('（未找到全局经验库 ' + globalDb + '，跳过 lessons；这不是失败）');
}

const cfg = resolveDecayConfig({ enabled: true });
const byKind = candidates.reduce((a, c) => { a[c.kind] = (a[c.kind] || 0) + 1; return a; }, {});
console.log('══ 时间衰减对照（同一批候选，只允许排名变化）══');
console.log('库：' + dbPath + '（只读，' + sessions + ' 场会话 / ' + candidates.length + ' 条命中候选）');
console.log('候选构成：' + JSON.stringify(byKind) + (lessons ? '（含 ' + lessons + ' 条经验）' : ''));
console.log('查询代理：「' + query + '」→ 查询 bigram ' + QB.length + ' 个，命中分数 = 出现次数（**不是**生产 bm25，见文件头）');
console.log('配置：' + cfg.mode + '，半衰期 ' + JSON.stringify({ ...DEFAULT_HALF_LIFE_DAYS }) + ' 天，floor ' + cfg.floor + '，enabled=true');
console.log('');

if (!candidates.length) {
  console.error('查询「' + query + '」在候选里零命中 —— 换一个查询词再跑（这不是衰减的问题）。');
  process.exit(1);
}

// ── [1] 不变量：衰减前后候选集逐一同 ──────────────────────────────────────
const off = rankByDecayedScore(candidates, { enabled: false });
const on = rankByDecayedScore(candidates, cfg);
console.log('[1] 不变量（衰减绝不过滤）');
check(off.length === candidates.length && on.length === candidates.length, '候选数不变：' + candidates.length + ' → ' + on.length);
const idsBefore = candidates.map((c) => c.id).sort().join('|');
const idsAfter = on.map((r) => r.candidate.id).sort().join('|');
check(idsBefore === idsAfter, 'id 逐一同（含重复 id 的重数）：' + on.length + ' 条，唯一 ' + new Set(on.map((r) => r.candidate.id)).size + ' 个');
check(on.every((r) => Number.isFinite(r.decayedScore) && r.decayedScore > 0), '所有衰减后分数严格 >0（min ' + fmt(Math.min(...on.map((r) => r.decayedScore)), 4) + '）');
check(off.every((r) => r.rankWith === r.rankWithout), '关掉衰减时 rankWith===rankWithout（开关真的作用于全部路径）');
const oldSet = candidates.filter((c) => Number.isFinite(c.ageMs) && c.ageMs >= OLD_DAYS * DAY_MS);
check(oldSet.every((c) => on.some((r) => r.candidate.id === c.id)), '≥' + OLD_DAYS + ' 天的老记录（' + oldSet.length + ' 条）全部仍在结果里');

// ── [2] 排序变化 ─────────────────────────────────────────────────────────
const topOff = off.slice(0, TOP);
const topOn = on.slice(0, TOP);
const churn = topOn.filter((r) => !topOff.some((x) => x.candidate.id === r.candidate.id)).length;
const moved = on.map((r) => Math.abs(r.rankWith - r.rankWithout));
console.log('');
console.log('[2] 排序确实变了');
check(churn > 0, 'top-' + TOP + ' 换血 ' + churn + ' 条（' + churn + '/' + TOP + '）');
console.log('  · 平均名次移动 ' + fmt(avg(moved)) + ' 位，最大 ' + Math.max(...moved) + ' 位');
const oldest = on.reduce((a, b) => (a.candidate.ageMs > b.candidate.ageMs ? a : b));
console.log('  · 最老命中记录：' + fmt(oldest.candidate.ageMs / DAY_MS) + ' 天，名次 ' + oldest.rankWithout + ' → ' + oldest.rankWith
  + '（系数 ' + fmt(oldest.factor, 3) + '）' + (oldest.notes.length ? ' 注: ' + oldest.notes.join('；') : ''));
const ageOff = avg(topOff.map((r) => r.candidate.ageMs / DAY_MS));
const ageOn = avg(topOn.map((r) => r.candidate.ageMs / DAY_MS));
console.log('  · top-' + TOP + ' 平均年龄 ' + fmt(ageOff) + ' 天 → ' + fmt(ageOn) + ' 天（' + (ageOn <= ageOff ? '变新 ' + fmt(ageOff - ageOn) : '变老 ' + fmt(ageOn - ageOff)) + ' 天）');
console.log('  · 前 5 名（衰减后）：');
for (const [i, r] of on.slice(0, 5).entries()) {
  console.log('      ' + (i + 1) + '. [' + r.candidate.kind + '] ' + fmt(r.candidate.ageMs / DAY_MS) + 'd 分 ' + fmt(r.candidate.score, 2)
    + '→' + fmt(r.decayedScore, 3) + '（原第 ' + r.rankWithout + '）' + String(r.candidate.text).replace(/\s+/g, ' ').slice(0, 42));
}

// ── [3] 人造长龄样本：老记录永远还能被检索到 ────────────────────────────────
console.log('');
console.log('[3] 人造长龄样本（真库里最老只有 ' + fmt(candidates.reduce((m, c) => Math.max(m, c.ageMs), 0) / DAY_MS) + ' 天，长龄只能人造）');
const synthetic = [
  { id: 'plant:3y-strong', score: 10, ageMs: 1095 * DAY_MS, kind: 'decision', text: '三年前的高相关决策（人造）' },
  { id: 'plant:10y-strong', score: 10, ageMs: 3650 * DAY_MS, kind: 'decision', text: '十年前的高相关决策（人造）' },
  { id: 'plant:10y-negative', score: 10, ageMs: 3650 * DAY_MS, kind: 'negative', text: '十年前否掉的一条路（人造）' },
  { id: 'plant:10y-question', score: 10, ageMs: 3650 * DAY_MS, kind: 'question', text: '十年前的未决问题（人造）' },
  { id: 'plant:new-weak', score: 1, ageMs: 0.5 * DAY_MS, kind: 'decision', text: '今天但弱相关（人造）' },
];
const mix = rankByDecayedScore([...candidates, ...synthetic], cfg);
const at = (id) => mix.find((r) => r.candidate.id === id);
for (const s of synthetic) {
  const r = at(s.id);
  check(Boolean(r), '样本仍在结果里：' + s.id + '（名次 ' + (r ? r.rankWith : '无') + '）');
}
check(at('plant:3y-strong').decayedScore > at('plant:new-weak').decayedScore, '3 年前强相关（' + fmt(at('plant:3y-strong').decayedScore, 2) + '）仍压过今天弱相关（' + fmt(at('plant:new-weak').decayedScore, 2) + '）');
check(at('plant:10y-question').factor === 1, '未决问题 10 年不衰减（系数 1.000）');
// ⚠️ 10 年这个年龄下两类都已被 floor 兜到 0.25，比不出半衰期差异 —— 用 180 天（还没触保底）来比。
const f180neg = decayFactor(180 * DAY_MS, 'negative', cfg);
const f180dec = decayFactor(180 * DAY_MS, 'decision', cfg);
check(f180neg > f180dec, '负结果比同龄决策衰减慢（180 天：' + fmt(f180neg, 3) + ' > ' + fmt(f180dec, 3) + '）');
check(at('plant:10y-strong').factor === cfg.floor, '10 年决策已被 floor 兜住（' + fmt(cfg.floor, 3) + '），仍 >0 且仍在结果里');

// ── 汇总 ────────────────────────────────────────────────────────────────
console.log('');
if (fail.length) {
  console.log('🔴 FAIL：' + fail.length + ' 条');
  for (const f of fail) console.log('   - ' + f);
  process.exit(1);
}
console.log('✅ PASS：候选集 100% 保留（' + candidates.length + ' 条一条不少），只有排名变化；'
  + '老记录 ' + oldSet.length + ' 条全部可检索；top-' + TOP + ' 换血 ' + churn + ' 条、平均年轻 ' + fmt(Math.max(0, ageOff - ageOn)) + ' 天。');
