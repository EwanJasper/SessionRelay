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
 * 来源可信度（只用于**决定谁能当代表 / 能不能合并**，不参与『是不是重复』的判定）。
 *
 * 为什么需要它 —— 这是 L1 跨会话合并**当年被否决的真正原因**，不是『L1 本身有损』：
 *   合并规则原来是『保留最新的一条』。而跨 origin 的近重复里，最新的往往正是
 *   **workflow 子代理的转述**（每轮都在增）。于是转述吸收掉用户拍板 →
 *   幸存者带 origin='workflow' → 读路径的硬过滤 origin != 'workflow'
 *   （store/db.ts:786/908）把整组挡在检索面外 ⇒ **真掉召回**（实测 hit@1 −5~7pt）。
 *
 * 分档与读路径口径**必须一致**：读路径只排除 workflow，所以只有 workflow 是 0 档，
 * 其余（manual/auto/未标注）都在『可见』档；manual 再高一点，因为它来自人工确认。
 */
const trustRank = (it: CompactItem): number => {
  const o = String((it as Record<string, unknown>).origin ?? '');
  if (o === 'manual') return 3;
  if (o === 'workflow') return 0;
  return 2;
};

export type RepresentativePolicy = 'newest' | 'highest-trust';

export interface CompactOptions {
  /** 近重复判定阈值（默认 0.8） */
  threshold?: number;
  /**
   * 'newest'        —— 历史行为，保留时间最新的一条
   * 'highest-trust' —— **低可信来源不许当代表**：跨档合并时升档，升档过不了
   *                    『与全组互相似』的校验就**不许合并**（拆开更安全）。
   * 默认 'newest'：不改历史行为，要新语义必须显式传。
   */
  representative?: RepresentativePolicy;
}

/**
 * 把一组条目按『近重复』分组合并，并在保留下来的那条上写 dupCount / firstSeen
 * —— 频次本身就是重要性信号，不能丢。
 */
export function compactItems<T extends CompactItem>(
  items: T[],
  thresholdOrOpts: number | CompactOptions = 0.8,
  maybeOpts: CompactOptions = {},
): { kept: T[]; groups: MergeGroup<T>[] } {
  const opts: CompactOptions = typeof thresholdOrOpts === 'number'
    ? { ...maybeOpts, threshold: thresholdOrOpts }
    : thresholdOrOpts;
  const threshold = opts.threshold ?? 0.8;
  const policy: RepresentativePolicy = opts.representative ?? 'newest';

  const sorted = items.slice().sort((x, y) => String(y.at || '').localeCompare(String(x.at || '')));   // 新的在前
  const kept: T[] = [];
  const groups: MergeGroup<T>[] = [];
  for (const it of sorted) {
    let merged = false;
    for (const g of groups) {
      const near = isNearDuplicate(g.keep.text, it.text, threshold);
      if (!near.dup) continue;
      if (policy === 'highest-trust') {
        const ri = trustRank(it), rk = trustRank(g.keep);
        if (ri > rk) {
          // 后来的是**更可信**的：它应该当代表。但只有当它跟组内**每个**成员都还是近重复时
          // 才能接过去 —— 否则这组本来就不该长在一起（近重复不满足传递性），
          // 强行合并会造出一个『代表跟某些成员其实不像』的假合并。
          const members: T[] = [g.keep, ...g.absorbed];
          const ok = members.every((m) => m === it || isNearDuplicate(it.text, m.text, threshold).dup);
          if (!ok) continue;                       // 升档失败 ⇒ 不许合并，让它另起一组
          g.absorbed = members;                    // 旧代表降为被吸收
          g.keep = it;
          const idx = kept.indexOf(members[0]);
          if (idx >= 0) kept[idx] = it;
          merged = true;
          break;
        }
        // ri <= rk：可信档不高于现代表 ⇒ 正常被吸收（低档被高档吃掉是我们要的方向）
      }
      g.absorbed.push(it);
      merged = true;
      break;
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