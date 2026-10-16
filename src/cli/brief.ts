// srelay brief —— 一次子进程把开场简报要的数据全给齐（1015 夜新增）
//
// ═══ 为什么加 ═══
// ZCode 侧的开场简报此前要 spawn **两次**子进程（decisions --json / unresolved --json），
// 实测每次 175–203ms ⇒ 每轮固定烧掉约 380ms。合并成一次后 **−190ms**，同时白得
// 「最近在动哪些文件」那一行（DSH 侧早就有，ZCode 侧一直没有）。
//
// ═══ 口径契约（改了会让两侧简报分叉）═══
// · decisions / unresolved 的取数与截断**逐条复刻** cmdDecisions --json / cmdUnresolved --json：
//     decisions：listDecisions 升序全量 → slice(-limit) → reverse（最近在前）
//     unresolved：listUnresolved 上限 100 → 14 天保质期 → slice(0, limit)
// · counts 就是上面两个数组的长度（= 老命令 --json 里的 count，ZCode 侧提示句的计数用它）
// · recentFiles 见 listRecentFiles 的注释（与 DSH 插件同规）
//
// 人话输出（不带 --json）只给命令行看着方便，**不参与任何客户端渲染**。

import { loadConfig } from '../shared/config.js';
import { listDecisions, listUnresolved, listRecentFiles } from '../store/db.js';
import { foldNearDuplicates, lengthRatioGate } from '../core/compact/fold.js';
import type { DB, DecisionRow, UnresolvedRow, RecentFileRow } from '../store/db.js';
import { requireRoot, openRelayDb, pc } from './ui.js';
import { openGlobal, pickForInjection, type LessonRow } from '../store/global.js';
import { resolveDomain, resolveWorkspaceId } from '../shared/workspace.js';
import { passesUnresolvedFilters, UNR_SLOTS } from './brief-filter.js';

export interface BriefPayload {
  decisions: DecisionRow[];
  unresolved: UnresolvedRow[];
  counts: { decisions: number; decisionsRaw?: number; folded?: number; unresolved: number };
  recentFiles: RecentFileRow[];
  /** 🌍 全局经验（两道闸 + 预算后；没命中就是空数组，客户端应整段不渲染） */
  experiences: Array<{ text: string; scope: string; grade: string }>;
}

/** 纯取数（不碰 CLI / 不开库）——便于单测与组件复用 */
export function collectBrief(db: DB, projectId: string, opts: { limit?: number; days?: number; top?: number } = {}, root?: string): BriefPayload {
  const limit = opts.limit ?? 200;
  // 呈现层折叠（ADR-003 D3）：近重复只折叠"这一次显示"，存储一条不动 —— 简报里 5 个名额
  // 应该给 5 件不同的事，而不是同一件事说 3 遍。判据复用核心 isNearDuplicate（含长度比门，
  // 修掉生产前缀键误杀「采用 Vite 作为前端构建工具」那个 bug）。
  const rawDecisions = listDecisions(db, projectId, {}).slice(-limit).reverse();
  const { rows: decisions, folded } = foldNearDuplicates<DecisionRow>(rawDecisions, 0.8, lengthRatioGate);
  const cutoff = Date.now() - 14 * 86_400_000;
  // [1017 夜 U-A] 渲染侧过滤：以前这里**一条判据都没有**，于是 `srelay brief` 显示的内容
  // 与用户真正看到的简报（DSH/ZCode 两侧都过滤）不一致 —— 拿它核对"简报会说什么"会看错。
  // 判据与 DSH/ZCode 同源（见 cli/brief-filter.ts 的说明与 check-brief-filters §⑥ 的行为对拍）。
  const unresolved = listUnresolved(db, projectId, 100)
    .filter((r) => new Date(r.at).getTime() >= cutoff)
    .filter((r) => passesUnresolvedFilters(r.q))
    .slice(0, limit);
  const recentFiles = listRecentFiles(db, { days: opts.days ?? 7, top: opts.top ?? 3 });
  const experiences = collectExperiences(root ?? process.cwd(), opts);
  return { experiences, decisions, unresolved, recentFiles,
    counts: { decisions: decisions.length, decisionsRaw: rawDecisions.length, folded, unresolved: unresolved.length } };
}

export async function cmdBrief(opts: { limit?: number; days?: number; top?: number; json?: boolean }): Promise<void> {
  const root = requireRoot();
  const cfg = loadConfig(root);
  const db = openRelayDb(root);
  try {
    const pay = collectBrief(db, cfg.identity.project_id ?? root, opts, root);
    if (opts.json) { console.log(JSON.stringify(pay)); return; }
    console.log(`决策 ${pay.counts.decisions} 条 · 未决 ${pay.counts.unresolved} 条 · 最近在动 ${pay.recentFiles.length} 个`);
    for (const r of pay.recentFiles) console.log(pc.dim(`  🗂 ${r.file}（${r.sessions} 场）`));
    for (const d of pay.decisions.slice(0, 5)) console.log(`  ${pc.dim(d.at?.slice(0, 10) ?? '')} ${d.kind === 'negative' ? pc.red('✗') : pc.green('✓')} ${d.text.slice(0, 60)}`);
    for (const u of pay.unresolved.slice(0, UNR_SLOTS)) console.log(`  ${pc.yellow('◻')} ${u.q.slice(0, 60)}`);
  } finally {
    db.close();
  }
}

/** 经验段的取数：**没命中就返回空数组**，由调用方决定整段渲不渲染 */
function collectExperiences(root: string, opts: { top?: number; maxChars?: number }): Array<{ text: string; scope: string; grade: string }> {
  try {
    const db = openGlobal();
    try {
      // [1016 收口] 工作区/领域都和别的面走同一份解析（此前写死 process.cwd() ⇒
      // 在子目录里跑 brief 时，project 作用域的经验会静默消失；domain 更是从来没传过）。
      const rows = pickForInjection(db, {
        workspaceId: resolveWorkspaceId(root),
        domain: resolveDomain(root),
        top: opts.top ?? 3,
        maxChars: opts.maxChars ?? 200,
      });
      return rows.map((r: LessonRow) => ({ text: r.text, scope: r.scope, grade: r.grade }));
    } finally { db.close(); }
  } catch { return []; }   // 全局库还不存在/打不开 = 没有经验，不影响简报其他段
}