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
// 用法：npx tsx scripts/recall-bench.ts <库路径> [--n 150] [--limit 10] [--rewrite 0|1] [--fusion 0|1] [--lengthnorm 0|1] [--json out.json]
//                                        [--save-questions f.json] [--use-questions f.json]
//                                        [--semantic 0|1] [--threshold 0.4] [--reserve 3] [--topk 5] [--dtype q8]
//                                        [--config <root>] [--rows out.json]
//   ⚠️ [1017 夜 · 语义臂] 在这之前三条臂**全是纯词法的**：都走 searchSessions，而语义命中要靠
//      opts.semanticHits 由调用方注入 —— 本脚本从不注入 ⇒ 语义档的效果**没有任何仪器能测**。
//      现在：--semantic 1 会把语义臂（K/S/M 各一条）额外跑一遍，**同一个目标会话、同一批题面**，
//      于是两臂是**配对**的，可以直接比（配对 McNemar，比独立两组比例灵敏得多）。
//      语义臂的阈值/保底/候选上限/量化档全部走**基准自己的旋钮**（不写进 config.json）——
//      扫描要求每轮只改一个变量，且不许污染用户正在用的那份配置。
//   ⚠️ 做 A/B **必须**先 --save-questions 固定一批题面，之后每轮 --use-questions 复用它 ——
//      否则 ORDER BY RANDOM() 会换题面，跨轮差异里混着题面差异（P1 仪器缺陷，见交接 §10）。
//   现成的一批：scripts/bench-questions-agent1super.json（agent1super 库，198 条，2026-10-17 落盘）
//   --fusion 不给 = 产品默认（主路不硬时才融合）；1 = 强制融合；0 = 关（对照组）
import fs from 'node:fs';
import path from 'node:path';
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
// ⚠️ [1017 夜 纠正] 这里原先默认 '0' ⇒ 传下去的 fusion 是 **false**，即"逐字关掉融合"。
// 但**产品默认是 undefined（主路不硬时才融合）**（engine.ts:253-257）——
// 于是基准默认量的是"关掉融合"的旧行为，而不是用户在用的那套（口径 bug，与 lengthNorm 那次同型）。
// 现在：不给 --fusion = 产品默认；--fusion 1 = 强制融合；--fusion 0 = 逐字关。
const fusionArg = arg('fusion', '');
const FUSION: boolean | undefined = fusionArg === '' ? undefined : fusionArg === '1';
// ⚠️ 默认必须**等于产品默认**。产品默认 2026-10-16 起是**开**（用户拍板，见 engine.ts 的 A5 注释），
// 所以这里默认 1；要用"关"当对照组请显式 `--lengthnorm 0`。
const LENGTHNORM = arg('lengthnorm', '1') !== '0';
// [1017 夜 · 语义臂] 基准自己的旋钮。**不写 config.json**：扫描要每轮只改一个变量，
// 而且绝不能在用户正在用的项目配置上做实验（那会让"用户在用的那套"和"基准量的那套"分叉）。
const SEMANTIC = arg('semantic', '0') === '1';
const THRESHOLD = Number(arg('threshold', '0.4'));
const RESERVE = Number(arg('reserve', '3'));
const TOPK = Number(arg('topk', '5'));
const DTYPE = arg('dtype', '');
// [1017 夜 · 标签图谱] 查询扩展臂。和语义臂同一套做法：**同一批题面、同一个目标会话**，
// 扩展开/关两条臂**配对**跑 —— 配对 McNemar 比独立两组比例灵敏得多（噪声小一个量级）。
// 旋钮全部是基准自己的，不写进 config.json（扫描要求每轮只改一个变量）。
const EXPAND = arg('expand', '0') === '1';
const TAG_RESERVE = Number(arg('tagreserve', '0'));
const TAG_HOPS = Number(arg('taghops', '1'));
const TAG_TERMS = Number(arg('tagterms', '4'));
const TAG_FUSION = arg('tagfusion', '0') === '1';
/** 语义臂用的配置：以 --config 指向的项目配置为底，再套上基准旋钮（不给就用当前库自己的配置） */
const CFG_ROOT = arg('config', '');
const ROWS_OUT = arg('rows', '');
// [1017 夜 · 样本量] agent1super 全库只有 **87 个 ≥4 条消息**的会话（434 个是 workflow），
// 所以"每会话 1 题"的天花板就是 ~66 题/臂 —— 这正是调研件 §4.4 说的"样本太小"的**真正成因**：
// 不是 --n 给得不够，是**题源被会话数卡死**。修法：每个会话可出多题（--per-session）。
// 代价要诚实登记：同一会话出的多题**不独立**（聚簇），有效样本量小于题数。
const PER_SESSION = Math.max(1, Number(arg('per-session', '1')));
// [1017 夜] 融合探针每道题多跑 2 次检索（默认 vs 强制 / 默认 vs 关掉）——参数扫描时纯属浪费。
// --noprobe 只关探针，**不动** fusion 口径（仍是产品默认）。
const NO_PROBE = arg('noprobe', '0') === '1';
// [1017 夜] 题面复放时**按比例截断**：参数扫描一轮 20+ 个配置，全量题面跑一轮要几十分钟。
// 截断只影响**精度**不影响**可比性** —— 所有配置用同一份前缀子集，仍然是配对的。
// ⚠️ 用它做扫描没问题，**下最终结论必须回全量**（截断后的样本量要写进报告）。
const MAX_ITEMS = Number(arg('max-items', '0'));

