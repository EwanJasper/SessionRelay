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
import { parseQuery } from '../core/tokenize/tokenizer.js';

export const GRADES = {
  'verified-tool': 9.0,
  'verified-user': 7.5,
  'verified-file': 6.0,
  inferred: 1.5,
} as const;
export type Grade = keyof typeof GRADES;
export type Scope = 'project' | 'domain' | 'global';
export type Status = 'draft' | 'verified' | 'retired';

/** 能进注入层的最低分（写入时的基础分，之后按年龄衰减） */
export const INJECT_THRESHOLD = 6.0;
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
  const info = db.prepare(
    'INSERT INTO lessons (scope, workspace_id, domain, text, search_text, quote, source_ref, route, grade, importance, status, created_at, updated_at)'
    + ' VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(scope, input.workspaceId ?? null, input.domain ?? null, text, searchTextOf(text), input.quote ?? null,
    input.sourceRef ?? null, input.route ?? 'none', effectiveGrade, GRADES[effectiveGrade],
    input.status ?? 'draft', now, now);
    const id = Number(info.lastInsertRowid);
  // 手工维护 FTS：不用触发器 —— 触发器与表定义容易不同步（实测：改了 FTS 列名，触发器还在写旧列，
  // 报错却是「no column named text」，指向上游看不出真因）。写在同一条代码路径上，改一次就够。
  db.prepare("INSERT INTO lessons_fts(rowid, search_text, domain) VALUES (?,?,?)").run(id, searchTextOf(text), input.domain ?? null);
  return { id, reason };
}

/** 作用域可见性：project 只看自己；domain 看同领域；global 谁都看 */
export function visibleWhere(scopeSel: { workspaceId?: string; domain?: string }): { sql: string; params: unknown[] } {
  const parts = ["(scope = 'global')"];
  const params: unknown[] = [];
  if (scopeSel.workspaceId) { parts.push("(scope = 'project' AND workspace_id = ?)"); params.push(scopeSel.workspaceId); }
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
    db.prepare('UPDATE lessons SET hits = hits + 1 WHERE id IN (' + ids.map(() => '?').join(',') + ')').run(...ids);
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
    if (r.scope !== last) { g.push('', '## ' + r.scope, ''); last = r.scope; }
    g.push('- [' + r.grade + ' | ' + r.status + ' | ' + Number(liveImportance(r)).toFixed(1) + '] ' + r.text);
  }
  return g.join(String.fromCharCode(10)) + String.fromCharCode(10);
}