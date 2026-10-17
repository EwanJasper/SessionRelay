// ─────────── 压缩 L2：老化压缩（老会话正文 → 归档，派生结论留全）───────────
//
// 与 L1 的区别：L1 是"去掉重复"（无损）；L2 是"去掉过时的正文"——**有损**，所以必须有门禁。
// 社区对照：Letta/MemGPT 的分层 + 递归摘要、ACT-R 的激活衰减（我们 liveImportance 已是这套）。
// 我们的取舍：**不重写正文、不做 LLM 摘要**（那是有损且不可逆的），而是把"老会话的原始正文"
// 归档掉（cleanup_at），派生结果（决策/问题/经验）全部保留 —— 这样：
//   · 存储与上下文都变小；
//   · 结论一条不丢（信息主干还在）；
//   · 真需要原文时，原始会话还在客户端那边（记忆库是派生存储）⇒ 可重放。
//
// 触发条件（四条全中才动，且每轮有上限，渐变不突变）：
//   ① 最后活动 ≥ minAgeDays（默认 90 天）
//   ② 已按当前规则版本抽取过（extracted_version === CURRENT）——旧版本的重算完再说
//   ③ 有派生结果（决策 ≥1 条）——没结论的老会话归档了就真没了，不许归档
//   ④ 会话状态已是 confirmed（落定过的）

import { isNoteSession } from '../../shared/session-kind.js';

export interface AgingRow {
  id: string;
  last_event_at?: string | null;
  message_count?: number | null;
  extracted_version?: number | null;
  state?: string | null;
  origin?: string | null;          // 「怎么进来的」：imported/note 的判据起点（见 shared/session-kind.ts）
  source?: string | null;          // 「谁产出的」：isNoteSession 用的是这一列，不是 origin
  decisions?: string | null;
  cleanup_at?: string | null;
}

export interface AgingPlan { archive: AgingRow[]; kept: AgingRow[]; reasons: Record<string, string> }

export interface AgingOptions {
  now?: number;
  minAgeDays?: number;
  currentVersion: number;
  minDecisions?: number;
  cap?: number;
  /** 连续强度阈值（0~1）：低于它才考虑归档。见 strengthOf() 的注释 —— 取代原来的布尔状态位。 */
  maxStrength?: number;
}

/**
 * **连续强度**（0~1，越大越"还被需要"）——取代"布尔状态位"当淘汰判据。
 *
 * 依据（ADR-003 D1）：MemoryBank 用"强度 + 阈值"剪枝；ACT-R 用 `B = ln(Σ t^-d)`（decay 0.35）；
 * Wixted & Ebbesen 证幂律优于指数。我们不去实现 B 公式（那是给检索用的），而是给**淘汰**一个
 * 连续量：近期活跃 + 派生结论多 = 强度高；又老又没产出 = 强度低。
 * ⚠️ 公式改过一次（记录教训）：第一版给"结论密度"和"对话规模"各 0.3/0.1 权重，结果
 * **结论多的会话反而永远不会被归档** —— 但归档只删**正文**、结论是留着的，所以"结论多"
 * 恰恰是**该归档**的理由（信息已经提炼出来了）。真正决定"正文还要不要"的只有**最近性**：
 * 越近越可能要回原文；越老越只剩结论的价值。
 * 最终公式：`strength = max(0, 1 - ageDays/90)`（0~1），配合 minAgeDays 一起用。
 * 之所以要它：写死 `state==='active'` 这类布尔门的结果是——门一错，计划恒空/恒满，
 * 而且**没人能从数字上看出为什么**（我们的 aging 就在这上面栽过）。连续量可解释、可调、可测。
 */
export function strengthOf(r: AgingRow, now = Date.now()): number {
  const age = ageDays(r.last_event_at, now);
  return Number(Math.max(0, 1 - age / 90).toFixed(3));
}

function ageDays(at: string | null | undefined, now: number): number {
  const t = Date.parse(String(at || ''));
  if (!Number.isFinite(t)) return 0;                 // 时间不可信 → 当"新"处理，不归档
  return (now - t) / 86400000;
}

function decisionCount(raw: string | null | undefined): number {
  try { const a = JSON.parse(String(raw || '[]')); return Array.isArray(a) ? a.filter((x) => x && x.text && String(x.text).trim().length >= 2).length : 0; }
  catch { return 0; }
}

