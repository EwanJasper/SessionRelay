// 存储层（方针 §7.2 完整 DDL + Review#3/#4 修订 + T34/T20/R8 实现增补）。
// R8（实现发现，待回填方针 Review #5）：cooldown 计时需要 pending 时刻 → sessions.pending_at。
// T34：source_files.cursor 通用水位（文件型=字节偏移 JSON；SQLite 型=rowid 水位 JSON）。
import Database from 'better-sqlite3';
import { toSearchText } from '../core/tokenize/tokenizer.js';

// 便捷再导出：dbFile 常被误从本模块导入（实测已误 4 次），统一出口消灭此类错误
export { dbFile } from '../shared/paths.js';

export type DB = Database.Database;

const SCHEMA_VERSION = 2;

const DDL = `
CREATE TABLE IF NOT EXISTS sessions (
  id                TEXT PRIMARY KEY,
  source            TEXT NOT NULL,
  source_session_id TEXT NOT NULL,
  project_id        TEXT NOT NULL,
  origin            TEXT NOT NULL DEFAULT 'auto',
  state             TEXT NOT NULL DEFAULT 'active',
  git_branch        TEXT,
  title             TEXT,
  created_at        TEXT NOT NULL,
  last_event_at     TEXT,
  confirmed_at      TEXT,
  pending_at        TEXT,
  message_count     INTEGER NOT NULL DEFAULT 0,
  files_mentioned   TEXT,
  topics            TEXT,
  decisions         TEXT,
  key_questions     TEXT,
  code_changes      TEXT,
  summary_rule      TEXT,
  summary_ai        TEXT,
  user_summary      TEXT,
  user_tags         TEXT,
  author            TEXT,
  imported_from     TEXT,
  origin_project    TEXT,
  content_hash      TEXT,
  source_file       TEXT,
  synced_at         TEXT,
  meta_text         TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_sessions_src ON sessions(source, source_session_id);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);
CREATE INDEX IF NOT EXISTS idx_sessions_state ON sessions(state);
CREATE INDEX IF NOT EXISTS idx_sessions_created ON sessions(created_at);
CREATE INDEX IF NOT EXISTS idx_sessions_author ON sessions(author);

CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role        TEXT NOT NULL,
  content     TEXT NOT NULL,
  search_text TEXT,
  seq_num     INTEGER NOT NULL,
  created_at  TEXT
);
-- T20：幂等去重键（崩溃重放去重 + 排序二合一）
CREATE UNIQUE INDEX IF NOT EXISTS ux_messages_session_seq ON messages(session_id, seq_num);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  search_text, content='messages', content_rowid='id'
);
CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, search_text) VALUES (new.id, new.search_text);
END;
CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, search_text) VALUES ('delete', old.id, old.search_text);
END;
CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE OF search_text ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, search_text) VALUES ('delete', old.id, old.search_text);
  INSERT INTO messages_fts(rowid, search_text) VALUES (new.id, new.search_text);
END;

CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
  meta_text, content='sessions', content_rowid='rowid'
);
-- F1（方针 Review #4）：外部内容表三处触发器缺一不可
CREATE TRIGGER IF NOT EXISTS sessions_fts_ai AFTER INSERT ON sessions BEGIN
  INSERT INTO sessions_fts(rowid, meta_text) VALUES (new.rowid, new.meta_text);
END;
CREATE TRIGGER IF NOT EXISTS sessions_fts_au AFTER UPDATE OF meta_text ON sessions BEGIN
  INSERT INTO sessions_fts(sessions_fts, rowid, meta_text) VALUES ('delete', old.rowid, old.meta_text);
  INSERT INTO sessions_fts(rowid, meta_text) VALUES (new.rowid, new.meta_text);
END;
CREATE TRIGGER IF NOT EXISTS sessions_fts_ad AFTER DELETE ON sessions BEGIN
  INSERT INTO sessions_fts(sessions_fts, rowid, meta_text) VALUES ('delete', old.rowid, old.meta_text);
END;

CREATE TABLE IF NOT EXISTS session_links (
  session_id        TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  linked_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  kind              TEXT NOT NULL DEFAULT 'pinned',
  created_at        TEXT NOT NULL,
  PRIMARY KEY (session_id, linked_session_id, kind)
);

CREATE TABLE IF NOT EXISTS source_files (
  source     TEXT NOT NULL,
  file_path  TEXT NOT NULL,
  cursor     TEXT,          -- T34：通用水位 JSON（{offset,lines} 或 {rowid}）
  file_hash  TEXT,
  line_count INTEGER,
  bad_lines  INTEGER NOT NULL DEFAULT 0,
  suspect    INTEGER NOT NULL DEFAULT 0,
  last_seen  TEXT NOT NULL,
  deleted    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (source, file_path)
);

CREATE TABLE IF NOT EXISTS scope_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL, predicate TEXT NOT NULL, issued_by TEXT, created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS transfer_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL, file_path TEXT NOT NULL, from_user TEXT, to_user TEXT,
  session_ids TEXT, created_at TEXT NOT NULL
);

-- ═══════════ M2：归档审计（隐私与数据生命周期设计） ═══════════
CREATE TABLE IF NOT EXISTS cleanup_log (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  triggered_by      TEXT NOT NULL,
  mode              TEXT NOT NULL,
  criteria          TEXT NOT NULL,
  sessions_affected INTEGER NOT NULL,
  sessions_skipped  INTEGER NOT NULL,
  bytes_freed       INTEGER NOT NULL,
  created_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cleanup_detail (
  cleanup_log_id INTEGER NOT NULL REFERENCES cleanup_log(id) ON DELETE CASCADE,
  session_id     TEXT NOT NULL,
  title          TEXT,
  source         TEXT NOT NULL,
  message_count  INTEGER NOT NULL,
  decision_count INTEGER NOT NULL,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cleanup_detail_log ON cleanup_detail(cleanup_log_id);
CREATE INDEX IF NOT EXISTS idx_cleanup_detail_session ON cleanup_detail(session_id);
`;

