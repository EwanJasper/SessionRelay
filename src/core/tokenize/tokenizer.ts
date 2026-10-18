// 分词器（技术方案 §3.3 / T3）：索引与查询必须共用同一实现实例，
// 否则 token 不一致是中文检索最大的隐性 bug 源。
//
// Spike 发现（待回填技术方案 §6.1）：
// 1. @node-rs/jieba v2 为类 API：Jieba.withDict(dict)，dict 来自 '@node-rs/jieba/dict'
// 2. 单字 CJK 必须入索引（"按月"非词典词，切为 按|月 —— 短语查询 C5 依赖位置连续性）；
//    单字仅在"非引号查询"侧丢弃（AND 词元无区分度）。引号短语保留完整 token 序列。
//
// ⚠️ config.ts 早就声明 search.tokenizer: 'jieba' | 'bigram'，但这里长期只有 jieba
// 一条实现——配置里写 bigram 什么都不发生且不报错（ADR-002）。现已补齐。
import { Jieba } from '@node-rs/jieba';
import { dict } from '@node-rs/jieba/dict.js';
import type { RelayConfig } from '../../shared/config.js';

type TokenizerKind = RelayConfig['search']['tokenizer'];

const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g;
const IDENT_RE = /[a-z0-9_][a-z0-9_.\/\-]*/g;

let jieba: Jieba | null = null;
function getJieba(): Jieba {
  if (!jieba) jieba = Jieba.withDict(dict);
  return jieba;
}

function isCjkCode(c: number): boolean {
  return (c >= 0x3400 && c <= 0x4dbf) || (c >= 0x4e00 && c <= 0x9fff) || (c >= 0xf900 && c <= 0xfaff);
}

/** NFC 归一 + 全角转半角 + 小写 + 空白折叠（技术方案 §6.1） */
export function normalize(text: string): string {
  let s = text.normalize('NFC');
  s = s.replace(/[\uff01-\uff5e]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  s = s.replace(/\u3000/g, ' ');
  return s.replace(/\s+/g, ' ').toLowerCase();
}

export interface SegmentOptions {
  /** 保留单字 CJK。索引=true（短语位置保真）；非引号查询=false（区分度）。 */
  keepSingles?: boolean;
}

/** 单个 CJK 连续段 → 词元 */
function segmentRun(run: string, keepSingles: boolean): string[] {
  // ADR-002：bigram 路线完全不碰词典——零加载、零体积，也不受 jieba 上下文相关
  // 切分的影响（同一子串在不同文档里可能被切成不同词，那是词级匹配的不稳定源）。
  if (activeTokenizer === 'bigram') return segmentBigram(run, keepSingles);
  const words = getJieba().cutForSearch(run, true).map((w) => w.trim()).filter((w) => w.length > 0);
  if (keepSingles) return words;
  const multi = words.filter((w) => Array.from(w).length >= 2 || !Array.from(w).every((ch) => isCjkCode(ch.codePointAt(0)!)));
  return multi.length > 0 ? multi : words;
}

/** 非 CJK 段 → 标识符形态词元（src/db/query.ts 保持单 token） */
function pushNonCjk(part: string, out: string[]): void {
  if (!part) return;
  IDENT_RE.lastIndex = 0;
  for (const t of part.match(IDENT_RE) ?? []) out.push(t);
}

/**
 * 纯 unigram+bigram 分词（ADR-002）——不依赖任何词典。
 * 依据 SIGIR 1997《Chinese text retrieval without using a dictionary》：中文检索不需要
 * 通用词典，bigram 在三套测试集上全胜 138,955 词的最大匹配词典。
 *
 * 本机实测（D:\agent1super，37818 条消息 / 65 个真实查询，两边各自建索引）：
 *   召回打平（65/65 都是 100%），但 jieba 平均返回 38.5 条、bigram 只返回 3.0 条，
 *   jieba 多出的 2270 条抽样判读绝大多数是噪声（命中"需要/什么/模型"这类常用词）。
 *   所以词典没带来可测的召回收益。
 *
 * **但没有切成默认**：本测量的 ground truth 是"正文字面包含查询"，这个定义本身偏向
 * bigram（它本质就是子串匹配），测不了"换个说法"的查询。paraphrase 场景未验证前不动默认。
 */
function segmentBigram(run: string, keepSingles: boolean): string[] {
  const chars = Array.from(run);
  const out: string[] = [];
  if (keepSingles) for (const c of chars) out.push(c);
  for (let i = 0; i + 1 < chars.length; i++) out.push(chars[i] + chars[i + 1]);
  return out;
}

/** 当前生效的分词器（进程级缓存；配置在启动时读一次，改了要重启守护） */
let activeTokenizer: TokenizerKind = 'jieba';
export function setTokenizer(kind: TokenizerKind): void {
  activeTokenizer = kind;
}
export function activeTokenizerKind(): TokenizerKind {
  return activeTokenizer;
}

/** 文本 → 词元序列（索引与查询共用） */
export function segment(text: string, opts: SegmentOptions = {}): string[] {
  const keepSingles = opts.keepSingles ?? true;
  const norm = normalize(text);
  const out: string[] = [];
  let last = 0;
  CJK_RUN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CJK_RUN.exec(norm)) !== null) {
    pushNonCjk(norm.slice(last, m.index), out);
    out.push(...segmentRun(m[0], keepSingles));
    last = m.index + m[0].length;
  }
  pushNonCjk(norm.slice(last), out);
  return out;
}