const db = new Database(dbPath, { readonly: true });
const projRow = db.prepare('SELECT project_id FROM sessions LIMIT 1').get() as { project_id: string };
const PID = projRow.project_id;

const isCJK = (s: string) => /^[\u4e00-\u9fff]+$/.test(s);
const isIdent = (s: string) => /^[A-Za-z][A-Za-z0-9_.\-]{2,}$/.test(s);
const COMMON = new Set(['这个','那个','我们','你们','他们','可以','需要','应该','问题','东西','时候','因为','所以','但是','如果','已经','还有','就是','什么','怎么','现在','一下','然后','没有','不是','还是','或者','这样','那样']);

const dfCache = new Map<string, number>();
/**
 * 文档频率 = 「含该词的不同会话数」。
 *
 * ── [1021 修一个仪器 bug：它让全部 A/B 结论都不可信] ──
 *   原实现：`SELECT COUNT(*) FROM (SELECT 1 FROM messages WHERE content LIKE ? LIMIT 4)`
 *   内层 `LIMIT 4` 把行数封在 4 ⇒ **df() 最大只能返回 4** ⇒ 调用方那句 `df(t) <= 8`
 *   （「只取低频专名当 K 臂题面」）**恒真**，等于从来没过滤过。
 *   实测后果：K 臂 326 题里只有 16.3% 真是 df≤8，**83.7% 的词命中 14~79 个会话**；
 *   而检索只返回 top-10 ⇒ **86% 的题在结构上就不可能被排进前 10**。
 *   也就是说「基线 56.44%」量的不是检索质量，是运气 —— 所有「改进没效果」的 A/B
 *   都是拿这把坏尺子量出来的（语义臂 / 标签扩展 / 长度归一的结论都受它污染）。
 *
 *   修法两处：① 去掉内层 LIMIT，直接数不同会话；
 *              ② 统计口径从 `content` 改成 `search_text` —— FTS 索引的是 search_text，
 *                拿 content 数会与实际可检索性不符。
 *   加 `LIMIT 200` 只是防止极端常见词全表扫，不影响判别（阈值远小于 200）。
 */
