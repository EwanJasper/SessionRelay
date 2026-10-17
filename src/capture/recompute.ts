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
//   - 只重算「当前仍在库里的消息」。归档过的会话正文已删（保护规则允许它留骨架）。
//     **【1021 更正】原文写「归档会话的脏数据不会被这机制清掉，那需要 rebuild」—— 这是错的。**
//     归档会话走不了「重抽」路线，但它的 `decisions` 列还在，**纯文本判据就能重筛**。
//     真正的原因不是「做不到」，而是**那段清理代码够不着**：批次 SELECT 带
//     `cleanup_at IS NULL AND message_count > 0`，归档会话两条都不满足 ⇒ 永远选不中。
//     修法见 `cleanArchivedDecisions()`（独立通道，纯文本重筛 + 事务 + 跑过打戳）。
//     实测规模：831 条决策里 532 条卡在 497 个归档会话上，其中 107 条是 v24 会拒收的垃圾。
//   - 限流 + 可中断：每批 N 个会话，单批耗时计入守护周期压力；失败不抛，下周期继续。
import type { DB } from '../store/db.js';
import { summaryRule, extractFiles, passesDecisionTextGuards } from '../core/extract/extract.js';
import { extractForWrite, dedupKey } from '../store/db.js';
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
 * 11 → 1015 治第三个注入盲区（Phase 2 Phase 0 实测发现，此前从未被发现是因为它只在
 *        装了 DSH mneme 记忆插件的项目上发作——实测 music player 546 条消息带它、
 *        545 条 role=user，而 agent1super 只有 2 条）：
 *        A `Approval prompts are disabled in this session:` 进 TAGLESS_INJECTED。
 *           原规则只认 `Approval policy: ask.` 一种措辞，实测 597 条消息带的是另一种。
 *        B 新增 `stripMnemeMemory()`：剥 `[记忆库] 来自 dsh-mneme 的跨会话记忆…` 整块
 *           （块以 [记忆库] 头起、到第一个空行或文末；实测无孤儿行，一个规则全覆盖）。
 *           **只走抽取路径、不走索引路径**——块里是真实项目记忆（用户偏好/项目上下文），
 *           剥出 search_text 会让 "ACE-Step" 这类词搜不到；但它不是用户在本会话说的话，
 *           留着就会被抽取器当成用户的拍板收进库。Phase 2 Phase 0 实测：22–42% 的
 *           环境事实/纠正误报直接来自它。
 *        本轮同时实现了 Phase 2 的两个抽取器（extractEnvFacts/extractCorrections），
 *        但**未接入任何写路径**——真实库精度门禁全面不过（见核对表 §32），按调研报告
 *        §5"Phase 0 不过则全停"的规矩停下，登记重新评估条件。
 * 12 → 1015 引入外部专家方案的引号**极性**守卫（升级 quotesBalanced，修两个真 bug）：
 *        · 先剥反引号内联代码再数引号（否则 `raw.match(/"/g)` 里的引号被算进去）
 *        · 排除字母两侧的英文撇号 `(?<=[a-zA-Z])['’](?=[a-zA-Z])`——这一条外部专家
 *          声称做了但代码里漏写，本机补上（否则 user’s 弯撇号仍被误杀）
 *        · 增加极性检查：弯引号栈深度（先出现闭引号=撕裂残片）+ 直引号看第一个的位置
 *        实测：修好 user's/don't-ask 两类误杀（旧版两库各 1 条已中招）；拦掉
 *        `决定用 X"，但…往往是"试过 X` 这条 Phase 3 之后残留的散文噪声；
 *        对库里 30 条现有决策的行为与旧版一致（那 3 条旧版也在杀的仍被杀）。
 * 13 → 1015 两处（均来自外部专家方案，本机实测有效后合入）：
 *        A HTML 实体解码进 stripInjected。`&quot;` 被英文词元正则拆出假词 `quot`
 *           （实测主库 topics 14 次、音乐库 6 次，是记忆地图可用率跌到 35%/15% 的成因之一）。
 *           **解码必须放在注入规则之前**——客户端可能把注入块也转义存储
 *           （`&lt;system-reminder&gt;`），先剥后解码会让它解码成真标签而活下来（实测抓到）。
 *        B parseQuery 剔除冗余子词：cutForSearch 把"数据库"展开成 数据/据库/数据库，
 *           前两个是更长词元的子串，查询里必须剔掉。实测真实引擎上
 *           「数据库重算游标」会话命中 28 → 6 条（↓79%），其余查询一条不变。
 *           （注：ADR-002 记的"jieba 平均返回 38.5 条"在本机复测为 6–100 条，
 *           因为引擎早已做会话级 AND；专家的两阶段 MSM 解决的是我们没有的问题，未合入。）
 * 14 → 1015 重算判据改为**逐会话自报** sessions.extracted_version（Bug-2 根治）：
 *        原判据是「库级 extract_meta.progress_version + ORDER BY s.id 的字典序游标」，
 *        隐含假设"新进入目标集的会话 ID 一定大于当前游标"。会话 ID 是随机 16 位 hex，
 *        字典序与时间序无关（实测真实库按时间相邻对里 273/580 是逆序），于是：
 *        分批重算跑到中途时，任何**状态流转（active→confirmed）进来且 ID 更小**的会话
 *        会被 `s.id > ?` 永久跳过；而收尾时元数据照样写 remaining=0 / version=最新，
 *        doctor 的「提取规则版本」检查全绿 —— 静默数据损坏的教科书形态。
 *        本机实跑复现（真实库副本 + 哨兵列）：id=011e2072f56de9a9 的会话被漏算，
 *        哨兵原封不动，而 extract_meta 显示 v13 已完成。
 *        现改为 sessions.extracted_version 自报状态，与集合变动、ID 形态、归档、forget
 *        全部解耦；重算查询不再需要游标，也不需要"猜单行状态"。
 *        同时把常量搬到 core/extract/version.ts（store/db.ts 写派生列要打版本戳，
 *        常量留在本文件会让 store 反向依赖 capture）。本文件原样 re-export。
 * 15 → 1015 未决问题**同会话内近似去重**（实测真实库：music player 未决 30.9% 是近似重复、
 *        全部问题 19.6%；agent1super 为 1.1% / 3.5%）。危害不在存储而在简报——
 *        未决段只有 3 个名额且取最新，重复项会把真问题挤出窗口。
 *        键 = 去空白与标点后的前 28 字（足以合并"同一句被不同标点切分"，不会合并不同的短问题）。
 * 16 → 1015 决策的括号**极性**守卫（`parenDepthOk`，与 quotesBalanced 的极性检查同族）：
 *        旧守卫只数括号**数量**，而 `弃用）、…（冗余 clone` 恰好 1 个 ）+ 1 个 （，数量配对 → 放行；
 *        但顺序是"先闭后开"，说明它是从 `（已弃用）、…（冗余 clone）` 长句内部截出的残片。
 *        实测（真实库全量决策、去重后）：agent1super 判拒 35 条、music 13 条，逐条读完**全是碎片，
 *        0 条真决策被误杀**（唯一 borderline 是一条"决定】① …"枚举残片，本身已残缺）。
 *        先剥反引号内联代码再判——`foo()` 里的 ) 是代码不是文本（与 quotesBalanced 同处理）。
 * 17 → 1015 files 抽取**第一性原理重建**：旧正则不要求扩展名，把任何斜杠串当文件
 *        （`/task-id`、`/tool-use-id`、`/status`、`/127.0.0.1`、`D:/agent1super`、`/zcode-context`），
 *        实测两个库各抽 1 万+ 条目、**只有 26% / 33% 是文件**。
 *        新判据：必须「文件名 + 扩展名」；先剥 URL；文件名段 ≤64 字（滤句子残片）。
 *        同批还修了重算路径：`recomputeSession` 此前**不写 files_mentioned**，于是 files 规则一改，
 *        历史行永远拿不到新结果（这次实测踩到）。
 * 18 → 1015 夜 名词化的「选择X」不算拍板（`nounChoiceFalsePositive`）：选择器 / 选择题 / 选择框
 *        这类**界面排障里的名词**被当成决策入库（实测两库全量、文本唯一化后命中 83 条 → 收窄到 15 条）。
 *        ⚠️ 不能一刀切 `选择(?!器|框|题)`：那会把"选择器改当前会话+…"这类**名词作主语的真决策**一起误杀；
 *        判据是"名词开头 + 后 4 字内没有动词"，见 extract.ts 的注释。
 * 19 → 1016 夜 topics 里的 **harness 记账 token**（`isSystemToken`，B4）：
 *        实测三库全量 topics 词表：`tool` 128 次、`id` 38、`task-notification` 11、`task-id` 10、
 *        `in_progress` 9、`tool-use-id` 7、`output-file` 6、`created_at` 3 —— 话题列既脏又占名额。
 *        判据故意收窄：只有"每个分段都是记账词"才丢，所以 python-docx / yt-dlp / utf-8 /
 *        test_book.txt / inkos_docx_build / q4_k_m 这些真名字**逐条核过，全部保留**。
 *        （只动 topics 一列；search_text 是消息入库时写的派生列，要清得走 rebuild。）
 * 递增时在下面加一行说明，便于回溯「哪批数据是哪个规则算的」。 */

