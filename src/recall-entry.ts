// recall.js —— 给「适配器」用的可导入小包（DSH 插件 / ZCode hook 直接 import，不用起子进程）。
//
// 为什么要有它：插件与 hook 都是**别的进程/别的语言环境**，拿不到核心库的 TS 源码。
// 之前两边各自实现了一套"关键词打分"，于是**核心库刚验证出来的排序改进，它们吃不到** ——
// 一个系统里有几套排序，慢的那几套就会把快的那套的努力抵消掉。
// 这里把两件事做成**唯一实现**：
//   1) lastUserMessage(root)：DSH 会话文件的**逐帧解码**取最后一条用户消息（每轮召回的输入）；
//   2) recall(root, { query, limit })：项目决策 + 全局经验的统一召回（两道闸 + 长度归一）。
export { decodeSessionFile, dshSessionSlug } from './adapters/dsh/format.js';
export { searchSessions } from './search-svc/engine.js';
// [1016 红队 A-5 收敛] 可见性 / 闸 2 / 工作区解析都只有**一份实现**，适配器直接 import 这里的。
// 病历：三个面各抄一份 SQL 与关键词打分 ⇒ 抄完就漂移（插件缺 domain、hook 缺 workspace、
// hook 的中文 2 字滑窗把"我写"这种偶然重合判成相关）。适配器凡是"要不要注入"的判断，
// 都必须走这几个导出，不准自己再写一套。
export {
  openGlobal, pickForInjection, gate2Score, gate2Tokens,
  INJECT_THRESHOLD, liveImportance, isInjectable,
  // [1021] 经验查询也走入口导出：MCP 的 srelay_lessons 与 CLI 共用同一份可见性判据。
  //   不外泄 ⇒ 调用方只能自己拼 SQL ⇒ 那就是第二份判据（铁律禁止）。
  listLessons, searchLessons,
  // [1021] 维护也要从入口走：CLI 的 lesson maintain 与生命周期必须用**同一份**衰减/退休判据。
  maintainLessons,
} from './store/global.js';
export { resolveDomain, resolveWorkspaceId, workspaceKey } from './shared/workspace.js';
export { findRelayRootInfo, findRelayRoot, inferProjectRoot, isUnclaimableAncestor } from './shared/paths.js';
// [红队第二轮 P2] 守门脚本要判「整套记忆有没有在进」，需要**项目候选列表**。
//   读不到就只能自己拼 ~/.sessionrelay-registry 路径 —— 那就是第二份判据（本仓铁律禁止）。
//   从入口导出，让 check-versions 与内核用同一份。
export { isTransientRoot, registryCandidates } from './shared/registry.js';
export { globalDbFile } from './store/global.js';
// [B3] 一次性探针会话的判据（SQL 片段）—— 适配器/守门要能拿到**同一份口径**，别各写一套
export { PROBE_SQL, PROBE_MAX_MESSAGES, countProbeSessions } from './store/db.js';
// [B4] harness 记账 token 判据（topics 清洗用；工具与核心库共用同一份词表）
export { isSystemToken, isLikelyFile, isTopicNoise } from './core/extract/extract.js';
// 冲突消解（新话压旧话）：判据与执行都只在核心库这一份
export { findSupersedeConflicts, subjectTokens, hasNegation } from './store/global.js';
// 压缩 L1：确定性去重合并（判据唯一一份，工具与 CLI 都从这里取）
export { compactItems, isNearDuplicate } from './core/compact/dedup.js';
// 呈现层折叠：适配器/插件要折叠显示也必须调这一份（不许自己抄一套判据）
export { foldNearDuplicates, lengthRatioGate } from './core/compact/fold.js';
// 老化压缩计划（只做计划；执行复用 capture/archive.ts 的 runArchive）
export { planAging } from './core/compact/aging.js';

// [1017 夜 U-A] 未决段的**渲染侧**过滤判据：核心 CLI 用它，工作区仓的 DSH 插件 / ZCode hook
// 目前用的是同判据副本（不同仓库无法共用模块）。两边由 tools/check-brief-filters.mjs §⑥ 做
// **行为对拍**（同一批样本判决必须完全一致）。终态是那两处也 import 这里 —— 见交接的后续任务。
export { passesUnresolvedFilters, unresolvedContentChars, UNRESOLVED_CONTENT_MIN, UNR_SLOTS } from './cli/brief-filter.js';
// [1017 夜 09:3x] 七条规范过滤器作**独立第三方参照**导出。
//   本库渲染路径**不调用**它们（核心 CLI 不用这套判据），
//   导出的唯一目的是让守门能做三方对拍 —— 在此之前两份客户端副本「同改」无人能发现。
//   是否接入本库渲染是架构决策，见 docs/1018-七条规范过滤器-无第三方-结构原因.md。
export { passesBriefFilters, BRIEF_CANONICAL_FILTERS, BRIEF_TEXT_MAX } from './cli/brief-filter.js';