function df(tok: string): number {
  const hit = dfCache.get(tok);
  if (hit !== undefined) return hit;
  let n = 0;
  try {
    const r = db.prepare('SELECT COUNT(DISTINCT session_id) AS c FROM messages WHERE search_text LIKE ? LIMIT 200').get('%' + tok + '%') as { c: number };
    n = Number(r?.c ?? 0);
  } catch { n = 0; }
  dfCache.set(tok, n);
  return n;
}

// [1016 · 红队B 纠正] 原先写的是 BETWEEN 4 AND 600 —— 于是**巨无霸永远不是答案**，
// 而"把巨无霸压下去"的改动（长度归一化）在这个口径下必然虚高（实测它只在"答案是小会话"时成立）。
// 现在按**全量分层**抽样：小会话、中等、巨无霸都进池子，让基准同时覆盖两种情形。
const wantSessions = Math.min(Math.ceil((N * 4) / PER_SESSION), 100000);
const sessions = db.prepare(`
  SELECT id, message_count AS c FROM sessions
   WHERE message_count >= 4
   ORDER BY RANDOM() LIMIT ?
`).all(wantSessions) as Array<{ id: string; c: number }>;
// 每个会话取**多条**候选用户消息（per-session>1 时），每条各出一组 K/S/M
const pickMsg = db.prepare("SELECT content FROM messages WHERE session_id = ? AND role = 'user' AND length(content) BETWEEN 30 AND 400 ORDER BY RANDOM() LIMIT ?");

const stats = { sess: sessions.length, toks: 0, noRare: 0, fewCommon: 0, ok: 0, distinctSessions: 0 };
interface Item { arm: 'K' | 'S' | 'M'; query: string; target: string }
const items: Item[] = [];

