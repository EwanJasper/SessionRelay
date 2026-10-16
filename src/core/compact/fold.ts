// ─────────── 呈现层折叠：近重复只折叠"这一次显示"，不碰存储 ───────────
//
// 依据（ADR-003 D2/D3）：Mem0/Zep/TEPA 都不做全局相似度合并；我们实测存储层合并会拆掉
// "读路径屏蔽 workflow"那道边界（music 66 组里 45 组跨 origin）⇒ 合并只能发生在**显示层**。
//
// 四条纪律（前三条来自 task-4 实测，第四条是 1017 夜被 selftest 打出来的）：
//   ① **不重排**：只按输入顺序走一遍，组的位置 = "本组首次出现的位置"。采用 compactItems
//      那种"按时间重排"的输出顺序等于偷偷改判据（它内部会 reorder）。
//   ② **必须继承长度比门**：生产在用的"14 字前缀键"曾误杀干净决策「采用 Vite 作为前端构建工具」，
//      留下 62 字粘连噪声（长度比 3.88）——判据复用 isNearDuplicate（含 ≤2.2 长度门）。
//   ③ **只加字段，不删条目语义**：被折叠的条数记在 `dupCount` 与 `dupTexts`（供"看原文"），
//      原文一条都没从库里消失。
//   ④ **代表可以由调用方指定**（opts.prefer）：简报侧"置顶"必须赢——按时间挑代表时，
//      置顶的那条会被同组更新的普通决策顶掉，pin 形同虚设（1017 实测红了 3 条断言）。

import { isNearDuplicate } from './dedup.js';

export interface FoldableRow { text: string }   // 只要求有 text；额外字段（dupCount/dupTexts）由实现内部按需挂

export interface FoldOptions<T> {
  /** 代表优先判据：组内凡满足它的行，优先当代表（多条满足时仍取 at 最新的一条）。异常按 false 处理 */
  prefer?: (row: T) => boolean;
}

export interface FoldResult<T extends FoldableRow> {
  /** 折叠后的行（**保持输入顺序**），代表行上带 dupCount / dupTexts */
  rows: T[];
  /** 折叠掉的行数（= 输入 − 输出） */
  folded: number;
}

/** 取时间戳；缺字段/脏值一律 NaN（不抛） */
const atOf = (r: unknown): number => Date.parse(String((r as { at?: string } | null)?.at ?? ''));

/**
 * 按近重复折叠一组行，**保持输入顺序**（不是"按时间排"），代表行默认取组内 at 最新的一条。
 * @param rows 输入行（顺序由调用方决定，本函数绝不重排）
 * @param threshold 重叠系数阈值（默认 0.8）
 * @param gate 额外门槛（默认放行；生产必须传 lengthRatioGate —— 见纪律②）
 * @param opts.prefer 代表优先判据（见纪律④）
 */
export function foldNearDuplicates<T extends FoldableRow>(
  rows: T[], threshold = 0.8, gate: (a: string, b: string) => boolean = () => true,
  opts: FoldOptions<T> = {},
): FoldResult<T> {
  // 代表必须按 **at 取最新**，不能按"数组最后一条"取：核心简报传降序（最新在前）、
  // 插件 SQL 通道传升序——按位置取会让两条通道选出不同的代表（分叉，本项目反复踩过）。
  const pick = (members: T[]): T => {
    let pool = members;
    if (opts.prefer) {
      const preferred = members.filter((m) => {
        try { return opts.prefer!(m) === true } catch { return false }
      });
      if (preferred.length) pool = preferred;
    }
    let best = pool[0];
    for (const m of pool) {
      const t = atOf(m), bt = atOf(best);
      if (Number.isFinite(t) && (!Number.isFinite(bt) || t > bt)) best = m;
    }
    return best;
  };
  // 分组：新组只会在遇到"与所有已有组代表都不近重复"的行时创建；由于按输入顺序遍历，
  // groups 天然就是**按首次出现位置排序**的——所以输出 = groups.map(pick)，一个 sort 都不需要。
  const groups: Array<{ members: T[] }> = [];
  for (const r of rows) {
    let placed = false;
    for (const g of groups) {
      const rep = pick(g.members);
      const { dup } = isNearDuplicate(rep.text, r.text, threshold);
      if (dup && gate(rep.text, r.text)) { g.members.push(r); placed = true; break }
    }
    if (!placed) groups.push({ members: [r] });
  }
  const out = groups.map((g) => pick(g.members));
  for (let i = 0; i < groups.length; i++) {
    const members = groups[i].members;
    if (members.length <= 1) continue;
    const rep = out[i];
    (rep as unknown as Record<string, unknown>).dupCount = members.length;
    (rep as unknown as Record<string, unknown>).dupTexts = members.filter((m) => m !== rep).map((m) => m.text);
  }
  return { rows: out, folded: rows.length - out.length };
}

/** 长度比门（纪律②）：复刻 isNearDuplicate 里的 ≤2.2 判据，供调用方显式传入 */
export function lengthRatioGate(a: string, b: string, maxRatio = 2.2): boolean {
  const la = a.length, lb = b.length;
  const shorter = Math.min(la, lb) || 1, longer = Math.max(la, lb);
  return longer <= shorter * maxRatio;
}
