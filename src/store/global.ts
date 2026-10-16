// 全局经验层（设计见 docs/1016-全局经验层设计.md）
//
// 为什么单独一个库：我们的记忆一直是「一个项目一个库」，而经验是**跨项目**的。
// 直接塞进项目库 = 跨项目泄露；直接合并所有库 = 违背既定边界。
// 所以另起一个**只存提炼后条目**的库：不存原文、不存消息、不存跨项目文件路径。
//
// 借鉴（DSH 生态实测，见 community-plugins/dsh-experience-memory）：
//   ① 写入即定级、此后不重算；② 两道闸（定级 + 相关性）；③ 预算固定；④ 会老会退休。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { searchTextOf } from './db.js';
import { normalize, parseQuery } from '../core/tokenize/tokenizer.js';
import { workspaceKey } from '../shared/workspace.js';

export const GRADES = {
  'verified-tool': 9.0,
  'verified-user': 7.5,
  'verified-file': 6.0,
  inferred: 1.5,
} as const;
export type Grade = keyof typeof GRADES;
export type Scope = 'project' | 'domain' | 'global';
export type Status = 'draft' | 'verified' | 'retired';

/**
 * 能进注入层的最低分。
 *
 * ⚠️ 必须是 5.5 而不是 6.0：verified-file 的基础分正好是 6.0，阈值若也取 6.0，
 * 那么**任何一丁点年龄衰减都会把它压到线下**（哪怕只过了几毫秒）——实测被测试抓到过
 * （expected 1 to be 2）。留 0.5 的间隔 = 新经验白送约 60 天曝光期，之后要靠被用来续命。
 */
export const INJECT_THRESHOLD = 5.5;
/** 年龄衰减：每天扣多少分（照抄实测值） */
export const DECAY_PER_DAY = 0.0083;

/** 全局库路径：~/.sessionrelay/global.sqlite（与项目库物理分开） */
export function globalDbFile(): string {
  const home = process.env.SRELAY_GLOBAL_HOME || path.join(os.homedir(), '.sessionrelay');
  return path.join(home, 'global.sqlite');
}

export function openGlobal(file?: string): Database.Database {
  const f = file ?? globalDbFile();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const db = new Database(f);
  db.pragma('journal_mode = WAL');
  db.exec(
    'CREATE TABLE IF NOT EXISTS lessons ('
    + ' id INTEGER PRIMARY KEY AUTOINCREMENT,'
    + " scope TEXT NOT NULL DEFAULT 'project',"
    + ' workspace_id TEXT,'
    + ' domain TEXT,'
    + ' text TEXT NOT NULL,'
    + ' quote TEXT,'
    + ' search_text TEXT,'
    + ' source_ref TEXT,'
    + " route TEXT NOT NULL DEFAULT 'none',"
    + " grade TEXT NOT NULL DEFAULT 'inferred',"
    + ' importance REAL NOT NULL,'
    + " status TEXT NOT NULL DEFAULT 'draft',"
    + ' hits INTEGER NOT NULL DEFAULT 0,'
    + ' uses INTEGER NOT NULL DEFAULT 0,'
    + ' needs_review INTEGER NOT NULL DEFAULT 0,'
    + ' created_at TEXT NOT NULL, updated_at TEXT NOT NULL'
    + ');'
    + 'CREATE INDEX IF NOT EXISTS lessons_scope ON lessons(scope, workspace_id, domain);'
    + 'CREATE INDEX IF NOT EXISTS lessons_status ON lessons(status);'
    + 'CREATE VIRTUAL TABLE IF NOT EXISTS lessons_fts USING fts5(search_text, domain, content=\'lessons\', content_rowid=\'id\', tokenize=\'unicode61\');'
  );
  return db;
}

export interface LessonRow {
  id: number; scope: Scope; workspace_id: string | null; domain: string | null;
  text: string; grade: Grade; importance: number; status: Status;
  hits: number; uses: number; needs_review: number; created_at: string;
}

