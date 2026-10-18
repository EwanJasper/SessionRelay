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
import { passesUnresolvedFilters, passesBriefFilters, UNR_SLOTS } from './brief-filter.js';

export interface BriefPayload {
  decisions: DecisionRow[];
  unresolved: UnresolvedRow[];
  counts: { decisions: number; decisionsRaw?: number; folded?: number; unresolved: number };
  recentFiles: RecentFileRow[];
  /**
   * 🌍 全局经验（**两道闸 + 预算**后；没命中就是空数组，客户端应整段不渲染）
   *
   * ⚠️ [1021 后端红队 N1] 这里原来写「两道闸」，而**实际只过了一道**：
   *   `pickForInjection` 的相关性闸需要 `query`，本仓调用时**没传**。
   *   实测后果（同一时刻同一库）：ZCode（走 CLI）注入 3 条、DSH（传了 lastUserMessage）注入 2 条，
   *   **两组内容零交集**，而两侧注释都声称已过两道闸。
   *
   * 语义上这不是错：ZCode 的钩子是 SessionStart，此刻**还没有用户输入**，没有 query 只能按分数取。
   * 错的是注释把「有条件」说成「无条件」。现在：① 注释改实话；
   * ② `collectBrief` 接受 `query`，让**有上下文**的调用方真能把闸 2 打开。
   */
  experiences: Array<{ text: string; scope: string; grade: string }>;
}

/** 纯取数（不碰 CLI / 不开库）——便于单测与组件复用 */
export function collectBrief(db: DB, projectId: string, opts: { limit?: number; days?: number; top?: number; query?: string } = {}, root?: string): BriefPayload {
  const limit = opts.limit ?? 200;
  // 呈现层折叠（ADR-003 D3）：近重复只折叠"这一次显示"，存储一条不动 —— 简报里 5 个名额
  // 应该给 5 件不同的事，而不是同一件事说 3 遍。判据复用核心 isNearDuplicate（含长度比门，
  // 修掉生产前缀键误杀「采用 Vite 作为前端构建工具」那个 bug）。
  // [1021 修一个我自己引入的崩溃] 这两个常量原来声明在**决策过滤之后**（原第 73 行），
  //   而决策那条 48h 过滤（第 60 行左右）要用 `cutoff` ⇒ **TDZ：ReferenceError: Cannot access 'cutoff' before initialization**。
  //   是 graph-recall 在跑真实 CLI 时炸出来的（`node --check`/编译器都不报，因为它是运行期 TDZ，不是语法错）。
  //   教训：`const` 的 TDZ 只在**执行到那一行之前**才炸，静态检查抓不到 —— 这类只能靠「真的跑一遍」。
  const BRIEF_FRESH_MS = 48 * 3600_000;
  const cutoff = Date.now() - BRIEF_FRESH_MS;
  const rawDecisions = listDecisions(db, projectId, {}).slice(-limit).reverse()
    // ── 1020 · P1：压缩卡片机制（压缩不掉召回）──
    //   L3 压缩写回后：原始条目带 `compressed_into: <卡片id>`，同时追加了一条卡片。
    //   **简报跳过带标记的**（否则同一件事显示两遍：一次原文一次卡片）；
    //   **检索路径绝不跳**（cli/search.ts 走的是 messages/decisions 全量，不经这里）
    //   ⇒ 简报变短，搜索一条不少。这正是 memcore 那套「结算卡片 + source_id 回读」的落地形式。
    .filter((d) => !(d as { compressed_into?: string }).compressed_into)
    // ── 1020 修三路分叉：CLI 简报此前**完全没过 passesBriefFilters** ──
    //   实测后果：`srelay brief` 把人话输出里 6 条中的 3~4 条垃圾全显示出来
    //   （「决定要不要另下 Launcher ← 问句，不是决策2. 决定已归档记忆 ← 碎片」这种串行污染），
    //   而 DSH / ZCode 两侧的简报是**过滤过的** ⇒ 用户拿 CLI 核对「简报会说什么」会看错。
    //   判据与两侧同源（`cli/brief-filter.ts`，check-brief-filters §⑥ 有行为对拍）。
    .filter((d) => passesBriefFilters(String((d as { text?: string }).text ?? '')))
    // [1021 红队 R4] 时间窗 + pin 豁免，与 DSH/ZCode 同规：
    //   · 48h 内的决策才进简报（简报说的是「最近在动什么」）
    //   · **pin 过的不受时间窗限制** —— 用户亲手置顶的东西不该被时间挤掉
    //     （这条与 DSH 曾经的 bug 同源：那边一度写成 `key === 'decisions' && pinned`，
    //      导致 30 天前 pin 的未决一边被砍一边留着。判据只许有一份。）
    .filter((d) => {
      const dd = d as { pinned?: boolean; at?: string };
      if (dd.pinned === true) return true;
      const t = Date.parse(String(dd.at ?? ''));
      return !Number.isFinite(t) || t >= cutoff;   // 时间不可解析时宁可保留（容错不静默丢）
    });
  const { rows: decisions, folded } = foldNearDuplicates<DecisionRow>(rawDecisions, 0.8, lengthRatioGate);
  // [1021 红队 R4 修复] **三路分叉**：这里原来是「决策无时间窗 + 未决 14 天」，
  //   而 DSH（plugins/dsh/index.js:81 `FRESH_MS = 48 * 3600_000`）与
  //   ZCode（integrations/zcode/brief-shared.mjs:25 同值）**两者都是 48 小时**。
  //   后果：拿 `srelay brief` 核对「简报会说什么」会看到**完全不同的内容**（177 条 vs 十几个）。
  //   本项目的判据铁律是「只许有一份」——这里对齐到 48h，与两侧同值。
  //   ⚠️ 若将来觉得未决问题该放长（未决是欠条，欠越久越该被看见），**要三处一起改**，不能只改这里。
  //   （声明已上移到本函数开头 —— 原来在这里会用时未定义，见上方注释）
  // [1017 夜 U-A] 渲染侧过滤：以前这里**一条判据都没有**，于是 `srelay brief` 显示的内容
  // 与用户真正看到的简报（DSH/ZCode 两侧都过滤）不一致 —— 拿它核对"简报会说什么"会看错。
  // 判据与 DSH/ZCode 同源（见 cli/brief-filter.ts 的说明与 check-brief-filters §⑥ 的行为对拍）。
  // [1021 红队 R12 修复] 原来是 `listUnresolved(db, projectId, 100)` **先截断再过滤**。
  //   问题：取证 100 条 → 按 14 天保质期滤掉一批 → 再按判据滤掉一批 → 最后才 slice(limit)。
  //   如果最新那 100 条里有大量过期/被过滤的，**名额就白白空了**，而库里明明还有够格的问题。
  //   修法：先多取（4× 上限），过滤完再截。取多了只是多读几行 JSON，代价远小于简报缺条目。
  //   不直接无上限取：库大时 listUnresolved 会把全部未决读进内存，那是另一个极端。
  const UNR_FETCH = Math.max(100, limit * 4);
  const unresolved = listUnresolved(db, projectId, UNR_FETCH)
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
    // ── [1021 修「面板说可注入 10 条，但 srelay brief 一条经验都不显示」] ──
    //   `collectExperiences()` 一直是**取到了的**（`--json` 里实测 3 条），
    //   但人话输出**从来没有渲染过这一段** —— 于是用户敲 `srelay brief` 看到的是「没有经验」，
    //   而面板同一时刻显示「可注入: 10 条」。两个面各说一套，最容易被判成「功能坏了」。
    //   这里补上：只在**真取到**时打印（空就不占行，别每天多一行「经验 0 条」的噪音）。
    if (pay.experiences.length > 0) {
      console.log(pc.dim('  经验 ' + pay.experiences.length + ' 条（会自动注入新对话）：'));
      for (const e of pay.experiences) console.log(pc.dim('  · ' + String(e.text).slice(0, 72)));
    }
  } finally {
    db.close();
  }
}