// ── 生命周期内核 API（ADR-002：宿主 hooks/workers 与 CLI 读同一份实现）──
export { runLifecycle, lifecycleStatus } from './core/lifecycle/runner.js';
export { integrityOf, repairProject } from './core/lifecycle/repair.js';
export { STAGES, lightStages, ensureLifecycleTables, loadLifecycle, saveLifecycle, dueStages, setHeartbeat, heartbeatAgeMs } from './core/lifecycle/stages.js';
export { compactExactSessions } from './core/compact/exact.js';
// [1021] L1b 跨会话近重复合并（写回 + 审计 + 回滚）。与 L0 并列导出 ——
// 两者都是"确定性、零模型"的压缩层，调用方按层选。
export { compactNearDuplicates, rollbackNearDuplicates } from './core/compact/near-dup.js';
// [1021] 经验采集也进内核：生命周期要跑它，CLI 只是薄壳（铁律：判据只有一份）
export { harvestCandidates, harvestLessons } from './core/extract/lesson-harvest.js';
export type { Harvested, HarvestReport, HarvestOptions } from './core/extract/lesson-harvest.js';
export type { NearDupReport, NearDupOptions, NearDupSample } from './core/compact/near-dup.js';
export { cleanDerivedColumns } from './core/extract/derived-cleanup.js';
// [B4] 清 topics 时 meta_text 必须**按原规重算**（title+topics 的索引文本）；
// 导出核心库这两个函数，工具才不会自己拼一份（拼错=把搜索面写坏）。
export { metaTextOf, searchTextOf, recomputeSessionMetaText, openExisting, createDb } from './store/db.js';

// ── 采集：宿主事件钩子（DSH hooks）在**宿主进程内**做单项目增量采集 ──
// [1021 审查 #17] 钩子（integrations/dsh/src/hooks.mjs）一直在等这两个导出，而本仓库只导出
// runLifecycle ⇒ 事件驱动即时采集恒报「内核缺 loadConfig / runSync」，且那条日志只在
// SRELAY_BRIEF_DEBUG=1 时才可见（=坏了没人知道；主路径 srelay watch 正常，所以表现是
// "偶尔慢半拍"而不是"完全没采集"，更难发现）。
// 契约在这里显式化：配置加载与增量采集都只有核心库这一份实现，钩子不自抄（铁律 1/2）。
export { loadConfig } from './shared/config.js';
export { runSync } from './capture/sync.js';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decodeSessionFile, dshSessionSlug } from './adapters/dsh/format.js';

interface CacheEntry { mtimeMs: number; size: number; text: string }
const tailCache = new Map<string, CacheEntry>();

/**
 * 取「本轮用户输入」：DSH 把会话实时写进
 *   ~/.dsh/sessions/<slug>/session-<uuid>/session.v4.jsonl.zstd
 * 这是**多帧** zstd，node 自带的 zstdDecompressSync 只解得出头帧（实测：12959KB 的文件只出 1 行），
 * 所以必须用核心库的逐帧解码器。
 * 按 (mtime,size) 缓存：同一轮里被问多次只解一次。
 */
export function lastUserMessage(root: string, opts: { maxAgeMs?: number } = {}): string {
  try {
    const dir = path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'sessions', dshSessionSlug(path.resolve(root)));
    if (!fs.existsSync(dir)) return '';
    let best: { file: string; mtimeMs: number; size: number } | null = null;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory() || !e.name.startsWith('session-')) continue;
      const sd = path.join(dir, e.name);
      for (const f of fs.readdirSync(sd)) {
        if (!f.endsWith('.jsonl.zstd')) continue;
        const fp = path.join(sd, f);
        const st = fs.statSync(fp);
        if (!best || st.mtimeMs > best.mtimeMs) best = { file: fp, mtimeMs: st.mtimeMs, size: st.size };
      }
    }
    if (!best) return '';
    // 太旧就不当"本轮"（别的项目/别的会话也可能落在这个 slug 下）
    const maxAge = opts.maxAgeMs ?? 10 * 60 * 1000;
    if (Date.now() - best.mtimeMs > maxAge) return '';
    const c = tailCache.get(best.file);
    if (c && c.mtimeMs === best.mtimeMs && c.size === best.size) return c.text;
    const walk = decodeSessionFile(best.file);
    let text = '';
    for (const line of walk.lines) {
      let o: { type?: string; data?: { source?: { kind?: string }; content?: unknown } };
      try { o = JSON.parse(line); } catch { continue; }
      if (o.type !== 'user/message') continue;
      const kind = o.data?.source?.kind;
      if (typeof kind === 'string' && kind !== 'user') continue;   // 注入内容不算"用户说的"
      const parts = o.data?.content;
      if (!Array.isArray(parts)) continue;
      const t = parts
        .filter((b: { type?: string; text?: string }) => b && typeof b === 'object' && b.type === 'text')
        .map((b: { text?: string }) => b.text ?? '')
        .join('\n')
        .trim();
      if (t) text = t;
    }
    tailCache.set(best.file, { mtimeMs: best.mtimeMs, size: best.size, text });
    return text;
  } catch { return ''; }
}
