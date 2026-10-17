// 简报散文/注入碎片过滤器的**单一权威源**（Phase 3.5 / 外部专家方案核验 5 合入）
//
// 为什么单独一个文件：ZCode 侧（~/.zcode/hooks/statebrief/brief-shared.mjs）与 DSH 插件侧
// （plugins/dsh/index.js）是同一套简报语义的两份实现，历史上"过滤器漂移"咬过我们一次
// （1015 实测：DSH 多一条"报告/审稿碎片"过滤而 ZCode 没有，而用户日常在 ZCode 侧干活）。
// 这七条来自外部专家方案核验 5 的实测结论：**主库只拦 6/1172、音乐库 5/490，全部是噪声、
// 0 误杀，且正好覆盖 Phase 3 治不掉的 3 条散文噪声**（`决定用 X"，但…往往是"试过 X`、
// `改为探测实际构建产物 fd3f53c，作者点名表扬`、`决定合入，按你在 Notes 里提议…`）。
//
// 两侧都从本文件 import，物理上只有一份。tools/check-brief-filters.mjs 会断言两边都没被改坏。

// ─────────────────────────────────────────────────────────────────────────────
// [ADR-002 theOneThing · **影子期**] 会话目的分类：扩展的任务书签名族
//
// 状态：**只导出谓词，不生效**。简报过滤链一行都没接它 —— 回滚 = 删掉本段。
// 为什么不直接接：ADR 裁决「先影子后接线」。而实测已经说明它今天接线也等于没接 ——
//   拉取式影子（2026-10-15 21:1x，tools/_probe_purpose_shadow.mjs，两库全量、生产去重口径）：
//     主库 903 条去重决策里只触及 **10 条（1.1%）、窗内 0**；对照库 325 条里 **6 条（1.8%）、窗内 0**。
//   其中 `# 任务：…` 与 `只读探索。目标：…` 在两个库上分别是 0 命中 / 只在对照库 6 命中。
//   ⇒ **接线与否，今天的简报一模一样**。
//
// 为什么要补（已发货的 SUBAGENT_TASK_TITLE 只认 5 个锚：你是/你作为/任务[:：]/你的任务/act as/you are）：
//   红队全量盘点出四类干净漏召签名（markdown 标题躲过 `^任务` 锚定等），补上它们零风险、
//   但**今天不产生任何可见变化**——这一点必须写在代码里，免得后人误以为它「没生效=写错了」。
//
// ⚠️ ADR 未给出四条签名的精确正则，下面是**字面还原版**。引用它的数字时必须同时引用探针，
//    否则又会出现「口径不明 → 数字不可复核」那类账。
export const PURPOSE_SHADOW_SIGNATURES = [
  { name: 'md-heading-task', re: /^#\s*任务\s*[:：]/ },              // 「# 任务：…」markdown 标题
  { name: 'you-in-env', re: /^你在.{0,60}环境/ },                      // 「你在…环境…」
  { name: 'readonly-explore-goal', re: /^只读探索[。.，,]?\s*目标\s*[:：]/ }, // 「只读探索。目标：…」
  { name: 'today-task', re: /^今天是.{0,60}[。.]\s*任务\s*[:：]/ },     // 「今天是…。任务：…」
]

/** 影子判定：会话标题命中哪条签名（未命中返回 null）。**不参与任何过滤**。 */
export function purposeShadowMatch(title) {
  const t = String(title ?? '').trim()
  for (const s of PURPOSE_SHADOW_SIGNATURES) if (s.re.test(t)) return s.name
  return null
}

/** 七条规范过滤器。顺序即优先级，新增往末尾加并在 check-brief-filters.mjs 登记。 */
export const BRIEF_CANONICAL_FILTERS = [
  // 1. 系统注入与提醒残片（防注入块从某条路漏进 decisions 列）
  /(?:<system-reminder>|TodoWrite|task-notification|sessionrelay-brief)/i,
  // 2. 审稿/红队报告与统计残片——这类词只可能出现在"讨论怎么写代码"的会话里
  /(?:候选信号|覆盖率|精度门禁|实测两库|负对照|分组精度|点名表扬|独立\s*PR)/,
  // 3. 单字母代数占位符与反例引述（`决定用 X` 这种举例，不是真拍板）
  /(?:决定|改为|改用|换成|采用|选择)[^a-zA-Z0-9\u4e00-\u9fa5]{0,3}[XYABxyab](?:[^a-zA-Z0-9_]|$)/,
  // 4. 认识论转折评述句（`, 但…往往是` 这种复盘规律的句式）
  /[，,]\s*(?:但|而|不过)[^。！？!?\n]{0,12}(?:往往是|通常是|最值钱的)/,
  // 5. 书信/PR 评论转述（`按你在 Notes 里提议` / `期待第一批`）
  /(?:按你在.*里提议|期待第[一二三1-3]批)/,
  // 6. 极短无意义残片或纯路径碎片
  /^[\s\p{P}\d]{0,6}$/u,
  // 7. 先闭后开的撕裂直引号（`决定用 X"，但…往往是"试过 X` 的引号极性特征）
  /^[^"]*"[，,。；;]/,
  // 8. 待决问句冒充决策（1018 实测：864 条里命中 20 条 = 2.31%，逐条看过全是真问句）
  //    形状：`决定要不要 X` / `决定能不能 X` / `决定是否 X` —— 它们是在提出选择，不是拍板。
  //    排除含箭头的：那是**在描述程序逻辑**（如「决定是否调用工具 → 条件边」），
  //    实测那 2 条是唯一假阳性，加箭头排除后归零。
  /^\s*决定\s*(?:要不要|能不能|是否|该不该|如何|怎么)(?![\s\S]*[→⇒])/,
  // 9. 语音口述填充词（1020 实测 864 条命中 12 条）——用户口述里「呃/那个那个/就是说」
  //    这类填充出来的长句，抽出来是一句话但语义上是碎片的碎。
  /(呃|那个那个|就是说|然后就是|而不是是在|直接直接)/,
  // 10. 报告残渣标记（命中 17 条）——`[in_progress]`/`[completed]` 这种是我自己写的进度报告
  //    被抽进来了，不是用户的决策。只认方括号标记，不认单个箭头（箭头也可能是真决策的记号）。
  /\[(in_progress|pending|completed|done)\]/i,
  // 11. `决定了` + 疑问从句（命中 7 条）——`决定了我能不能…` / `决定了你所有…能不能走`
  //    是**在问**，不是拍板。与第 8 条（`决定要不要X`）同族但形状不同，单列。
  /^决定了[^，。]{0,3}(你|谁|能不能|要不要|为什么)/,
]

// ─────────────────────────────────────────────────────────────────────────────
// 未决段专用过滤器（2026-10-15 夜 · U-A 落地）
//
// 病历：未决段长期是简报最差一环（可用率 0–33%）。实测 14 天池 36 条里，进简报的那三条是
//   Mermaid 图形残片、语音转写、从句残片。四条规则在真库上量过爆破半径：
//     agent1super 14 天池 36 条 → 死 4 条（全是上述噪声）；E:\music player 池 8 条 → **死 0 条**（零误杀）。
//   ⚠️ 第一版规则写的是「口语开头词」，实测会误杀两条真问题——
//     「那一边的测试集怎么样了？」「呢思考预算还有一些细致的调节的是什么参数？」
//     （语气词只是句首口语，句子本身是真问题）。改成「口语词计数 ≥2」后两条都保住了。
// 只作用于未决段（decisions 侧不受影响）；置顶条目豁免由调用方负责（与本文件其它过滤器同规矩）。
/**
 * 未决段四条规则（v2，2026-10-15 夜红队审计后修订）。
 *
 * v1 的三个问题（红队 A#4 实测复现，均已在本版修正）：
 *   ① 规则 4 把「所以/但是/另外/因此」当从句残片 ⇒ **误杀真问题**（「所以现在到底该用哪个判据？」现场被拦）；
 *   ② 规则 3「≥90 字全杀」与抽取器 90 字上限同值 ⇒ **长问题结构性消失**；
 *   ③ 规则 1 覆盖不到代码围栏与 Mermaid 头行 ⇒ 「```bash 这行到底怎么装？」「subgraph 记忆层」能进简报抢名额。
 * v2 逐条对拍（tools/_probe_unresolved_rules_v2.mjs，两库真池 36/8）：**杀数不变（4/0），但成分修正**——
 *   放行 1 条真问题、新拦 2 类残片。
 */
export const UNRESOLVED_FILTERS = [
  // 1. 图形/代码残片：Mermaid（-->）/ 表格行 / 方括号 / 代码围栏 / Mermaid 头行 / 行首代码关键字
  /-->|\|.*\||\[[^\]]*\]|\{[^}]*\}|^```|^~~~|^\s{2,}\S|^(?:subgraph|flowchart|graph\s+(?:TB|TD|LR)|sequenceDiagram|participant|classDef|end)\b|^(?:const|let|var|function|import|export|return|if|for)\s/,
  // 2. 口语转写：语气词出现 ≥2 次（单个语气词放行——「呢…是什么参数？」是真问题）
  /(?:[呃呢嗯啊呀嘛][\s\S]*){2}/,
  // 3. 截断残片：撞上 90 字上限**且没有句末标点**才算（自然长度的长问句要放行）
  /^[\s\S]{90,}$(?<![。！？!?…])/,
  // 4. 从句残片开头：只留结构上不能独立成句的「并/而/且」；话语标记（所以/但是/另外/因此）放行
  /^(?:并|而|且)\s*/,
]

// ── 残片守卫（2026-10-17 夜 U-A 调研后加，见 docs/research/2026-10-18-U-A未决段处置调研.md §2.2/§3）──
//
// 病历：agent1super 实际注入的 3 条未决里 2 条是残片，precision ≈ 1/3。其中一条是 5 字的
// 「怎么样呢？」—— 它躲过了全部四条规则，因为**共享下限 BRIEF_TEXT_MIN 是 5**（那条下限是为
// decisions 设的：「改用 X」这类短决策是合法的，抬它会连带误伤）。
//
// 判据选的是「**剥掉疑问词与语气词之后还剩几个实义字**」，而不是简单抬长度——理由是
// 长度分不开这两类：「怎么样呢？」5 字是残片，而「后续还能增加什么？」9 字是真问题。
// 实测标定（两侧真问题清单见 tools/check-brief-filters.mjs §⑤）：
//   残片 怎么样呢？→0 · 还有呢？→2 · 然后呢？→2      → 拦
//   真问题 后续还能增加什么？→6 · 所以现在到底该用哪个判据？→10 · 那一边的测试集怎么样了？→8 → 放行
const UNRESOLVED_QUESTION_WORDS = /(怎么样|怎样|怎么|什么|为什么|为啥|如何|哪个|哪些|哪边|哪里|哪儿|是否|能否|能不能|要不要|该不该|多少|多久|什么时候|谁)/g
const UNRESOLVED_PARTICLES = /[呢吧吗啊呀嘛哦噢]/g

/** 剥掉疑问词/语气词/标点后剩下的实义字数（导出让守门与调研脚本用同一口径）。 */
export function unresolvedContentChars(q) {
  return String(q ?? '')
    .replace(UNRESOLVED_QUESTION_WORDS, '')
    .replace(UNRESOLVED_PARTICLES, '')
    .replace(/[？?！!。.，,、；;：:\s"'“”‘’()（）\-—_/\\]/g, '')
    .length
}
/** 少于这个实义字数 = 残片（实测标定：残片 ≤2，最短的真问题 6）。 */
export const UNRESOLVED_CONTENT_MIN = 4

// ─────────────────────────────────────────────────────────────────────────────
// [1017 夜 · 12d 归核] 未决段判据的**权威源已搬到内核**：核心库 dist/recall.js 导出了
// passesUnresolvedFilters / unresolvedContentChars / UNRESOLVED_CONTENT_MIN / UNR_SLOTS。
// 本文件下面那份实现**降级为「内核缺席时的兼容兜底」**，只在 recall 拿不到时才用。
//
// 为什么不是直接删掉本地副本：插件是自包含发布件（用户可能只装 dsh-plugin 没配内核），
//   删了就整段静默消失。**拿不到就降级 ≠ 判据有两份** —— recall 在场时永远是它说了算，
//   而 recall 在场与否由 tools/check-brief-filters §⑥ 对拍 + 插件 selftest 双重把关。
//
// 真正的终态是 recall 恒在场（它就在 vendor/dist 里），本地这份可删。本轮保留兜底以防万一，
//   并把「实际走的是哪一份」暴露成 __unresolvedFromRecall，给守门与 selftest 断言。

let _recall = null;
// ⚠️ [复审 S3] 降级必须**可见**（纪律 2「容错不许静默」）。
//   原来这里是 `catch { _recall = null }` 且整个文件零 console.* ⇒ 内核拿不到时**一点输出都没有**，
//   用户只会看到「简报和以前不太一样」，查不出是走了兜底。降级本身是对的（插件是自包含发布件），
//   错的是它不可观测。判定用环境变量开关，避免污染正常宿主 stderr。
try { _recall = await import('../vendor/dist/recall.js'); } catch (e) {
  _recall = null
  if (process.env.SRELAY_DEBUG || process.env.SRELAY_BRIEF_DEBUG) {
    console.error('[brief-filters] 内核 recall.js 取不到，未决段判据降级为本地兜底：' + (e?.message ?? e))
  }
}

/** 未决段判据实际来自内核（true）还是本地兜底（false）。守门/selftest 断言它为 true。 */
export const __unresolvedFromRecall = !!(
  _recall && typeof _recall.passesUnresolvedFilters === 'function'
)

/** 未决段名额：同样转发内核权威值。内核缺席时退回 1（= U-A 降级后的值，本地兜底常量的含义）。 */
export const UNR_SLOTS = __unresolvedFromRecall
  ? (_recall.UNR_SLOTS ?? 1)
  : 1

/** 未决问题是否够格进简报。false = 该拦。**优先调内核权威判据**，缺席才用本地兜底。 */
export function passesUnresolvedFilters(q) {
  if (__unresolvedFromRecall) return _recall.passesUnresolvedFilters(q);
  const t = String(q ?? '').trim()
  if (t.length < BRIEF_TEXT_MIN) return false
  if (unresolvedContentChars(t) < UNRESOLVED_CONTENT_MIN) return false
  for (const re of UNRESOLVED_FILTERS) {
    re.lastIndex = 0
    if (re.test(t)) return false
  }
  return true
}

/** 长度边界：过短是碎片，过长是整段报告被塞进来 */
export const BRIEF_TEXT_MIN = 5
export const BRIEF_TEXT_MAX = 220

// ─────────────────────────────────────────────────────────────────────────────
// [1018 · 七条**收进内核**] 与上面未决段同一条路：判据权威源在内核，本文件的实现降级为兜底。
//
// 为什么要做这一步：此前七条只存在于两份客户端副本里，内核那份是「只参照」的抄本 ⇒
//   守门只能证「两侧一致」，**证不了「两侧都对」** —— 两边一起改错时它照样绿。
//   这不是外观补丁，是把权威源真的挪到内核：recall.js 是唯一说了算的那一份。
//
// 为什么保留本地兜底：插件是自包含发布件（用户可能只装 dsh-plugin 没配内核），
//   删了就整段静默消失。**拿不到就降级 ≠ 判据有两份** —— recall 在场时永远是它说了算。
//   和未决段一样，降级必须**可见**：__briefFromRecall 暴露实际走的是哪一份。

/** 七条判据实际来自内核（true）还是本地兜底（false）。守门/selftest 断言它为 true。 */
export const __briefFromRecall = !!(
  _recall &&
  typeof _recall.passesBriefFilters === 'function' &&
  Array.isArray(_recall.BRIEF_CANONICAL_FILTERS)
)

/** 单条文本是否够格进简报。false = 该拦。**优先调内核权威判据**，缺席才用本地兜底。 */
export function passesBriefFilters(text) {
  if (__briefFromRecall) return _recall.passesBriefFilters(text)
  const t = String(text ?? '').trim()
  if (t.length < BRIEF_TEXT_MIN || t.length > BRIEF_TEXT_MAX) return false
  for (const re of BRIEF_CANONICAL_FILTERS) {
    re.lastIndex = 0
    if (re.test(t)) return false
  }
  return true
}