/** 经验段的取数：**没命中就返回空数组**，由调用方决定整段渲不渲染 */
function collectExperiences(root: string, opts: { top?: number; maxChars?: number; query?: string }): Array<{ text: string; scope: string; grade: string }> {
  try {
    const db = openGlobal();
    try {
      // [1016 收口] 工作区/领域都和别的面走同一份解析（此前写死 process.cwd() ⇒
      // 在子目录里跑 brief 时，project 作用域的经验会静默消失；domain 更是从来没传过）。
      const rows = pickForInjection(db, {
        workspaceId: resolveWorkspaceId(root),
        domain: resolveDomain(root),
        // [1021 红队 N1] 有 query 就传 —— 传了才会开「相关性闸」，与 DSH 侧走同一条路径。
        //   没有（SessionStart 场景）就保持 undefined：那时确实无从判断相关性，
        //   按分数取是唯一诚实的选择。**关键是这个区别现在在类型上看得见了**。
        query: opts.query && opts.query.trim() ? opts.query.trim() : undefined,
        top: opts.top ?? 3,
        maxChars: opts.maxChars ?? 200,
      });
      return rows.map((r: LessonRow) => ({ text: r.text, scope: r.scope, grade: r.grade }));
    } finally { db.close(); }
  } catch (e) {
    // [1021 红队 R11 修复] 原来是 `catch { return [] }` —— **全局库一坏，整段经验凭空消失且零留痕**。
    //   用户看到的是「没有经验」，无法区分「真没有」和「库坏了」。这是本项目最嫌恶的静默失效。
    //   修法：区分两种情形 ——
    //     · 库**不存在**（ENOENT）= 全新用户，真的没有经验 ⇒ 安静返回 []，这是正常状态；
    //     · 其它异常（权限/损坏/锁）⇒ 打到 stderr 一行，让人看得见，但仍返回 [] 不让简报整段崩。
    const code = String((e as { code?: string })?.code ?? '');
    const msg = String((e as Error)?.message ?? e);
    if (code !== 'ENOENT' && !/does not exist|no such table/i.test(msg)) {
      try { process.stderr.write('[brief] 经验段读取失败（简报其余部分不受影响）：' + msg.slice(0, 160) + '\n'); } catch { /* 连 stderr 都写不了就别管了 */ }
    }
    return [];
  }
}