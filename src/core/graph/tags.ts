// 标签关系表（零模型「轻量知识图谱」）—— 数据在同一个 sqlite 库里
//
// 为什么需要它：用户搜「怎么省空间」找不到写着「归档机制」的记录 —— 这是**换说法**问题。
// 语义检索那条路实测无效（慢 2.15 倍、召回在噪声内，见 engine.ts 的 DEFAULT_RESERVE_SLOTS 注释），
// 所以这里走竞品（AstrBot memory_companion）验证过的低成本路线：
//    不需要模型，只需要一张「标签 ↔ 会话」关系表；查询时把查询词沿**共现边**扩成相关标签再检索。
//
// 结构（三张表，全部 CREATE IF NOT EXISTS，不动既有表）：
//   graph_tags(id, name, kind, df)                     标签字典（name 已归一化：小写去空白）
//   graph_tag_sessions(tag_id, session_id, weight)     标签 ↔ 会话（weight 见 KIND_BASE）
//   graph_tag_edges(a, b, w)                           **共现边**：同一会话里出现过的标签两两相连
//   graph_meta(...)                                    构建台账（版本/时间/规模），便于判定是否要重建
//
// 标签从哪来（**纯规则，零模型**）：
//   ① sessions.files_mentioned（JSON）→ 文件名（db.ts / engine.ts 这种用户真会打的名字）
//   ② messages.search_text（**已分词**，索引侧表示）→ 英文标识符 + 2~6 字 CJK 词
//      —— 用 search_text 而不是 content：分词结果与索引同源（tokenizer 是唯一判据），
//         不必重新切一遍，也不会有「库里切一套、查询切另一套」的分叉。
//   ③ sessions.decisions / key_questions / title（原始文本）→ 反引号代码片段、文件路径、技术栈词典词
//   ④ sessions.topics（既有抽取产物）→ 话题标签
//
// 为什么标签共现就是「图」：同一会话里出现的标签互相关联。边权用 cosine（co/√(dfa·dfb)），
// 于是「两个都罕见的标签一起出现过」得分高（信息量大），「一个到处都是的标签」自动被压下去。
import type { DB } from '../../store/db.js';

/** schema/抽取规则变更时 +1 —— 用来判断已落库的图谱要不要重建 */
export const GRAPH_TAG_VERSION = 1;

export type TagKind = 'file' | 'tech' | 'term' | 'topic';

/** 各来源的基础权重（同一会话内 tf 再折算）：文件名/标识符最能指认一个会话，话题词最弱 */
const KIND_BASE: Record<TagKind, number> = { file: 3.0, tech: 2.0, term: 1.6, topic: 1.2 };

/**
 * 标签抽取的停用词。与 tokenize/rewrite.ts 的 SCAFFOLD（问句外壳）**不是一回事**：
 * 那个服务于「查询改写」，这个服务于「标签词表」—— 目标是剔掉在任何会话里都出现、
 * 因此不具区分度的词。两处都留着自己那份是**故意的**，合表会让任一方的改动去污染另一方。
 */