import { EXTRACT_VERSION } from '../core/extract/version.js';
export { EXTRACT_VERSION };

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
  // [v14] 已被 sessions.extracted_version 取代（判据不再需要游标），保留列只为兼容旧库。
  if (!cols.some((c) => c.name === 'cursor_id')) {
    db.exec("ALTER TABLE extract_meta ADD COLUMN cursor_id TEXT NOT NULL DEFAULT ''");
  }

  // [v14] 会话级版本列：判据从"库级游标猜单行状态"改为"单行自报状态"。
  // 存量行一律留 0 → 升级后首次会全量重算一遍（秒级）。这是**刻意**的：
  // 旧游标漏掉的那些会话，我们没有任何可靠办法反推它的数据是哪个版本算的，
  // 与其做一次无法验证的"存量认账"，不如全量重算一遍。
  const scols = db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
  if (!scols.some((c) => c.name === 'extracted_version')) {
    db.exec('ALTER TABLE sessions ADD COLUMN extracted_version INTEGER NOT NULL DEFAULT 0');
  }
  // 复合索引：重算查询的判据+过滤列，避免全表扫（581 会话时无所谓，10 万时有关）。
  db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_extractver ON sessions(extracted_version, state)');
}

/** 本库记录的重算版本（无记录 = 0，视为全新库/未初始化） */
export function extractVersionOf(db: DB): number {
  // [1020] 只读容错：`ensureTable` 做的是 CREATE TABLE（**写操作**），而本函数也会被
  //   **只读连接**调用 —— `srelay doctor` 用 `new Database(f, { readonly: true })` 调它做体检。
  //   原本直接 ensureTable ⇒ 只读库上抛 `attempt to write a readonly database`，
  //   doctor 只能把它显示成一条 ⚠️ —— **新用户第一次跑 doctor 就会撞到**（本轮实测）。
  //   正确语义：表在就跳过；不在（全新库）说明还没提取过，返回 0 本来就是真实答案。
  try { ensureTable(db); } catch { /* 只读连接且表不存在 */ }
  let row: { version: number } | undefined;
  try { row = db.prepare('SELECT version FROM extract_meta WHERE id = 1').get() as { version: number } | undefined; } catch { row = undefined; /* 表根本不存在（全新库/只读）⇒ 版本即 0，这是真实答案不是错误 */ }
  return row?.version ?? 0;
}

