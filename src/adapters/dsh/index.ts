// DSH Adapter（DeepSeek Harness 会话源，[fork 1011]）
// 存储：~/.dsh/sessions/<路径slug>/session-<uuid>/session.v4.jsonl.zstd
// 容器：zstd 多帧流 + 逐帧 NDJSON（format.ts）；格式逆向与实测依据见 docs/design-dsh-adapter.md
// 归属：slug 目录即项目归属（DSH 自己按 cwd 分组）；会话头 cwd 为权威校验字段
// 零侵入：只读 DSH 文件，不写任何东西；DSH 更新断了 = 修本目录，不动其本体
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { dshSessionSlug, decodeSessionFile, frameOffsets, hasNativeZstd, type FrameWalkResult } from './format.js';
import type { SessionSourceAdapter, AdapterConfig, DiscoveredSession, ReadResult } from '../types.js';

export const SOURCE_ID = 'dsh';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

export function defaultSessionsDir(): string {
  return path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'sessions');
}

interface DshHeader {
  type: string;
  version: number;
  id: string;
  createdAt?: number;
  cwd?: string;
  delegationDepth?: number;
  isSeeded?: boolean;
}

/** 头帧缓存：discover 每周期扫全组，头部 (mtime,size) 未变的文件零解压（zcode discoverCache 同范式） */
const headerCache = new Map<string, { mtimeMs: number; size: number; header: DshHeader | null }>();

function readHeaderCached(fp: string, st: fs.Stats): DshHeader | null {
  const hit = headerCache.get(fp);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.header;
  let header: DshHeader | null = null;
  try {
    const fh = fs.openSync(fp, 'r');
    const buf = Buffer.alloc(Math.min(65536, st.size));
    fs.readSync(fh, buf, 0, buf.length, 0);
    fs.closeSync(fh);
    const first = buf.indexOf(MAGIC);
    const next = first >= 0 ? buf.indexOf(MAGIC, first + MAGIC.length) : -1;
    const frame1 = buf.subarray(Math.max(0, first), next > 0 ? next : buf.length);
    const line0 = zlib.zstdDecompressSync(frame1).toString('utf8').split('\n')[0];
    const o = JSON.parse(line0) as DshHeader;
    if (o?.type === 'session') header = o;
  } catch { /* 头帧异常：discover 降级为无元数据，不阻塞 */ }
  headerCache.set(fp, { mtimeMs: st.mtimeMs, size: st.size, header });
  return header;
}

/** 会话目录里取会话文件（正常恰一个 *.jsonl.zstd；多文件取最新） */
function sessionFileOf(sessionDir: string): { file: string; st: fs.Stats } | null {
  let best: { file: string; st: fs.Stats } | null = null;
  for (const f of fs.readdirSync(sessionDir)) {
    if (!f.endsWith('.jsonl.zstd')) continue;
    const fp = path.join(sessionDir, f);
    const st = fs.statSync(fp);
    if (!best || st.mtimeMs > best.st.mtimeMs) best = { file: fp, st };
  }
  return best;
}

type Mapped =
  | { kind: 'message'; role: 'user' | 'assistant'; content: string; seqNum: number; createdAt?: string }
  | { kind: 'skip' }
  | { kind: 'bad' };

/** 事件行 → 统一消息。仅 user/assistant 的 text 部件入库（reasoning/工具噪声跳过，
 * 与 claude-code 适配器 extractText 同范式）；seq 直接做 seqNum（幂等键天然对上）。 */
