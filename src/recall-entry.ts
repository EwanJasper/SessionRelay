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
} from './store/global.js';
export { resolveDomain, resolveWorkspaceId, workspaceKey } from './shared/workspace.js';
export { findRelayRootInfo, findRelayRoot, inferProjectRoot, isUnclaimableAncestor } from './shared/paths.js';
export { isTransientRoot } from './shared/registry.js';
export { globalDbFile } from './store/global.js';
// [B3] 一次性探针会话的判据（SQL 片段）—— 适配器/守门要能拿到**同一份口径**，别各写一套
export { PROBE_SQL, PROBE_MAX_MESSAGES, countProbeSessions } from './store/db.js';
// [B4] harness 记账 token 判据（topics 清洗用；工具与核心库共用同一份词表）
export { isSystemToken } from './core/extract/extract.js';
// [B4] 清 topics 时 meta_text 必须**按原规重算**（title+topics 的索引文本）；
// 导出核心库这两个函数，工具才不会自己拼一份（拼错=把搜索面写坏）。
export { metaTextOf, searchTextOf } from './store/db.js';

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
