// 提取规则版本与后台重算（审计报告 P3）
//
// 问题：提取规则（正则/守卫）改了，但历史会话的 decisions/questions/topics 早已落库，
// 刷新走 seq-watermark 增量——只有新确认或新刷新的会话会重算，历史行保持旧结果。
// 用户观感是「修了没用」：明明换了规则，垃圾还在。
//
// 机制：
//   ① EXTRACT_VERSION 常量 = 提取规则族版本（改规则必须递增，注释写清为什么）
//   ② extract_meta 表记「本库已重算到哪个版本」+ 每批进度（可中断、可续跑）
//   ③ 守护空闲周期发现版本落后 → 对 confirmed/pending 会话分批重算受影响字段
//      ——只读 messages + 重写 sessions 行的 decisions/key_questions/topics/summary_rule，
//      不碰原始消息、不走源文件、语义比 rebuild 轻得多（rebuild = 全量重扫源）
//
// 边界（诚实登记）：
//   - 只重算「当前仍在库里的消息」。归档过的会话正文已删（保护规则允许它留骨架），
//     重算只能基于残余消息 → 归档会话的脏数据不会被这机制清掉，那需要 rebuild。
//   - 限流 + 可中断：每批 N 个会话，单批耗时计入守护周期压力；失败不抛，下周期继续。
import type { DB } from '../store/db.js';
import { extractDecisions, extractQuestions, extractTopics, summaryRule } from '../core/extract/extract.js';
import type { Msg } from '../core/extract/extract.js';

/** 提取规则族版本。任何会影响 decisions/questions/topics 语义的改动都必须递增。
 *  3 → 1013 转述/引用过滤 + 词中误命中守卫（审计 P4）。
 *  递增时在下面加一行说明，便于回溯「哪批数据是哪个规则算的」。 */
export const EXTRACT_VERSION = 4;

/** 每批重算的会话数：兼顾单批耗时与中断粒度（50 会话实测在 ms 级） */
const BATCH_SIZE = 50;

/** 确保 extract_meta 表存在（createDb 的 DDL 之外，供 openExisting 的旧库自愈） */
function ensureTable(db: DB): void {
  db.exec(`CREATE TABLE IF NOT EXISTS extract_meta (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    version INTEGER NOT NULL,
    last_run_at TEXT,
    last_recomputed INTEGER NOT NULL DEFAULT 0,
    remaining INTEGER NOT NULL DEFAULT 0,
    progress INTEGER NOT NULL DEFAULT 0
  )`);
}

/** 本库记录的重算版本（无记录 = 0，视为全新库/未初始化） */
export function extractVersionOf(db: DB): number {
  ensureTable(db);
  const row = db.prepare('SELECT version FROM extract_meta WHERE id = 1').get() as { version: number } | undefined;
  return row?.version ?? 0;
}

export interface RecomputeResult {
  /** 本批实际重算的会话数 */
  recomputed: number;
  /** 是否还有待重算的会话（false = 已全部跟上 EXTRACT_VERSION） */
  remaining: number;
}

/** 取一个待重算会话的当前消息（用于重新跑提取器）。 */
function messagesOf(db: DB, sessionId: string): Msg[] {
  const rows = db.prepare(
    'SELECT role, content, seq_num AS seqNum, created_at AS createdAt FROM messages WHERE session_id = ? ORDER BY seq_num',
  ).all(sessionId) as Msg[];
  return rows.map(r => ({ role: r.role, content: r.content, seqNum: r.seqNum, createdAt: r.createdAt ?? null }));
}

/** 重算单个会话的提取字段（写回同一行，不动消息本体）。 */
function recomputeSession(db: DB, s: { id: string; title: string | null }): void {
  const msgs = messagesOf(db, s.id);
  if (msgs.length === 0) return;
  const decisions = extractDecisions(msgs);
  const questions = extractQuestions(msgs);
  const topics = extractTopics(msgs);
  const summary = summaryRule(s.title, {
    files: [], topics, decisions, questions, codeBlockCount: 0, keyExchanges: [],
  }, { messageCount: msgs.length, source: 'recompute', firstAt: new Date(0).toISOString(), lastAt: null });
  db.prepare(
    'UPDATE sessions SET decisions = ?, key_questions = ?, topics = ?, summary_rule = ? WHERE id = ?',
  ).run(
    JSON.stringify(decisions),
    JSON.stringify(questions),
    JSON.stringify(topics),
    summary,
    s.id,
  );
}

/** 剩余待重算会话数（版本已跟上时为 0）。 */
function remainingCount(db: DB): number {
  return (db.prepare(
    `SELECT COUNT(*) AS n FROM sessions s
     WHERE s.state IN ('confirmed', 'pending') AND s.cleanup_at IS NULL AND s.message_count > 0`,
  ).get() as { n: number }).n;
}

/** 跑一批重算（守护按需调用；幂等——重跑同一批只是再算一遍同样的规则）。
 *  分批推进：每批算 batch 个会话，把「已算过的会话数」写进 extract_meta.progress，
 *  下次调用跳过前 progress 个。全部算完才把 version 提到 EXTRACT_VERSION。
 *  失败不抛：单会话异常跳过，本批已算的进度仍然保留，下周期继续。 */
export function recomputeExtractions(db: DB, batch = BATCH_SIZE): RecomputeResult {
  ensureTable(db);
  const cur = extractVersionOf(db);
  if (cur >= EXTRACT_VERSION) return { recomputed: 0, remaining: 0 };

  const total = remainingCount(db);
  if (total === 0) {
    finishVersion(db, 0);
    return { recomputed: 0, remaining: 0 };
  }

  // 取本批：跳过已算的进度（progress 存在 extract_meta 里）
  const row = db.prepare('SELECT progress FROM extract_meta WHERE id = 1').get() as { progress?: number } | undefined;
  const skip = row?.progress ?? 0;
  const todo = db.prepare(
    `SELECT s.id, s.title FROM sessions s
     WHERE s.state IN ('confirmed', 'pending') AND s.cleanup_at IS NULL AND s.message_count > 0
     ORDER BY s.confirmed_at DESC, s.id
     LIMIT ? OFFSET ?`,
  ).all(batch, skip) as Array<{ id: string; title: string | null }>;

  let done = 0;
  for (const s of todo) {
    try { recomputeSession(db, s); done++; } catch { /* 单会话失败不阻塞整批 */ }
  }

  const progressed = skip + done;
  if (progressed >= total) {
    // 全部算完 → 推进版本并清零进度
    finishVersion(db, done);
    return { recomputed: done, remaining: 0 };
  }
  // 分批中：只推进进度，不碰 version（下次调用继续跳过已算的）
  db.prepare(
    `INSERT INTO extract_meta (id, version, last_run_at, last_recomputed, remaining, progress) VALUES (1, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       last_run_at = excluded.last_run_at,
       last_recomputed = excluded.last_recomputed,
       remaining = excluded.remaining,
       progress = excluded.progress`,
  ).run(cur, new Date().toISOString(), done, total - progressed, progressed);
  return { recomputed: done, remaining: total - progressed };
}

function finishVersion(db: DB, done: number): void {
  db.prepare(
    `INSERT INTO extract_meta (id, version, last_run_at, last_recomputed, remaining, progress) VALUES (1, ?, ?, ?, 0, 0)
     ON CONFLICT(id) DO UPDATE SET
       version = ?,
       last_run_at = ?,
       last_recomputed = ?,
       remaining = 0,
       progress = 0`,
  ).run(EXTRACT_VERSION, new Date().toISOString(), done,
       EXTRACT_VERSION, new Date().toISOString(), done);
}