const TAG_STOP = new Set<string>([
  // 中文高频虚词/代词
  '这个','那个','这些','那些','我们','你们','他们','它们','什么','怎么','怎样','为什么','如何','可以','需要','应该',
  '没有','不是','还是','或者','因为','所以','但是','如果','已经','还有','就是','现在','一下','然后','这样','那样',
  '东西','时候','问题','自己','一个','两个','一次','一点','一些','上面','下面','里面','出来','起来','进来','过来',
  '不会','不能','不要','可能','知道','觉得','确实','其实','目前','之前','之后','以后','以前','同时','并且','而且',
  '关于','对于','通过','进行','已经','一直','总是','比如','例如','包括','以及','另一','其他','所有','每个','每个',
  // 英文高频词（索引里是小写）
  'the','and','for','with','that','this','from','not','you','are','was','were','has','have','had','but','can','all',
  'any','use','using','used','new','old','one','two','get','got','set','out','see','let','its','is','to','of','in',
  'on','at','by','as','or','if','do','be','no','so','up','we','my','me','it','an','a','will','would','should','could',
  'true','false','null','undefined','string','number','object','array','function','return','const','let','var','import',
  'export','default','type','interface','class','async','await','error','warn','info','debug','log','console','test',
  // 采集/序列化噪声（不同来源反复出现的字段名，没有指认力）
  'json','http','https','www','com','html','body','args','params','result','data','name','value','time','date','seq',
  // 系统提示/工具回显噪声（**实测踩过**：这些词在同一条 system-reminder 里反复出现，
  // 一度把 completed/your 顶进 top-20 标签，还靠弱边连成一片 —— 它们指认不了任何会话）
  'completed','your','youre','please','note','task','todowrite','todo','read','write','search','file','files','path',
  'reminder','system','assistant','user','tool','tools','agent','agents','message','messages','content','output','input',
  'current','following','below','above','also','only','must','should','will','would','could','does','doing','done',
])

/** 技术栈词典：jieba 会把它们切碎（省空间 → 省|空间），所以对**原始文本**按子串补一轮 */
const TECH_DICT: string[] = [
  '省空间','知识图谱','查询扩展','共现','标签','图谱','注意力','嵌入','向量','语义检索','语义','分词','索引','检索',
  '召回','排序','打分','阈值','衰减','时间衰减','归一化','长度归一','融合','改写','抽取','决策','未决','简报','归档',
  '压缩','清理','清理策略','内存','磁盘','缓存','迁移','重构','部署','插件','配置','守护','会话','记忆','回滚','验证',
  '基准','延迟','吞吐','面板','钩子','协议','数据库','事务','迁移','备份','日志','权限','隔离','并发','锁','队列',
]

const CJK_RE = /^[\u3400-\u4dbf\u4e00-\u9fff]{2,6}$/;
const ASCII_TOKEN_RE = /^[a-z][a-z0-9_.\/-]*$/;
const FILE_TOKEN_RE = /\.(?:ts|tsx|js|mjs|cjs|jsx|json|md|py|go|rs|java|sql|yml|yaml|sh|bat|ps1|css|html|txt|toml|ini|lock)$/;
const BACKTICK_RE = /`([^`\n]{2,60})`/g;

/** 一条候选标签（同一会话内按 name 合并 tf） */
export interface TagCandidate { name: string; kind: TagKind; tf: number }

/** 绝对路径 → 用户真会打的名字（文件名）。取不到就用原串。 */
export function fileTagName(p: string): string {
  const base = String(p ?? '').trim().split(/[\\/]/).filter(Boolean).pop() ?? '';
  return base.toLowerCase();
}

/** 归一化：小写 + 去首尾空白/引号 —— 标签字典与查询侧必须用同一套（否则永不命中） */
export function normalizeTag(name: string): string {
  return String(name ?? '').trim().replace(/^[\s`'"()\[\]<>,]+|[\s`'"()\[\]<>,]+$/g, '').toLowerCase();
}

/** 单个 token → 标签？（规则，无模型） */
function classifyToken(tok: string): TagCandidate | null {
  if (!tok || tok.length < 2 || tok.length > 40) return null;
  if (TAG_STOP.has(tok)) return null;
  if (CJK_RE.test(tok)) return { name: tok, kind: 'topic', tf: 1 };
  if (!ASCII_TOKEN_RE.test(tok)) return null;
  // 纯数字/十六进制 id 之类没有语义
  if (/^[0-9_]+$/.test(tok.replace(/[./-]/g, ''))) return null;
  if (FILE_TOKEN_RE.test(tok) || tok.includes('/')) return { name: fileTagName(tok), kind: 'file', tf: 1 };
  if (tok.length < 3) return null;
  return { name: tok, kind: 'tech', tf: 1 };
}

