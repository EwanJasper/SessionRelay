// Qoder Adapter（完整适配：明文 JSONL，user/assistant 均可读）
// 存储：~/.qoder-cn/cache/projects/<folderName>-<hash>/conversation-history/<taskId>/<taskId>.jsonl
// 项目映射：cache/projects 目录名的 folderName 部分匹配项目根的 basename
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { tailCompleteLines } from '../claude-code/tailer.js';
import type { SessionSourceAdapter, AdapterConfig, DiscoveredSession, ReadResult } from '../types.js';

export const SOURCE_ID = 'qoder';

function qoderCacheDir(config: AdapterConfig): string {
  return config.qoderDir as string ?? path.join(os.homedir(), '.qoder-cn');
}

// 项目映射（#03）：cache/projects 目录名是 <folderName>-<hash>。
//
// 病历（外部审查 #03，可复现）：之前只比 folderName、**忽略 hash** ⇒
//   `company-a/app` 与 `company-b/app` 两个项目都叫 app，两个项目都会认领同两个缓存目录，
//   会话被收进对方的库。目录名撑不起项目级隔离的承诺 —— 同名是常态（app/server/web）。
//
// 修法（不靠猜 hash 算法）：
//   ① 先收集**所有**同名候选（原实现遍历时遇到一个扫一个，等于全都要）；
//   ② 候选只有 1 个 → 照旧用（兼容现状：绝大多数人只有一个同名项目）；
//   ③ 候选 ≥2 → 试「绝对路径的常见摘要」（md5/sha1/sha256 × 多种规范化 × 8/12/16 位），
//      必须**唯一命中**才用；命中不到或有多个 → **拒绝自动认领并报出来**。
//   为什么用「猜摘要」而不是硬拒：摘要是**可验证**的 —— 猜错只会不命中（安全方向），
//   不会选错。而「按名字硬选」是先选错、再也没人发现得了。两者风险不对称。

function hashForms(abs: string): Set<string> {
  const forms = [abs, abs.toLowerCase(), abs.replace(/\\/g, '/'), abs.replace(/\\/g, '/').toLowerCase()];
  const out = new Set<string>();
  for (const form of forms) {
    for (const alg of ['md5', 'sha1', 'sha256'] as const) {
      const h = createHash(alg).update(form).digest('hex');
      for (const n of [8, 12, 16]) out.add(h.slice(0, n));
    }
  }
  return out;
}

interface CacheGuess {
  dirs: string[];
  /** 有歧义时的候选（非空 ⇒ 调用方必须拒绝认领并报出来） */
  ambiguous: string[];
}

/** 项目根 → 缓存目录。歧义时 dirs 为空，候选原样带出。 */
function cacheDirsFor(cacheDir: string, projectRoot: string): CacheGuess {
  const abs = path.resolve(projectRoot);
  const base = path.basename(abs).toLowerCase();
  let entries: string[] = [];
  try { entries = fs.readdirSync(cacheDir); } catch { return { dirs: [], ambiguous: [] }; }
  const sameName: Array<{ dir: string; hash: string }> = [];
  for (const d of entries) {
    const p = path.join(cacheDir, d);
    try { if (!fs.statSync(p).isDirectory()) continue; } catch { continue; }
    const m = /^(.+)-([0-9a-f]{8,})$/i.exec(d);
    if (!m) continue;
    if (m[1].toLowerCase() !== base) continue;
    sameName.push({ dir: p, hash: m[2].toLowerCase() });
  }
  if (sameName.length <= 1) return { dirs: sameName.map((x) => x.dir), ambiguous: [] };
  const forms = hashForms(abs);
  const exact = sameName.filter((x) => forms.has(x.hash));
  if (exact.length === 1) return { dirs: [exact[0].dir], ambiguous: [] };
  return { dirs: [], ambiguous: sameName.map((x) => x.dir) };
}

