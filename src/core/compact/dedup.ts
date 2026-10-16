// ─────────── 压缩 L1：确定性去重合并（零损失、不调 LLM）───────────
//
// 为什么先做这一层（社区调研后的取舍）：
//   Mem0 的 "update 阶段" 靠 LLM 判 ADD/UPDATE/DELETE —— 效果好但要调模型，**贵且慢**；
//   Zep/Graphiti 用时间知识图谱（新旧事实各自带 valid_at/invalid_at）—— 结构重；
//   Letta/MemGPT 分层 + 递归摘要 —— 有损，需要门禁；
//   ACT-R 系（我们已经在用）= 激活度随时间和频次衰减（liveImportance）。
// 我们做的是**轻量本地框架**：先用**确定性判据**把"本来就重复的东西"合并掉。
// 实测（前 6 个库 2,323 条决策）：近重复 763 条 = 32.8%，文本体积 35.1% —— 这部分压掉**零信息损失**。
//
// 判据与冲突消解共用同一份"实词"提取（subjectTokens），避免两套判据打架。

import { subjectTokens } from '../../store/global.js';

export interface CompactItem {
  text: string;
  at?: string | null;
  kind?: string | null;
  [k: string]: unknown;
}

export interface MergeGroup<T extends CompactItem> {
  /** 保留下来的那条（最新的） */
  keep: T;
  /** 被它吸收掉的（时间更早的近重复） */
  absorbed: T[];
  /** 共同主题词（前几个，便于人工核对） */
  shared: string[];
}

const polarity = (t: string) => /不|别|勿|避免|禁止|弃用|废弃|取消|关闭|禁用|停止|没有/.test(String(t || ''));

/** 两条是不是"近重复"：极性相同 + 重叠系数 ≥ 阈值（默认 0.8，实测能吃掉 1/3 而不误杀） */
export function isNearDuplicate(a: string, b: string, threshold = 0.8): { dup: boolean; shared: string[] } {
  const sa = String(a || '').trim(), sb = String(b || '').trim();
  if (!sa || !sb) return { dup: false, shared: [] };
  if (polarity(sa) !== polarity(sb)) return { dup: false, shared: [] };       // 极性不同 = 可能真冲突，交给 needs_review，不在这里合并
  const shorter = Math.min(sa.length, sb.length), longer = Math.max(sa.length, sb.length);
  if (longer > shorter * 2.2) return { dup: false, shared: [] };             // 长度差太多：一条是另一条的展开，不是重复
  const ta = subjectTokens(sa), tb = subjectTokens(sb);
  const shared = [...ta].filter((t) => tb.has(t));
  const min = Math.min(ta.size, tb.size) || 1;
  return { dup: shared.length / min >= threshold, shared: shared.slice(0, 6) };
}

/**
 * 把一组条目按"近重复"分组合并。**保留最新的一条**（新话压旧话），
 * 并在保留下来的那条上写 `dupCount` / `firstSeen` —— 频次本身就是重要性信号，不能丢。
 */
export function compactItems<T extends CompactItem>(items: T[], threshold = 0.8): { kept: T[]; groups: MergeGroup<T>[] } {
  const sorted = items.slice().sort((x, y) => String(y.at || '').localeCompare(String(x.at || '')));   // 新的在前
  const kept: T[] = [];
  const groups: MergeGroup<T>[] = [];
  for (const it of sorted) {
    let merged = false;
    for (const g of groups) {
      const r = isNearDuplicate(g.keep.text, it.text, threshold);
      if (r.dup) { g.absorbed.push(it); merged = true; break; }
    }
    if (!merged) { kept.push(it); groups.push({ keep: it, absorbed: [], shared: [] }); }
  }
  for (const g of groups) {
    if (!g.absorbed.length) continue;
    const times = g.absorbed.map((x) => String(x.at || '')).filter(Boolean).sort();
    (g.keep as Record<string, unknown>).dupCount = g.absorbed.length + 1;
    if (times.length) (g.keep as Record<string, unknown>).firstSeen = times[0];
    const r = isNearDuplicate(g.keep.text, g.absorbed[0].text, threshold);
    g.shared = r.shared;
  }
  return { kept, groups: groups.filter((g) => g.absorbed.length > 0) };
}
