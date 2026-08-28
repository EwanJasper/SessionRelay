// Codex Adapter（统一接口）
// 存储：~/.codex/sessions/YYYY/MM/DD/*.jsonl（活跃）+ ~/.codex/archived_sessions/*.jsonl（归档）
// 项目归属：session_meta.cwd 显式路径（比 Claude Code 的 slug 推断更可靠）
// 角色：user / assistant 保留，developer 跳过（系统指令）
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { tailCompleteLines } from '../claude-code/tailer.js';
import type { SessionSourceAdapter, AdapterConfig, DiscoveredSession, ReadResult } from '../types.js';

export const SOURCE_ID = 'codex';

/** 获取 session_index.jsonl 的 thread_name 映射（会话标题） */
function loadSessionTitles(codexDir: string): Map<string, string> {
  const titles = new Map<string, string>();
  try {
    const idx = fs.readFileSync(path.join(codexDir, 'session_index.jsonl'), 'utf8');
    for (const line of idx.trim().split('\n')) {
      try {
        const j = JSON.parse(line) as { id: string; thread_name: string };
        if (j.id && j.thread_name) titles.set(j.id, j.thread_name);
      } catch { /* 坏行跳过 */ }
    }
  } catch { /* index 不存在 */ }
  return titles;
}

/** 递归找所有 .jsonl 会话文件（sessions/ + archived_sessions/） */
function findJsonlFiles(dir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  function walk(d: string) {
    for (const f of fs.readdirSync(d)) {
      const fp = path.join(d, f);
      const st = fs.statSync(fp);
      if (st.isDirectory()) walk(fp);
      else if (f.endsWith('.jsonl')) out.push(fp);
    }
  }
  walk(dir);
  return out;
}

/** 从文件名提取会话 ID（rollout-<date>-<uuid>.jsonl → uuid） */
function sessionIdFromFilename(filename: string): string {
  const m = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(filename);
  return m ? m[1] : filename.replace('.jsonl', '');
}

/** 读首行 session_meta 获取 cwd（首行可能很长，含 base_instructions） */
function readSessionMeta(filePath: string): { session_id?: string; cwd?: string; timestamp?: string } | null {
  try {
    // Codex 的 session_meta 行可含长 base_instructions（实测 45KB+），需大 buffer
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(256 * 1024); // 256KB 足够
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const text = buf.subarray(0, bytesRead).toString('utf8');
    const nlIdx = text.indexOf('\n');
    const firstLine = nlIdx === -1 ? text : text.slice(0, nlIdx);
    const j = JSON.parse(firstLine);
    if (j.type === 'session_meta') return j.payload;
    return null;
  } catch { return null; }
}

export function discover(projectRoot: string, codexDir: string): DiscoveredSession[] {
  const titles = loadSessionTitles(codexDir);
  const sessionsDir = path.join(codexDir, 'sessions');
  const archivedDir = path.join(codexDir, 'archived_sessions');
  const files = [...findJsonlFiles(sessionsDir), ...findJsonlFiles(archivedDir)];

  const root = path.resolve(projectRoot).toLowerCase();
  const out: DiscoveredSession[] = [];
  for (const fp of files) {
    const meta = readSessionMeta(fp);
    if (!meta?.cwd) continue;
    // 项目归属：cwd 匹配项目根（Windows 不区分大小写）
    if (path.resolve(meta.cwd).toLowerCase() !== root) continue;
    const sid = meta.session_id ?? sessionIdFromFilename(path.basename(fp));
    const st = fs.statSync(fp);
    out.push({
      source: SOURCE_ID,
      sourceSessionId: sid,
      sourceFile: fp,
      title: titles.get(sid) ?? null,
      createdAt: meta.timestamp ?? new Date(st.birthtime).toISOString(),
      updatedAt: new Date(st.mtimeMs).toISOString(),
      sizeBytes: st.size,
      mtimeMs: st.mtimeMs,
    });
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
  } catch { return { kind: 'bad' }; }

  if (o.type !== 'response_item') return { kind: 'skip' };
  const payload = o.payload as { type?: string; role?: string; content?: Array<{ type: string; text?: string }> } | undefined;
  if (!payload || payload.type !== 'message') return { kind: 'skip' };
  const role = payload.role;
  if (role !== 'user' && role !== 'assistant') return { kind: 'skip' }; // developer = 系统指令，跳过

  const content = (payload.content ?? [])
    .map((c) => c.text ?? '')
    .join('\n')
    .trim();
  if (!content) return { kind: 'skip' };

  return {
    kind: 'message',
    role,
    content,
    seqNum: lineNo,
    createdAt: typeof o.timestamp === 'string' ? o.timestamp : undefined,
  };
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

// ── 统一接口导出 ──
export const adapter: SessionSourceAdapter = {
  id: SOURCE_ID,
  displayName: 'Codex',
  discover(root, config) {
    return discover(root, config.codexDir as string);
  },
  async readNew(ds, cursor, _config) {
    return readNew(ds, cursor);
  },
  watchRoots(_root, config) {
    const codexDir = config.codexDir as string;
    const dirs: string[] = [];
    const sess = path.join(codexDir, 'sessions');
    const arch = path.join(codexDir, 'archived_sessions');
    if (fs.existsSync(sess)) dirs.push(sess);
    if (fs.existsSync(arch)) dirs.push(arch);
    return dirs;
  },
  healthCheck(_root, config) {
    const codexDir = config.codexDir as string;
    return fs.existsSync(codexDir) ? null : `目录不存在：${codexDir}（未安装 Codex 可忽略）`;
  },
};