// [1017 夜 · P1 仪器缺陷修复] 题面**必须可落盘复用**。
// 病历：抽样用的是 ORDER BY RANDOM()，每跑一次题面就换一批 —— 于是"这轮 vs 上轮"的差异里
//   混着题面差异，跨轮不可比（2026-10-17 那组融合 A/B 就是这么量的，只能看方向不能看幅度）。
// 用法：
//   node ... --save-questions bench/q-20261017.json   # 第一次：固定一批题面
//   node ... --use-questions  bench/q-20261017.json   # 之后每次 A/B 都用这同一批
// ⚠️ [1017 夜] 题面文件**必须落在仓库内**（scripts/ 下）并随仓提交：它落在外面临时目录时，
// 会被清盘/隔离动作连带删掉，于是「跨轮可比」这个前提在下一轮静默失效（实测踩到：
// 一轮扫描跑到一半题面消失，后面每个配置都报 ENOENT，看起来像「扫描失败」）。
const SAVE_Q = arg('save-questions', '');
const USE_Q = arg('use-questions', '');
if (USE_Q) {
  const j = JSON.parse(fs.readFileSync(USE_Q, 'utf8')) as { dbPath?: string; limit?: number; items: Item[] };
  if (j.dbPath && j.dbPath !== dbPath) console.log('⚠️ 题面来自另一个库（' + j.dbPath + '）—— 只在你明确跨库对照时才这么做');
  if (j.limit && j.limit !== LIMIT) console.log('⚠️ 题面的 limit=' + j.limit + ' 与本次 --limit=' + LIMIT + ' 不同，命中率不可直接比');
  // 子集要**跨会话**：items 是按会话成组（每会话 3×per-session 条）排的，取前缀只会拿到头几个会话
  // （实测：取前 240 条 = 只有 15 个会话）。改为按**整组**等步长抽样，保持 K/S/M 三臂成对。
  const src = j.items;
  if (MAX_ITEMS > 0 && src.length > MAX_ITEMS) {
    const groups: typeof src[] = [];
    for (let i = 0; i + 3 <= src.length; i += 3) groups.push(src.slice(i, i + 3));
    const wantG = Math.max(1, Math.floor(MAX_ITEMS / 3));
    const step = Math.max(1, Math.ceil(groups.length / wantG));
    for (let i = 0; i < groups.length && items.length < MAX_ITEMS; i += step) items.push(...groups[i]);
  } else items.push(...src);
  stats.ok = items.length / 3;
  console.log('题面来自 ' + USE_Q + '（' + items.length + ' 条，可跨轮对照）');
}
if (!USE_Q) for (const s of sessions) {
  if (items.length >= N * 3) break;
  const msgs = pickMsg.all(s.id, PER_SESSION) as Array<{ content: string }>;
  if (msgs.length === 0) continue;
  let usedHere = 0;
  for (const m of msgs) {
    if (items.length >= N * 3 || usedHere >= PER_SESSION) break;
    const toks = parseQuery(m.content).units.flat().filter((t) => t.length >= 2);
    if (toks.length < 4) continue;
    stats.toks += toks.length;
    // [1017 夜 · 题面质量闸] 实测 per-session 抽样会产出 "the" / "the todowrite tool" 这类题面：
    // 英文停用词在中文库里 df 很高、又够长，于是同时混进 K 臂（当"低频专名"）与 S/M 臂（当"普通词"）——
    // 那种题目标会话根本无从命中，**只会给所有臂灌噪声**。这里把停用词与纯 ASCII 短词剔掉。
    const STOP = new Set(['the','and','for','with','that','this','from','not','you','are','was','were','has','have','had','but','can','all','any','use','using','used','new','old','one','two','get','got','set','out','see','let','its','it','is','to','of','in','on','at','by','as','or','if','do','be','no','so','up','we','my','me']);
    const usable = (t: string) => t.length >= 2 && !STOP.has(t.toLowerCase()) && !/^[\x00-\x7f]+$/.test(t.replace(/[A-Za-z0-9_.\-]/g, ''));
    const toksOk = toks.filter(usable);
    if (toksOk.length < 4) { stats.fewCommon++; continue; }
    const rare = toksOk.filter((t) => (isCJK(t) && t.length >= 3) || isIdent(t)).filter((t) => df(t) <= 8);
    const common = toksOk.filter((t) => !COMMON.has(t) && t.length >= 2 && df(t) >= 3);
    if (rare.length === 0) { stats.noRare++; continue; }
    if (common.length < 3) { stats.fewCommon++; continue; }
    stats.ok++;
    usedHere++;
    items.push({ arm: 'K', query: rare[0], target: s.id });
    items.push({ arm: 'S', query: common.slice(0, 2).join(' '), target: s.id });
    items.push({ arm: 'M', query: common.slice(0, 3).join(' '), target: s.id });
  }
}
if (SAVE_Q && !USE_Q) {
  try {
    fs.mkdirSync(path.dirname(SAVE_Q), { recursive: true });
    fs.writeFileSync(SAVE_Q, JSON.stringify({ at: new Date().toISOString(), dbPath, limit: LIMIT, n: N, perSession: PER_SESSION, items }, null, 2));
    console.log('题面已落盘：' + SAVE_Q + '（' + items.length + ' 条）—— 下次用 --use-questions 复用同一批');
  } catch (e) { console.log('题面落盘失败（不影响本次结果）：' + String((e as Error)?.message ?? e)); }
}