/** 从一段**原始文本**里抽标签（反引号片段 / 路径 / 技术词典词） */
function mineRawText(text: string, out: Map<string, TagCandidate>, weightBump: number): void {
  if (!text) return;
  const low = text.toLowerCase();
  BACKTICK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = BACKTICK_RE.exec(text)) !== null) {
    const name = normalizeTag(m[1]);
    if (name.length >= 2 && name.length <= 40) add(out, { name, kind: 'tech', tf: 1 }, weightBump);
  }
  for (const term of TECH_DICT) {
    // 词典词按「出现与否」计一次（不数次数）：数次数会被一段长文里的重复放大成噪声
    if (low.includes(term)) add(out, { name: normalizeTag(term), kind: 'term', tf: 1 }, weightBump);
  }
}

/**
 * 标签落表的**唯一入口**（长度下限只在这里判一次）。
 * 病历：长度校验原先散在三条抽取路径上，于是漏了一条 —— file 分支从分词产物 "x/s" 取 basename 得到
 * 单字符标签 "s"（df=7），扩展路把它当有效词检索（cpu → "s" 这种纯噪声），还极难排查。
 */
function add(out: Map<string, TagCandidate>, c: TagCandidate, bump = 1): void {
  if (!c.name || c.name.length < 2) return;
  const prev = out.get(c.name);
  if (!prev) out.set(c.name, { ...c, tf: c.tf * bump });
  else {
    prev.tf += c.tf * bump;
    // 同一名字有两种来源时保留「更强」的那一类（文件 > 标识符 > 词典 > 话题）
    if (KIND_BASE[c.kind] > KIND_BASE[prev.kind]) prev.kind = c.kind;
  }
}

/** JSON 列安全解析（解析失败必须留痕：库里的列是外部写入的，不可能保证永远是合法 JSON） */
function parseJsonArray(raw: unknown): unknown[] {
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch (e) {
    console.warn('[graph] 列内容不是合法 JSON，已跳过：' + String((e as Error)?.message ?? e).slice(0, 80));
    return [];
  }
}

/** 会话行（只列与本模块相关的列） */
interface SessionRow {
  id: string;
  title: string | null;
  topics: string | null;
  decisions: string | null;
  key_questions: string | null;
  files_mentioned: string | null;
}

/** 单个会话 → 标签候选（tf 已累计）。纯函数（除读取 search_text 之外），便于单测。 */
export function extractSessionTags(row: SessionRow, searchText: string): TagCandidate[] {
  const out = new Map<string, TagCandidate>();
  // ① 文件清单（结构化字段，权重最高）
  for (const f of parseJsonArray(row.files_mentioned)) {
    const name = fileTagName(String(f));
    if (name.length >= 3 && name.length <= 60) add(out, { name, kind: 'file', tf: 1 }, 2);
  }
  // ② 话题（既有抽取产物）
  for (const t of parseJsonArray(row.topics)) {
    const name = normalizeTag(String(t));
    // ⚠️ 长度下限必须在这里也判：实测漏了它，单字符 ASCII（"s"）混进标签表，
    // 还被扩展路当成有效词去检索（cpu → "s" 这种纯噪声），排查起来极费劲。
    const okLen = CJK_RE.test(name) ? true : (name.length >= 3 && ASCII_TOKEN_RE.test(name));
    if (okLen && !TAG_STOP.has(name)) add(out, { name, kind: 'topic', tf: 1 });
  }
  // ③ 决策/未决/标题的原始文本：反引号 + 技术词典
  for (const d of parseJsonArray(row.decisions)) {
    const text = typeof d === 'string' ? d : String((d as { text?: unknown })?.text ?? '');
    mineRawText(text, out, 1);
  }
  for (const q of parseJsonArray(row.key_questions)) {
    const text = typeof q === 'string' ? q : String((q as { q?: unknown })?.q ?? '');
    mineRawText(text, out, 1);
  }
  if (row.title) mineRawText(row.title, out, 1);
  // ④ 正文：**已分词**的 search_text（索引侧原样复用，不重新切）
  if (searchText) {
    for (const tok of searchText.split(' ')) {
      const c = classifyToken(tok);
      if (c) add(out, c);
    }
  }
  const scored = [...out.values()].map((c) => ({ ...c, weight: KIND_BASE[c.kind] * (1 + Math.log(1 + c.tf)) }));
  // 先按权重取一批候选，再**剔切分碎片**：同一会话里若已保留更长的包含词，短的视为 jieba 碎片。
  // 病历：不做这步时图谱里长出了「件夹 ↔ 文件夹」「百分 ↔ 百分比」这种边——它们占比一度
  // 挤满最强边 top-15，全是噪声；而 parseQuery 早就在查询侧剔过同一类冗余子词（理由一样）。
  // 代价要写明：较短词若只与长词共现，就不进这个会话的标签了（其它会话里仍会出现）。
  scored.sort((a, b) => b.weight - a.weight || b.name.length - a.name.length || a.name.localeCompare(b.name));
  const kept: typeof scored = [];
  for (const c of scored) {
    if (kept.length >= MAX_TAGS_PER_SESSION * 3) break;
    if (kept.some((k) => k.name.length > c.name.length && k.name.includes(c.name))) continue;
    kept.push(c);
  }
  return kept.slice(0, MAX_TAGS_PER_SESSION).map((c) => ({ name: c.name, kind: c.kind, tf: c.tf }));
}

