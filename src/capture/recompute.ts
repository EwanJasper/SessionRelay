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
 *  9 → 1014 红队回环修三个真缺陷（docs 红队报告 F1/F5/F9）：
 *        F1 TAGLESS_INJECTED 改成**行界**匹配。原用续行匹配，而客户端真实格式是
 *           "标记与正文同在一行"，实测只剥掉标记短语、70–84% 正文残留。
 *        F5 SKILL_CATALOG_LINE 改成**≥3 行连续的块**判据。原单行判据把用户自己的
 *           kebab-case 清单整行剥掉（实测 129 条消息中招，真决策既进不了 decisions
 *           也进不了 search_text，双双失明）。
 *        F9 `不用` 从否定标记族整体移除（实测 13% 的 negative 仅靠它命中，其中约
 *           三分之二是用户指令/口语/保留型决策），并补词中误命中防护。
 * 10 → 1015 Phase 3 简报决策噪声治理（根因修在抽取器，两处都是"修一半"的收尾）：
 *        A `不用` 从**决策判别族** DECISION_WEAK_ANCHORED 整体移除。F9 上次只摘了
 *          否定标记族（NEGATIVE_MARKERS），没摘判别族——于是"你不用管过程""不用每章
 *          都烧朱雀额度""旧会话不用删，放着就行"照样能进 decisions 列。
 *          实测两库该分支 61/24 条，逐条判读 85–90% 是用户对 AI 的指令或口语。
 *          同族 直接用/优先用/统一用/改为使用 四条实测保留率良好，不动。
 *        B 引号不配对=腰斩碎片（新增 quotesBalanced，与括号配对同族）。实测两库
 *          83/30 条，样例几乎全是"讨论决策的散文"：`采用宿主 CLI 弹性探测"与 10-14"
 *          自包含 vendor"字面直接冲突`、`决定论"误命中在 extractDecisions 的
 *          DECISION_STRONG 里`。**必须在尾部剥离前判**——`改为"…那个"` 这种合法决策的
 *          闭引号正在尾部，先剥后查会误杀（这个交互 bug 由回归测试抓到）。
 *          故意不查反引号：真决策也用反引号包标识符（"改用 `fileURLToPath()`"）。
 *        C plausibleDecision 的 JSON 残片守卫扩族：原只认 confirmed/title/session_id
 *          三个键名，实测漏 `"done": true`、`"evidence": "..."`，改为任意 `"key":`。
 *        同轮还在两个简报通道加了"子代理会话不进简报"（plugins/dsh/index.js 与
 *        ZCode brief-shared.mjs），那是**消费侧**过滤、零数据丢失，不走重算。
 * 递增时在下面加一行说明，便于回溯「哪批数据是哪个规则算的」。 */