// ── 语义臂：题面定下来之后才建（需要 pid/候选集），且**只建一次** ──
let semReady = false, semWhy = '';
let semCfg: Record<string, unknown> | null = null;
let semanticHitsOf: ((q: string) => Promise<Array<{ sessionId: string; score: number }> | null>) | null = null;
if (SEMANTIC) {
  try {
    const { loadConfig } = await import('../src/shared/config.js');
    const { semanticSearch, getEmbedder, DEFAULT_MODEL } = await import('../src/search-svc/semantic.js');
    const { configFile } = await import('../src/shared/paths.js');
    // 底：--config 指向的项目配置（或本库自己的）；再套基准旋钮
    const baseRoot = CFG_ROOT || path.dirname(path.dirname(dbPath));
    const cfg0 = loadConfig(baseRoot);
    semCfg = {
      ...cfg0,
      semantic: { ...(cfg0.semantic ?? {}), enabled: true, threshold: THRESHOLD, reserve_slots: RESERVE, top_k: TOPK, ...(DTYPE ? { dtype: DTYPE } : {}) },
    };
    // 自证：装载失败必须**当场说出来**（否则整轮扫描会静默量到"等于关掉语义"的假数据）
    const e = await getEmbedder(semCfg as never);
    if (!e) { semWhy = 'embedder 装载失败（看 srelay semantic status）'; }
    else {
      semReady = true;
      semanticHitsOf = (q: string) => semanticSearch(db as never, semCfg as never, q, { project: PID });
      console.log('语义臂已就绪：模型 ' + e.model + ' dim=' + e.dim
        + ' · 阈值 ' + THRESHOLD + ' · 保底 ' + RESERVE + ' · topk ' + TOPK + (DTYPE ? ' · dtype ' + DTYPE : '')
        + ' · 配置底 ' + configFile(baseRoot).replace(/\\/g, '/'));
      if (cfg0.semantic?.enabled !== true) console.log('  （本库 config 里语义是关的；基准按上面的旋钮强制开——这是基准臂，不改你的配置）');
    }
  } catch (e) { semWhy = String((e as Error)?.message ?? e).slice(0, 200); }
  if (!semReady) console.log('⚠️ 语义臂不可用：' + semWhy + ' —— 本轮只出词法三臂（**不要**把它当成"语义无效"的证据）');
}

/** 双侧精确二项（McNemar 用；n 很小也准）。**只此一份**：语义臂与扩展臂共用 —— 判据不许各写一遍。 */
function binom2(k: number, n: number): number {
  if (n === 0) return 1;
  let s2 = 0;
  for (let i = 0; i <= n; i++) {
    let c2 = 1;
    for (let j = 0; j < i; j++) c2 = c2 * (n - j) / (j + 1);
    const p = c2 * Math.pow(0.5, n);
    if (i <= k || i >= n - k) s2 += p;
  }
  return Math.min(1, s2);
}

/** 配对 McNemar：以 lex（词法基线）为基准，统计新臂「救回 / 打掉」各有几条（只看 hit@1） */
function mcnemarByArm(rows: Array<{ arm: string; lex: number } & Record<string, number>>, key: string): Map<string, { b: number; c: number }> {
  const out = new Map<string, { b: number; c: number }>();
  for (const r of rows) {
    const e = out.get(r.arm) ?? { b: 0, c: 0 };
    const baseHit = r.lex === 0;
    const newHit = r[key] === 0;
    if (baseHit && !newHit) e.c++;   // 基线中、新臂不中 —— 退步
    if (!baseHit && newHit) e.b++;   // 基线不中、新臂中 —— 改善
    out.set(r.arm, e);
  }
  return out;
}

/** 打印一张配对显著性表（语义 / 扩展两条臂共用同一套口径与文字格式） */
function reportMcNemar(title: string, m: Map<string, { b: number; c: number }>, gain: string, loss: string): void {
  console.log(title);
  for (const k of ['K', 'S', 'M']) {
    const e = m.get(k);
    if (!e) continue;
    const p = binom2(Math.min(e.b, e.c), e.b + e.c);
    console.log('  ' + k + ' 臂：' + gain + ' ' + e.b + ' 条 · ' + loss + ' ' + e.c + ' 条 · 净 ' + (e.b - e.c >= 0 ? '+' : '') + (e.b - e.c)
      + ' · McNemar 精确 p=' + p.toFixed(3) + (p < 0.05 ? '  ← 显著' : ''));
  }
}