export interface RecomputeResult {
  /** 本批实际重算的会话数 */
  recomputed: number;
  /** 还有多少会话没跟上 EXTRACT_VERSION（0 = 全部跟上） */
  remaining: number;
  /** [v14] 本批提取抛异常、被跳过并打了版本戳的会话数。
   *  旧实现是"游标越过即放弃"，但**不留任何痕迹**；现在至少能被看见（>0 会告警）。 */
  failed: number;
  /** [1021] 本轮从**归档会话**里清掉的存量垃圾决策条数。
   *  `-1` = 清理过程抛异常（调用方应告警）；`0` = 没有要清的。
   *  为什么要这个字段：归档会话的正文已删，走不了「重抽」那条路，
   *  只能纯文本重筛 —— 而它此前**永远不可达**（被 SELECT 的 `cleanup_at IS NULL AND message_count > 0` 挡掉），
   *  实测 532 条决策卡在 497 个归档会话上、其中 107 条是现行规则会拒收的垃圾。 */
  archivedCleaned: number;
}

/** 取一个待重算会话的当前消息（用于重新跑提取器）。
 *  ⚠️ [1021 红队 R13] SELECT 必须带 `id`：这是**版本重算**写路径，原来不带 id ⇒
 *    extractDecisions 里的 `msgId: m.id` 恒为 undefined ⇒ v22 的"稳定主键"从来没写进库
 *    （实测 622 场 / 831 条决策 msgId 覆盖率 **0%**）。读端修好也没东西可读，先补这里。 */
