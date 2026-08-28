// 分词器（技术方案 §3.3 / T3）：索引与查询必须共用同一实现实例，
// 否则 token 不一致是中文检索最大的隐性 bug 源。
//
// Spike 发现（待回填技术方案 §6.1）：
// 1. @node-rs/jieba v2 为类 API：Jieba.withDict(dict)，dict 来自 '@node-rs/jieba/dict'
// 2. 单字 CJK 必须入索引（"按月"非词典词，切为 按|月 —— 短语查询 C5 依赖位置连续性）；
//    单字仅在"非引号查询"侧丢弃（AND 词元无区分度）。引号短语保留完整 token 序列。
import { Jieba } from '@node-rs/jieba';
import { dict } from '@node-rs/jieba/dict';

const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g;

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
  const words = getJieba().cutForSearch(run, true).map((w) => w.trim()).filter((w) => w.length > 0);
  if (keepSingles) return words;
  const multi = words.filter((w) => Array.from(w).length >= 2 || !Array.from(w).every((ch) => isCjkCode(ch.codePointAt(0)!)));
  return multi.length > 0 ? multi : words;
}

/** 非 CJK 段 → 标识符形态词元（src/db/query.ts 保持单 token） */
function pushNonCjk(part: string, out: string[]): void {
  if (!part) return;
  for (const t of part.match(/[a-z0-9_][a-z0-9_.\/\-]*/g) ?? []) out.push(t);
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

export function parseQuery(query: string): ParsedQuery {
  const q = normalize(query);
  const units: string[][] = [];
  const phraseRe = /"([^"]+)"/g;
  const rest = q.replace(phraseRe, (_all, ph: string) => {
    const toks = segment(ph, { keepSingles: true });
    if (toks.length > 0) units.push(toks);
    return ' ';
  });
  for (const piece of rest.split(' ')) {
    if (!piece) continue;
    for (const t of segment(piece, { keepSingles: false })) units.push([t]);
  }
  return { units };
}

/** 单元 → FTS5 表达式：单 token 加引号；多 token 为短语（引号内空格连接） */
export function unitExpr(unit: string[]): string {
  return unit.length === 1 ? `"${unit[0]}"` : `"${unit.join(' ')}"`;
}

/** 多单元表达式（OR 用于取行，会话语义覆盖度在引擎层做 AND，见 engine.ts） */
export function matchExprForUnits(units: string[][], mode: 'AND' | 'OR'): string {
  return units.map(unitExpr).join(mode === 'AND' ? ' AND ' : ' OR ');
}
