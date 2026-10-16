// ─────────── 呈现层折叠：近重复只折叠"这一次显示"，不碰存储 ───────────
//
// 依据（ADR-003 D2/D3）：Mem0/Zep/TEPA 都不做全局相似度合并；我们实测存储层合并会拆掉
// "读路径屏蔽 workflow" 那道边界（music 66 组里 45 组跨 origin）⇒ 合并只能发生在**显示层**。
//
// 三条纪律（来自 task-4 的实测教训）：
//   ① **不重排**：只按输入顺序走一遍，保留"最新的那条"作为代表，其余折叠成计数 —— 采用
//      compactItems 那种"按时间重排"的输出顺序等于偷偷改判据（它内部会 reorder）。
//   ② **必须继承长度比门**：生产在用的"14 字前缀键"曾误杀干净决策「采用 Vite 作为前端构建工具」，
//      留下 62 字粘连噪声（长度比 3.88）——判据复用 isNearDuplicate（含 ≤2.2 长度门）。
//   ③ **只加字段，不删条目语义**：被折叠的条数记在 `dupCount` 与 `dupTexts`（供"看原文"），
//      原文一条都没从库里消失。

import { isNearDuplicate } from './dedup.js';

export interface FoldableRow { text: string }   // 只要求有 text；额外字段（dupCount/dupTexts）由实现内部按需挂

export interface FoldResult<T extends FoldableRow> {
  /** 折叠后的行（**保持输入顺序**），代表行上带 dupCount / dupTexts */
  rows: T[];
  /** 折叠掉的行数（= 输入 − 输出） */
  folded: number;
}

/**
 * 按近重复折叠一组行，**保持输入顺序**，代表行取"最后出现的那条"（调用方传升序 ⇒ 最新）。
 * @param rows 输入行（顺序由调用方决定，本函数不改）
 * @param threshold 重叠系数阈值（默认 0.8）
 * @param gate 额外门槛（默认开启长度比门 —— 见纪律②）
 */
export function foldNearDuplicates<T extends FoldableRow>(
  rows: T[], threshold = 0.8, gate: (a: string, b: string) => boolean = () => true,
): FoldResult<T> {
  const out: T[] = [];
  const groups: Array<{ keepIdx: number; members: T[] }> = [];
  for (const r of rows) {
    let placed = false;
    for (const g of groups) {
      const rep = g.members[g.members.length - 1];       // 最新的代表
      const { dup } = isNearDuplicate(rep.text, r.text, threshold);
      if (dup && gate(rep.text, r.text)) { g.members.push(r); placed = true; break; }
    }
    if (!placed) groups.push({ keepIdx: -1, members: [r] });
  }
  // 代表行 = 组内**最后一条**；组在输出里的位置 = 该组**首次出现**的位置（保持输入顺序）
  const seenGroup = new Map<number, number>();           // groupIdx → out 下标
  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi];
    const rep = g.members[g.members.length - 1];
    if (g.members.length > 1) {
      (rep as unknown as Record<string, unknown>).dupCount = g.members.length;
      (rep as unknown as Record<string, unknown>).dupTexts = g.members.slice(0, -1).map((m) => m.text);
    }
    seenGroup.set(gi, out.length);
    out.push(rep);
  }
  // 按"组内第一条在输入里的出现顺序"重排输出（保持与输入一致的相对次序）
  const firstOf = new Map<T, number>();
  rows.forEach((r, i) => { if (!firstOf.has(r)) firstOf.set(r, i); });
  out.sort((a, b) => {
    const ga = groups.findIndex((g) => g.members.indexOf(a) >= 0);
    const gb = groups.findIndex((g) => g.members.indexOf(b) >= 0);
    const ia = firstOf.get(groups[ga].members[0]) ?? 0;
    const ib = firstOf.get(groups[gb].members[0]) ?? 0;
    return ia - ib;
  });
  return { rows: out, folded: rows.length - out.length };
}

/** 长度比门（纪律②）：复刻 isNearDuplicate 里的 ≤2.2 判据，供调用方显式传入 */
export function lengthRatioGate(a: string, b: string, maxRatio = 2.2): boolean {
  const la = a.length, lb = b.length;
  const shorter = Math.min(la, lb) || 1, longer = Math.max(la, lb);
  return longer <= shorter * maxRatio;
}