function messagesOf(db: DB, sessionId: string): Msg[] {
  const rows = db.prepare(
    'SELECT id, role, content, seq_num AS seqNum, created_at AS createdAt FROM messages WHERE session_id = ? ORDER BY seq_num',
  ).all(sessionId) as Array<{ id: number; role: 'user' | 'assistant'; content: string; seqNum: number; createdAt: string | null }>;
  // id 归一成字符串：messages.id 是 INTEGER，两条写路径（重算 / confirm）形态保持一致
  return rows.map((r) => ({ id: String(r.id), role: r.role, content: r.content, seqNum: r.seqNum, createdAt: r.createdAt ?? null }));
}

/** 重算单个会话的提取字段（写回同一行，不动消息本体）。 */
function recomputeSession(db: DB, s: { id: string; title: string | null }): void {
  // ⚠️ 必须先过 sanitizeMsgs：提取有多个入口，漏掉这一步，注入块就会从重算这条路
  // 重新污染库（1014 实测：重算跑了 85 个会话数据一点没变，就是因为这里绕过了
  // extractMessages 里的清洗）。
  const msgs = messagesOf(db, s.id);
  if (msgs.length === 0) {
    // [1015 夜 · 红队 A#3 修复] 正文为空（归档会话 / 只带决策不带消息的导入会话）时，
    // **必须打戳再返回**：原先直接 return，于是这类会话永远 `extracted_version < 当前版本` ⇒
    //   remaining 永久 ≥1、每批 recomputed 虚增、extract_meta.version 永不推进（两连跑实测）。
    //
    // [1015 夜 · 红队 B#1 修复] 顺带**按现行规则清理存量决策**：归档会话的正文已删，
    //   重抽不可能，但它们当年按旧规则抽出来的噪声（如名词化「选择器是旧的」）会永久留在库里——
    //   实测主库现存 4 条这样的残留。这里用纯文本级守卫重筛一遍（不依赖消息）。
    try {
      const row = db.prepare('SELECT decisions FROM sessions WHERE id = ?').get(s.id) as { decisions: string | null } | undefined;
      const kept = (JSON.parse(row?.decisions ?? '[]') as Array<{ text?: string }>).filter((d) => passesDecisionTextGuards(String(d.text ?? '')));
      const before = (JSON.parse(row?.decisions ?? '[]') as unknown[]).length;
      if (kept.length !== before) db.prepare('UPDATE sessions SET decisions = ? WHERE id = ?').run(JSON.stringify(kept), s.id);
    } catch { /* 坏 JSON：不阻塞 */ }
    markAttempted(db, s.id);
    return;
  }
  // ⚠️ 必须走 extractForWrite：它一次做三件事——剥注入块、提取、并回既有 pinned。
  // 本路径曾自己调 extractDecisions 又自己 JSON.stringify 写列，结果用户置顶的决策
  // 在每次版本升级（v5→v6、将来的 v7…）时被全库静默擦掉（红队 1014 🔴，且本机
  // 实测正在发生）。sanitizeMsgs 也已内含，不必在外部再剥一次。
  const { decisions, questions, topics } = extractForWrite(db, s.id, msgs);
  // [1015 夜 · A1 自动合并] 归档后复活的会话：正文在归档时已被删除（只留决策骨架），
  // 而重算只能从「残存的新消息」里抽 ⇒ 直接写回会把骨架整个换掉。
  // 实测规模（判据修正为 `> 0` 之后，2026-10-15 夜 + 红队复测）：
  //   归档过 373/229/82 场，**归档后又复活 0 场** ⇒ 这条是**潜伏**风险；合并逻辑是给将来兜底。
  //   ⚠️ 早先写的「主库 210 场/676 条」是判据用错（`IS NOT NULL` 命中默认值 0）得出的假数字，已作废。
  // 处置：**自动合并**——新抽出来的为准，骨架里没被覆盖的按原样补回（含 pinned 标记）。
  // 判据 `original_message_count > 0`：archive.ts 归档时把**归档前的消息数**写进这一列，复活不会清它。
  // ⚠️ 必须是 `> 0` 而不是 `IS NOT NULL`：该列 DDL 默认值是 **0**（db.ts:222/259），
  //    写成 not null 会把**每一场普通会话**都当成复活过——回归测试 p3-recompute ① 当场抓住。
  // 全程自动、无需人工；要丢弃骨架时手工清掉那一列即可。
  const prev = db.prepare('SELECT decisions, original_message_count FROM sessions WHERE id = ?')
    .get(s.id) as { decisions: string | null; original_message_count: number | null } | undefined;
  if (prev && (prev.original_message_count ?? 0) > 0) {
    try {
      const kept = JSON.parse(prev.decisions ?? '[]') as Array<{ text?: string }>;
      const have = new Set(decisions.map((d) => dedupKey(d.text)));
      let restored = 0;
      for (const k of kept) {
        const key = dedupKey(k.text ?? '');
        if (!key || have.has(key)) continue;
        have.add(key);
        decisions.push(k as never);
        restored++;
      }
      void restored;   // 计数只用于本地调试；对外不新增字段（重算结果是既有形状）
    } catch { /* 骨架坏 JSON：不阻塞重算 */ }
  }
  // [v17] 顺带刷新 files_mentioned——重算此前只写 decisions/questions/topics/summary_rule，
  // 于是 files 列的规则一改，历史行永远拿不到新结果（本轮重建 files 抽取时实测踩到）。
  const files = extractFiles(msgs.map((m) => m.content));
  const summary = summaryRule(s.title, {
    files: [], topics, decisions, questions, codeBlockCount: 0, keyExchanges: [],
  }, { messageCount: msgs.length, source: 'recompute', firstAt: new Date(0).toISOString(), lastAt: null });
  // [v14] 打版本戳：这一行从此**自报**"我的派生列是哪个规则版本算的"。
  // 判据、进度、doctor 的逐会话检查全部读它，不再依赖任何库级游标。
  db.prepare(
    'UPDATE sessions SET decisions = ?, key_questions = ?, topics = ?, files_mentioned = ?, summary_rule = ?, extracted_version = ? WHERE id = ?',
  ).run(
    JSON.stringify(decisions),
    JSON.stringify(questions),
    JSON.stringify(topics),
    JSON.stringify(files),
    summary,
    EXTRACT_VERSION,
    s.id,
  );
}

