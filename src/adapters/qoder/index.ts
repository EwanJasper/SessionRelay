// Qoder Adapter（完整适配：明文 JSONL，user/assistant 均可读）
// 存储：~/.qoder-cn/cache/projects/<folderName>-<hash>/conversation-history/<taskId>/<taskId>.jsonl
// 项目映射：cache/projects 目录名的 folderName 部分匹配项目根的 basename
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { tailCompleteLines } from '../claude-code/tailer.js';
import type { SessionSourceAdapter, AdapterConfig, DiscoveredSession, ReadResult } from '../types.js';

export const SOURCE_ID = 'qoder';

function qoderCacheDir(config: AdapterConfig): string {
  return config.qoderDir as string ?? path.join(os.homedir(), '.qoder-cn');
}

/** 列出项目下所有 conversation-history JSONL */
export function discover(projectRoot: string, qoderDir: string): DiscoveredSession[] {
  const cacheDir = path.join(qoderDir, 'cache', 'projects');
  if (!fs.existsSync(cacheDir)) return [];

  const projectBase = path.basename(path.resolve(projectRoot)).toLowerCase();
  const out: DiscoveredSession[] = [];

  for (const d of fs.readdirSync(cacheDir)) {
    const dirPath = path.join(cacheDir, d);
    if (!fs.statSync(dirPath).isDirectory()) continue;

    // 目录名格式：<folderName>-<8charHash>
    // 去掉最后一段 8 字符 hash，剩下的是项目文件夹名
    const match = /^(.+)-[0-9a-f]{8,}$/i.exec(d);
    if (!match) continue;
    const folderName = match[1].toLowerCase();
    if (folderName !== projectBase) continue;

    // 匹配！扫描 conversation-history
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