let probeN = 0, fuseDiff = 0, gateOpen = 0;
interface Acc { n: number; h1: number; h3: number; h10: number; satTop1: number }
const mk = (): Acc => ({ n: 0, h1: 0, h3: 0, h10: 0, satTop1: 0 });
// 词法臂 K/S/M；语义臂 Ks/Ss/Ms —— **同一个目标会话、同一批题面**，两臂配对可比
const acc: Record<string, Acc> = { K: mk(), S: mk(), M: mk(), Ks: mk(), Ss: mk(), Ms: mk(), Ke: mk(), Se: mk(), Me: mk() };
/** 扩展臂的阶段计数与样例（截图留存用：什么词扩成了什么词，出问题时唯一能查的东西） */
const expStats = { n: 0, seeded: 0, expanded: 0, terms: 0, pathHits: 0, ms: 0, baseMs: 0, sample: [] as Array<{ q: string; seeds: string[]; terms: string[] }> };
/** 逐题结果（落盘用）：两臂的命中名次都记，扫描完可以算配对 McNemar，而不是只看汇总百分比 */
const rows: Array<{ arm: string; query: string; target: string; lex: number; sem: number }> = [];
/** 巨型会话（≥800 条消息）在 top-1 里的占比 —— 反向护栏：语义若只是"给巨无霸再加一条路"，这个数会不降反升 */
const SAT_MSG = 800;
const msgCount = new Map<string, number>();
{
  const all = db.prepare('SELECT id, message_count AS c FROM sessions').all() as Array<{ id: string; c: number }>;
  for (const r of all) msgCount.set(r.id, Number(r.c || 0));
}
for (const it of items) {
  let ids: string[] = [];
  const t0 = Date.now();
  try { ids = searchSessions(db, { project: PID, query: it.query, limit: LIMIT, rewrite: REWRITE, fusion: FUSION, lengthNorm: LENGTHNORM } as never).map((h) => h.sessionId); } catch { continue; }
  expStats.baseMs += Date.now() - t0;
  // ── 标签扩展臂：同一题、同一目标，只是在旧行为之上多开一条扩展路（单变量） ──
  let expIds: string[] = [];
  if (EXPAND) {
    const t1 = Date.now();
    try {
      const tr: { seeds?: Array<{ tag: string }>; terms?: Array<{ name: string }>; pathHits?: number } = {};
      expIds = searchSessions(db, {
        project: PID, query: it.query, limit: LIMIT, rewrite: REWRITE, fusion: FUSION, lengthNorm: LENGTHNORM,
        tagExpand: true, tagReserve: TAG_RESERVE, tagHops: TAG_HOPS, tagMaxTerms: TAG_TERMS,
        tagInFusion: TAG_FUSION ? true : undefined, tagTrace: tr,
      } as never).map((h) => h.sessionId);
      expStats.n++;
      if ((tr.seeds?.length ?? 0) > 0) expStats.seeded++;
      if ((tr.terms?.length ?? 0) > 0) expStats.expanded++;
      expStats.terms += tr.terms?.length ?? 0;
      expStats.pathHits += tr.pathHits ?? 0;
      if (expStats.sample.length < 5 && (tr.terms?.length ?? 0) > 0) {
        expStats.sample.push({ q: it.query, seeds: (tr.seeds ?? []).map((s) => s.tag), terms: (tr.terms ?? []).map((t) => t.name) });
      }
    } catch (e) {
      if (expStats.n === 0) console.log('⚠️ 扩展臂单题失败：' + String((e as Error)?.message ?? e).slice(0, 140));
    }
    expStats.ms += Date.now() - t1;
  }
  // ── 语义臂：同一题、同一目标，只是多注入了语义命中（配对比较） ──
  let semIds: string[] = [];
  if (semReady && semanticHitsOf) {
    try {
      const sh = await semanticHitsOf(it.query);
      semIds = searchSessions(db, { project: PID, query: it.query, limit: LIMIT, rewrite: REWRITE, fusion: FUSION, lengthNorm: LENGTHNORM, semanticHits: sh, semanticReserve: RESERVE } as never).map((h) => h.sessionId);
    } catch (e) { if (rows.length < 1) console.log('⚠️ 语义臂单题失败：' + String((e as Error)?.message ?? e).slice(0, 120)); }
  }
  // [1017 夜] 默认档到底走没走融合？两个**不同的**量，别混为一谈（我第一次就混了）：
  //   fuseDiff  : 默认 vs **强制融合** 结果不同 ⇒ 说明"融合算法本身会改排序"
  //   gateOpen  : 默认 vs **关掉融合** 结果不同 ⇒ 说明"默认档真的走过了 fusedSearch"（这才是闸门放行）
  // 判据：engine.ts 的闸门是"主路够硬（coverage≥1）就不融合"，而主路的 AND 分支**本身就要求
  //       每个查询单元都被覆盖** ⇒ coverage 恒为 1 ⇒ 闸门可能恒真、融合成了死代码。
  if (FUSION === undefined && !NO_PROBE) {
    probeN++;
    try {
      const forced = searchSessions(db, { project: PID, query: it.query, limit: LIMIT, rewrite: REWRITE, fusion: true, lengthNorm: LENGTHNORM } as never).map((h) => h.sessionId);
      if (forced.join(',') !== ids.join(',')) fuseDiff++;
      const off = searchSessions(db, { project: PID, query: it.query, limit: LIMIT, rewrite: REWRITE, fusion: false, lengthNorm: LENGTHNORM } as never).map((h) => h.sessionId);
      if (off.join(',') !== ids.join(',')) gateOpen++;
    } catch { /* 探测失败不计 */ }
  }
  const tally = (a: Acc, list: string[]) => {
    const i = list.indexOf(it.target);
    a.n++;
    if (i === 0) { a.h1++; if ((msgCount.get(it.target) ?? 0) >= SAT_MSG) a.satTop1++; }
    if (i >= 0 && i < 3) a.h3++;
    if (i >= 0) a.h10++;
    return i;
  };
  const li = tally(acc[it.arm], ids);
  const si = semReady ? tally(acc[it.arm + 's'], semIds) : -1;
  const ei = EXPAND ? tally(acc[it.arm + 'e'], expIds) : -1;
  if (semReady || EXPAND) rows.push({ arm: it.arm, query: it.query, target: it.target, lex: li, sem: si, exp: ei });
}