/** [v14] 提取失败时也打版本戳：与旧实现"游标越过即永久放弃"同语义（避免每个周期
 *  对同一个坏会话无限重试），但这次至少留下可观测的计数（RecomputeResult.failed）。 */
function markAttempted(db: DB, id: string): void {
  try {
    db.prepare('UPDATE sessions SET extracted_version = ? WHERE id = ?').run(EXTRACT_VERSION, id);
  } catch { /* 打戳失败不阻塞整批 */ }
}

/** 剩余待重算会话数（版本已跟上时为 0）。 */
function remainingCount(db: DB): number {
  // 三个状态都要：confirmed 已定案、pending/pending_end 是判定链中间态（闲置>10min 等
  // 6h 冷却）。此前只算 confirmed+pending，漏掉 pending_end——实测 5 个会话的污染决策
  // 因此永远重算不掉（1014）。已归档的 cleanup_at 非空/message_count=0，正确排除。
  // [v14] 判据从"在目标集里"改为"**没跟上当前规则版本**"——前者会漏掉游标越过的会话。
  return (db.prepare(
    `SELECT COUNT(*) AS n FROM sessions s
     WHERE s.extracted_version < ? AND s.state IN ('confirmed', 'pending', 'pending_end')
       AND s.cleanup_at IS NULL AND s.message_count > 0`,
  ).get(EXTRACT_VERSION) as { n: number }).n;
}

