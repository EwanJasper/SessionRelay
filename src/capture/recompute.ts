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
import { summaryRule } from '../core/extract/extract.js';
import { extractForWrite } from '../store/db.js';
import type { Msg } from '../core/extract/extract.js';

/** 提取规则族版本。任何会影响 decisions/questions/topics 语义的改动都必须递增。
 *  3 → 1013 转述/引用过滤 + 词中误命中守卫（审计 P4）。
 *  5 → 1014 未决问题显示归一化（口语填充压缩，保留真疑问）。
 *  6 → 1014 剥注入块（<system-reminder> 等塞进 user 消息的系统上下文，实测把
 *        技能说明挖成了决策，一条重复 24 次）+ 决策查询跨会话去重。
 *  7 → 1014 否定性决策标记（ADR-001）。不改抽取召回，只给"否掉一条路"的既有决策贴
 *        kind:'negative'——实测切换/放弃族早已占决策总量 43.6% 但一律无标记，简报里
 *        "改用 Y"与"采用 Y"不可分辨。失败判定族（不可行/不装…）暂不抽取：自由文本规则
 *        实测精度仅 75%，灌噪声不划算，见 ADR-001 Option B 的重新评估条件。
 *  8 → 1014 无标签注入剥离。客户端把 XML 外壳剥掉后才把系统上下文存进 user 消息，
 *        成对标签规则一条都匹配不到——实测 D:\agent1super 4361 条消息带同一句 TodoWrite
 *        提醒，占全部 search_text 的 18.7%、topics 里 10.7% 是它的英文虚词残片。
 *        症状是"索引胀大 + topics 变脏"而非简报出错，所以这个盲区一直没被发现。
 *        ⚠️ 只重算不清 search_text：那是消息插入时写的派生列，要清得走 rebuild 或
 *        定向刷新，见 README。
 * 递增时在下面加一行说明，便于回溯「哪批数据是哪个规则算的」。 */
export const EXTRACT_VERSION = 8;

/** 每批重算的会话数：兼顾单批耗时与中断粒度（50 会话实测在 ms 级） */
const BATCH_SIZE = 50;

/** 确保 extract_meta 表存在（createDb 的 DDL 之外，供 openExisting 的旧库自愈）。
 *  progress_version：progress 游标是在**哪个 EXTRACT_VERSION 下**累积的。
 *  没有它，一次版本 bump 发生在重算中途时，旧游标会被当成新版本的进度继续用——
 *  1014 实测：版本被打回 0 后游标停在 500，之后 bump 到 v7，守护从 500 继续跑，
 *  只重算了尾巴 75 个会话就把版本标记为完成。**前 500 个会话永远拿着旧规则的数据，
 *  而元数据说"已是最新"**——静默数据损坏，doctor 的「提取规则版本」检查也被骗过。
 *  ALTER TABLE 兜旧库：CREATE TABLE IF NOT EXISTS 对已存在的表无效。 */
function ensureTable(db: DB): void {
  db.exec(`CREATE TABLE IF NOT EXISTS extract_meta (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    version INTEGER NOT NULL,
    last_run_at TEXT,
    last_recomputed INTEGER NOT NULL DEFAULT 0,
    remaining INTEGER NOT NULL DEFAULT 0,
    progress INTEGER NOT NULL DEFAULT 0,
    progress_version INTEGER NOT NULL DEFAULT 0
  )`);
  const cols = db.prepare('PRAGMA table_info(extract_meta)').all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'progress_version')) {
    db.exec('ALTER TABLE extract_meta ADD COLUMN progress_version INTEGER NOT NULL DEFAULT 0');
  }
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
  // ⚠️ 必须先过 sanitizeMsgs：提取有多个入口，漏掉这一步，注入块就会从重算这条路
  // 重新污染库（1014 实测：重算跑了 85 个会话数据一点没变，就是因为这里绕过了
  // extractMessages 里的清洗）。
  const msgs = messagesOf(db, s.id);
  if (msgs.length === 0) return;
  // ⚠️ 必须走 extractForWrite：它一次做三件事——剥注入块、提取、并回既有 pinned。
  // 本路径曾自己调 extractDecisions 又自己 JSON.stringify 写列，结果用户置顶的决策
  // 在每次版本升级（v5→v6、将来的 v7…）时被全库静默擦掉（红队 1014 🔴，且本机
  // 实测正在发生）。sanitizeMsgs 也已内含，不必在外部再剥一次。
  const { decisions, questions, topics } = extractForWrite(db, s.id, msgs);
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
  // 三个状态都要：confirmed 已定案、pending/pending_end 是判定链中间态（闲置>10min 等
  // 6h 冷却）。此前只算 confirmed+pending，漏掉 pending_end——实测 5 个会话的污染决策
  // 因此永远重算不掉（1014）。已归档的 cleanup_at 非空/message_count=0，正确排除。
  return (db.prepare(
    `SELECT COUNT(*) AS n FROM sessions s
     WHERE s.state IN ('confirmed', 'pending', 'pending_end') AND s.cleanup_at IS NULL AND s.message_count > 0`,
  ).get() as { n: number }).n;
}

