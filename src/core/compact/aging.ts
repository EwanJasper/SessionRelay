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
// [1021 审查 #17 后续] 连续强度判据：**唯一实现**在 core/decay/strength.ts。
// 本文件不再写任何衰减公式（铁律：判据只许有一份）—— 旧版这里写死了 1 - age/90，
// 而生产传的窗是 config.archive.hot_days（30），公式里的 90 与真实窗根本不是同一个数。
import { shouldRetire, strengthOfAge, STRENGTH_RETIRE_THRESHOLD } from '../decay/strength.js';

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
  /** @deprecated 旧线性强度门（1 − 窗/90）。决策已改用连续强度的常数阈值 T=1/e（见 decay/strength.ts）；
   *  本字段仅为兼容既有调用方（archive.ts / panel 仍会传）而保留，**不参与判定**。
   *  窗边界仍落在 minAgeDays 上：strength(minAgeDays) = exp(−minAgeDays/S)，S=minAgeDays ⇒ e^-1 = T。 */
  maxStrength?: number;
}

/**
 * **连续强度**（0~1，越大越"还被需要"）——淘汰判据。核心公式在 core/decay/strength.ts：
 *   strength = exp(−t/S)（艾宾浩斯保持率）；t = 距最后活动天数，S = 强度天数（本函数取窗 minAgeDays）。
 * 重放=强化：会话被恢复/追加消息 ⇒ last_event_at 前移 ⇒ t 归零 ⇒ 立刻回血；
 * 经验层则用 hits/uses 抬高出生分 ⇒ 抬高 S（见 global.ts maintainLessons）。
 *
 * 为什么不再用"结论多 = 强度高"（记录教训）：归档只删**正文**、结论留着，
 * 所以"结论多"恰恰是**该归档**的理由；决定"正文还要不要"的只有最近性。
 * 本函数不再写死 90：分母必须是**调用方真实的窗**（生产是 config.archive.hot_days）。
 */
export const DEFAULT_AGING_SPAN_DAYS = 90;

export function strengthOf(r: AgingRow, now = Date.now(), spanDays: number = DEFAULT_AGING_SPAN_DAYS): number {
  const age = ageDays(r.last_event_at, now);
  return Number(strengthOfAge(age, spanDays).toFixed(3));
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
  // ── [1021] 窗口即强度时间常数 S，阈值是曲线常数 T=1/e ──
  //   旧实现有两套"界"：先按 d < minAge 硬门筛，再用强度门（由窗推导）二次筛；而强度公式里
  //   还写死了 90 —— 生产传 30 时，两个数根本不是同一个界。现在只保留**一个**连续判据：
  //   strength = exp(−age/S)，S = minAgeDays ⇒ 归档边界仍落在 minAgeDays 天上（strength = e^-1 = T），
  //   与旧"窗"行为等价，但变成可解释/可调/可测的连续量（红队 R15 那类"两套判据各说各话"不再可能）。
  //   o.maxStrength 已废弃（见 AgingOptions 注释），仅为兼容既有调用方保留，不参与判定。
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
    // 唯一判据：strength < T（比较只在 shouldRetire 里，见 decay/strength.ts）
    const s = strengthOf(r, now, minAge);
    if (!shouldRetire(s)) {
      plan.reasons[r.id] = '强度 ' + s.toFixed(3) + ' ≥ T' + STRENGTH_RETIRE_THRESHOLD.toFixed(3) + (ageDays(r.last_event_at, now) < minAge ? '（还不到 ' + minAge + ' 天）' : '');
      plan.kept.push(r); continue;
    }
    (r as unknown as Record<string, unknown>).strength = s;   // 可解释：报告能打印"为什么归档它"
    plan.reasons[r.id] = '强度 ' + s.toFixed(3) + ' < T' + STRENGTH_RETIRE_THRESHOLD.toFixed(3);
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

/**
 * 旧线性强度门：1 − 窗/90。**已不参与淘汰判定**（判据改为 strength < T=1/e，见 decay/strength.ts）。
 * 保留原因（诚实记录）：它仍被 capture/archive.ts 的判据摘要行与 panel/snapshot.ts 的展示字段
 * 引用，且 test/fork/d26-auto-archive.spec.ts 与 test/unit/panel-snapshot.spec.ts 断言了它的数值。
 * ⚠️ 已知不一致（留给后续单点修，非本任务写区）：这两处展示的是旧线性门 0.667，而真实阈值是
 * 1/e≈0.368 —— 打印值与判据不同口径。修法：archive/panel 改引 STRENGTH_RETIRE_THRESHOLD。
 */
export function strengthGateOf(minAgeDays: number): number {
  return Number(Math.max(0, Math.min(1, 1 - minAgeDays / 90)).toFixed(3));
}