/** 跑一批重算（守护按需调用；幂等——重跑同一批只是再算一遍同样的规则）。
 *
 *  ⚠️ [v14] 判据在**会话行**上（sessions.extracted_version < EXTRACT_VERSION），不在库级游标上。
 *  旧实现是 progress_version + `ORDER BY s.id` 的字典序游标，隐含假设"新进入目标集的会话
 *  ID 一定大于当前游标"——而 ID 是随机 16 位 hex，字典序与时间序无关（真实库实测相邻逆序
 *  273/580）。批次中途任何"ID 更小的会话进入目标集"都会被永久跳过，收尾时元数据仍写
 *  remaining=0 / version=最新，doctor 全绿。本机用真实库副本 + 哨兵列实跑复现过（见文件头 v14）。
 *
 *  也不能再用 `if (cur >= EXTRACT_VERSION) return` 提前退出：库版本已最新时单行仍可能落后
 *  ——那正是本次要治的形态。steady state 下这里只多一次带索引的 COUNT。
 *
 *  失败不抛：单会话异常跳过并打版本戳（与旧实现"游标越过即放弃"同语义，避免每周期对
 *  同一个坏会话无限重试），但计数会出现在 RecomputeResult.failed 里，不再无痕。 */
/**
 * [1021 · 红队/extract-v2 双料发现修复] **归档会话的存量决策清理**。
 *
 * ── 原来为什么清不掉 ──
 *   本文件 226 行附近**早就有**「归档会话按现行规则清理存量决策」的代码（v14/1015 夜加的），
 *   但它挂在 `msgs.length === 0` 分支下，而进入那条分支的前提是被 SELECT 选中 ——
 *   `remainingCount` 与批次 SELECT **都带** `cleanup_at IS NULL AND message_count > 0`。
 *   归档会话恰好 `cleanup_at` 非空、`message_count` 被清成 0 ⇒ **永远选不中 ⇒ 那段清理永远不可达**。
 *   实测：831 条决策只有 299 条能重算，**532 条挂在 497 个归档会话上动不了，其中 107 条是 v24 会拒收的垃圾**。
 *
 * ── 为什么必须单独一条通道 ──
 *   归档会话的**正文已删**（这是归档的定义），所以它们**不可能**走「重抽一遍」那条路。
 *   但它们的 `decisions` 列还在 —— 于是正确做法是**纯文本级重筛**：不依赖消息，只跑判据。
 *   这正是 226 行那段代码原本的设计意图，本函数只是给它一条**真正能被执行到**的路径。
 *
 * ── 安全性 ──
 *   · 只**删**判据不通过的，绝不新增或改写保留项；
 *   · 全程一个事务，中途异常整批回滚；
 *   · 只处理 `extracted_version < 当前版本` 的行，跑过一次就打戳，不会每轮重扫；
 *   · 返回清理条数，调用方负责打日志（**不许静默**）。
 */
export function cleanArchivedDecisions(db: DB): number {
  // ⚠️ [1021 红队 T6 补充] 原来 WHERE 里还有 `AND decisions IS NOT NULL AND decisions != '[]'` ——
  //   于是**决策为空的归档会话永远选不中，也就永远打不上版本戳** ⇒ 每轮都被重扫一遍，
  //   实测 502 场归档会话里 310 场卡在 <25 就是这个原因。
  //   现在把所有版本落后的归档会话都选出来：有决策的重筛，没决策的**只打戳**（不做事、不重扫）。
  const rows = db.prepare(
    `SELECT id, decisions FROM sessions
     WHERE extracted_version < ? AND (cleanup_at IS NOT NULL OR message_count = 0)`,
  ).all(EXTRACT_VERSION) as Array<{ id: string; decisions: string | null }>;
  if (rows.length === 0) return 0;
  let removed = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const r of rows) {
      // 决策为空/NULL：没什么可清的，**只打戳**就走（否则会每轮被重扫）。
      if (r.decisions === null || r.decisions === undefined || r.decisions === '' || r.decisions === '[]') { markAttempted(db, r.id); continue; }
      // 需要 pinned 字段（见下方 T8 豁免），所以类型要带它，否则读不到。
      let arr: Array<{ text?: string; pinned?: boolean }> = [];
      try { arr = JSON.parse(r.decisions); } catch { markAttempted(db, r.id); continue; }  // 坏 JSON 不阻塞，但要打戳防重试每轮重试
      if (!Array.isArray(arr)) { markAttempted(db, r.id); continue; }
      // ── [1021 红队 T8 修复] **pinned 决策豁免** ──
      //   红队合成复现：一条 pinned 的垃圾决策同样被删掉（removed=1）。
      //   而 pinned 是**用户亲手置顶**的东西 —— 判断「它不是决策」的权力不该高于用户的手动选择。
      //   本库当前 0 条 pinned（无现存受害），但这属于「一旦发生就找不回来」的删数据路径，必须提前堵上。
      //   简报过滤器那边早就有 pin 豁免，这里漏了 —— 判据只许有一份，现在补齐。
      const kept = arr.filter((d) => d?.pinned === true || passesDecisionTextGuards(String(d?.text ?? '')));
      if (kept.length !== arr.length) {
        removed += arr.length - kept.length;
        db.prepare('UPDATE sessions SET decisions = ? WHERE id = ?').run(JSON.stringify(kept), r.id);
      }
      markAttempted(db, r.id);
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* 回滚失败也不掩盖原始错误 */ }
    throw e;
  }
  return removed;
}