/** 年龄衰减后的实时重要度（定级分**不重算**，重算的是这个） */
export function liveImportance(row: LessonRow, now = Date.now()): number {
  const days = Math.max(0, (now - Date.parse(row.created_at)) / 86400000);
  const bonus = Math.log1p(row.uses) * 1.5 + Math.min(1.0, row.hits * 0.1);
  return row.importance - days * DECAY_PER_DAY + bonus;
}

export interface AddInput {
  text: string; grade?: Grade; scope?: Scope; workspaceId?: string; domain?: string;
  quote?: string; sourceRef?: string; route?: string; status?: Status;
}

export function addLesson(db: Database.Database, input: AddInput): { id: number; reason: string } {
  const grade: Grade = input.grade ?? 'inferred';
  const scope: Scope = input.scope ?? 'project';
  const text = String(input.text ?? '').trim();
  if (!text) throw new Error('经验正文不能为空');
  if (scope === 'project' && !input.workspaceId) throw new Error('scope=project 必须给 workspaceId');
  if (scope === 'domain' && !input.domain) throw new Error('scope=domain 必须给 domain');
  const now = new Date().toISOString();
  // 证据定级：只有真给了出处/引文才配得上非 inferred（与实测设计一致：插件自己去核对）
  let effectiveGrade: Grade = grade;
  let reason = '';
  if (grade !== 'inferred' && !input.sourceRef) { effectiveGrade = 'inferred'; reason = '给了定级但没给来源，降为 inferred'; }
  // 状态：有证据的显式录入 = verified；自动产 / 无来源 = draft（设计 §11.2 的「不能随便入库」）
  let status: Status = input.status ?? (effectiveGrade !== 'inferred' && !!input.sourceRef ? 'verified' : 'draft');
  // [红队 A-9] 显式 `--status verified` 不能绕开"没有定级就是草稿"：注入闸有 `grade <> 'inferred'` 兜着，
  // 但库里留一条"verified 且 inferred"的矛盾记录会让人误判（列表里到底算 ● 还是 ○）。
  if (status === 'verified' && effectiveGrade === 'inferred') {
    status = 'draft';
    reason = reason ? reason + '；inferred 只能是草稿' : 'inferred 只能是草稿（要进注入层先 lesson confirm）';
  }
  const info = db.prepare(
    'INSERT INTO lessons (scope, workspace_id, domain, text, search_text, quote, source_ref, route, grade, importance, status, created_at, updated_at)'
    + ' VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(scope, input.workspaceId ?? null, input.domain ?? null, text, searchTextOf(text), input.quote ?? null,
    input.sourceRef ?? null, input.route ?? 'none', effectiveGrade, GRADES[effectiveGrade],
    status, now, now);
    const id = Number(info.lastInsertRowid);
  // 手工维护 FTS：不用触发器 —— 触发器与表定义容易不同步（实测：改了 FTS 列名，触发器还在写旧列，
  // 报错却是「no column named text」，指向上游看不出真因）。写在同一条代码路径上，改一次就够。
  db.prepare("INSERT INTO lessons_fts(rowid, search_text, domain) VALUES (?,?,?)").run(id, searchTextOf(text), input.domain ?? null);
  return { id, reason };
}

/**
 * 作用域可见性（**唯一实现**，四个面都从这里取）：project 只看自己；domain 看同领域；global 谁都看。
 *
 * ⚠️ 两条实测教训，别再改回去：
 *   ① 这段 SQL 曾经被 DSH 插件与 ZCode hook **各抄一份**，抄完就漂移（插件缺 domain、hook 缺 workspace）
 *      —— 结果 `--scope domain` 的经验两端都看不见，且没有任何报错。
 *   ② workspace 用**路径比较键**比，不用字符串直接相等：Windows 上 `D:\proj` 与 `d:/proj`
 *      是同一个目录，直接相等会把同一个项目劈成两半（子目录里 add 的经验读不出来，就是这个病的轻症）。
 *      SQL 侧用 replace(lower(...), char(92), '/') 归一（**char(92) 而不是反斜杠字面量**：
 *      SQL 字符串里嵌反斜杠是这套代码踩过三次的坑），JS 侧用 workspaceKey，两侧口径必须一致。
 */