/** 跑一批重算（守护按需调用；幂等——重跑同一批只是再算一遍同样的规则）。
 *  分批推进：每批算 batch 个会话，把「已算过的会话数」写进 extract_meta.progress，
 *  下次调用跳过前 progress 个。全部算完才把 version 提到 EXTRACT_VERSION。
 *  失败不抛：单会话异常跳过，本批已算的进度仍然保留，下周期继续。
 *
 *  ⚠️ progress 必须与 progress_version 配对使用。版本 bump 会让上一次未跑完的进度
 *  全部作废（那些会话是按旧规则算的），此时要从头开始——否则就会重演 1014 那个
 *  静默损坏：元数据说 v7 已完成，实际只有尾巴几十个会话是 v7 规则算的。 */
export function recomputeExtractions(db: DB, batch = BATCH_SIZE): RecomputeResult {
  ensureTable(db);
  const cur = extractVersionOf(db);
  if (cur >= EXTRACT_VERSION) return { recomputed: 0, remaining: 0 };

  const total = remainingCount(db);
  if (total === 0) {
    finishVersion(db, 0);
    return { recomputed: 0, remaining: 0 };
  }

  // 取本批：跳过已算的进度（progress 存在 extract_meta 里）。
  // 但 progress 是在旧版本下累积的话，它指代的"已算完"毫无意义——一律作废重来。
  const row = db.prepare('SELECT progress, progress_version FROM extract_meta WHERE id = 1').get() as
    { progress?: number; progress_version?: number } | undefined;
  const stale = (row?.progress_version ?? 0) !== EXTRACT_VERSION;
  const skip = stale ? 0 : (row?.progress ?? 0);
  if (stale && (row?.progress ?? 0) > 0) {
    // 作废前留一行痕迹：这类"看起来正常其实只算了一半"的故障，最难查的就是没有日志
    db.prepare('UPDATE extract_meta SET progress = 0, progress_version = ? WHERE id = 1').run(EXTRACT_VERSION);
  } else if (!row) {
    db.prepare('INSERT INTO extract_meta (id, version, progress, progress_version) VALUES (1, ?, 0, ?)').run(cur, EXTRACT_VERSION);
  }
  const todo = db.prepare(
    `SELECT s.id, s.title FROM sessions s
     WHERE s.state IN ('confirmed', 'pending', 'pending_end') AND s.cleanup_at IS NULL AND s.message_count > 0
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
    `INSERT INTO extract_meta (id, version, last_run_at, last_recomputed, remaining, progress, progress_version) VALUES (1, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       last_run_at = excluded.last_run_at,
       last_recomputed = excluded.last_recomputed,
       remaining = excluded.remaining,
       progress = excluded.progress,
       progress_version = excluded.progress_version`,
  ).run(cur, new Date().toISOString(), done, total - progressed, progressed, EXTRACT_VERSION);
  return { recomputed: done, remaining: total - progressed };
}

function finishVersion(db: DB, done: number): void {
  db.prepare(
    `INSERT INTO extract_meta (id, version, last_run_at, last_recomputed, remaining, progress, progress_version) VALUES (1, ?, ?, ?, 0, 0, ?)
     ON CONFLICT(id) DO UPDATE SET
       version = ?,
       last_run_at = ?,
       last_recomputed = ?,
       remaining = 0,
       progress = 0,
       progress_version = ?`,
  ).run(EXTRACT_VERSION, new Date().toISOString(), done, EXTRACT_VERSION,
       EXTRACT_VERSION, new Date().toISOString(), done, EXTRACT_VERSION);
}
