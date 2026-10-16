// recall-bench.ts —— 大规模检索基准（自动出题，不需要人工标注）
//
// 为什么要它：早先那个 20 问基准（tools/ses-recall-probe.mjs）样本太小，
// 一个 +1 / −1 的抖动就足以让人下错结论（实测已经发生过一次）。
// 这里改成**自动出题**：从库里随机抽会话，从它们的消息里生成三类查询，目标会话已知。
//
// 三条臂：
//   K  关键词臂：取该会话里一个**低频**专名/长词（df≤3）——控制组，应该很高
//   S  子集臂  ：只取该句里 2 个普通词（模拟「记得大概、不记得原话」）
//   M  错位臂  ：取 3 个普通词、且**不含任何低频专名**（模拟「换了说法」）
//
// 用法：npx tsx scripts/recall-bench.ts <库路径> [--n 150] [--limit 10] [--rewrite 0|1] [--json out.json]
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require2 = createRequire(import.meta.url);
const Database = require2('better-sqlite3');
const { searchSessions } = await import('../src/search-svc/engine.js');
const { parseQuery } = await import('../src/core/tokenize/tokenizer.js');

const argv = process.argv.slice(2);
const dbPath = argv[0];
const arg = (n: string, d: string) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const N = Number(arg('n', '150'));
const LIMIT = Number(arg('limit', '10'));
const REWRITE = arg('rewrite', '1') !== '0';
const FUSION = arg('fusion', '0') === '1';
// ⚠️ 默认必须**等于产品默认**。产品默认 2026-10-16 起是**开**（用户拍板，见 engine.ts 的 A5 注释），
// 所以这里默认 1；要用"关"当对照组请显式 `--lengthnorm 0`。
const LENGTHNORM = arg('lengthnorm', '1') !== '0';

const db = new Database(dbPath, { readonly: true });
const projRow = db.prepare('SELECT project_id FROM sessions LIMIT 1').get() as { project_id: string };
const PID = projRow.project_id;

const isCJK = (s: string) => /^[\u4e00-\u9fff]+$/.test(s);
const isIdent = (s: string) => /^[A-Za-z][A-Za-z0-9_.\-]{2,}$/.test(s);
const COMMON = new Set(['这个','那个','我们','你们','他们','可以','需要','应该','问题','东西','时候','因为','所以','但是','如果','已经','还有','就是','什么','怎么','现在','一下','然后','没有','不是','还是','或者','这样','那样']);

const dfCache = new Map<string, number>();
function df(tok: string): number {
  const hit = dfCache.get(tok);
  if (hit !== undefined) return hit;
  const r = db.prepare('SELECT COUNT(*) AS c FROM (SELECT 1 FROM messages WHERE content LIKE ? LIMIT 4)').get('%' + tok + '%') as { c: number };
  dfCache.set(tok, r.c);
  return r.c;
}

// [1016 · 红队B 纠正] 原先写的是 BETWEEN 4 AND 600 —— 于是**巨无霸永远不是答案**，
// 而"把巨无霸压下去"的改动（长度归一化）在这个口径下必然虚高（实测它只在"答案是小会话"时成立）。
// 现在按**全量分层**抽样：小会话、中等、巨无霸都进池子，让基准同时覆盖两种情形。
const sessions = db.prepare(`
  SELECT id, message_count AS c FROM sessions
   WHERE message_count >= 4
   ORDER BY RANDOM() LIMIT ?
`).all(N * 4) as Array<{ id: string; c: number }>;
const pickMsg = db.prepare("SELECT content FROM messages WHERE session_id = ? AND role = 'user' AND length(content) BETWEEN 30 AND 400 LIMIT 3");

const stats = { sess: sessions.length, toks: 0, noRare: 0, fewCommon: 0, ok: 0 };
interface Item { arm: 'K' | 'S' | 'M'; query: string; target: string }
const items: Item[] = [];
for (const s of sessions) {
  if (items.length >= N * 3) break;
  const msgs = pickMsg.all(s.id) as Array<{ content: string }>;
  if (msgs.length === 0) continue;
  const toks = parseQuery(msgs[0].content).units.flat().filter((t) => t.length >= 2);
  if (toks.length < 4) continue;
  stats.toks += toks.length;
  const rare = toks.filter((t) => (isCJK(t) && t.length >= 3) || isIdent(t)).filter((t) => df(t) <= 8);
  const common = toks.filter((t) => !COMMON.has(t) && t.length >= 2 && df(t) >= 3);
  if (rare.length === 0) { stats.noRare++; continue; }
  if (common.length < 3) { stats.fewCommon++; continue; }
  stats.ok++;
  items.push({ arm: 'K', query: rare[0], target: s.id });
  items.push({ arm: 'S', query: common.slice(0, 2).join(' '), target: s.id });
  items.push({ arm: 'M', query: common.slice(0, 3).join(' '), target: s.id });
}

const acc: Record<string, { n: number; h1: number; h3: number; h10: number }> = { K: { n: 0, h1: 0, h3: 0, h10: 0 }, S: { n: 0, h1: 0, h3: 0, h10: 0 }, M: { n: 0, h1: 0, h3: 0, h10: 0 } };
for (const it of items) {
  let ids: string[] = [];
  try { ids = searchSessions(db, { project: PID, query: it.query, limit: LIMIT, rewrite: REWRITE, fusion: FUSION, lengthNorm: LENGTHNORM } as never).map((h) => h.sessionId); } catch { continue; }
  const i = ids.indexOf(it.target);
  const a = acc[it.arm];
  a.n++;
  if (i === 0) a.h1++;
  if (i >= 0 && i < 3) a.h3++;
  if (i >= 0) a.h10++;
}

console.log('库: ' + dbPath + '  改写: ' + (REWRITE ? 'on' : 'off') + '  融合: ' + (FUSION ? 'on' : 'off') + '  长度归一: ' + (LENGTHNORM ? 'on' : 'off'));
console.log('臂   样本    hit@1        hit@3        hit@10');
for (const k of ['K', 'S', 'M']) {
  const a = acc[k];
  const p = (x: number) => a.n ? ((x / a.n) * 100).toFixed(1) + '%' : '-';
  console.log(k.padEnd(5) + String(a.n).padEnd(8) + p(a.h1).padEnd(13) + p(a.h3).padEnd(13) + p(a.h10));
}
console.log('阶段计数:', JSON.stringify(stats));
const jf = arg('json', '');
if (jf) fs.writeFileSync(jf, JSON.stringify({ at: new Date().toISOString(), dbPath, rewrite: REWRITE, limit: LIMIT, acc }, null, 2));