export function visibleWhere(scopeSel: { workspaceId?: string; domain?: string }): { sql: string; params: unknown[] } {
  const parts = ["(scope = 'global')"];
  const params: unknown[] = [];
  if (scopeSel.workspaceId) {
    parts.push("(scope = 'project' AND rtrim(replace(lower(workspace_id), char(92), '/'), '/') = ?)");
    params.push(workspaceKey(scopeSel.workspaceId));
  }
  if (scopeSel.domain) { parts.push("(scope = 'domain' AND domain = ?)"); params.push(scopeSel.domain); }
  return { sql: '(' + parts.join(' OR ') + ')', params };
}

export function listLessons(db: Database.Database, sel: { workspaceId?: string; domain?: string; status?: Status; top?: number }): LessonRow[] {
  const w = visibleWhere(sel);
  const extra = sel.status ? ' AND status = ?' : '';
  const rows = db.prepare('SELECT * FROM lessons WHERE ' + w.sql + extra + ' ORDER BY importance DESC LIMIT ?')
    .all(...w.params, ...(sel.status ? [sel.status] : []), sel.top ?? 50) as LessonRow[];
  return rows.map((r) => ({ ...r, importance: Number(liveImportance(r)) }));
}

export function searchLessons(db: Database.Database, q: string, sel: { workspaceId?: string; domain?: string; top?: number }): LessonRow[] {
  const w = visibleWhere(sel);
  const rows = db.prepare(
    'SELECT l.* FROM lessons_fts f JOIN lessons l ON l.id = f.rowid'
    + ' WHERE lessons_fts MATCH ? AND ' + w.sql + ' ORDER BY bm25(lessons_fts) LIMIT ?'
  ).all(ftsExpr(q), ...w.params, sel.top ?? 10) as LessonRow[];
  if (rows.length > 0) {
    const ids = rows.map((r) => r.id);
    // [红队 A-6] 原先每次检索命中都 hits+1（永久 +0.1/次）——**调试式检索会把条目顶过注入线**。
    // 现在只记「被返回过」这件事的**不落库**语义：不再自动加分；加分只走 maintain 里靠真实复用（uses）。
  }
  return rows.map((r) => ({ ...r, importance: Number(liveImportance(r)) }));
}

