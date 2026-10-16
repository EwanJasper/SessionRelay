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

export interface AgingRow {
  id: string;
  last_event_at?: string | null;
  message_count?: number | null;
  extracted_version?: number | null;
  state?: string | null;
  origin?: string | null;          // 保护判据要对齐 archive.ts 的 isProtected（imported/note 不归档）
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
  const plan: AgingPlan = { archive: [], kept: [], reasons: {} };
  const cand: AgingRow[] = [];
  for (const r of rows) {
    if (r.cleanup_at) { plan.reasons[r.id] = '已归档过'; plan.kept.push(r); continue; }
    // ⚠️ 2026-10-17 实测纠正：原门禁写的是 state==='confirmed'，而重建后的库 719/719 场都是 pending_end
    //    ⇒ 计划恒为空（storage-scout 查出本文件当时还是**死代码**：只被自己的单测引用）。
    //    现在保护判据与 capture/archive.ts 的 isProtected 对齐；执行器复用 runArchive（真删正文的唯一实现）。
    if (String(r.state || '') === 'active') { plan.reasons[r.id] = '正在进行，不归档'; plan.kept.push(r); continue; }
    if (String(r.origin || '') === 'imported' || String(r.origin || '') === 'note') { plan.reasons[r.id] = '导入/笔记，不归档'; plan.kept.push(r); continue; }
    if (Number(r.extracted_version ?? -1) !== o.currentVersion) { plan.reasons[r.id] = '规则版本旧，先重算'; plan.kept.push(r); continue; }
    if (decisionCount(r.decisions) < minDec) { plan.reasons[r.id] = '没有派生结论，归档了就真没了'; plan.kept.push(r); continue; }
    const d = ageDays(r.last_event_at, now);
    if (d < minAge) { plan.reasons[r.id] = '还不到 ' + minAge + ' 天'; plan.kept.push(r); continue; }
    cand.push(r);
  }
  // 老的先归档，每轮封顶（渐变，不突变）
  cand.sort((a, b) => String(a.last_event_at || '').localeCompare(String(b.last_event_at || '')));
  for (const r of cand.slice(0, cap)) { plan.archive.push(r); plan.reasons[r.id] = '归档正文（结论保留）'; }
  for (const r of cand.slice(cap)) { plan.kept.push(r); plan.reasons[r.id] = '本轮超出上限，下轮再说'; }
  return plan;
}