/** 列出项目下所有 conversation-history JSONL */
export function discover(projectRoot: string, qoderDir: string): DiscoveredSession[] {
  const cacheDir = path.join(qoderDir, 'cache', 'projects');
  if (!fs.existsSync(cacheDir)) return [];

  const guess = cacheDirsFor(cacheDir, projectRoot);
  const out: DiscoveredSession[] = [];
  if (guess.ambiguous.length > 0) {
    // 容错不许静默：不认领就必须说出来，否则用户看到「没收录」却不知道是被拒绝了。
    console.error(
      '[srelay] qoder 发现 ' + String(guess.ambiguous.length) + ' 个同名缓存目录，无法确定哪个属于 ' + path.resolve(projectRoot)
      + '，已拒绝自动认领（避免把别的项目会话收进来）：' + guess.ambiguous.map((x) => path.basename(x)).join(', '),
    );
    return [];
  }

  for (const dirPath of guess.dirs) {
    const histDir = path.join(dirPath, 'conversation-history');
    if (!fs.existsSync(histDir)) continue;

    for (const taskDir of fs.readdirSync(histDir)) {
      const taskPath = path.join(histDir, taskDir);
      if (!fs.statSync(taskPath).isDirectory()) continue;
      const jsonlPath = path.join(taskPath, `${taskDir}.jsonl`);
      if (!fs.existsSync(jsonlPath)) continue;

      const st = fs.statSync(jsonlPath);
      const lineCount = fs.readFileSync(jsonlPath, 'utf8').trim().split('\n').length;
      if (lineCount < 2) continue; // 空会话跳过

      out.push({
        source: SOURCE_ID,
        sourceSessionId: taskDir,
        sourceFile: jsonlPath,
        title: `Qoder 对话（${taskDir}）`,
        createdAt: new Date(st.birthtime).toISOString(),
        updatedAt: new Date(st.mtime).toISOString(),
        sizeBytes: st.size,
        mtimeMs: st.mtimeMs,
      });
    }
  }
  return out;
}

/** 从用户消息中剥离系统标签，提取真实用户输入 */
function stripSystemTags(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<user_query>/g, '')
    .replace(/<\/user_query>/g, '')
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/g, '')
    .trim();
}

export function parseLine(lineText: string, lineNo: number):
  | { kind: 'message'; role: 'user' | 'assistant'; content: string; seqNum: number }
  | { kind: 'skip' }
  | { kind: 'bad' } {
  let o: { role?: string; message?: { content?: Array<{ type?: string; text?: string }> } };
  try {
    o = JSON.parse(lineText);
  } catch { return { kind: 'bad' }; }

  const role = o.role;
  if (role !== 'user' && role !== 'assistant') return { kind: 'skip' };

  const content = (o.message?.content ?? [])
    .map((c) => c.text ?? '')
    .join('\n')
    .trim();
  if (!content) return { kind: 'skip' };

  // 用户消息剥离系统标签
  const cleaned = role === 'user' ? stripSystemTags(content) : content;
  if (!cleaned || cleaned.length < 2) return { kind: 'skip' };

  return { kind: 'message', role, content: cleaned, seqNum: lineNo };
}

export async function readNew(ds: DiscoveredSession, cursor: unknown): Promise<ReadResult> {
  const cur = (cursor ?? {}) as { offset?: number; lines?: number };
  const t = await tailCompleteLines(ds.sourceFile, cur.offset ?? 0, cur.lines ?? 0);
  const messages: ReadResult['messages'] = [];
  let bad = 0;
  for (const l of t.lines) {
    const r = parseLine(l.text, l.lineNo);
    if (r.kind === 'message') messages.push(r);
    else if (r.kind === 'bad') bad++;
  }
  return { messages, badLines: bad, cursor: { offset: t.newOffset, lines: t.consumedLineCount } };
}

export const adapter: SessionSourceAdapter = {
  id: SOURCE_ID,
  displayName: 'Qoder',
  discover(root, config) {
    return discover(root, qoderCacheDir(config));
  },
  async readNew(ds, cursor, _config) {
    return readNew(ds, cursor);
  },
  watchRoots(_root, config) {
    const cacheDir = path.join(qoderCacheDir(config), 'cache', 'projects');
    return fs.existsSync(cacheDir) ? [cacheDir] : [];
  },
  healthCheck(_root, config) {
    const dir = qoderCacheDir(config);
    return fs.existsSync(dir) ? null : `目录不存在：${dir}（未安装 Qoder 可忽略）`;
  },
};
