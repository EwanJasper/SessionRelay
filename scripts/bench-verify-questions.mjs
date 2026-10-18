#!/usr/bin/env node
/**
 * bench-verify-questions.mjs — 题集唯一判据（v2）
 *
 * 用法（任意 cwd 均可）：
 *   node scripts/bench-verify-questions.mjs
 *   node scripts/bench-verify-questions.mjs --questions scripts/bench-questions-paraphrase-v2.json
 *   node scripts/bench-verify-questions.mjs --base scripts/bench-questions-paraphrase-v1.json --db <snapshot.sqlite>
 *
 * 判据（任一不过 → exit 1，不降级成 warning）：
 *   [1] 总数 + 各 arm 题数：arm 只取 R/X/T、kind 必须与 arm 对应、n 字段 = items.length、总数 ≥ 300
 *   [2] 每个 target 在库里真实存在（按前缀解析；缺失与歧义全部列出）
 *   [3] query 整串不能在目标会话 messages.content 里 LIKE 命中（命中的逐条列出）
 *   [4] target 不重复：同一 (target, arm) 只许一题；同一 target 跨臂最多 3 题（R/X/T 各一）
 *       —— 说明见下方 [4] 段：库内只有 118 个含正文的会话，"全局每 target 一题"与"v1 逐字保留"互斥，
 *          故本判据按 v1 既有惯例落到 (target, arm) 粒度，并显式打印 v1 基线，不做静默放宽。
 *   [5] 旧 94 题逐字原样保留（逐字段深比较 + 顺序 + 条数，与 v1 对比）
 *
 * 只读库：以 readonly 打开，不改任何数据。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : def;
};
const V2_PATH = path.resolve(opt('--questions', path.join(HERE, 'bench-questions-paraphrase-v2.json')));
const V1_PATH = path.resolve(opt('--base', path.join(HERE, 'bench-questions-paraphrase-v1.json')));

const ARMS = { R: 'rewrite', X: 'cross', T: 'temporal' };
const TARGET_N = 300;
const FIELDS = ['arm', 'query', 'target', 'kind'];

const failures = [];
const notes = [];
function fail(check, msg) { failures.push({ check, msg }); }
function line(s = '') { console.log(s); }
function hr() { line('─'.repeat(72)); }

line('题集校验 · bench-verify-questions');
line('v2 题集: ' + V2_PATH);
line('v1 题集: ' + V1_PATH);

// ── 载入 ────────────────────────────────────────────────────────────────
if (!fs.existsSync(V2_PATH)) { line('✗ 找不到 v2 题集：' + V2_PATH); process.exit(1); }
if (!fs.existsSync(V1_PATH)) { line('✗ 找不到 v1 题集：' + V1_PATH); process.exit(1); }
let q2, q1;
try {
  q2 = JSON.parse(fs.readFileSync(V2_PATH, 'utf8'));
  q1 = JSON.parse(fs.readFileSync(V1_PATH, 'utf8'));
} catch (e) {
  line('✗ 题集 JSON 解析失败：' + e.message);
  process.exit(1);
}
const DB_PATH = path.resolve(opt('--db', q2.dbPath || ''));
if (!q2.dbPath) fail(0, 'v2 题集缺 dbPath 字段');
if (!fs.existsSync(DB_PATH)) { line('✗ 快照库不存在：' + DB_PATH); process.exit(1); }
line('快照库: ' + DB_PATH);
line();

let db;
try {
  db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  db.prepare('select 1 from sessions limit 1').get();
} catch (e) {
  line('✗ 快照库打不开或不是 SessionRelay 库：' + e.message);
  process.exit(1);
}

const items = Array.isArray(q2.items) ? q2.items : [];
const v1Items = Array.isArray(q1.items) ? q1.items : [];
const isHex16 = (s) => typeof s === 'string' && /^[0-9a-f]{16}$/.test(s);

// ── [1] 总数 + 各 arm ────────────────────────────────────────────────────
hr();
line('[1] 数量 / arm');
const armCount = { R: 0, X: 0, T: 0 };
const armBad = [];
let v1KindLegacy = 0;
for (const [i, it] of items.entries()) {
  const at = '#' + (i + 1);
  const inV1Prefix = i < v1Items.length;
  if (ARMS[it.arm] === undefined) { armBad.push(at + ' arm=' + JSON.stringify(it.arm)); continue; }
  armCount[it.arm]++;
  // v1 里 5 条 X 的历史写法是 kind="cross-session"（原样保留，由 [5] 保证）；新题必须严格用 cross。
  if (it.kind !== ARMS[it.arm]) {
    if (inV1Prefix && it.arm === 'X' && it.kind === 'cross-session') v1KindLegacy++;
    else armBad.push(at + ' arm=' + it.arm + ' 但 kind=' + JSON.stringify(it.kind));
  }
  const keys = Object.keys(it).sort();
  if (keys.length !== 4 || FIELDS.some(f => !keys.includes(f))) armBad.push(at + ' 字段不合规：' + keys.join(','));
  if (typeof it.query !== 'string' || !it.query.trim()) armBad.push(at + ' query 为空');
  if (!isHex16(it.target)) armBad.push(at + ' target 不是 16 位会话 id 前缀：' + JSON.stringify(it.target));
}
if (q2.n !== items.length) fail(1, 'n 字段(' + q2.n + ') 与 items.length(' + items.length + ') 不一致');
if (items.length < TARGET_N) fail(1, '总数 ' + items.length + ' < ' + TARGET_N);
if (armCount.R + armCount.X + armCount.T !== items.length) fail(1, 'arm 统计合计与 items.length 不一致');
for (const b of armBad) fail(1, b);
line('    总数 ' + items.length + '（n=' + q2.n + '，上限 target=' + TARGET_N + '）');
line('    R(rewrite) ' + armCount.R + ' · X(cross) ' + armCount.X + ' · T(temporal) ' + armCount.T);
line('    唯一 target ' + new Set(items.map(i => i.target)).size + ' 个');
if (v1KindLegacy) line('    注：v1 有 ' + v1KindLegacy + ' 条 X 用历史写法 kind="cross-session"，按"v1 原样保留"不动；新题统一 kind="cross"。');

// ── [2] target 存在 ─────────────────────────────────────────────────────
hr();
line('[2] target 是否在库里存在');
const resolve = db.prepare('select id from sessions where id = ? or id like ? limit 2');
const missing = [];
const ambiguous = [];
const fullOf = new Map();
const seenTarget = new Set();
for (const [i, it] of items.entries()) {
  if (seenTarget.has(it.target)) continue;
  seenTarget.add(it.target);
  if (!isHex16(it.target)) { missing.push('#' + (i + 1) + ' ' + it.target + '（不是 16 位 id）'); continue; }
  const rows = resolve.all(it.target, it.target + '%');
  if (rows.length === 0) missing.push('#' + (i + 1) + ' ' + it.target);
  else if (rows.length > 1) ambiguous.push('#' + (i + 1) + ' ' + it.target + ' → ' + rows.map(r => r.id).join(','));
  else fullOf.set(it.target, rows[0].id);
}
line('    解析成功 ' + fullOf.size + ' / ' + seenTarget.size + ' 个 target');
if (missing.length) fail(2, '有 ' + missing.length + ' 个 target 在库里不存在');
if (ambiguous.length) fail(2, '有 ' + ambiguous.length + ' 个 target 前缀歧义');
for (const m of missing) line('    ✗ 不存在: ' + m);
for (const a of ambiguous) line('    ✗ 歧义: ' + a);

// ── [3] query 整串 LIKE 命中 ────────────────────────────────────────────
hr();
line('[3] query 整串是否在目标会话里 LIKE 命中');
const likeStmt = db.prepare("select 1 from messages where session_id = ? and content like ? escape '\\' limit 1");
const escapeLike = (s) => s.replace(/[\\%_]/g, (c) => '\\' + c);
const hits = [];
for (const [i, it] of items.entries()) {
  const full = fullOf.get(it.target);
  if (!full) { hits.push({ i: i + 1, it, why: 'target 未解析（见 [2]）' }); continue; }
  if (likeStmt.get(full, '%' + escapeLike(it.query) + '%')) hits.push({ i: i + 1, it, full, why: 'LIKE 命中' });
}
line('    检查 ' + items.length + ' 条，命中 ' + hits.length + ' 条');
if (hits.length) fail(3, '有 ' + hits.length + ' 条 query 能在目标会话正文里整串命中（等于抄原句）');
for (const h of hits) line('    ✗ #' + h.i + ' [' + h.it.arm + '] ' + h.it.target + ' :: ' + h.it.query);

// ── [4] target 唯一性（粒度 = target × arm） ────────────────────────────
hr();
line('[4] target 重复');
const pair = new Map();
const perTarget = new Map();
const pairDup = [];
for (const [i, it] of items.entries()) {
  const k = it.target + '|' + it.arm;
  if (pair.has(k)) pairDup.push('#' + (i + 1) + ' ' + it.target + ' [' + it.arm + '] 与 #' + pair.get(k) + ' 重复');
  else pair.set(k, i + 1);
  if (!perTarget.has(it.target)) perTarget.set(it.target, new Set());
  perTarget.get(it.target).add(it.arm);
}
const over = [];
for (const [t, arms] of perTarget) {
  if (arms.size > 3) over.push(t + ' → ' + [...arms].join(''));
  const cnt = items.filter(x => x.target === t).length;
  if (cnt > 3) over.push(t + ' 共 ' + cnt + ' 题（>3）');
}
const v1Multi = new Map();
for (const it of v1Items) {
  if (!v1Multi.has(it.target)) v1Multi.set(it.target, new Set());
  v1Multi.get(it.target).add(it.arm);
}
const v1MultiTargets = [...v1Multi.entries()].filter(([, s]) => s.size > 1);
line('    同一 (target, arm) 重复：' + pairDup.length);
line('    同一 target 跨臂超过 3 题：' + over.length);
line('    v1 基线（已存在、本轮不改）：' + v1MultiTargets.length + ' 个 target 跨臂复用，共 ' +
  v1MultiTargets.reduce((n, [, s]) => n + s.size, 0) + ' 题');
line('      ' + v1MultiTargets.map(([t, s]) => t.slice(0, 8) + ':' + [...s].join('')).join('  '));
line('    说明：库内仅 118 个会话含 messages 正文（620 个会话中其余 502 个 message_count=0，'
  + '只有 meta_text 摘要词，无法满足"锚点在正文出现"）。因此"全局每 target 一题"的上限是 118 题，'
  + '与"v1 逐字保留 94 题"互斥；本判据按 v1 既有惯例落到 arm 粒度：同一 arm 内每 target 只许 1 题。');
if (pairDup.length) fail(4, '有 ' + pairDup.length + ' 处 (target, arm) 重复');
if (over.length) fail(4, '有 ' + over.length + ' 个 target 跨臂超过 3 题');
for (const d of pairDup) line('    ✗ ' + d);
for (const o of over) line('    ✗ ' + o);

// ── [5] v1 94 题原样保留 ────────────────────────────────────────────────
hr();
line('[5] v1 题集是否逐字原样保留');
const cmpBad = [];
if (items.length < v1Items.length) fail(5, 'v2 条数 ' + items.length + ' 少于 v1 的 ' + v1Items.length);
const minLen = Math.min(items.length, v1Items.length);
let same = 0;
for (let i = 0; i < minLen; i++) {
  const a = v1Items[i], b = items[i];
  const diffs = [];
  for (const f of FIELDS) if (a[f] !== b[f]) diffs.push(f + ': ' + JSON.stringify(a[f]) + ' → ' + JSON.stringify(b[f]));
  const extra = Object.keys(b).filter(k => !FIELDS.includes(k));
  if (extra.length) diffs.push('多出字段 ' + extra.join(','));
  if (diffs.length) cmpBad.push('#' + (i + 1) + ' ' + diffs.join('; '));
  else same++;
}
if (cmpBad.length) fail(5, '有 ' + cmpBad.length + ' 条与 v1 不一致');
line('    逐字段比对 ' + minLen + ' 条：一致 ' + same + '，不一致 ' + cmpBad.length);
line('    v2 新增 ' + Math.max(0, items.length - v1Items.length) + ' 条（v1=' + v1Items.length + '，v2=' + items.length + '）');
for (const c of cmpBad.slice(0, 40)) line('    ✗ ' + c);
if (cmpBad.length > 40) line('    … 还有 ' + (cmpBad.length - 40) + ' 条未列出');

// ── 结论 ────────────────────────────────────────────────────────────────
hr();
for (const n of notes) line('注意：' + n);
if (failures.length === 0) {
  line('结论：五条判据全部通过（exit 0）');
  line('  [1] 总数 ' + items.length + ' ✅   [2] target 存在 ' + fullOf.size + '/' + seenTarget.size + ' ✅   [3] LIKE 命中 0 ✅   [4] (target,arm) 无重复 ✅   [5] v1 94 题原样 ✅');
  db.close();
  process.exit(0);
} else {
  line('结论：不通过（exit 1），共 ' + failures.length + ' 处');
  const byCheck = new Map();
  for (const f of failures) byCheck.set(f.check, (byCheck.get(f.check) || 0) + 1);
  for (const [c, n] of [...byCheck.entries()].sort((a, b) => a[0] - b[0])) line('  [' + c + '] ' + n + ' 处：' + failures.filter(f => f.check === c).map(f => f.msg).join(' ｜ '));
  db.close();
  process.exit(1);
}
