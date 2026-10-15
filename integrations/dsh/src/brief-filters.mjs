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
