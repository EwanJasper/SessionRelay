/**
 * 会话类别判据（**唯一来源**）—— [1021 审查 #01 的延伸]
 *
 * 病历：同一件事「这条会话是不是笔记」曾在至少三处各写一套，而且都写错了：
 *   · capture/archive.ts     判 origin === 'note'  → 恒假 ⇒ 笔记照样被归档，正文被删
 *   · capture/rebuild.ts     只迁 origin='imported' ⇒ 笔记重建后从新库消失
 *   · core/compact/aging.ts  也判 origin === 'note' ⇒ 计划数字把笔记算进候选（执行器拦下了，但**数字在撒谎**）
 *
 * 为什么必须放 shared/ 而不是 store/db.ts：
 *   core/compact 是纯计算模块（零依赖），让它反过来依赖 store 会形成 core→store 的倒挂。
 *   判据放中性层，store / capture / core 都可以引用，且**只有一份**。
 *
 * 字段语义（别搞混）：
 *   source = **谁产出的**（note = MCP save_note 写的；zcode/dsh = 采集来）
 *   origin = **怎么进来的**（manual = 人工补录；auto = 自动采集；imported = 交接包导入；workflow = 工作流派生）
 * 判断"是不是笔记"要用 source —— 用 origin 会把任何人工补录都误判成笔记。
 */

/**
 * 这条会话是手写笔记（MCP save_note 写入）——笔记的正文是唯一副本，任何清理都必须豁免。
 *
 * 判据同时接受 source 与 origin 两种写法：
 *   · 现行 createNoteSession 写的是 source='note' / origin='manual'  → 命中 source
 *   · 但 store/db.ts 的 PROBE_SQL 与历史数据里存在 origin='note' 形态（老版本或外部导入写的）
 *   → 两个都收，避免升级后**旧库里的笔记忽然不再受保护**（那正是这条 bug 最坏的形态：
 *     修好新数据、把老数据弄丢）。
 * 这不是"两套判据"，是同一个函数里对同一语义的两种历史表示。
 */
export function isNoteSession(row: { source?: string | null; origin?: string | null }): boolean {
  return row.source === 'note' || row.origin === 'note';
}

/** 这条会话没有本地源文件，无法从客户端重放 ⇒ 重建时必须整行搬迁。 */
export function isUnrebuildableSession(row: { origin?: string | null; source?: string | null }): boolean {
  if (isNoteSession(row)) return true;                 // 笔记：只有库里有
  return row.origin === 'imported';                    // 交接包导入：没源文件
}