export const EXTRACT_VERSION = 10;

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
    progress_version INTEGER NOT NULL DEFAULT 0,
    cursor_id TEXT NOT NULL DEFAULT ''
  )`);
  const cols = db.prepare('PRAGMA table_info(extract_meta)').all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'progress_version')) {
    db.exec('ALTER TABLE extract_meta ADD COLUMN progress_version INTEGER NOT NULL DEFAULT 0');
  }
  // cursor_id：重算游标必须是会话 ID 而非位置数（红队 1014 F2）
  if (!cols.some((c) => c.name === 'cursor_id')) {
    db.exec("ALTER TABLE extract_meta ADD COLUMN cursor_id TEXT NOT NULL DEFAULT ''");
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
 *  ⚠️ progress_version 必须与 progress 配对。版本 bump 会让上一次未跑完的进度全部作废
 *  （那些会话是按旧规则算的），此时要从头开始——否则就会重演 1014 那个静默损坏：
 *  元数据说 v7 已完成，实际只有尾巴几十个会话是 v7 规则算的。
 *
 *  ⚠️⚠️ 游标必须是**会话 ID**，不能是"已算几个位置"（红队 1014 F2）。
 *  位置计数在批次间集合变动时会跳过会话：归档（每小时）、forget、resume 回滚都会让
 *  目标集缩小，OFFSET 相对集合过计一格，其后每个未算会话顺移一格，最后
 *  `progressed >= total` 提前触发 finishVersion——**被跳过的会话永远拿着旧规则数据，
 *  而 extract_meta 说 version=N, remaining=0「已是最新」**，doctor 的「提取规则版本」
 *  检查同样被骗。守护 6 小时一批、554 个目标会话要 72 小时才追完，这 72 小时里
 *  归档与判定持续改集合——不是理论风险。
 *  ID 游标不受集合变动影响：离开集合的会话只是不被重算（正确），没有任何会话被跳过。 */
export function recomputeExtractions(db: DB, batch = BATCH_SIZE): RecomputeResult {
  ensureTable(db);
  const cur = extractVersionOf(db);
  if (cur >= EXTRACT_VERSION) return { recomputed: 0, remaining: 0 };

  const total = remainingCount(db);
  if (total === 0) {
    finishVersion(db, 0);
    return { recomputed: 0, remaining: 0 };
  }

  // 取游标：上一个已算会话的 id。stale（版本不匹配）时作废重来。
  const row = db.prepare('SELECT progress, cursor_id, progress_version FROM extract_meta WHERE id = 1').get() as
    { progress?: number; cursor_id?: string; progress_version?: number } | undefined;
  const stale = (row?.progress_version ?? 0) !== EXTRACT_VERSION;
  const lastId = stale ? '' : (row?.cursor_id ?? '');
  if (stale && (row?.cursor_id ?? '')) {
    // 作废前留痕迹：这类"看起来正常其实只算了一半"的故障，最难查的就是没有日志
    db.prepare('UPDATE extract_meta SET progress = 0, cursor_id = \'\', progress_version = ? WHERE id = 1').run(EXTRACT_VERSION);
  } else if (!row) {
    db.prepare('INSERT INTO extract_meta (id, version, progress, cursor_id, progress_version) VALUES (1, ?, 0, \'\', ?)').run(cur, EXTRACT_VERSION);
  }
  // ORDER BY id（稳定、唯一、永不变）而非 confirmed_at DESC——排序不影响正确性，
  // 但 id 游标要求排序键与游标键一致，否则"id > lastId"会漏。
  const todo = db.prepare(
    `SELECT s.id, s.title FROM sessions s
     WHERE s.state IN ('confirmed', 'pending', 'pending_end') AND s.cleanup_at IS NULL AND s.message_count > 0 AND s.id > ?
     ORDER BY s.id
     LIMIT ?`,
  ).all(lastId, batch) as Array<{ id: string; title: string | null }>;

  if (todo.length === 0) {
    // 游标后面没有了 → 全部算完
    finishVersion(db, 0);
    return { recomputed: 0, remaining: 0 };
  }

  let done = 0;
  for (const s of todo) {
    try { recomputeSession(db, s); done++; } catch { /* 单会话失败不阻塞整批 */ }
  }

  const newLast = todo[todo.length - 1].id;
  if (todo.length < batch) {
    // 取不满一批 → 这个游标下后面没有了（新会话会在下次调用时被 `id > lastId` 捞到，
    // 但版本已推进所以会直接 return——与旧实现同语义，不引入新行为）
    finishVersion(db, done);
    return { recomputed: done, remaining: 0 };
  }
  // 分批中：推进游标，不碰 version
  db.prepare(
    `INSERT INTO extract_meta (id, version, last_run_at, last_recomputed, remaining, progress, cursor_id, progress_version) VALUES (1, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       last_run_at = excluded.last_run_at,
       last_recomputed = excluded.last_recomputed,
       remaining = excluded.remaining,
       progress = excluded.progress,
       cursor_id = excluded.cursor_id,
       progress_version = excluded.progress_version`,
  ).run(cur, new Date().toISOString(), done, Math.max(0, total - done), (row?.progress ?? 0) + done, newLast, EXTRACT_VERSION);
  return { recomputed: done, remaining: Math.max(0, total - done) };
}

function finishVersion(db: DB, done: number): void {
  db.prepare(
    `INSERT INTO extract_meta (id, version, last_run_at, last_recomputed, remaining, progress, progress_version, cursor_id) VALUES (1, ?, ?, ?, 0, 0, ?, '')
     ON CONFLICT(id) DO UPDATE SET
       version = ?,
       last_run_at = ?,
       last_recomputed = ?,
       remaining = 0,
       progress = 0,
       progress_version = ?,
       cursor_id = ''`,
  ).run(EXTRACT_VERSION, new Date().toISOString(), done, EXTRACT_VERSION,
       EXTRACT_VERSION, new Date().toISOString(), done, EXTRACT_VERSION);
}