/** 每会话保留的标签上限（边数是平方级，见 buildTagGraph 的注释） */
export const MAX_TAGS_PER_SESSION = 60;
/** 参与**建边**的标签数上限（取权重最高的这些；边数 ~ n²/2） */
const MAX_EDGE_TAGS_PER_SESSION = 40;

export interface BuildStats {
  sessions: number;
  tags: number;
  pairs: number;
  edges: number;
  reused: boolean;
  ms: number;
}

/** 建表（幂等） */
/**
 * 图内容指纹 —— 判断「库变了没」。
 *
 * [1021 红队 T5] 原来复用判据只看 `session_count`。于是：抽取规则升级后 topics/decisions 变了、
 *   标签来源也就变了，但会话数没变 ⇒ 直接复用旧图 ⇒ **图与库静默不一致且无告警**。
 *   指纹取三样：会话数 + 抽取版本之和 + 最新更新时间；任一变化就重建。
 *   不用内容哈希：那要读所有 sessions 算 md5，代价大于重建本身（620 会话 1.3s）；
 *   而这三样都是走索引的聚合查询，毫秒级。
 */
export function contentFingerprint(db: DB): string {
  try {
    const r = db.prepare(
      'SELECT COUNT(*) AS n, COALESCE(SUM(COALESCE(extracted_version, 0)), 0) AS v,'
      + ' MAX(COALESCE(created_at, \'\')) AS t FROM sessions',
    ).get() as { n?: number; v?: number; t?: string | null } | undefined;
    return String(r?.n ?? 0) + ':' + String(r?.v ?? 0) + ':' + String(r?.t ?? '');
  } catch { return 'unknown'; }   // 算不出就给固定值 ⇒ 下次必不匹配 ⇒ 重建一次（宁多建，不复用错的）
}
export function ensureGraphSchema(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS graph_tags (
      id   INTEGER PRIMARY KEY,          -- 行号即 id，回填时整体重建
      name TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      df   INTEGER NOT NULL DEFAULT 0    -- 出现在多少个会话里
    );
    CREATE TABLE IF NOT EXISTS graph_tag_sessions (
      tag_id     INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      weight     REAL NOT NULL,
      PRIMARY KEY (tag_id, session_id)
    );
    CREATE INDEX IF NOT EXISTS idx_graph_ts_session ON graph_tag_sessions(session_id);
    CREATE TABLE IF NOT EXISTS graph_tag_edges (
      a  INTEGER NOT NULL,
      b  INTEGER NOT NULL,
      w  REAL NOT NULL,                 -- cosine：co / sqrt(df_a * df_b)，取值 (0,1]
      PRIMARY KEY (a, b)
    );
    CREATE INDEX IF NOT EXISTS idx_graph_edges_b ON graph_tag_edges(b);
    CREATE TABLE IF NOT EXISTS graph_meta (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      version INTEGER NOT NULL,
      built_at TEXT NOT NULL,
      session_count INTEGER NOT NULL,
      tag_count INTEGER NOT NULL,
      edge_count INTEGER NOT NULL,
      -- [1021 红队 T5] 内容指纹：只比 session_count 会漏掉「会话数不变但内容变了」
      --   （典型：抽取规则升级后 topics/decisions 变了，标签来源也就变了，但图不重建）。
      --   老库没有这一列，下面用 ALTER 幂等补。
      fingerprint TEXT
    );
  `);
  // 幂等补列（老库升级路径）
  try {
    const cols = db.prepare("PRAGMA table_info(graph_meta)").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'fingerprint')) db.exec('ALTER TABLE graph_meta ADD COLUMN fingerprint TEXT');
  } catch { /* 补列失败不影响主流程：指纹为 null 时按「不一致」处理，会重建一次 */ }
}

export interface BuildOptions {
  /** 已构建且版本/会话数一致时跳过（默认 true）；false = 强制重建 */
  reuse?: boolean;
  /** 进度回调（构建 30k 条消息大约 3~8s，长任务必须能看见在动） */
  onProgress?: (done: number, total: number) => void;
}

/**
 * 重建标签图谱（全量）。幂等：先清空三张表再写回，**不触碰 sessions/messages**。
 *
 * 复杂度说明：会话数 × 每会话标签数² 建边。620 会话 × 40² / 2 ≈ 50 万对，实测 1s 量级；
 * 所以这里选「全量重建」而不是增量——增量要在标签合并时维护 df 与边权，出错概率远高于省下的时间。
 */
export function buildTagGraph(db: DB, opts: BuildOptions = {}): BuildStats {
  const t0 = Date.now();
  ensureGraphSchema(db);
  const rows = db.prepare('SELECT id, title, topics, decisions, key_questions, files_mentioned FROM sessions').all() as SessionRow[];
  if (opts.reuse !== false) {
    const fp = contentFingerprint(db);
    const meta = db.prepare('SELECT version, session_count, fingerprint FROM graph_meta WHERE id = 1').get() as { version: number; session_count: number; fingerprint: string | null } | undefined;
    // [1021 红队 T5] 判据从「只看会话数」改成「会话数 + **内容指纹**」。
    //   原来只比 session_count：抽取规则升级后 topics/decisions 变了（标签来源变），
    //   但会话数没变 ⇒ 直接复用旧图 ⇒ **图与库静默不一致，还不报错**。
    //   指纹 = 会话数 + 抽取版本和 + 最新更新时间，任一变化都会触发重建。
    if (meta && meta.version === GRAPH_TAG_VERSION && meta.session_count === rows.length && meta.fingerprint === fp) {
      const tags = (db.prepare('SELECT COUNT(*) AS c FROM graph_tags').get() as { c: number }).c;
      const edges = (db.prepare('SELECT COUNT(*) AS c FROM graph_tag_edges').get() as { c: number }).c;
      if (tags > 0) return { sessions: rows.length, tags, pairs: 0, edges, reused: true, ms: Date.now() - t0 };
    }
  }

  // 一次流式扫过 messages 的**已分词**文本，按 session 聚合
  const searchBySession = new Map<string, string>();
  {
    let done = 0;
    const total = rows.length;
    const it = db.prepare('SELECT session_id, search_text FROM messages').iterate() as Iterable<{ session_id: string; search_text: string | null }>;
    for (const m of it) {
      if (!m.search_text) continue;
      const prev = searchBySession.get(m.session_id);
      searchBySession.set(m.session_id, prev ? prev + ' ' + m.search_text : m.search_text);
      done++;
      if (opts.onProgress && done % 5000 === 0) opts.onProgress(done, total);
    }
  }

  const bySession = new Map<string, TagCandidate[]>();
  for (const row of rows) bySession.set(row.id, extractSessionTags(row, searchBySession.get(row.id) ?? ''));

  const write = db.transaction((entries: Map<string, TagCandidate[]>) => {
    db.exec('DELETE FROM graph_tag_sessions; DELETE FROM graph_tag_edges; DELETE FROM graph_tags;');
    const tagId = new Map<string, number>();
    const tagKind = new Map<string, TagKind>();
    const insTag = db.prepare('INSERT INTO graph_tags (name, kind, df) VALUES (?, ?, 0)');
    const insPair = db.prepare('INSERT OR REPLACE INTO graph_tag_sessions (tag_id, session_id, weight) VALUES (?, ?, ?)');
    const df = new Map<string, number>();
    for (const [sid, tags] of entries) {
      for (const t of tags) {
        if (!tagId.has(t.name)) {
          const info = insTag.run(t.name, t.kind);
          tagId.set(t.name, Number(info.lastInsertRowid));
          tagKind.set(t.name, t.kind);
        }
        const weight = KIND_BASE[t.kind] * (1 + Math.log(1 + t.tf));
        insPair.run(tagId.get(t.name)!, sid, weight);
        df.set(t.name, (df.get(t.name) ?? 0) + 1);
      }
    }
    const updDf = db.prepare('UPDATE graph_tags SET df = ? WHERE id = ?');
    for (const [name, c] of df) updDf.run(c, tagId.get(name)!);

    // ── 共现边：同一会话内两两相连，按 cosine 归一 ──
    const co = new Map<string, number>();
    let pairs = 0;
    for (const tags of entries.values()) {
      const names = tags.slice(0, MAX_EDGE_TAGS_PER_SESSION).map((t) => t.name).sort();
      for (let i = 0; i < names.length; i++) {
        for (let j = i + 1; j < names.length; j++) {
          const key = names[i] + '\u0000' + names[j];
          co.set(key, (co.get(key) ?? 0) + 1);
          pairs++;
        }
      }
    }
    const insEdge = db.prepare('INSERT OR REPLACE INTO graph_tag_edges (a, b, w) VALUES (?, ?, ?)');
    let edges = 0;
    for (const [key, n] of co) {
      const [na, nb] = key.split('\u0000');
      const dfa = df.get(na) ?? 0;
      const dfb = df.get(nb) ?? 0;
      if (dfa < 2 || dfb < 2) continue;            // 只出现一次的标签没有「关系」可言
      const w = n / Math.sqrt(dfa * dfb);
      if (w < 0.05) continue;                       // 弱到没有解释价值的边不入库
      insEdge.run(tagId.get(na)!, tagId.get(nb)!, w);
      edges++;
    }
    const tagCount = tagId.size;
    db.prepare('INSERT OR REPLACE INTO graph_meta (id, version, built_at, session_count, tag_count, edge_count, fingerprint) VALUES (1, ?, ?, ?, ?, ?, ?)')
      // [1021 T5] 第 7 个参数是指纹 —— 加了列就必须加值，否则运行期才炸（Too few parameter values）
      .run(GRAPH_TAG_VERSION, new Date().toISOString(), entries.size, tagCount, edges, contentFingerprint(db));
    return { tags: tagCount, edges, pairs };
  });

  const res = write(bySession);
  return { sessions: rows.length, tags: res.tags, pairs: res.pairs, edges: res.edges, reused: false, ms: Date.now() - t0 };
}