/** 入库 search_text：保留单字（短语位置保真），词元空格连接 */
export function toSearchText(text: string): string {
  return segment(text, { keepSingles: true }).join(' ');
}

/** 查询解析：非引号 → 每个多字词元是独立 AND 单元；引号内 → 完整短语单元 */
export interface ParsedQuery {
  units: string[][];
}

/**
 * 查询解析：非引号 → 每个多字词元是独立 AND 单元；引号内 → 完整短语单元。
 *
 * [fork 1015] 剔除**冗余子词**：`cutForSearch` 会把"数据库"展开成
 * `["数据","据库","数据库"]`，前两个是更长词元的子串。它们在索引里保留（保召回），
 * 但查询里必须剔掉——否则会话级 AND 会被"数据"这种低区分度词元拖出一堆弱命中。
 * 实测：`数据库重算游标` 的单元从 5 个（数据/据库/数据库/重算/游标）收到 3 个。
 * （外部专家方案 3.5 的核心贡献，本机实测有效后合入。）
 */
export function parseQuery(query: string): ParsedQuery {
  const q = normalize(query);
  const units: string[][] = [];
  const phraseRe = /"([^"]+)"/g;
  const rest = q.replace(phraseRe, (_all, ph: string) => {
    const toks = segment(ph, { keepSingles: true });
    if (toks.length > 0) units.push(toks);
    return ' '
  })
  for (const piece of rest.split(' ')) {
    if (!piece) continue
    for (const t of segment(piece, { keepSingles: false })) units.push([t])
  }
  // 冗余子词剔除：只作用于**非短语单元**（短语单元是用户显式加引号的，动不得）
  const singles = units.filter((u) => u.length === 1).map((u) => u[0])
  const redundant = new Set(singles.filter((t) => singles.some((o) => o !== t && o.length > t.length && o.includes(t))))
  if (redundant.size > 0) {
    const kept = units.filter((u) => u.length > 1 || !redundant.has(u[0]))
    // 全被剔光（极端：查询只有一个被展开的词）→ 保留原样，别把查询弄空
    if (kept.length > 0) return { units: kept }
  }
  return { units }
}

/** 单元 → FTS5 表达式：单 token 加引号；多 token 为短语（引号内空格连接） */
export function unitExpr(unit: string[]): string {
  return unit.length === 1 ? `"${unit[0]}"` : `"${unit.join(' ')}"`;
}

/** 多单元表达式（OR 用于取行，会话语义覆盖度在引擎层做 AND，见 engine.ts） */
export function matchExprForUnits(units: string[][], mode: 'AND' | 'OR'): string {
  return units.map(unitExpr).join(mode === 'AND' ? ' AND ' : ' OR ');
}