const fusionLabel = FUSION === undefined ? '产品默认(条件)' : (FUSION ? '强制on' : 'off');
console.log('库: ' + dbPath + '  改写: ' + (REWRITE ? 'on' : 'off') + '  融合: ' + fusionLabel + '  长度归一: ' + (LENGTHNORM ? 'on' : 'off'));
console.log('臂   样本    hit@1        hit@3        hit@10      巨霸top1');
for (const k of ['K', 'S', 'M', 'Ks', 'Ss', 'Ms', 'Ke', 'Se', 'Me']) {
  const a = acc[k];
  if (a.n === 0) continue;
  const p = (x: number) => a.n ? ((x / a.n) * 100).toFixed(1) + '%' : '-';
  console.log(k.padEnd(5) + String(a.n).padEnd(8) + p(a.h1).padEnd(13) + p(a.h3).padEnd(13) + p(a.h10).padEnd(13) + p(a.satTop1));
}
if (!SEMANTIC) console.log('（语义臂未开：加 --semantic 1 才会跑；三臂 K/S/M 是纯词法基线）');
// 分辨率声明（调研件 §4.4）：没有这句话，扫描一定会把噪声当结论
if (semReady) {
  const n = rows.length;
  const se = Math.sqrt(0.25 / Math.max(1, n)) * 100;
  console.log('分辨率：每臂 ' + n + ' 题时，单臂比例标准误约 ' + se.toFixed(1) + 'pt（95% 区间约 ±' + (se * 1.96).toFixed(1) + 'pt）；'
    + '两臂是**配对**的，实际可检出的差比这更小 —— 但小于约 3pt 的差异仍不要当结论。');
}
stats.distinctSessions = new Set(items.map((i) => i.target)).size;
console.log('阶段计数:', JSON.stringify(stats));
console.log('题源：' + items.length + ' 条题面 / ' + stats.distinctSessions + ' 个不同会话（每会话最多 ' + PER_SESSION + ' 题）'
  + (PER_SESSION > 1 ? ' —— ⚠️ 同会话多题**不独立**（聚簇），有效样本量小于题数' : ''));