/** 纯函数：给定一批行，算出该归档哪些、为什么。可单测 —— 判据错了要立刻红。 */
export function planAging(rows: AgingRow[], o: AgingOptions): AgingPlan {
  const now = o.now ?? Date.now();
  const minAge = o.minAgeDays ?? 90;
  const minDec = o.minDecisions ?? 1;
  const cap = o.cap ?? 100;
  // ── [1021 红队 R15 修复] 默认值**跟着 minAgeDays 走**，不再硬编码 0.25 ──
  //   原来：`?? 0.25`。而默认 minAgeDays=90 对应 strengthGateOf(90)=0，
  //   0.25 对应的是 90*(1-0.25)=67.5 天 ⇒ **两个默认值在不同界**。
  //   注释却写「窗与强度门在数学上边界重合」—— 那句话**只在调用方显式传参时成立**
  //   （目前唯一生产调用方 archive.ts 确实传了 strengthGateOf(minAgeDays)，所以线上没炸）。
  //   但 planAging 是**导出的纯函数**：任何新调用方漏传 maxStrength，
  //   就会得到 67.5 天 vs 90 天两套边界，而且**没有任何断言会红** —— 这正是 1017 前
  //   「两套判据各说各话」的完整复现条件（红队实测：planAging([60天前], {minAgeDays:60}) 返回 archive=0）。
  //   修法：默认值由 minAgeDays 现算 ⇒ **在数学上真的重合**，注释才配得上。
  const maxStrength = o.maxStrength ?? strengthGateOf(minAge);
  const plan: AgingPlan = { archive: [], kept: [], reasons: {} };
  const cand: AgingRow[] = [];
  for (const r of rows) {
    if (r.cleanup_at) { plan.reasons[r.id] = '已归档过'; plan.kept.push(r); continue; }
    // ⚠️ 2026-10-17 实测纠正：原门禁写的是 state==='confirmed'，而重建后的库 719/719 场都是 pending_end
    //    ⇒ 计划恒为空（storage-scout 查出本文件当时还是**死代码**：只被自己的单测引用）。
    //    现在保护判据与 capture/archive.ts 的 isProtected 对齐；执行器复用 runArchive（真删正文的唯一实现）。
    if (String(r.state || '') === 'active') { plan.reasons[r.id] = '正在进行，不归档'; plan.kept.push(r); continue; }
    // [1021 审查 #01 延伸] 笔记判据走唯一来源 isNoteSession（source==='note'）。
    //   原来这里判的是 origin==='note' —— 恒假 ⇒ 计划里把笔记算进候选，虽然执行器 runArchive 会拦下，
    //   但**计划数字在撒谎**（rt-robust 实测：计划「0+1」，执行「0+0」）。数字要绑口径，不许自相矛盾。
    if (String(r.origin || '') === 'imported' || isNoteSession(r)) { plan.reasons[r.id] = '导入/笔记，不归档'; plan.kept.push(r); continue; }
    if (Number(r.extracted_version ?? -1) !== o.currentVersion) { plan.reasons[r.id] = '规则版本旧，先重算'; plan.kept.push(r); continue; }
    if (decisionCount(r.decisions) < minDec) { plan.reasons[r.id] = '没有派生结论，归档了就真没了'; plan.kept.push(r); continue; }
    const d = ageDays(r.last_event_at, now);
    if (d < minAge) { plan.reasons[r.id] = '还不到 ' + minAge + ' 天'; plan.kept.push(r); continue; }
    const s = strengthOf(r, now);
    if (s > maxStrength) { plan.reasons[r.id] = '强度 ' + s.toFixed(2) + ' 仍高于阈值 ' + maxStrength; plan.kept.push(r); continue; }
    (r as unknown as Record<string, unknown>).strength = s;   // 可解释：报告能打印"为什么归档它"
    plan.reasons[r.id] = '强度 ' + s.toFixed(2) + ' ≤ ' + maxStrength;
    cand.push(r);
  }
  // 老的先归档，每轮封顶（渐变，不突变）
  cand.sort((a, b) => String(a.last_event_at || '').localeCompare(String(b.last_event_at || '')));
  for (const r of cand.slice(0, cap)) { plan.archive.push(r); plan.reasons[r.id] = '归档正文（结论保留）'; }
  for (const r of cand.slice(cap)) { plan.kept.push(r); plan.reasons[r.id] = '本轮超出上限，下轮再说'; }
  return plan;
}

/** 每轮归档上限（渐变不突变）。1017 夜从 capture/archive.ts 提升到这里：
 *  面板要报"每轮上限"，而它不能 import 那个文件（那里拖着 store/db 与 recompute）。 */
export const ARCHIVE_CAP_PER_ROUND = 200;

/** 窗 → 强度阈值：strength = 1 − ageDays/90（见 strengthOf 的注释）。
 *  这样"窗"与"强度门"在数学上边界重合 —— 不会出现两套判据各说各话（1017 前的病）。
 *  **唯一实现**：capture/archive.ts 原样再导出，老调用点不变。 */
export function strengthGateOf(minAgeDays: number): number {
  return Number(Math.max(0, Math.min(1, 1 - minAgeDays / 90)).toFixed(3));
}
