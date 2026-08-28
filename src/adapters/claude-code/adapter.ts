// Claude Code Adapter（方针 §6.1 / 技术方案 §3.1，Phase 1 实现）
// 存储：~/.claude/projects/<路径slug>/<sessionId>.jsonl，每行一个事件
// 已按本机真实格式验证（Spike S5 交叉验证）：
//  - 目录 slug = 项目绝对路径的 [\\/:] → '-'（D:\a\b → D--a-b）
//  - 行：{type:'user'|'assistant', message:{content}, timestamp, isSidechain, attachment?, cwd, sessionId}
import fs from 'node:fs';
import path from 'node:path';
import { pathSlug } from '../../shared/paths.js';
import { tailCompleteLines } from './tailer.js';
import type { DiscoveredSession, ParseOutcome, ReadResult } from '../types.js';

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

export function parseLine(lineText: string, lineNo: number): ParseOutcome {
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
    seqNum: lineNo, // 确定性源序号 = 行号（§3.1 契约 1）
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
  const cur = (cursor ?? {}) as { offset?: number; lines?: number };
  const t = await tailCompleteLines(ds.sourceFile, cur.offset ?? 0, cur.lines ?? 0);
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
    cursor: { offset: t.newOffset, lines: t.consumedLineCount },
  };
}