if (FUSION === undefined && !NO_PROBE && probeN) {
  const pc = (x: number) => (x / probeN * 100).toFixed(1) + '%';
  console.log('融合探针（' + probeN + ' 条查询）：');
  console.log('  · 默认 vs 强制融合 结果不同：' + fuseDiff + '（' + pc(fuseDiff) + '）—— 融合算法本身会不会改排序');
  console.log('  · 默认 vs 关掉融合 结果不同：' + gateOpen + '（' + pc(gateOpen) + '）—— **默认档是否真的走过了融合**（0% = 闸门恒真、条件融合是死代码）');
}
// ── 配对显著性（McNemar 精确检验）：只看「救回几条 / 打掉几条」，不看绝对百分比 ──
if (semReady && rows.length > 0) reportMcNemar('配对 McNemar（hit@1，词法 → 语义）：', mcnemarByArm(rows, 'sem'), '语义救回', '语义打掉');
if (EXPAND && rows.length > 0) {
  reportMcNemar('配对 McNemar（hit@1，词法 → 标签扩展）：', mcnemarByArm(rows, 'exp'), '扩展救回', '扩展打掉');
  const q = (x: number) => expStats.n ? (x / expStats.n * 100).toFixed(1) + '%' : '-';
  console.log('扩展臂统计（' + expStats.n + ' 条查询）：命中种子 ' + expStats.seeded + '（' + q(expStats.seeded) + '）'
    + ' · 扩出词 ' + expStats.expanded + '（' + q(expStats.expanded) + '）'
    + ' · 平均扩展词 ' + (expStats.expanded ? (expStats.terms / expStats.expanded).toFixed(1) : '-') + ' 个'
    + ' · 扩展路平均命中 ' + (expStats.expanded ? (expStats.pathHits / expStats.expanded).toFixed(1) : '-') + ' 个会话');
  console.log('  延迟：基线 ' + (expStats.baseMs / Math.max(1, expStats.n)).toFixed(0) + 'ms/次 · 扩展 ' + (expStats.ms / Math.max(1, expStats.n)).toFixed(0) + 'ms/次'
    + '（' + (expStats.baseMs ? (expStats.ms / expStats.baseMs).toFixed(2) : '-') + 'x）');
  for (const s of expStats.sample) console.log('  样例 「' + s.q + '」 种子=[' + s.seeds.join(',') + '] → 扩展=[' + s.terms.join(',') + ']');
}
const jf = arg('json', '');
if (jf) fs.writeFileSync(jf, JSON.stringify({
  at: new Date().toISOString(), dbPath, rewrite: REWRITE, limit: LIMIT, acc,
  knobs: { semantic: SEMANTIC, threshold: THRESHOLD, reserve: RESERVE, topk: TOPK, dtype: DTYPE || null, fusion: fusionArg || 'default', lengthnorm: LENGTHNORM,
    expand: EXPAND, tagreserve: TAG_RESERVE, taghops: TAG_HOPS, tagterms: TAG_TERMS, tagfusion: TAG_FUSION },
  expStats, semReady, semWhy, rows,
}, null, 2));
if (ROWS_OUT) fs.writeFileSync(ROWS_OUT, JSON.stringify(rows, null, 2));