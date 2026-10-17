// 全局经验段（DSH 插件侧）—— **只做渲染与降级，判据一律来自核心库**。
//
// [1016 收口 · 红队 A-5/B-7] 这里原先有两样"自产"的东西：
//   ① 一段自己写的可见性 SQL（只有 global + project，**缺 domain 分支**）⇒ `--scope domain`
//      的经验在 DSH 侧永远不出现，而且没有任何报错；
//   ② 一套"中文 2 字滑窗 + 任一 bigram 命中即算相关"的打分 ⇒ "我写/么样"这种偶然重合
//      会把无关经验判成相关（实测写诗题注入了不相干内容）。
// 现在：可见性、闸 1（状态/定级/阈值）、闸 2（相关性）、预算，**全部调 recall.js 里的同一份实现**
// （核心库 store/global.ts 的 pickForInjection / visibleWhere / gate2Score）。
//
// 加载：模块顶层 await import 一次；拿不到就没有经验段（见下面的降级说明）。
// 三条降级纪律：
//   · recall.js 拿不到 ⇒ 整段不出现。**不退回"按重要度硬塞"** —— 那等于悄悄换一套判据，
//     而"看起来在工作、其实用的是另一套规则"正是本项目的第一号故障模式。插件自带 vendor
//     里有 recall.js，守门 J 段（依赖闭包）与 selftest 都会抓它的缺席。
//   · 有本轮输入、但没有任何经验与它**具体**相关 ⇒ 整段不出现（不硬塞）。
//   · 冷路径（prompt 组装同步路径）用 { noQuery: true }：不解码会话、不加载分词器，
//     只按重要度给最重要的几条 —— 这正是设计里"没有查询时"的既定行为，且毫秒级、不阻塞组装。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
let DatabaseSync = null;
try { ({ DatabaseSync } = require_('node:sqlite')); } catch { DatabaseSync = null; }

let recall = null;
try { recall = await import('../vendor/dist/recall.js'); } catch { recall = null; }
export const __recallAvailable = !!recall;

/**
 * 把"这些经验真的进了 prompt"记到 uses 上（1021 新增）。
 *
 * 为什么必须记：`liveImportance = importance − 年龄天数×0.0083 + log1p(uses)×1.5 + min(1,hits×0.1)`
 * 里那两项此前**全仓零写入点** —— 意味着「一条被反复用到的经验，分数也不会涨」，
 * 只会按年龄一路衰减到退休（阈值 5.5）。好经验留不住、坏经验不掉队，衰减机制等于空转。
 *
 * 口径很要紧（别放宽）：
 *   · 只在**真的渲染进 prompt 之后**加，不是"被检索到"就加 ——
 *     调试式检索会把它刷过注入线（红队 A-6 否决 hits 的正是这个理由）。
 *   · 有上限（USES_CAP）：防止一条经验靠次数堆分霸榜。3 条/轮 × 很多轮，不封顶迟早失控。
 *   · 写失败**不许影响主流程**：注入是主路，计数是旁路；出错就静默跳过（下轮再记）。
 *
 * 为什么用 node:sqlite 而不是内核的 better-sqlite3：本模块刻意零原生依赖
 * （DSH 宿主里没有那 27MB 原生模块），读和写都走内置的 node:sqlite。
 */
const USES_CAP = 50;

function recordLessonUse(file, ids) {
  if (!DatabaseSync || !Array.isArray(ids) || !ids.length) return;
  let w = null;
  try {
    w = new DatabaseSync(file);
    const stmt = w.prepare('UPDATE lessons SET uses = MIN(uses + 1, ?), updated_at = ? WHERE id = ?');
    const now = new Date().toISOString();
    for (const id of ids) stmt.run(USES_CAP, now, Number(id));
  } catch { /* 计数是旁路，失败不影响注入 */ }
  finally { try { w?.close(); } catch { /* 已关闭 */ } }
}

/** 同步取经验段；库不存在 / 没命中 / 引擎缺席 → 空串（整段不渲染） */
export function experiencesLine(root, opts = {}) {
  if (!DatabaseSync || !recall) return '';
  const home = process.env.SRELAY_GLOBAL_HOME || path.join(os.homedir(), '.sessionrelay');
  const f = path.join(home, 'global.sqlite');
  try { if (!fs.existsSync(f)) return ''; } catch { return ''; }
  const ws = String(root || '');
  let db = null;
  try {
    db = new DatabaseSync(f, { readOnly: true });
    // 本轮用户输入：默认自己去取（recall.js 的逐帧解码），冷路径显式 noQuery 跳过
    let q = String(opts.query ?? '');
    if (!q && !opts.noQuery) { try { q = recall.lastUserMessage(ws) || ''; } catch { q = ''; } }
    q = q.trim();
    const rows = recall.pickForInjection(db, {
      workspaceId: recall.resolveWorkspaceId(ws),
      domain: recall.resolveDomain(ws),
      query: q || undefined,
      top: opts.top ?? 3,
      maxChars: opts.maxChars ?? 200,
    });
    if (!rows.length) return '';
    const body = rows.map((r) => String(r.text || '')).filter(Boolean).join('；');
    if (!body) return '';
    // ⚠️ 顺序：先确认**确实**渲染出去了，再记 uses。不在这里提前记。
    recordLessonUse(f, rows.map((r) => r.id));
    return '🌍 经验：' + body + String.fromCharCode(10);
  } catch { return ''; } finally { try { db?.close(); } catch { /* 已关闭 */ } }
}