export function createDb(file: string = ':memory:'): DB {
  const db = new Database(file);
  if (file !== ':memory:') db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  const v = db.pragma('user_version', { simple: true }) as number;
  if (v > SCHEMA_VERSION) {
    db.close();
    throw new Error(`数据库由更新版本的 srelay 创建（v${v} > 支持 v${SCHEMA_VERSION}），请升级 srelay（T30）`);
  }
  db.exec(DDL);
  // M2 迁移：给已有库加归档列（CREATE TABLE IF NOT EXISTS 不会加列）
  if (v < 2) {
    const cols = db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
    const hasCleanupAt = cols.some(c => c.name === 'cleanup_at');
    if (!hasCleanupAt) {
      db.exec('ALTER TABLE sessions ADD COLUMN cleanup_at TEXT');
      db.exec('ALTER TABLE sessions ADD COLUMN original_message_count INTEGER DEFAULT 0');
    }
  }
  db.pragma(`user_version = ${SCHEMA_VERSION}`);
  return db;
}

/** 打开已初始化的库（自动执行迁移；T30 探测同 createDb） */
export function openExisting(file: string): DB {
  const db = new Database(file);
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  const v = db.pragma('user_version', { simple: true }) as number;
  if (v > SCHEMA_VERSION) {
    db.close();
    throw new Error(`数据库由更新版本的 srelay 创建（v${v}），请升级 srelay（T30）`);
  }
  // 自动迁移：确保旧库升级到当前 schema
  if (v < SCHEMA_VERSION) {
    db.exec(DDL);
    if (v < 2) {
      const cols = db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
      if (!cols.some(c => c.name === 'cleanup_at')) {
        db.exec('ALTER TABLE sessions ADD COLUMN cleanup_at TEXT');
        db.exec('ALTER TABLE sessions ADD COLUMN original_message_count INTEGER DEFAULT 0');
      }
    }
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }
  return db;
}

export function metaTextOf(title: string | null | undefined, topics: string[] = []): string {
  return toSearchText([title ?? '', ...topics].join(' '));
}

// ───────────────────────── 捕获写入（sync 引擎用） ─────────────────────────

export interface UpsertCapture {
  source: string;
  sourceSessionId: string;
  projectId: string;
  title?: string | null;
  createdAt: string;
  lastEventAt: string;
  sourceFile: string;
  origin?: 'auto' | 'manual';
}

