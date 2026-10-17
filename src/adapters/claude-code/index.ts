// Claude Code Adapter（统一接口版，改进方案 改动1）
// 存储：~/.claude/projects/<slug>/<sessionId>.jsonl
import fs from 'node:fs';
import path from 'node:path';
import { pathSlug } from '../../shared/paths.js';
import { readTailProbe, tailCompleteLines } from './tailer.js';
import type { SessionSourceAdapter, AdapterConfig, DiscoveredSession, ReadResult } from '../types.js';

export const SOURCE_ID = 'claude-code';

export function discover(projectRoot: string, baseDir: string): DiscoveredSession[] {
  const slugDir = path.join(baseDir, pathSlug(path.resolve(projectRoot)));
  if (!fs.existsSync(slugDir)) return [];
  const out: DiscoveredSession[] = [];
  for (const f of fs.readdirSync(slugDir)) {
    if (!f.endsWith('.jsonl')) continue;
    const fp = path.join(slugDir, f);
    try {
      const st = fs.statSync(fp);
      out.push({
        source: SOURCE_ID,
        sourceSessionId: f.replace(/\.jsonl$/, ''),
        sourceFile: fp,
        sizeBytes: st.size,
        mtimeMs: st.mtimeMs,
        updatedAt: new Date(st.mtimeMs).toISOString(),
      });
    } catch { /* 瞬态 */ }
  }
  return out;
}

export function parseLine(lineText: string, lineNo: number):
  | { kind: 'message'; role: 'user' | 'assistant'; content: string; seqNum: number; createdAt?: string }
  | { kind: 'skip' }
  | { kind: 'bad' } {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(lineText);
  } catch {
    return { kind: 'bad' };
  }
  if (o.isSidechain === true) return { kind: 'skip' };
  const t = o.type;
  if (t !== 'user' && t !== 'assistant') return { kind: 'skip' };
  if (o.attachment) return { kind: 'skip' };
  const content = extractText((o.message as { content?: unknown } | undefined)?.content);
  if (!content.trim()) return { kind: 'skip' };
  return {
    kind: 'message',
    role: t,
    content,
    seqNum: lineNo,
    createdAt: typeof o.timestamp === 'string' ? o.timestamp : undefined,
  };
}

function extractText(c: unknown): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .filter((b): b is { type: string; text?: string } => typeof b === 'object' && b !== null && (b as { type?: string }).type === 'text')
      .map((b) => b.text ?? '')
      .join('\n');
  }
  return '';
}

export async function readNew(ds: DiscoveredSession, cursor: unknown): Promise<ReadResult> {
  const cur = (cursor ?? {}) as { offset?: number; lines?: number; rewrites?: number; tailHash?: string | null };
  let offset = cur.offset ?? 0;
  let lines = cur.lines ?? 0;
  let rewrites = cur.rewrites ?? 0;
  // ── 原地重写检测（红队 P1#4）──
  //   detectRewrite 只认「变小」；源文件被整段重写且**变大**时它完全不触发 ⇒
  //   实测 367B→421B 重写后 new=0 conflicts=0，游标照推到 421，库内永远旧文本。
  //   这里加「已消费前缀尾部指纹」：append-only 时不变，被重写必然变。
  //   老游标没有 tailHash（这个字段是后加的）⇒ 跳过检查，保持向后兼容。
  if (offset > 0 && typeof cur.tailHash === 'string') {
    const probe = await readTailProbe(ds.sourceFile, offset);
    if (probe !== null && probe !== cur.tailHash) {
      offset = 0;
      lines = 0;
      rewrites += 1;
    }
  }
  const t = await tailCompleteLines(ds.sourceFile, offset, lines);
  const tailHash = await readTailProbe(ds.sourceFile, t.newOffset);
  const messages: ReadResult['messages'] = [];
  let bad = 0;
  for (const l of t.lines) {
    const r = parseLine(l.text, l.lineNo);
    if (r.kind === 'message') messages.push(r);
    else if (r.kind === 'bad') bad++;
  }
  return {
    messages,
    badLines: bad,
    cursor: { offset: t.newOffset, lines: t.consumedLineCount, rewrites, tailHash },
  };
}

// ── 统一接口导出（注册表用） ──
export const adapter: SessionSourceAdapter = {
  id: SOURCE_ID,
  displayName: 'Claude Code',
  discover(root, config) {
    return discover(root, config.projectsDir as string);
  },
  async readNew(ds, cursor, _config) {
    return readNew(ds, cursor);
  },
  watchRoots(_root, config) {
    return [config.projectsDir as string];
  },
  healthCheck(_root, config) {
    const dir = config.projectsDir as string;
    return fs.existsSync(dir) ? null : `目录不存在：${dir}（未安装 Claude Code 可忽略）`;
  },
};
