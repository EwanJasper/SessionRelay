// Codex Adapter（统一接口）
// 存储：~/.codex/sessions/YYYY/MM/DD/*.jsonl（活跃）+ ~/.codex/archived_sessions/*.jsonl（归档）
// 项目归属：session_meta.cwd 显式路径（比 Claude Code 的 slug 推断更可靠）
// 角色：user / assistant 保留，developer 跳过（系统指令）
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tailCompleteLines } from '../claude-code/tailer.js';
import type { SessionSourceAdapter, AdapterConfig, DiscoveredSession, ReadResult } from '../types.js';

/** 前缀连续性检查窗口（字节）。256B 足以区分任何真实重写，又是 O(1) 读 */
const TAIL_PROBE_BYTES = 256;

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

/**
 * 已消费前缀的"尾部指纹"：offset 前最后 TAIL_PROBE_BYTES 个字节的 sha1（O(256B)/次）。
 *
 * [1021 · 适配器附加检查] 回答"文件被重写/截断时 offset 会不会漏读/错读"：
 *   · **截断（长度变短）**：已由共享 tailer 的 `detectRewrite(size < offset)` 兜住
 *     （claude-code/codex/qoder 共用；探针实测：截断后 readNew 从头重读，offset 归位）。
 *   · **原地重写（内容变了但长度 ≥ offset）**：tailer 只认"变小"，看不出来；于是 offset
 *     停在新文件中间，**重写后的前半段永远读不到**，而且没有任何告警。
 *     实测（假数据）：4 行 → 重写成 5 行再追加 1 行，readNew 只吐出「重写乙/丙/丁/新追加」，
 *     「重写甲」永久丢失。
 *   · 为什么不用"offset-1 必须是 '\n'"那种边界检查：实测它会**巧合命中** ——
 *     重写后各行长度相近，offset 恰好落在新文件的行边界上，照样漏读。
 *     改用"前缀尾部 256B 指纹"：append-only 时这段字节不变；被重写则必然变。
 *   ⚠️ 这是**前缀连续性**检查，不是 detectRewrite 的第二份实现（大小比较仍只有 tailer 那一份）。
 *     它目前只装在 Codex 这条线上；claude-code/qoder 有同样风险，正确归宿是搬进 tailer.ts
 *     （三个适配器共用）——那不在本次写权限内，已在交付说明里登记。
 */
async function readTailProbe(filePath: string, offset: number): Promise<string | null> {
  if (offset <= 0) return '';
  const start = Math.max(0, offset - TAIL_PROBE_BYTES);
  const len = offset - start;
  const fh = await open(filePath, 'r');
  try {
    const b = Buffer.alloc(len);
    const { bytesRead } = await fh.read(b, 0, len, start);
    if (bytesRead < len) return null;   // 文件比 offset 还短 = 被截断（那条判据归 tailer）
    return createHash('sha1').update(b.subarray(0, bytesRead)).digest('hex').slice(0, 16);
  } finally {
    await fh.close();
  }
}
export async function readNew(ds: DiscoveredSession, cursor: unknown): Promise<ReadResult> {
  const cur = (cursor ?? {}) as { offset?: number; lines?: number; rewrites?: number; tailHash?: string | null };
  let offset = cur.offset ?? 0;
  let consumed = cur.lines ?? 0;
  let rewrites = cur.rewrites ?? 0;
  // 原地重写检测（见 readTailProbe 注释）：已消费前缀的尾部指纹变了 ⇒ 整文件重读、行号归零
  // （seqNum = 行号，重写后必须重排）。留痕：rewrites 计数写进游标，source_files.cursor 里看得见。
  if (offset > 0 && typeof cur.tailHash === 'string') {
    const nowProbe = await readTailProbe(ds.sourceFile, offset);
    if (nowProbe !== null && nowProbe !== cur.tailHash) {
      offset = 0;
      consumed = 0;
      rewrites += 1;
    }
  }
  const t = await tailCompleteLines(ds.sourceFile, offset, consumed);
  const tailHash = await readTailProbe(ds.sourceFile, t.newOffset);
  const messages: ReadResult['messages'] = [];
  let bad = 0;
  for (const l of t.lines) {
    const r = parseLine(l.text, l.lineNo);
    if (r.kind === 'message') messages.push(r);
    else if (r.kind === 'bad') bad++;
  }
  return { messages, badLines: bad, cursor: { offset: t.newOffset, lines: t.consumedLineCount, rewrites, tailHash } };
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