export function upsertCapturedSession(
  db: DB,
  s: UpsertCapture,
): { id: string; isNew: boolean; prevState: string; title: string | null } {
  const existing = db
    .prepare('SELECT id, state, title FROM sessions WHERE source = ? AND source_session_id = ?')
    .get(s.source, s.sourceSessionId) as { id: string; state: string; title: string | null } | undefined;
  if (!existing) {
    const id = require$sessionId(s.source, s.sourceSessionId);
    db.prepare(`
      INSERT INTO sessions (id, source, source_session_id, project_id, origin, state, title,
                            created_at, last_event_at, source_file, meta_text, synced_at)
      VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)
    `).run(id, s.source, s.sourceSessionId, s.projectId, s.origin ?? 'auto', s.title ?? null, s.createdAt,
      s.lastEventAt, s.sourceFile, metaTextOf(s.title ?? null), new Date().toISOString());
    return { id, isNew: true, prevState: 'active', title: s.title ?? null };
  }
  // 标题为空时允许补填（首条用户消息晚到）；origin 显式传入时更新（手动 save 覆盖 auto）
  if (!existing.title && s.title) {
    db.prepare('UPDATE sessions SET title = ?, meta_text = ?, last_event_at = ?, synced_at = ?, origin = COALESCE(?, origin) WHERE id = ?')
      .run(s.title, metaTextOf(s.title), s.lastEventAt, new Date().toISOString(), s.origin ?? null, existing.id);
  } else {
    db.prepare('UPDATE sessions SET last_event_at = ?, synced_at = ?, origin = COALESCE(?, origin) WHERE id = ?')
      .run(s.lastEventAt, new Date().toISOString(), s.origin ?? null, existing.id);
  }
  return { id: existing.id, isNew: false, prevState: existing.state, title: existing.title ?? s.title ?? null };
}

// 独立小函数避免循环依赖（paths.ts 引入 crypto 而已，直接内联实现同样轻量）
import { createHash } from 'node:crypto';
function require$sessionId(source: string, sid: string): string {
  return createHash('sha1').update(`${source}:${sid}`).digest('hex').slice(0, 16);
}

export function rollbackSession(db: DB, id: string): void {
  db.prepare(`UPDATE sessions SET state = 'active', summary_rule = NULL, pending_at = NULL WHERE id = ?`).run(id);
}

export function markPending(db: DB, id: string, at: string): void {
  db.prepare(`UPDATE sessions SET state = 'pending_end', pending_at = ? WHERE id = ? AND state = 'active'`).run(at, id);
}

export function markConfirmed(db: DB, id: string, at: string): void {
  db.prepare(`UPDATE sessions SET state = 'confirmed', confirmed_at = ? WHERE id = ? AND state = 'pending_end'`).run(at, id);
}

export function forceConfirm(db: DB, id: string, at: string): number {
  return db.prepare(`UPDATE sessions SET state = 'confirmed', confirmed_at = ? WHERE id = ?`).run(at, id).changes;
}

export function purgePending(db: DB, projectId: string): number {
  return db.prepare(`DELETE FROM sessions WHERE project_id = ? AND state = 'pending_end'`).run(projectId).changes;
}

export function bumpMessageCount(db: DB, id: string, delta: number): void {
  db.prepare('UPDATE sessions SET message_count = message_count + ? WHERE id = ?').run(delta, id);
}

export function getCursor(db: DB, source: string, filePath: string): unknown {
  const row = db.prepare('SELECT cursor FROM source_files WHERE source = ? AND file_path = ?').get(source, filePath) as { cursor: string | null } | undefined;
  if (!row || !row.cursor) return null;
  try { return JSON.parse(row.cursor); } catch { return null; }
}

export function recordCursor(
  db: DB,
  source: string,
  filePath: string,
  cursor: unknown,
  extra?: { badLines?: number; lineCount?: number; suspect?: boolean },
): void {
  db.prepare(`
    INSERT INTO source_files (source, file_path, cursor, bad_lines, line_count, suspect, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source, file_path) DO UPDATE SET
      cursor = excluded.cursor, last_seen = excluded.last_seen,
      bad_lines = bad_lines + excluded.bad_lines,
      line_count = COALESCE(excluded.line_count, line_count),
      suspect = MAX(suspect, excluded.suspect)
  `).run(source, filePath, JSON.stringify(cursor), extra?.badLines ?? 0, extra?.lineCount ?? null,
    extra?.suspect ? 1 : 0, new Date().toISOString());
}

// ───────────────────────── 查询（CLI/judge 用） ─────────────────────────

export interface SessionRow {
  id: string; source: string; source_session_id: string; state: string; origin: string;
  title: string | null; created_at: string; last_event_at: string | null;
  message_count: number; summary_rule: string | null;
}

