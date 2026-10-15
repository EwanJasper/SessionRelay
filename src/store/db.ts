// 存储层（方针 §7.2 完整 DDL + Review#3/#4 修订 + T34/T20/R8 实现增补）。
// R8（实现发现，待回填方针 Review #5）：cooldown 计时需要 pending 时刻 → sessions.pending_at。
// T34：source_files.cursor 通用水位（文件型=字节偏移 JSON；SQLite 型=rowid 水位 JSON）。
import Database from 'better-sqlite3';
import { toSearchText } from '../core/tokenize/tokenizer.js';
import { stripInjected } from '../core/extract/extract.js';
import { EXTRACT_VERSION } from '../core/extract/version.js';

// 便捷再导出：dbFile 常被误从本模块导入（实测已误 4 次），统一出口消灭此类错误
export { dbFile } from '../shared/paths.js';

export type DB = Database.Database;

const SCHEMA_VERSION = 5;

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
  meta_text         TEXT,
  extracted_version INTEGER NOT NULL DEFAULT 0
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

-- ═══════════ v3：遗忘（srelay forget，设计 v4 §3.2/§3.4） ═══════════
-- 墓碑：防复活次级防线（主防线是 .sessionrelayignore 的 session: 规则，跨 rebuild 存活；
-- 墓碑随库走，rebuild 后消失——故只是 ignore 被用户清理后的兜底）
CREATE TABLE IF NOT EXISTS forget_tombstones (
  source            TEXT NOT NULL,
  source_session_id TEXT NOT NULL,
  forgot_at         TEXT NOT NULL,
  PRIMARY KEY (source, source_session_id)
);