export function mapLine(lineText: string):
  | Mapped
  | { kind: 'skip' } {
  let o: Record<string, unknown>;
  try { o = JSON.parse(lineText); } catch { return { kind: 'bad' }; }
  const seq = (o as { seq?: unknown }).seq;
  if (typeof seq !== 'number') return { kind: 'skip' };
  const t = (o as { type?: unknown }).type;
  const data = (o as { data?: unknown }).data as Record<string, unknown> | undefined;
  let role: 'user' | 'assistant';
  let parts: unknown;
  if (t === 'user/message') {
    // [1015 夜 · 出口③] `user/message` 事件带 `data.source.kind` —— **注入内容在采集层就丢掉**。
    //
    // ⚠️ 口径（红队 A 复测纠正）：**单个会话**里见过 6 种 kind；全量真实语料（95,218 条 user/message）
    //   实测有 **22 种**，且**没有一条缺 kind** ⇒ 下面那条回退口子在真实数据上不可达（保留只为老库/手工构造的库）。
    // 单会话实测（6534 事件，tools/_probe_dsh_source.mjs）：kind 共 6 种，
    //   user 44 条/64329 字（你真正发的）、time-context 32/8138、agent-instructions 2/7574、
    //   runtime-context 2/780、model-selection 2/304、**compact-checkpoint 1/12144（上下文压缩摘要）**。
    //   注入类合计约 29K 字 = 该会话用户消息总量的 **45%** —— 与统计口径（45.85%）对得上。
    //
    // 为什么以前没炸：下游 stripInjected 会剥掉其中大部分，但**压缩摘要不是**——
    //   实测主库 48h 窗内那 4 条污染决策（「采用 Vite 作为前端构建工具」等）就是从摘要文本里抽出来的。
    //   在采集层丢 = 它连 messages 表都进不去，重算也不会再抽到；这比在下游加过滤器硬。
    //   kind 缺失（老版本 DSH / 手工构造的库）时照旧收，交给下游 stripInjected —— 保持向后兼容。
    const kind = (data?.source as Record<string, unknown> | undefined)?.kind;
    if (typeof kind === 'string' && kind !== 'user') return { kind: 'skip' };
    role = 'user'; parts = data?.content;
  }
  else if (t === 'assistant/message') { role = 'assistant'; parts = (data?.message as Record<string, unknown> | undefined)?.content; }
  else return { kind: 'skip' };
  const content = partsToText(parts);
  if (!content.trim()) return { kind: 'skip' };
  const time = (o as { time?: unknown }).time;
  return {
    kind: 'message', role, content,
    seqNum: seq,
    createdAt: typeof time === 'number' ? new Date(time).toISOString() : undefined,
  };
}

function partsToText(parts: unknown): string {
  if (!Array.isArray(parts)) return '';
  return parts
    .filter((b): b is { type: string; text?: string } => typeof b === 'object' && b !== null && (b as { type?: string }).type === 'text')
    .map(b => b.text ?? '')
    .join('\n');
}

export const adapter: SessionSourceAdapter = {
  id: SOURCE_ID,
  displayName: 'DSH (DeepSeek Harness)',

  discover(root, config) {
    if (!hasNativeZstd) return [];
    const dir = (config.sessionsDir as string) ?? defaultSessionsDir();
    const groupDir = path.join(dir, dshSessionSlug(path.resolve(root)));
    if (!fs.existsSync(groupDir)) return [];
    const out: DiscoveredSession[] = [];
    for (const e of fs.readdirSync(groupDir, { withFileTypes: true })) {
      if (!e.isDirectory() || !e.name.startsWith('session-')) continue;
      const sessionDir = path.join(groupDir, e.name);
      const best = sessionFileOf(sessionDir);
      if (!best) continue;
      const uuid = e.name.replace(/^session-/, '');
      const header = readHeaderCached(best.file, best.st);
      out.push({
        source: SOURCE_ID,
        sourceSessionId: uuid,
        sourceFile: best.file,
        title: null,
        createdAt: header?.createdAt ? new Date(header.createdAt).toISOString() : undefined,
        sizeBytes: best.st.size,
        mtimeMs: best.st.mtimeMs,
        originHint: (header?.delegationDepth ?? 0) > 0 ? 'workflow' : undefined,
      });
    }
    return out;
  },

  async readNew(ds, cursor, _config) {
    // 游标 = DSH 原生 seq（单调、稀疏、幂等键直对 messages(session_id, seq_num)）。
    // 全帧重解（只碰 mtime/size 变了的文件——水位线先行跳过）；15MB 级实测 <100ms。
    const lastSeq = (cursor as { lastSeq?: number } | null)?.lastSeq ?? 0;
    const walk: FrameWalkResult = hasNativeZstd ? decodeSessionFile(ds.sourceFile) : { lines: [], failedFrames: 0 };
    const messages: ReadResult['messages'] = [];
    let bad = walk.failedFrames;
    let maxSeq = lastSeq;
    for (const l of walk.lines) {
      const m = mapLine(l);
      if (m.kind === 'bad') { bad++; continue; }
      if (m.kind === 'skip') continue;
      if (m.seqNum <= maxSeq) continue; // 截断尾帧重读的重复行由 seq 去重兜底
      messages.push({ role: m.role, content: m.content, seqNum: m.seqNum, createdAt: m.createdAt });
      maxSeq = m.seqNum;
    }
    return { messages, badLines: bad, cursor: { lastSeq: maxSeq } };
  },

  watchRoots(_root, config) {
    return [(config.sessionsDir as string) ?? defaultSessionsDir()];
  },

  healthCheck(_root, config) {
    if (!hasNativeZstd) {
      return `Node ≥24 才有原生 zstd 解压（当前 ${process.version}）；DSH 会话为 zstd 容器，该源暂不可用`;
    }
    const dir = (config.sessionsDir as string) ?? defaultSessionsDir();
    if (!fs.existsSync(dir)) return `目录不存在：${dir}（DSH 未安装或未使用，可忽略）`;
    return null;
  },
};