export function getSession(db: DB, id: string): SessionRow | undefined {
  return db.prepare('SELECT id, source, source_session_id, state, origin, title, created_at, last_event_at, message_count, summary_rule FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
}

export function findSessionByPrefix(db: DB, prefix: string, projectId: string): SessionRow | undefined {
  return db.prepare('SELECT id, source, source_session_id, state, origin, title, created_at, last_event_at, message_count, summary_rule FROM sessions WHERE project_id = ? AND id LIKE ? ORDER BY last_event_at DESC LIMIT 1').get(projectId, prefix + '%') as SessionRow | undefined;
}

export function listSessions(db: DB, opts: { projectId: string; source?: string; state?: string; limit?: number; where?: { sql: string; params: unknown[] } | null }): SessionRow[] {
  const conds = ['project_id = ?'];
  const params: unknown[] = [opts.projectId];
  if (opts.source) { conds.push('source = ?'); params.push(opts.source); }
  if (opts.state) { conds.push('state = ?'); params.push(opts.state); }
  if (opts.where) { conds.push(opts.where.sql); params.push(...opts.where.params); }
  params.push(opts.limit ?? 20);
  return db.prepare(`SELECT id, source, source_session_id, state, origin, title, created_at, last_event_at, message_count, summary_rule FROM sessions s WHERE ${conds.join(' AND ')} ORDER BY COALESCE(s.last_event_at, s.created_at) DESC LIMIT ?`).all(...params) as SessionRow[];
}

/** Scope 审计（方针 §7.2 scope_log；Team 版复用） */
export function insertScopeLog(db: DB, action: string, predicate: unknown, issuedBy?: string): void {
  db.prepare('INSERT INTO scope_log (action, predicate, issued_by, created_at) VALUES (?, ?, ?, ?)')
    .run(action, JSON.stringify(predicate ?? {}), issuedBy ?? null, new Date().toISOString());
}

export function recentScopeLogs(db: DB, limit = 10): Array<{ action: string; predicate: string; created_at: string }> {
  return db.prepare('SELECT action, predicate, created_at FROM scope_log ORDER BY id DESC LIMIT ?').all(limit) as Array<{ action: string; predicate: string; created_at: string }>;
}

export function countsByState(db: DB, projectId: string): Record<string, number> {
  const rows = db.prepare('SELECT state, COUNT(*) n FROM sessions WHERE project_id = ? GROUP BY state').all(projectId) as Array<{ state: string; n: number }>;
  return Object.fromEntries(rows.map(r => [r.state, r.n]));
}

export function countsBySource(db: DB, projectId: string): Record<string, number> {
  const rows = db.prepare('SELECT source, COUNT(*) n FROM sessions WHERE project_id = ? GROUP BY source').all(projectId) as Array<{ source: string; n: number }>;
  return Object.fromEntries(rows.map(r => [r.source, r.n]));
}

export function recentSessions(db: DB, projectId: string, n = 3): SessionRow[] {
  return listSessions(db, { projectId, limit: n });
}

export function dueIdle(db: DB, projectId: string, cutoffIso: string): string[] {
  return (db.prepare(`SELECT id FROM sessions WHERE project_id = ? AND state = 'active' AND last_event_at IS NOT NULL AND last_event_at < ?`).all(projectId, cutoffIso) as Array<{ id: string }>).map(r => r.id);
}

export function dueConfirm(db: DB, projectId: string, cutoffIso: string): string[] {
  return (db.prepare(`SELECT id FROM sessions WHERE project_id = ? AND state = 'pending_end' AND pending_at IS NOT NULL AND pending_at < ?`).all(projectId, cutoffIso) as Array<{ id: string }>).map(r => r.id);
}

export function getMessageRange(db: DB, sessionId: string, fromSeq: number, toSeq: number): Array<{ role: string; content: string; seq_num: number; created_at: string | null }> {
  return db.prepare('SELECT role, content, seq_num, created_at FROM messages WHERE session_id = ? AND seq_num >= ? AND seq_num <= ? ORDER BY seq_num').all(sessionId, fromSeq, toSeq) as Array<{ role: string; content: string; seq_num: number; created_at: string | null }>;
}

// ───────────────────── Phase 2：confirmed 副作用与元数据查询 ─────────────────────

import { extractMessages, summaryRule, type Msg, type ExtractedMeta } from '../core/extract/extract.js';

export function getSessionMessages(db: DB, sessionId: string): Msg[] {
  return (db.prepare('SELECT role, content, seq_num, created_at FROM messages WHERE session_id = ? ORDER BY seq_num')
    .all(sessionId) as Array<{ role: string; content: string; seq_num: number; created_at: string | null }>)
    .map((r) => ({ role: r.role === 'user' ? 'user' : 'assistant', content: r.content, seqNum: r.seq_num, createdAt: r.created_at }));
}

/** confirmed 统一入口（judge 与 srelay confirm 共用）：提取元数据 + summary_rule + meta_text 重算 */
export function confirmSession(db: DB, id: string, at: string): boolean {
  const s = getSession(db, id);
  if (!s) return false;
  const msgs = getSessionMessages(db, id); // meta 模式无正文 → 提取为空，摘要仅标题/计数
  const meta: ExtractedMeta = extractMessages(msgs);
  const summary = summaryRule(s.title, meta, {
    messageCount: s.message_count,
    source: s.source,
    firstAt: s.created_at,
    lastAt: s.last_event_at,
  });
  applyExtraction(db, id, meta, summary);
  db.prepare(`UPDATE sessions SET state = 'confirmed', confirmed_at = ?, pending_at = NULL WHERE id = ?`).run(at, id);
  return true;
}

export function applyExtraction(db: DB, id: string, meta: ExtractedMeta, summary: string): void {
  const s = getSession(db, id);
  const topicsAndDecisions = [...meta.topics, ...meta.decisions.map((d) => d.text.slice(0, 30))];
  db.prepare(`
    UPDATE sessions SET
      files_mentioned = ?, topics = ?, decisions = ?, key_questions = ?, code_changes = ?,
      summary_rule = ?, meta_text = ?
    WHERE id = ?
  `).run(
    JSON.stringify(meta.files),
    JSON.stringify(meta.topics),
    JSON.stringify(meta.decisions),
    JSON.stringify(meta.questions),
    JSON.stringify({ codeBlockCount: meta.codeBlockCount }),
    summary,
    metaTextOf(s?.title ?? null, topicsAndDecisions),
    id,
  );
}

export interface DecisionRow {
  at: string; source: string; sessionId: string; title: string | null;
  text: string; seq: number; msgAt?: string;
}

export function listDecisions(db: DB, projectId: string, filter?: { topic?: string; source?: string }): DecisionRow[] {
  const conds = ['project_id = ?', "state = 'confirmed'", 'decisions IS NOT NULL'];
  const params: unknown[] = [projectId];
  if (filter?.source) { conds.push('source = ?'); params.push(filter.source); }
  const rows = db.prepare(`SELECT id, source, title, created_at, decisions, topics FROM sessions WHERE ${conds.join(' AND ')} ORDER BY created_at DESC`).all(...params) as Array<{
    id: string; source: string; title: string | null; created_at: string; decisions: string; topics: string | null;
  }>;
  const out: DecisionRow[] = [];
  for (const r of rows) {
    let decs: Array<{ text: string; seq: number; at?: string }> = [];
    let topics: string[] = [];
    try { decs = JSON.parse(r.decisions); topics = JSON.parse(r.topics ?? '[]'); } catch { continue; }
    if (filter?.topic && !topics.includes(filter.topic) && !r.title?.includes(filter.topic)) continue;
    for (const d of decs) {
      out.push({ at: d.at ?? r.created_at, source: r.source, sessionId: r.id, title: r.title, text: d.text, seq: d.seq, msgAt: d.at });
    }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

export interface UnresolvedRow { q: string; at: string; source: string; sessionId: string; title: string | null }

export function listUnresolved(db: DB, projectId: string, limit = 20): UnresolvedRow[] {
  const rows = db.prepare(`SELECT id, source, title, created_at, key_questions FROM sessions WHERE project_id = ? AND key_questions IS NOT NULL ORDER BY created_at DESC`).all(projectId) as Array<{
    id: string; source: string; title: string | null; created_at: string; key_questions: string;
  }>;
  const out: UnresolvedRow[] = [];
  for (const r of rows) {
    let qs: Array<{ q: string; at?: string; unresolved: boolean }> = [];
    try { qs = JSON.parse(r.key_questions); } catch { continue; }
    for (const q of qs.filter((x) => x.unresolved)) {
      out.push({ q: q.q, at: q.at ?? r.created_at, source: r.source, sessionId: r.id, title: r.title });
    }
  }
  return out.slice(0, limit);
}

// ───────────────────── Phase 3.5：HOP 导出/导入/团队 ─────────────────────

export interface SessionFull {
  id: string; source: string; sourceSessionId: string; projectId: string; origin: string;
  state: string; title: string | null; createdAt: string; lastEventAt: string | null;
  messageCount: number; files: string[]; topics: string[];
  decisions: Array<{ text: string; seq: number; at?: string }>;
  questions: Array<{ q: string; seq: number; at?: string; unresolved: boolean }>;
  summaryRule: string | null; userTags: string[]; author: string | null;
  importedFrom: string | null; originProject: string | null; contentHash: string | null;
  sourceFile: string | null;
}

export function getSessionFull(db: DB, id: string): SessionFull | undefined {
  const r = db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  if (!r) return undefined;
  const j = <T,>(v: unknown, fb: T): T => { try { return v == null ? fb : JSON.parse(String(v)) as T; } catch { return fb; } };
  return {
    id: String(r.id), source: String(r.source), sourceSessionId: String(r.source_session_id),
    projectId: String(r.project_id), origin: String(r.origin), state: String(r.state),
    title: (r.title as string | null) ?? null, createdAt: String(r.created_at),
    lastEventAt: (r.last_event_at as string | null) ?? null, messageCount: Number(r.message_count ?? 0),
    files: j<string[]>(r.files_mentioned, []), topics: j<string[]>(r.topics, []),
    decisions: j(r.decisions, []), questions: j(r.key_questions, []),
    summaryRule: (r.summary_rule as string | null) ?? null, userTags: j<string[]>(r.user_tags, []),
    author: (r.author as string | null) ?? null, importedFrom: (r.imported_from as string | null) ?? null,
    originProject: (r.origin_project as string | null) ?? null,
    contentHash: (r.content_hash as string | null) ?? null, sourceFile: (r.source_file as string | null) ?? null,
  };
}

export interface ImportedSessionInput {
  source: string; sourceSessionId: string; projectId: string;
  title: string | null; createdAt: string; lastEventAt: string | null;
  messageCount: number; topics: string[]; decisions: Array<{ text: string; seq: number; at?: string }>;
  summaryRule: string | null; author: string | null; importedFrom: string | null; originProject: string | null;
  contentHash: string | null; sourceFile: string | null;
}

/** 导入（T21 归化 + 往返规则）：同身份同 hash 跳过；同身份不同 hash → 后缀保留双方 */
export function insertImportedSession(db: DB, s: ImportedSessionInput): { id: string; skipped: boolean } {
  const existing = db.prepare('SELECT id, content_hash FROM sessions WHERE source = ? AND source_session_id = ?')
    .get(s.source, s.sourceSessionId) as { id: string; content_hash: string | null } | undefined;
  if (existing && s.contentHash && existing.content_hash === s.contentHash) {
    return { id: existing.id, skipped: true };
  }
  let sid = s.sourceSessionId;
  if (existing) sid = `${s.sourceSessionId}#imp-${Date.now().toString(36)}`;
  const id = require$sessionId(s.source, sid);
  const metaText = metaTextOf(s.title, [...s.topics, ...s.decisions.map((d) => d.text.slice(0, 30))]);
  db.prepare(`
    INSERT INTO sessions (id, source, source_session_id, project_id, origin, state, title, created_at, last_event_at,
                          message_count, topics, decisions, summary_rule, meta_text, author, imported_from,
                          origin_project, content_hash, source_file, confirmed_at)
    VALUES (?, ?, ?, ?, 'imported', 'confirmed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, s.source, sid, s.projectId, s.title, s.createdAt, s.lastEventAt ?? s.createdAt,
    s.messageCount, JSON.stringify(s.topics), JSON.stringify(s.decisions), s.summaryRule, metaText,
    s.author, s.importedFrom, s.originProject, s.contentHash, s.sourceFile, new Date().toISOString());
  return { id, skipped: false };
}

export function insertImportedMessage(db: DB, sessionId: string, m: { seq: number; role: string; content: string; createdAt?: string | null }): number {
  return insertMessage(db, { sessionId, role: m.role, content: m.content, seqNum: m.seq, createdAt: m.createdAt ?? undefined });
}

// ── 归档审计（隐私与数据生命周期设计） ──

export function insertCleanupLog(db: DB, o: { triggeredBy: string; mode: string; criteria: string }): number {
  return Number(db.prepare(
    'INSERT INTO cleanup_log (triggered_by, mode, criteria, sessions_affected, sessions_skipped, bytes_freed, created_at) VALUES (?,?,?,?,?,?,?)'
  ).run(o.triggeredBy, o.mode, o.criteria, 0, 0, 0, new Date().toISOString()).lastInsertRowid);
}

export function insertCleanupDetail(db: DB, o: {
  cleanupLogId: number; sessionId: string; title: string | null; source: string;
  messageCount: number; decisionCount: number;
}): void {
  db.prepare(
    'INSERT INTO cleanup_detail (cleanup_log_id, session_id, title, source, message_count, decision_count, created_at) VALUES (?,?,?,?,?,?,?)'
  ).run(o.cleanupLogId, o.sessionId, o.title, o.source, o.messageCount, o.decisionCount, new Date().toISOString());
}

// ── 会话关联（P3-A 提前落地：link/get_linked 由 MCP 工具驱动） ──

export function addSessionLink(db: DB, sessionId: string, linkedSessionId: string, kind: 'pinned' | 'continues' | 'related' = 'related'): number {
  if (sessionId === linkedSessionId) return 0;
  return db.prepare('INSERT OR IGNORE INTO session_links (session_id, linked_session_id, kind, created_at) VALUES (?,?,?,?)')
    .run(sessionId, linkedSessionId, kind, new Date().toISOString()).changes;
}

export interface LinkedSessionBrief {
  sessionId: string; title: string | null; source: string; createdAt: string;
  state: string; kind: string; direction: 'out' | 'in';
}

export function getLinkedSessions(db: DB, sessionId: string): LinkedSessionBrief[] {
  const out = db.prepare(`
    SELECT l.kind AS kind, s.id AS sid, s.title AS title, s.source AS source, s.created_at AS ca, s.state AS st
    FROM session_links l JOIN sessions s ON s.id = l.linked_session_id
    WHERE l.session_id = ?
  `).all(sessionId) as Array<{ kind: string; sid: string; title: string | null; source: string; ca: string; st: string }>;
  const inn = db.prepare(`
    SELECT l.kind AS kind, s.id AS sid, s.title AS title, s.source AS source, s.created_at AS ca, s.state AS st
    FROM session_links l JOIN sessions s ON s.id = l.session_id
    WHERE l.linked_session_id = ?
  `).all(sessionId) as Array<{ kind: string; sid: string; title: string | null; source: string; ca: string; st: string }>;
  return [
    ...out.map((r) => ({ sessionId: r.sid, title: r.title, source: r.source, createdAt: r.ca, state: r.st, kind: r.kind, direction: 'out' as const })),
    ...inn.map((r) => ({ sessionId: r.sid, title: r.title, source: r.source, createdAt: r.ca, state: r.st, kind: r.kind, direction: 'in' as const })),
  ];
}

// ── AI 笔记会话（MCP 写域：结论性记忆，source='note'，可溯源可检索） ──

export function createNoteSession(db: DB, o: { projectId: string; title: string; content: string; tags?: string[] }): string {
  const now = new Date();
  const nid = `note-${now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${Math.random().toString(36).slice(2, 6)}`;
  const id = require$sessionId('note', nid);
  const tags = o.tags ?? [];
  db.prepare(`
    INSERT INTO sessions (id, source, source_session_id, project_id, origin, state, title, created_at,
                          last_event_at, user_tags, meta_text, source_file)
    VALUES (?, 'note', ?, ?, 'manual', 'active', ?, ?, ?, ?, ?, 'mcp:save_note')
  `).run(id, nid, o.projectId, o.title.slice(0, 120), now.toISOString(), now.toISOString(),
    JSON.stringify(tags), metaTextOf(o.title, tags));
  insertMessage(db, { sessionId: id, role: 'user', content: o.content, seqNum: 1, createdAt: now.toISOString() });
  bumpMessageCount(db, id, 1);
  confirmSession(db, id, now.toISOString()); // 立即提取（笔记中的决策句式直接进决策库）+ 摘要
  // confirm 会以提取结果重写 meta_text → 再并入标签，保证标签可搜
  const s = getSessionFull(db, id);
  if (s) {
    db.prepare('UPDATE sessions SET meta_text = ? WHERE id = ?')
      .run(metaTextOf(s.title, [...s.topics, ...tags]), id);
  }
  return id;
}

export function insertTransferLog(db: DB, type: 'export' | 'import', filePath: string, fromUser: string | null, toUser: string | null, sessionIds: string[]): void {
  db.prepare('INSERT INTO transfer_log (type, file_path, from_user, to_user, session_ids, created_at) VALUES (?,?,?,?,?,?)')
    .run(type, filePath, fromUser, toUser, JSON.stringify(sessionIds), new Date().toISOString());
}

export function listTransferLog(db: DB, limit = 20): Array<{ type: string; file_path: string; from_user: string | null; to_user: string | null; session_ids: string; created_at: string }> {
  return db.prepare('SELECT type, file_path, from_user, to_user, session_ids, created_at FROM transfer_log ORDER BY id DESC LIMIT ?').all(limit) as Array<{ type: string; file_path: string; from_user: string | null; to_user: string | null; session_ids: string; created_at: string }>;
}

export interface TeamStatus { native: number; imported: number; byAuthor: Record<string, number>; byImporter: Record<string, number>; packages: number }

export function teamStatus(db: DB, projectId: string): TeamStatus {
  const origin = db.prepare('SELECT origin, COUNT(*) n FROM sessions WHERE project_id = ? GROUP BY origin').all(projectId) as Array<{ origin: string; n: number }>;
  const byAuthor: Record<string, number> = {};
  for (const r of db.prepare('SELECT COALESCE(author, imported_from, "（未署名）") a, COUNT(*) n FROM sessions WHERE project_id = ? GROUP BY a').all(projectId) as Array<{ a: string; n: number }>) byAuthor[r.a] = r.n;
  const byImporter: Record<string, number> = {};
  for (const r of db.prepare("SELECT COALESCE(imported_from, '（本地捕获）') a, COUNT(*) n FROM sessions WHERE project_id = ? GROUP BY a").all(projectId) as Array<{ a: string; n: number }>) byImporter[r.a] = r.n;
  return {
    native: origin.find((r) => r.origin !== 'imported')?.n ?? 0,
    imported: origin.find((r) => r.origin === 'imported')?.n ?? 0,
    byAuthor, byImporter,
    packages: (db.prepare("SELECT COUNT(DISTINCT file_path) n FROM transfer_log WHERE type='import'").get() as { n: number }).n,
  };
}

// ───────────────────────── Spike 期兼容 API（既有测试沿用） ─────────────────────────

export interface SessionSeed {
  id: string; source: string; sourceSessionId: string; projectId: string;
  title?: string; createdAt: string; topics?: string[]; files?: string[]; tags?: string[];
  state?: string; metaText?: string;
}

export function insertSession(db: DB, s: SessionSeed): void {
  db.prepare(`
    INSERT OR REPLACE INTO sessions
      (id, source, source_session_id, project_id, state, title, created_at,
       topics, files_mentioned, user_tags, meta_text)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    s.id, s.source, s.sourceSessionId, s.projectId, s.state ?? 'active',
    s.title ?? null, s.createdAt,
    s.topics ? JSON.stringify(s.topics) : null,
    s.files ? JSON.stringify(s.files) : null,
    s.tags ? JSON.stringify(s.tags) : null,
    s.metaText ?? null,
  );
}

export function insertMessage(
  db: DB,
  m: { sessionId: string; role: string; content: string; seqNum: number; createdAt?: string },
): number {
  const info = db.prepare(`
    INSERT OR IGNORE INTO messages (session_id, role, content, search_text, seq_num, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(m.sessionId, m.role, m.content, toSearchText(m.content), m.seqNum, m.createdAt ?? null);
  return info.changes;
}

export function countMessages(db: DB, sessionId: string): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?').get(sessionId) as { n: number }).n;
}

export function setSessionState(
  db: DB,
  id: string,
  state: string,
  patch?: { summaryRule?: string | null; confirmedAt?: string },
): void {
  if (patch && 'summaryRule' in patch) {
    db.prepare('UPDATE sessions SET state = ?, summary_rule = ?, confirmed_at = COALESCE(?, confirmed_at) WHERE id = ?')
      .run(state, patch.summaryRule ?? null, patch.confirmedAt ?? null, id);
  } else {
    db.prepare('UPDATE sessions SET state = ? WHERE id = ?').run(state, id);
  }
}