-- 审计：删除本身被永久记住（先例：cleanup_log/cleanup_detail）。
-- 规范决策（设计 v4 §3.4 评审 A1）：forget_detail.session_id 为裸 TEXT、故意无外键——
-- 被删行的 id 必须留在审计里，审计链自身永不删除。禁止后续"补上 FK"（会级联破坏审计）。
CREATE TABLE IF NOT EXISTS forget_log (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  triggered_by      TEXT NOT NULL,
  mode              TEXT NOT NULL,
  criteria          TEXT NOT NULL,
  sessions_affected INTEGER NOT NULL,
  messages_affected INTEGER NOT NULL,
  created_at        TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS forget_detail (
  forget_log_id INTEGER NOT NULL REFERENCES forget_log(id) ON DELETE CASCADE,
  session_id    TEXT NOT NULL,
  title         TEXT,
  source        TEXT,
  message_count INTEGER,
  created_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_forget_detail_log ON forget_detail(forget_log_id);

-- ═══════════ v4：语义检索（设计 design-semantic §3.4） ═══════════
-- model 列是向量版本键：换模型 = 旧行视为不存在（查询过滤 + digest 覆盖重嵌），杜绝跨维度混算。
-- FK ON DELETE CASCADE：forget 删会话连带清向量（0.2.5 forget 代码零改动即联动）。
CREATE TABLE IF NOT EXISTS session_vectors (
  session_id  TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  model       TEXT NOT NULL,
  dim         INTEGER NOT NULL,
  vec         BLOB NOT NULL,        -- Float32Array little-endian，已 L2 归一化
  embedded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_session_vectors_model ON session_vectors(model);
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
  // v14 迁移：会话级提取版本列 + 判据索引（CREATE TABLE IF NOT EXISTS 不会给旧表加列）
  {
    const xcols = db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
    if (!xcols.some(c => c.name === 'extracted_version')) {
      db.exec('ALTER TABLE sessions ADD COLUMN extracted_version INTEGER NOT NULL DEFAULT 0');
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_extractver ON sessions(extracted_version, state)');
  }
  // M2 迁移：给已有库加归档列（CREATE TABLE IF NOT EXISTS 不会加列）
  if (v < 2) {
    const cols = db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
    const hasCleanupAt = cols.some(c => c.name === 'cleanup_at');
    if (!hasCleanupAt) {
      db.exec('ALTER TABLE sessions ADD COLUMN cleanup_at TEXT');
      db.exec('ALTER TABLE sessions ADD COLUMN original_message_count INTEGER DEFAULT 0');
    }
  }
  // v5 迁移（游标竞态修复的自愈）：清空 zcode 源游标，下次 sync 全量重扫。
  // 0.4.4 及之前 assistant 消息可能因 part 流式延迟被跳过且游标越过——重扫按
  // messages (session_id, seq_num) 唯一键幂等，已捕获的不会重复，缺失的被补齐。
  if (v < 5) {
    db.prepare("DELETE FROM source_files WHERE source = 'zcode'").run();
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
    {
      const xcols = db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
      if (!xcols.some(c => c.name === 'extracted_version')) {
        db.exec('ALTER TABLE sessions ADD COLUMN extracted_version INTEGER NOT NULL DEFAULT 0');
      }
      db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_extractver ON sessions(extracted_version, state)');
    }
    if (v < 2) {
      const cols = db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
      if (!cols.some(c => c.name === 'cleanup_at')) {
        db.exec('ALTER TABLE sessions ADD COLUMN cleanup_at TEXT');
        db.exec('ALTER TABLE sessions ADD COLUMN original_message_count INTEGER DEFAULT 0');
      }
    }
    if (v < 5) {
      db.prepare("DELETE FROM source_files WHERE source = 'zcode'").run();
    }
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }
  return db;
}

/**
 * 跨会话去重键（决策与问题共用）。
 *
 * ⚠️ [1015 修] 原实现只去空白（`replace(/\s+/g, "").slice(0, 40)`），于是"同一句话被表格符号/
 * 不同标点切分"的两个版本会算成两条 —— 实测简报里同一条决策双显，`brief-sql.mjs` 那侧同因同果。
 * 现在把**标点与表格竖线**一并剔掉。键长保持 40 字符不变（改长度会改变与历史行为的可比性）。
 * 三处调用点（listDecisions / listUnresolved / 本文件的合并路径）与插件侧 brief-sql.mjs 必须同规。
 */
export function dedupKey(s: string | null | undefined): string {
  return String(s ?? '').replace(/[\s，。！？、,.!?;；:：|｜]+/g, '').slice(0, 40);
}
export function metaTextOf(title: string | null | undefined, topics: string[] = []): string {
  return searchTextOf([title ?? '', ...topics].join(' '));
}

/**
 * 进全文索引的文本。**必须先过 stripInjected**。
 *
 * 为什么：清洗规则此前只接进了抽取路径（sanitizeMsgs），索引路径从来没剥——
 * 客户端把 XML 外壳剥掉后才存进 user 消息的系统上下文（TodoWrite 提醒、运行时快照、
 * 文件策略、审批策略），于是原样进了 search_text。实测 D:\agent1super：4361 条消息带
 * 同一句提醒，占全部 search_text 的 15.9%（E:\music player 7.3%）。
 *
 * 这是与 decisions 被注入块污染**并列的第二个盲区**，症状是"索引胀大"而非简报出错，
 * 所以一直没被发现。抽取路径修好（v8）之后索引路径照样脏——必须两边都修。
 */
export function searchTextOf(text: string): string {
  return toSearchText(stripInjected(text));
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
  origin?: 'auto' | 'manual' | 'workflow';
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
  // 标题为空时允许补填（首条用户消息晚到）；origin 显式传入时更新（手动 save 覆盖 auto）。
  // [1015 夜] 但 **'manual' 不可被自动判据降级** —— 与 pinned 同族：用户显式做过的动作优先级最高。
  // 病历：ZCode 适配器改成读 task_type 真值后重跑一次 sync，382 场会话从 auto 改判 workflow，
  // 其中 **10 场原本是用户手动 save 的**（manual 36→26）被一起盖掉。显式保存过的会话不该被自动规则吞掉。
  const ORIGIN_SET = "origin = CASE WHEN origin = 'manual' THEN 'manual' ELSE COALESCE(?, origin) END";
  if (!existing.title && s.title) {
    db.prepare(`UPDATE sessions SET title = ?, meta_text = ?, last_event_at = ?, synced_at = ?, ${ORIGIN_SET} WHERE id = ?`)
      .run(s.title, metaTextOf(s.title), s.lastEventAt, new Date().toISOString(), s.origin ?? null, existing.id);
  } else {
    db.prepare(`UPDATE sessions SET last_event_at = ?, synced_at = ?, ${ORIGIN_SET} WHERE id = ?`)
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
  // 语义联动（design-semantic §3.2）：resume 回滚=正文将增长，旧向量过期，待 confirm 后重嵌
  db.prepare('DELETE FROM session_vectors WHERE session_id = ?').run(id);
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

import { extractMessages, extractDecisions, extractQuestions, extractTopics, summaryRule, sanitizeMsgs, type Msg, type ExtractedMeta } from '../core/extract/extract.js';

export function getSessionMessages(db: DB, sessionId: string): Msg[] {
  return (db.prepare('SELECT role, content, seq_num, created_at FROM messages WHERE session_id = ? ORDER BY seq_num')
    .all(sessionId) as Array<{ role: string; content: string; seq_num: number; created_at: string | null }>)
    .map((r) => ({ role: r.role === 'user' ? 'user' : 'assistant', content: r.content, seqNum: r.seq_num, createdAt: r.created_at }));
}

/** confirmed 统一入口（judge 与 srelay confirm 共用）：提取元数据 + summary_rule + meta_text 重算 */
/** [fork 0924] 提取刷新（不改变状态）：长活会话在 pending 转换时调用——
 *  决策/话题/问题随消息增量对齐，不再冻结到 6h 确认（mc整合包实测：活跃会话决策滞后 20+ 小时） */
export function refreshExtraction(db: DB, id: string): boolean {
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
  return true;
}

export function confirmSession(db: DB, id: string, at: string): boolean {
  const s = getSession(db, id);
  if (!s) return false;
  if (!refreshExtraction(db, id)) return false;
  db.prepare(`UPDATE sessions SET state = 'confirmed', confirmed_at = ?, pending_at = NULL WHERE id = ?`).run(at, id);
  return true;
}

/** [fork 0924b] 决策/问题增量刷新（pending 转换用，O(增量)）：
 *  水位 = 决策列里已有的最大 seq；只对新消息跑提取并追加（键去重）。
 *  topics/summary/meta_text 的全量重建留给 confirm（6h 一次，成本可摊）。
 *  没有水位的会话（从未提取过）退化为全量——与旧行为一致。 */
export function refreshDecisionsIncremental(db: DB, id: string): boolean {
  const s = getSession(db, id);
  if (!s) return false;
  let existing: Array<{ text: string; seq: number; at?: string }> = [];
  try { existing = JSON.parse((db.prepare('SELECT decisions FROM sessions WHERE id = ?').get(id) as { decisions?: string } | undefined)?.decisions ?? '[]'); } catch { existing = []; }
  const lastSeq = existing.reduce((m, d) => Math.max(m, d.seq ?? 0), 0);
  const msgs = (db.prepare('SELECT role, content, seq_num AS seqNum, created_at AS createdAt FROM messages WHERE session_id = ? AND seq_num > ? ORDER BY seq_num')
    .all(id, lastSeq) as Msg[]).map((m) => ({ ...m, role: m.role === 'user' ? 'user' as const : 'assistant' as const }));
  // ⚠️ 必须走 extractForWrite：这里曾直接调 extractDecisions(msgs)，没过 sanitizeMsgs，
  // 技能目录垃圾从最高频的 pending 路径原样写回库（红队 1014 🔴）。且本路径每闲置
  // 10 分钟必跑，是四个写入方里最勤快的那个。
  const extracted = extractForWrite(db, id, msgs);
  const newDecs = extracted.decisions.filter((d) => !existing.some((e) => dedupKey(e.text) === dedupKey(d.text)));
  const newQs = extracted.questions;
  if (newDecs.length === 0 && newQs.length === 0) return true;
  const mergedDecs = [...existing, ...newDecs];
  let questions: Array<{ q: string; seq: number; at?: string; unresolved: boolean }> = [];
  try { questions = JSON.parse((db.prepare('SELECT key_questions FROM sessions WHERE id = ?').get(id) as { key_questions?: string } | undefined)?.key_questions ?? '[]'); } catch { questions = []; }
  // [1015] 与其余写路径同规：走 dedupKey（标点/表格竖线一并剔掉），不再另用裸 slice(0,40)
  const qKeys = new Set(questions.map((q) => dedupKey(q.q)));
  const mergedQs = [...questions, ...newQs.filter((q) => !qKeys.has(dedupKey(q.q)))];
  const existingTags = (() => {
    const row = db.prepare('SELECT user_tags, topics FROM sessions WHERE id = ?').get(id) as { user_tags?: string | null; topics?: string | null } | undefined;
    try { return JSON.parse(row?.user_tags ?? '[]') as string[]; } catch { return []; }
  })();
  let existingTopics: string[] = [];
  try { existingTopics = JSON.parse((db.prepare('SELECT topics FROM sessions WHERE id = ?').get(id) as { topics?: string | null } | undefined)?.topics ?? '[]') as string[]; } catch { existingTopics = []; }
  const topicsAndDecisions = [...existingTopics, ...mergedDecs.map((d) => d.text.slice(0, 30)), ...existingTags];
  // [1015] 打版本戳：这是**第四条**写派生列的路径（judge 的增量刷新，每闲置 10 分钟必跑，最勤快的一条），
  // 此前独独漏了打戳——于是 active 长活会话的 extracted_version 永远停在 0，看起来像"规则没生效"。
  // 修的是这个，而不是放宽重算的状态过滤（那条不变量由回归测试 ⑤ 钉着：active 由 judge 管）。
  db.prepare('UPDATE sessions SET decisions = ?, key_questions = ?, meta_text = ?, extracted_version = ? WHERE id = ?')
    .run(JSON.stringify(mergedDecs), JSON.stringify(mergedQs), metaTextOf(s.title, topicsAndDecisions), EXTRACT_VERSION, id);
  return true;
}

/** 读某会话现有的 pinned 决策文本集合（用于并回，防重写丢状态） */
function readPinnedTexts(db: DB, id: string): Set<string> {
  try {
    const raw = (db.prepare('SELECT decisions FROM sessions WHERE id = ?').get(id) as { decisions?: string | null } | undefined)?.decisions;
    const set = new Set<string>();
    for (const d of JSON.parse(raw ?? '[]') as Array<{ text?: string; pinned?: boolean }>) {
      if (d?.pinned === true && typeof d.text === 'string') set.add(d.text);
    }
    return set;
  } catch { return new Set(); }
}

/**
 * ═══ 唯一的提取写入口 ═══
 * 所有写 `decisions` / `key_questions` 列的路径**必须**走这里，不许自己调
 * extractDecisions / extractQuestions。
 *
 * 病历（同一bug被红队两次抓到，1014）：
 *   decisions 列有四个写入方——applyExtraction（confirm）、
 *   refreshDecisionsIncremental（judge pending，最高频）、recomputeSession（版本重算）、
 *   setDecisionPinned（pin/unpin）。1014 的"剥注入块"只补进 extractMessages 入口，
 *   "pinned 并回"只补进 applyExtraction，于是：
 *     · pending 路径（每次闲置>10min 必跑）原样把技能目录垃圾写回库
 *     · 版本重算把用户置顶标记逐个静默擦掉
 *   两次都是"改了一条路，另一条路继续坏"，且全程无报错。
 *
 * 本函数把三件事锁在一处：① sanitizeMsgs 剥注入块 ② 提取 ③ 并回既有 pinned。
 * 新增写入方时，走这里就同时获得三件；自己调 extractDecisions 就会重新打开这个洞。
 */
export function extractForWrite(db: DB, id: string, msgs: Msg[]): {
  decisions: ExtractedMeta['decisions'];
  questions: ExtractedMeta['questions'];
  topics: string[];
} {
  const clean = sanitizeMsgs(msgs);
  const decisions = extractDecisions(clean);
  const questions = extractQuestions(clean);
  const topics = extractTopics(clean);
  const pinned = readPinnedTexts(db, id);
  const merged = pinned.size === 0 ? decisions
    : decisions.map((d) => (pinned.has(d.text) ? { ...d, pinned: true } : d));
  return { decisions: merged, questions, topics };
}

export function applyExtraction(db: DB, id: string, meta: ExtractedMeta, summary: string): void {
  const s = getSession(db, id);
  // [fork 0924] meta_text 重写必须并回既有 user_tags（confirm/refresh 路径同 annotate/save——
  // 否则刷新一次，用户标签就从检索索引里静默消失）
  let existingTags: string[] = [];
  try {
    existingTags = JSON.parse((db.prepare('SELECT user_tags FROM sessions WHERE id = ?').get(id) as { user_tags?: string | null } | undefined)?.user_tags ?? '[]') as string[];
  } catch { /* 空标签 */ }
  const topicsAndDecisions = [...meta.topics, ...meta.decisions.map((d) => d.text.slice(0, 30)), ...existingTags];
  // [fork 1014b] decisions 整体重写会把 pinned 置顶标记静默清掉——confirm/refresh 路径
  // 每次都走这里，用户置顶过的决策会被下一次提取吃得一干二净。与上面 user_tags 的
  // "重写必须并回既有状态"是同一类病，按 text 键把旧标记并回来。
  // pinned 并回统一走 readPinnedTexts（与 extractForWrite 同一份逻辑，不分叉）
  const pinned = readPinnedTexts(db, id);
  const decisions = pinned.size === 0
    ? meta.decisions
    : meta.decisions.map((d) => (pinned.has(d.text) ? { ...d, pinned: true } : d));
  db.prepare(`
    UPDATE sessions SET
      files_mentioned = ?, topics = ?, decisions = ?, key_questions = ?, code_changes = ?,
      summary_rule = ?, meta_text = ?, extracted_version = ?
    WHERE id = ?
  `).run(
    JSON.stringify(meta.files),
    JSON.stringify(meta.topics),
    JSON.stringify(decisions),
    JSON.stringify(meta.questions),
    JSON.stringify({ codeBlockCount: meta.codeBlockCount, keyExchanges: meta.keyExchanges }),
    summary,
    metaTextOf(s?.title ?? null, topicsAndDecisions),
    // [v14] 写派生列时必须打版本戳：新捕获/确认/刷新路径产生的数据，
    // 从此自报"我是按哪个规则版本算的"，重算判据据此决定要不要再碰它。
    EXTRACT_VERSION,
    id,
  );
}

export interface DecisionRow {
  at: string; source: string; sessionId: string; title: string | null;
  text: string; seq: number; msgAt?: string; pinned?: boolean;
  /** ADR-001：这条决策是否编码"否掉一条路"。缺省视为 'decision'（存量数据无此字段）。 */
  kind?: 'decision' | 'negative';
}

export function listDecisions(db: DB, projectId: string, filter?: { topic?: string; source?: string; kind?: 'decision' | 'negative' }): DecisionRow[] {
  // [fork 0924b] 不再过滤 state='confirmed'——长活会话（一直 active）的决策也要可见，
  // 否则决策列再新鲜也进不了简报（mc整合包 0924 实测：791 条消息的活跃会话 9 条决策不可见）。
  // 未确认会话的"半成品"风险由抽取守卫+origin 排除+简报 48h 窗三层兜住。
  const conds = ['project_id = ?', 'decisions IS NOT NULL', "(origin IS NULL OR origin != 'workflow')"];
  const params: unknown[] = [projectId];
  if (filter?.source) { conds.push('source = ?'); params.push(filter.source); }
  // ADR-001：按 kind 过滤。SQL 层用 JSON 函数不可靠（不同 Node/SQLite 版本的 json_each
  // 可用性不同），故取出后在 JS 侧过滤——listDecisions 本来就全量解析 JSON。
  const wantKind = filter?.kind;
  const rows = db.prepare(`SELECT id, source, title, created_at, decisions, topics FROM sessions WHERE ${conds.join(' AND ')} ORDER BY created_at DESC`).all(...params) as Array<{
    id: string; source: string; title: string | null; created_at: string; decisions: string; topics: string | null;
  }>;
  const out: DecisionRow[] = [];
  // [fork 1014] 跨会话去重——与 listUnresolved 的 seenQ 完全同规。
  // 此前这里一条去重都没有，而同一条决策每被一个会话碰到就重复入库一次：
  // E:\music player 实测 423 条决策里 74 条是重复（17%），最狠的一条重复了 24 次，
  // 把简报仅有的 2 个名额整个占满。rows 按 created_at DESC 排，所以先遇到的是
  // 最新出现的那次——保留新、丢弃旧，语义正确。
  // key → { idx: 已入队条目下标（-1 = 被 --kind 过滤掉了）, atMs, pinned }
  const seen = new Map<string, { idx: number; atMs: number; pinned: boolean }>();
  for (const r of rows) {
    let decs: Array<{ text: string; seq: number; at?: string; pinned?: boolean; kind?: 'decision' | 'negative' }> = [];
    let topics: string[] = [];
    try { decs = JSON.parse(r.decisions); topics = JSON.parse(r.topics ?? '[]'); } catch { continue; }
    if (filter?.topic && !topics.includes(filter.topic) && !r.title?.includes(filter.topic)) continue;
    for (const d of decs) {
      const key = dedupKey(d.text);
      if (!key) continue;
      const at = d.at ?? r.created_at;
      const atMs = Date.parse(at) || 0;
      const prev = seen.get(key);
      if (prev) {
        // 已见过同文本：**把 pinned 状态继承给先前进队的那条**。
        // 否则用户置顶的是旧会话里的条目、新会话又出现同文本决策时，胜出的最新条目
        // pinned=false，置顶静默失效（红队 1014 🟠7）。
        if (d.pinned === true && !prev.pinned) {
          prev.pinned = true;
          if (prev.idx >= 0) out[prev.idx].pinned = true;
        }
        // [1015 夜 · 修] 同键重复时保留**决策自身时间更新**的那条。
        // 病历：原实现是"先遇到的赢"，而遍历顺序是会话 created_at 降序——实测因此会留下更旧的一条：
        //   music 2/325 组、agent1super 30/893 组；music 那一组把 31h 的新决策顶成 48h 的旧重复，
        //   于是简报的决策段（48h 新鲜度窗）**提前 17 小时空掉**。
        // 旧注释说"先遇到的是最新出现的那次"——那句话只对"新会话里重写旧决策"成立，
        // 对"旧会话里的决策被新会话重新提到"不成立（`at` 才是决策自己的时间）。
        if (atMs <= prev.atMs) continue;
        prev.atMs = atMs;
        if (prev.idx < 0) continue;   // 之前被 --kind 过滤掉：保持"整键不上"，不因时间更新而复活
        const row: DecisionRow = { at, source: r.source, sessionId: r.id, title: r.title, text: d.text, seq: d.seq, msgAt: d.at, pinned: prev.pinned || d.pinned === true, kind: d.kind === 'negative' ? 'negative' : 'decision' };
        // [1015 夜 · 红队 A#2 修复] 覆写前**必须重判 --kind**：
        //   原先直接 out[prev.idx] = row ⇒ `decisions --kind decision` 可能返回 kind='negative' 的行
        //   （构造复现：同键两条，先到的 kind=decision、后到的 kind=negative 且时间更新）。
        //   修法：覆写后若不满足 wantKind，就**放弃这次覆写**（保留原条目）——
        //   原条目是按 wantKind 进来的，保留它即可维持"返回值全部符合过滤"的契约；
        //   代价是 `--kind` 视图下这一键可能保留较旧那条（可接受，且比返回错 kind 轻）。
        if (wantKind && row.kind !== wantKind) continue;
        out[prev.idx] = row;
        continue;
      }
      const row: DecisionRow = { at, source: r.source, sessionId: r.id, title: r.title, text: d.text, seq: d.seq, msgAt: d.at, pinned: d.pinned === true, kind: d.kind === 'negative' ? 'negative' : 'decision' };
      if (wantKind && row.kind !== wantKind) { seen.set(key, { idx: -1, atMs, pinned: row.pinned === true }); continue; }
      seen.set(key, { idx: out.length, atMs, pinned: row.pinned === true });
      out.push(row);
    }
  }
  // [fork 1014b] 置顶优先：本数组按时间升序返回，调用方 cmdDecisions 取末尾 N 条
  // 再 reverse 作为"最近 N 条"。所以 pinned 必须排到数组**末尾**——否则置顶的
  // 老决策（如三个月前拍板的架构选择）会被 slice(-N) 一刀切掉，置顶形同虚设。
  // 置顶组排末尾保证它一定落在取用窗口内；组内保持原升序（时间倒序语义不变），
  // 非置顶条目的时间规则逐字节不变。
  out.sort((a, b) => {
    if (!!a.pinned !== !!b.pinned) return a.pinned ? 1 : -1;
    return a.at.localeCompare(b.at);
  });
  return out;
}

/** 置顶/取消置顶决策（srelay pin/unpin）：把 decisions JSON 里 text 含 fragment
 *  的条目的 pinned 置 true（pin）或删字段（unpin，JSON 回到原状）。返回匹配条目数。
 *  匹配分两步：先 SQL LIKE 对 JSON 列做包含预筛（决策存在 JSON blob 里，没有列可
 *  等值匹配，只能整行 LIKE；% _ \ 是 LIKE 通配符，需转义防漏），再 JSON.parse
 *  逐条按 text 精确判定——LIKE 可能命中 JSON 的非 text 位置（时间戳、键名），
 *  最终以"text 包含片段"为准。JSON.parse 失败的行跳过：一条坏行不该让命令崩。
 *
 *  ⚠️ LIKE 预筛对含反斜杠的片段会失配：decisions 是 JSON 列，字面 `\` 在库里存成
 *  **两个字符**，而转义后的 LIKE 模式只匹配单个字面 `\`。红队 1014 实测：库里有
 *  "决定把 100%_raw\path 换成新格式"，`pin "100%_raw\path"` 命中 0 而
 *  `pin "100%_raw"` 命中 1——含 Windows 路径的决策置顶静默失效。
 *  修法：预筛同时试**原样**与**JSON 义**（\ → \\）两种模式，命中任一即入围。
 *
 *  ⚠️ 空片段必须拒绝：`fragment=''` → LIKE `%%` 命中全部行 → `text.includes('')`
 *  恒真 → 一次 `pin ""` 把全库所有决策置顶（红队 1014 🟠）。 */
export function setDecisionPinned(db: DB, projectId: string, fragment: string, pinned: boolean): number {
  if (!fragment || !fragment.trim()) return 0;   // 空片段：拒绝，否则全库被置顶
  // 预筛两种形态：原样 + JSON 双写反斜杠（覆盖路径类片段）
  const esc = (s: string) => s.replace(/[\\%_]/g, (c: string) => '\\' + c);
  const likeA = `%${esc(fragment)}%`;
  const likeB = `%${esc(fragment.replace(/\\/g, '\\\\'))}%`;
  const rows = db.prepare(`SELECT id, decisions FROM sessions WHERE project_id = ? AND decisions IS NOT NULL AND (decisions LIKE ? ESCAPE '\\' OR decisions LIKE ? ESCAPE '\\')`).all(projectId, likeA, likeB) as Array<{ id: string; decisions: string }>;
  let changed = 0;
  for (const r of rows) {
    let decs: Array<{ text: string; seq: number; at?: string; pinned?: boolean }>;
    try { decs = JSON.parse(r.decisions); } catch { continue; }
    if (!Array.isArray(decs)) continue;
    let touched = false;
    for (const d of decs) {
      if (typeof d?.text !== 'string' || !d.text.includes(fragment)) continue;
      if (pinned) d.pinned = true;
      else delete d.pinned;
      touched = true;
      changed++;
    }
    if (touched) db.prepare('UPDATE sessions SET decisions = ? WHERE id = ?').run(JSON.stringify(decs), r.id);
  }
  return changed;
}

export interface UnresolvedRow { q: string; at: string; source: string; sessionId: string; title: string | null }

export function listUnresolved(db: DB, projectId: string, limit = 20): UnresolvedRow[] {
  // [fork 0924] 同步排除 workflow 施工会话（与 listDecisions 同规，问题 4 的垃圾同源）
  const rows = db.prepare(`SELECT id, source, title, created_at, key_questions FROM sessions WHERE project_id = ? AND key_questions IS NOT NULL AND (origin IS NULL OR origin != 'workflow') ORDER BY created_at DESC`).all(projectId) as Array<{
    id: string; source: string; title: string | null; created_at: string; key_questions: string;
  }>;
  const out: UnresolvedRow[] = [];
  const seenQ = new Set<string>();
  for (const r of rows) {
    let qs: Array<{ q: string; at?: string; unresolved: boolean }> = [];
    try { qs = JSON.parse(r.key_questions); } catch { continue; }
    for (const q of qs.filter((x) => x.unresolved)) {
      // [fork 0924] 同一问题在多个会话被捕获时去重（简报曾同条双显）
      const key = dedupKey(q.q);
      if (key && seenQ.has(key)) continue;
      if (key) seenQ.add(key);
      out.push({ q: q.q, at: q.at ?? r.created_at, source: r.source, sessionId: r.id, title: r.title });
    }
  }
  return out.slice(0, limit);
}

// ───────────────────── Phase 1.5：简报一次取全（srelay brief --json） ─────────────────────

export interface RecentFileRow { file: string; sessions: number; decisions: number }

/**
 * 到处都出现的文件：实测会把真正的「在动什么」挤出前三（主库前三名一度全是它们）。
 * export 出去是给 cli/kanban.ts 用——**同一张表曾有三处各写一份**（这里 / 插件 brief-sql / kanban 的 UBIQ），
 * 其中 kanban 那份是子集（少了 README.en.md / settings.json / vitest.config.ts / pnpm-lock.yaml），
 * 正是本项目反复吃的「同一概念多处实现 → 悄悄漂移」那类亏。核心库内至少只留一份。
 */
export const UBIQUITOUS_FILES = new Set(['AGENTS.md', 'CLAUDE.md', 'SKILL.md', 'README.md', 'README.en.md',
  'package.json', 'package-lock.json', 'config.json', 'tsconfig.json', 'progress.md',
  'settings.json', 'vitest.config.ts', 'pnpm-lock.yaml'])

/**
 * 「最近在动哪些文件」——**与 DSH 插件 plugins/dsh/src/brief-sql.mjs:queryRecentFiles 同规**。
 *
 * 为什么两端各有一份实现：插件走 node:sqlite 直查（0 子进程、毫秒级），核心库走 better-sqlite3，
 * 两个运行时不能共用模块。所以这里必须**逐条对齐**：同 SQL、同过滤、同排序、同截断。
 * 插件 selftest §12 拿真实库与 `srelay brief --json` 对拍——改一边必须改另一边。
 *
 * 口径（1015 夜体检过，**别把它当名次用**）：近 N 天被提到过的文件，按「出现过它的会话数」降序，
 * 至少 2 场会话才列；`decisions` 是**这些会话的决策总数**（同一批会话里的文件必然同值），
 * 只用于并列时的次级排序，不进简报显示。全部数字见 docs/1015-深夜-最近在动-信号体检.md。
 */
export function listRecentFiles(db: DB, opts: { days?: number; top?: number; maxSessions?: number } = {}): RecentFileRow[] {
  const days = opts.days ?? 7
  const top = opts.top ?? 3
  const maxSessions = opts.maxSessions ?? 300
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString()
  const rows = db.prepare(`SELECT files_mentioned, decisions, coalesce(last_event_at, created_at) AS t
    FROM sessions
    WHERE files_mentioned IS NOT NULL AND files_mentioned != '[]' AND coalesce(last_event_at, created_at) >= ?
    ORDER BY t DESC LIMIT ?`).all(cutoff, maxSessions) as Array<{ files_mentioned: string; decisions: string | null }>
  const agg = new Map<string, RecentFileRow>()
  for (const r of rows) {
    let files: unknown = []
    try { files = JSON.parse(r.files_mentioned) } catch { continue }
    if (!Array.isArray(files)) continue
    let decs = 0
    try { const d: unknown = JSON.parse(r.decisions || '[]'); decs = Array.isArray(d) ? d.length : 0 } catch { decs = 0 }
    for (const f of files) {
      if (typeof f !== 'string' || f.length < 4) continue
      const cur = agg.get(f) ?? { file: f, sessions: 0, decisions: 0 }
      cur.sessions += 1
      cur.decisions += decs
      agg.set(f, cur)
    }
  }
  return [...agg.values()]
    .filter((x) => !UBIQUITOUS_FILES.has(String(x.file).split('/').pop() || ''))
    .filter((x) => x.sessions >= 2)
    .sort((a, b) => b.sessions - a.sessions || b.decisions - a.decisions)
    .slice(0, top)
}

// ───────────────────── Phase 3.5：HOP 导出/导入/团队 ─────────────────────

export interface SessionFull {
  id: string; source: string; sourceSessionId: string; projectId: string; origin: string;
  state: string; title: string | null; createdAt: string; lastEventAt: string | null;
  messageCount: number; files: string[]; topics: string[];
  decisions: Array<{ text: string; seq: number; at?: string; pinned?: boolean; kind?: 'decision' | 'negative' }>;
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
  messageCount: number; topics: string[]; decisions: Array<{ text: string; seq: number; at?: string; pinned?: boolean; kind?: 'decision' | 'negative' }>;
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
  // [1015 夜 · 版本对齐] 导入路径必须**自报版本**——这是 decisions 的第 5 个写入方，
  // 原先 INSERT 列清单里没有 extracted_version，于是它落在 DEFAULT 0 = 「落后于当前规则」。
  // 危害不是「不重算」，而是**会被盲目重算**：
  //   recompute 的选取条件是 extracted_version < 当前版本 AND message_count > 0，
  //   而导入的 messageCount 来自 HOP 包——若包是**只带决策不带消息**的交接（协议允许），
  //   message_count>0 成立却没有 messages 行 ⇒ 重算从 0 条消息里重新提取 ⇒ **把导入的决策清空**。
  // 打当前版本 = 「这是一份来自别处的快照，别拿本地规则重刷它」，语义与 capture 路径一致。
  // 若将来确要用本地规则重抽，手工把 extracted_version 置 0 再 recompute 即可。
  db.prepare(`
    INSERT INTO sessions (id, source, source_session_id, project_id, origin, state, title, created_at, last_event_at,
                          message_count, topics, decisions, summary_rule, meta_text, author, imported_from,
                          origin_project, content_hash, source_file, confirmed_at, extracted_version)
    VALUES (?, ?, ?, ?, 'imported', 'confirmed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, s.source, sid, s.projectId, s.title, s.createdAt, s.lastEventAt ?? s.createdAt,
    s.messageCount, JSON.stringify(s.topics), JSON.stringify(s.decisions), s.summaryRule, metaText,
    s.author, s.importedFrom, s.originProject, s.contentHash, s.sourceFile, new Date().toISOString(), EXTRACT_VERSION);
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

// ── 遗忘：墓碑与审计（设计 v4 §3.2/§3.4；MCP 永不获得删除能力） ──

/** 整表一次载入（规范形态，评审 A2：禁止 per-session 点查——常态 <100 行，Set 常驻零成本） */
export function loadTombstones(db: DB): Set<string> {
  const rows = db.prepare('SELECT source, source_session_id FROM forget_tombstones').all() as Array<{ source: string; source_session_id: string }>;
  return new Set(rows.map((r) => `${r.source}:${r.source_session_id}`));
}

export function insertTombstone(db: DB, source: string, sourceSessionId: string, at: string): void {
  db.prepare('INSERT OR REPLACE INTO forget_tombstones (source, source_session_id, forgot_at) VALUES (?,?,?)')
    .run(source, sourceSessionId, at);
}

export function insertForgetLog(db: DB, o: { triggeredBy: string; mode: string; criteria: string }): number {
  return Number(db.prepare(
    'INSERT INTO forget_log (triggered_by, mode, criteria, sessions_affected, messages_affected, created_at) VALUES (?,?,?,?,?,?)'
  ).run(o.triggeredBy, o.mode, o.criteria, 0, 0, new Date().toISOString()).lastInsertRowid);
}

export function finalizeForgetLog(db: DB, id: number, sessionsAffected: number, messagesAffected: number): void {
  db.prepare('UPDATE forget_log SET sessions_affected = ?, messages_affected = ? WHERE id = ?')
    .run(sessionsAffected, messagesAffected, id);
}

export function insertForgetDetail(db: DB, o: {
  forgetLogId: number; sessionId: string; title: string | null; source: string;
  messageCount: number; createdAt: string | null;
}): void {
  db.prepare(
    'INSERT INTO forget_detail (forget_log_id, session_id, title, source, message_count, created_at) VALUES (?,?,?,?,?,?)'
  ).run(o.forgetLogId, o.sessionId, o.title, o.source, o.messageCount, o.createdAt);
}

export function getForgetHistory(db: DB, opts?: { verbose?: boolean; logId?: number }): Array<Record<string, unknown>> {
  if (opts?.logId) {
    return db.prepare('SELECT session_id, title, source, message_count, created_at FROM forget_detail WHERE forget_log_id = ?').all(opts.logId) as Array<Record<string, unknown>>;
  }
  const logs = db.prepare('SELECT * FROM forget_log ORDER BY id DESC').all() as Array<Record<string, unknown>>;
  if (!opts?.verbose) return logs;
  return logs.map((l) => ({
    ...l,
    details: db.prepare('SELECT session_id, title, source, message_count FROM forget_detail WHERE forget_log_id = ?').all(l.id),
  }));
}

// ── 语义检索向量（设计 v4 §3.4；未 enable 时表恒空——升级零影响的构造性保证） ──

export function upsertSessionVector(db: DB, sessionId: string, model: string, vec: Float32Array): void {
  db.prepare('INSERT OR REPLACE INTO session_vectors (session_id, model, dim, vec, embedded_at) VALUES (?,?,?,?,?)')
    .run(sessionId, model, vec.length, Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength), new Date().toISOString());
}

export function deleteSessionVector(db: DB, sessionId: string): void {
  db.prepare('DELETE FROM session_vectors WHERE session_id = ?').run(sessionId);
}

/** 向量库签名（R1：进程内缓存失效检测——COUNT+MAX 变化才重载） */
export function vectorSignature(db: DB, model: string): string {
  const r = db.prepare('SELECT COUNT(*) n, COALESCE(MAX(embedded_at),\'\') mx FROM session_vectors WHERE model = ?').get(model) as { n: number; mx: string };
  return `${r.n}:${r.mx}`;
}

export function loadSessionVectors(db: DB, model: string): Map<string, Float32Array> {
  const out = new Map<string, Float32Array>();
  const rows = db.prepare('SELECT session_id, vec FROM session_vectors WHERE model = ?').all(model) as Array<{ session_id: string; vec: Uint8Array }>;
  for (const r of rows) out.set(r.session_id, new Float32Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength / 4));
  return out;
}

/** digest 候选：confirmed 且（无向量行 OR model 不匹配）——imported（直插 confirmed）天然覆盖（R9） */
export function pendingSemanticTargets(db: DB, model: string, limit: number, projectId?: string): Array<{ id: string; title: string | null }> {
  const rows = db.prepare(`
    SELECT s.id AS id, s.title AS title FROM sessions s
    WHERE s.state = 'confirmed'
      AND NOT EXISTS (SELECT 1 FROM session_vectors v WHERE v.session_id = s.id AND v.model = ?)
      ${projectId ? 'AND s.project_id = ?' : ''}
    ORDER BY COALESCE(s.last_event_at, s.created_at) DESC LIMIT ?
  `).all(...(projectId ? [model, projectId, limit] : [model, limit])) as Array<{ id: string; title: string | null }>;
  return rows;
}

export function countSemanticBacklog(db: DB, model: string): number {
  return (db.prepare(`
    SELECT COUNT(*) n FROM sessions s
    WHERE s.state = 'confirmed'
      AND NOT EXISTS (SELECT 1 FROM session_vectors v WHERE v.session_id = s.id AND v.model = ?)
  `).get(model) as { n: number }).n;
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
  // [fork 0922] 索引文本截断 100KB：jieba 对超大消息（工具输出转储）同步分词会卡事件循环秒级；
  // 100KB 内检索召回完整，超出部分正文仍全量入库、只是不进全文索引
  const idxSource = m.content.length > 100_000 ? m.content.slice(0, 100_000) : m.content;
  const info = db.prepare(`
    INSERT OR IGNORE INTO messages (session_id, role, content, search_text, seq_num, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(m.sessionId, m.role, m.content, searchTextOf(idxSource), m.seqNum, m.createdAt ?? null);
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
