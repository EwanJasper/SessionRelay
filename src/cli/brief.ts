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
import type { DB, DecisionRow, UnresolvedRow, RecentFileRow } from '../store/db.js';
import { requireRoot, openRelayDb, pc } from './ui.js';

export interface BriefPayload {
  decisions: DecisionRow[];
  unresolved: UnresolvedRow[];
  counts: { decisions: number; unresolved: number };
  recentFiles: RecentFileRow[];
}

/** 纯取数（不碰 CLI / 不开库）——便于单测与组件复用 */
export function collectBrief(db: DB, projectId: string, opts: { limit?: number; days?: number; top?: number } = {}): BriefPayload {
  const limit = opts.limit ?? 200;
  const decisions = listDecisions(db, projectId, {}).slice(-limit).reverse();
  const cutoff = Date.now() - 14 * 86_400_000;
  const unresolved = listUnresolved(db, projectId, 100)
    .filter((r) => new Date(r.at).getTime() >= cutoff)
    .slice(0, limit);
  const recentFiles = listRecentFiles(db, { days: opts.days ?? 7, top: opts.top ?? 3 });
  return { decisions, unresolved, counts: { decisions: decisions.length, unresolved: unresolved.length }, recentFiles };
}

export async function cmdBrief(opts: { limit?: number; days?: number; top?: number; json?: boolean }): Promise<void> {
  const root = requireRoot();
  const cfg = loadConfig(root);
  const db = openRelayDb(root);
  try {
    const pay = collectBrief(db, cfg.identity.project_id ?? root, opts);
    if (opts.json) { console.log(JSON.stringify(pay)); return; }
    console.log(`决策 ${pay.counts.decisions} 条 · 未决 ${pay.counts.unresolved} 条 · 最近在动 ${pay.recentFiles.length} 个`);
    for (const r of pay.recentFiles) console.log(pc.dim(`  🗂 ${r.file}（${r.sessions} 场）`));
    for (const d of pay.decisions.slice(0, 5)) console.log(`  ${pc.dim(d.at?.slice(0, 10) ?? '')} ${d.kind === 'negative' ? pc.red('✗') : pc.green('✓')} ${d.text.slice(0, 60)}`);
    for (const u of pay.unresolved.slice(0, 3)) console.log(`  ${pc.yellow('◻')} ${u.q.slice(0, 60)}`);
  } finally {
    db.close();
  }
}