export function ftsExpr(q: string): string {
  const toks = parseQuery(q).units.flat();
  if (toks.length === 0) return '"' + q.replace(/"/g, '') + '"';
  return toks.map((t) => '"' + t + '"').join(' OR ');
}

export function maintainLessons(db: Database.Database): { decayed: number; retired: number; resurrected: number } {
  const rows = db.prepare('SELECT * FROM lessons').all() as LessonRow[];
  const upd = db.prepare('UPDATE lessons SET status = ?, updated_at = ? WHERE id = ?');
  const now = new Date().toISOString();
  let decayed = 0, retired = 0, resurrected = 0;
  for (const r of rows) {
    // [红队 A-3] **人明确否决的不许被自动复活**：rejected 是终态。
    if (String(r.status) === 'rejected') continue;
    const live = liveImportance(r);
    if (live < INJECT_THRESHOLD) {
      decayed++;
      if (r.status !== 'retired') { upd.run('retired', now, r.id); retired++; }
    } else if (r.status === 'retired') { upd.run('verified', now, r.id); resurrected++; }
  }
  return { decayed, retired, resurrected };
}

/** Markdown 导出：经验库必须人可读、可 git、可手改（借鉴实测做法） */
export function exportMarkdown(db: Database.Database): string {
  const rows = db.prepare('SELECT * FROM lessons ORDER BY scope, importance DESC').all() as LessonRow[];
  const g = ['# 全局经验库（自动导出，可手改；改动以数据库为准）', '', '共 ' + rows.length + ' 条', ''];
  let last = '';
  for (const r of rows) {
    // [红队 A-3] **人明确否决的不许被自动复活**：rejected 是终态。
    if (String(r.status) === 'rejected') continue;
    if (r.scope !== last) { g.push('', '## ' + r.scope, ''); last = r.scope; }
    g.push('- [' + r.grade + ' | ' + r.status + ' | ' + Number(liveImportance(r)).toFixed(1) + '] ' + r.text);
  }
  return g.join(String.fromCharCode(10)) + String.fromCharCode(10);
}
/**
 * 注入挑选：**两道闸 + 预算**（设计见 docs/1016-经验层收什么怎么筛.md §11.2）
 *
 *   闸 1 定级：只有 importance ≥ INJECT_THRESHOLD 的才算（draft 与 retired 一律不进）
 *   闸 2 相关性：与本轮要有**具体**重合——三层证据（标识符 / 共享 ≥3 字子串 / 两个不同弱证据），
 *              判据只有 gate2Score 一处；常用词不算数（实测有插件因为「这个」两个字把无关经验注进无关的一轮）。
 *   预算：超了就截（默认 ≤200 字符 / ≤3 条），**没命中就返回空数组**——空输出优于塞噪声。
 */
const COMMON_WORDS = new Set(['这个','那个','什么','怎么','为什么','可以','需要','应该','我们','你们','他们','现在','然后','没有','不是','还是','或者','因为','所以','但是','如果','已经','还有','就是','一下','东西','时候','问题','这样','那样','之外','而且']);

/**
 * 闸 2 的判据结果（判据本体见下面 gate2Score 的注释；**前端适配器一律用 .pass，不要自己比 score**）。
 */
export interface Gate2Hit {
  /** 排序用总分（只看相对大小，不是概率） */ score: number;
  /** 命中的 ASCII 标识符个数（≥3 字符，或含 . _ - / 的词，如 pnpm / RRF / max_chars） */ idents: number;
  /** 命中的强证据个数（共享 ≥3 字的 CJK 子串） */ strong: number;
  /** 命中的孤立二元组个数（各自单独出现，凑不成 3 字子串） */ weak: number;
  /** 查询里"配得上当判据"的单元总数（全是常用词时 = 0） */ usable: number;
  /** 最终判据：**唯一一处阈值** */ pass: boolean;
}

const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g;

/**
 * 闸 2：相关性打分（**唯一实现** —— DSH 插件、ZCode hook、CLI 都只有这一个判据）。
 *
 * 三层证据，**都不需要 jieba**（纯字符串操作：hook 里不用加载词典，也不会因为分词差异而两边不一致）：
 *   ① **ASCII 标识符命中** = 强证据。大小写先经 normalize 统一 ——
 *      这是红队 B 报的"正文写 MAX_CHARS 就永远匹配不上"那个病历的根治处。
 *   ② **共享 ≥3 字的 CJK 子串**（如"长度归一"）= 强证据。3 字窗口能跨过词形差异：
 *      查询写"长度归一**化**"、正文写"长度归一"，仍算命中（词级匹配在这里会漏）。
 *   ③ **孤立的 2 字二元组** = 弱证据，**要两个不同的一起出现才作数**。
 *
 * 为什么弱证据必须成对（实测两例，都是真事故）：
 *   · 写诗题（…帮我写一首关于春天的诗）↔ 决策里的"跳下**一首**"：只共享「一首」；
 *   · "MAX_CHARS 简报上限是多少" ↔ 决策里的"挤出**简报**"：只共享「简报」。
 * 前者就是红队 B 7.3 报的"📌 段不静默"——只共享一个 2 字词就判相关，等于拿 2 个名额赌噪声。
 * 反过来，**单一判据**（查询里只有一个可判据的单元，比如就问"截图"）命中即算 —— 那是用户的本意。
 *
 * 常用词（这个/怎么/一下…）一律不作证据；整窗都是常用词的 3 字窗口也跳过（"怎么样"不算）。
 */
export function gate2Score(query: string, text: string): Gate2Hit {
  const q = normalize(query);
  const t = normalize(text);

  // ① ASCII 标识符：大小写已在 normalize 里统一（compare 两侧都是小写）
  let idents = 0;
  for (const w of q.split(/[^a-z0-9._\-/]+/)) {
    if (w.length < 2) continue;
    if (!(w.length >= 3 || /[._\-/]/.test(w))) continue;
    if (t.includes(w)) idents++;
  }

  // ②③ CJK：3 字窗口 = 强；非停用二元组 = 弱
  let strong = 0;
  const weakSet = new Set<string>();
  const usableSet = new Set<string>();
  for (const run of q.match(CJK_RUN) ?? []) {
    for (let i = 0; i + 3 <= run.length; i++) {
      const win = run.slice(i, i + 3);
      if (COMMON_WORDS.has(win.slice(0, 2)) || COMMON_WORDS.has(win.slice(1, 3))) continue;  // "怎么样"这类不算
      if (t.includes(win)) strong++;
    }
    for (let i = 0; i + 2 <= run.length; i++) {
      const bg = run.slice(i, i + 2);
      if (COMMON_WORDS.has(bg)) continue;
      usableSet.add(bg);
      if (t.includes(bg)) weakSet.add(bg);
    }
  }
  for (const w of q.split(/[^a-z0-9._\-/]+/)) {
    if (w.length >= 2 && (w.length >= 3 || /[._\-/]/.test(w))) usableSet.add(w);
  }

  const weak = weakSet.size;
  const usable = usableSet.size;
  const score = idents * 2 + strong * 2 + weak;
  const pass = idents > 0 || strong > 0 || weak >= 2 || (usable === 1 && weak === 1);
  return { score, idents, strong, weak, usable, pass };
}

/** 兼容旧调用点：查询里"配得上当判据"的单元（调试/探针用） */
export function gate2Tokens(query: string): string[] {
  const q = normalize(query);
  const out = new Set<string>();
  for (const w of q.split(/[^a-z0-9._\-/]+/)) if (w.length >= 2 && (w.length >= 3 || /[._\-/]/.test(w))) out.add(w);
  for (const run of q.match(CJK_RUN) ?? []) {
    for (let i = 0; i + 2 <= run.length; i++) {
      const bg = run.slice(i, i + 2);
      if (!COMMON_WORDS.has(bg)) out.add(bg);
    }
  }
  return [...out];
}

export interface PickOptions {
  workspaceId?: string; domain?: string; query?: string; top?: number; maxChars?: number;
}

export function pickForInjection(db: Database.Database, o: PickOptions = {}): LessonRow[] {
  const top = o.top ?? 3;
  const maxChars = o.maxChars ?? 200;
  const w = visibleWhere(o);
  const rows = (db.prepare(
    "SELECT * FROM lessons WHERE " + w.sql
    + " AND status IN ('verified','confirmed') AND grade <> 'inferred'"
    + " ORDER BY importance DESC LIMIT 40"
  ).all(...w.params) as LessonRow[]).map((r) => ({ ...r, importance: Number(liveImportance(r)) }))
    .filter((r) => r.importance >= INJECT_THRESHOLD);
  if (rows.length === 0) return [];

  // 闸 2 相关性：有本轮查询时才筛；没有查询（如 ZCode 开场 / DSH 冷路径）就退化为
  // 「按重要度给最重要的几条」。**判据本身只有 gate2Score 一处**（红队 A-5/B-7 的收敛点）。
  let ranked = rows;
  if (o.query && o.query.trim()) {
    const scored = rows
      .map((r) => ({ r, ...gate2Score(o.query!, String(r.text ?? '')) }))
      // pass 的判据在 gate2ScoreTokens 里（一处）；全查询只有"这个/怎么/一下"这类词时
      // usable=0 ⇒ 谁都不 pass ⇒ 宁可什么都不给（空输出优于塞噪声）
      .filter((s) => s.pass)
      .sort((a, b) => b.score - a.score || b.r.importance - a.r.importance);
    ranked = scored.map((s) => s.r);
  }

  const out: LessonRow[] = [];
  let used = 0;
  for (const r of ranked) {
    const len = String(r.text).length;
    if (used + len > maxChars && out.length > 0) break;
    out.push(r);
    used += len;
    if (out.length >= top) break;
  }
  return out;
}