export function recomputeExtractions(db: DB, batch = BATCH_SIZE): RecomputeResult {
  ensureTable(db);
  const cur = extractVersionOf(db);
  // [1021] 归档会话的存量决策清理必须在**早退之前**跑 —— 否则版本一旦追平就永远轮不到它。
  //   这也是 226 行那段清理一直够不着归档会话的根本原因（它排在早退之后）。
  //   失败不阻塞主流程（归档清理是增量修复，不是主链路），但要把数字**带出去**让人看得见，不许静默。
  // [1021 红队 T6 修复] 原来这里还套了一层**库级**闸门 `if (cur < EXTRACT_VERSION)`。
  //   问题：库级版本一追平（extract_meta.version == 当前版本）就再也不跑清理，
  //   而归档会话的**逐行**版本可能仍然落后 —— 实测库版本 25 时仍有 310 场归档会话 < 25。
  //   现在无条件跑：`cleanArchivedDecisions` 自己按逐行版本筛、跑过打戳，天然幂等，
  //   所以每轮多付的代价只是「一条走索引的空查询」。
  let archivedCleaned = 0;
  try { archivedCleaned = cleanArchivedDecisions(db); }
  catch { archivedCleaned = -1; }   // -1 = 清理失败（调用方据此告警）；0 = 没有要清的

  const total = remainingCount(db);
  if (total === 0) {
    // 全部跟上：把库级版本推进到当前规则版本（doctor 的「提取规则版本」读它）
    if (cur < EXTRACT_VERSION) finishVersion(db, 0);
    return { recomputed: 0, remaining: 0, failed: 0, archivedCleaned };
  }

  const todo = db.prepare(
    `SELECT s.id, s.title FROM sessions s
     WHERE s.extracted_version < ? AND s.state IN ('confirmed', 'pending', 'pending_end')
       AND s.cleanup_at IS NULL AND s.message_count > 0
     ORDER BY s.id
     LIMIT ?`,
  ).all(EXTRACT_VERSION, batch) as Array<{ id: string; title: string | null }>;

  if (todo.length === 0) {
    // 有 remaining 却选不出行 = 目标集口径不一致（例如列被外部写成 NULL）。
    // 不静默：把库版本推进避免守护空转，remaining 原样返回让人看得见。
    finishVersion(db, 0);
    return { recomputed: 0, remaining: total, failed: 0, archivedCleaned };
  }

  let done = 0;
  let failed = 0;
  for (const s of todo) {
    try { recomputeSession(db, s); done++; }
    catch { failed++; markAttempted(db, s.id); }
  }

  const left = remainingCount(db);
  if (left === 0) {
    finishVersion(db, done);
    return { recomputed: done, remaining: 0, failed, archivedCleaned };
  }

  const prev = (db.prepare('SELECT progress FROM extract_meta WHERE id = 1').get() as { progress?: number } | undefined)?.progress ?? 0;
  db.prepare(
    `INSERT INTO extract_meta (id, version, last_run_at, last_recomputed, remaining, progress, cursor_id, progress_version) VALUES (1, ?, ?, ?, ?, ?, \'\', ?)
     ON CONFLICT(id) DO UPDATE SET
       last_run_at = excluded.last_run_at,
       last_recomputed = excluded.last_recomputed,
       remaining = excluded.remaining,
       progress = excluded.progress,
       cursor_id = \'\',
       progress_version = excluded.progress_version`,
  ).run(cur, new Date().toISOString(), done, left, prev + done, EXTRACT_VERSION);
  return { recomputed: done, remaining: left, failed, archivedCleaned };
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
