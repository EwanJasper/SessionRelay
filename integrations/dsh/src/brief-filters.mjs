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
]

/** 长度边界：过短是碎片，过长是整段报告被塞进来 */
export const BRIEF_TEXT_MIN = 5
export const BRIEF_TEXT_MAX = 220

/** 单条文本是否够格进简报。false = 该拦。 */
export function passesBriefFilters(text) {
  const t = String(text ?? '').trim()
  if (t.length < BRIEF_TEXT_MIN || t.length > BRIEF_TEXT_MAX) return false
  for (const re of BRIEF_CANONICAL_FILTERS) {
    re.lastIndex = 0
    if (re.test(t)) return false
  }
  return true
}
