// Trae Adapter（部分适配：捕获用户输入历史；AI 回复加密不可读）
// 存储：~/.trae-cn/ + AppData/Roaming/Trae CN/
// 可读数据：workspace vscdb 中的 icube-ai-agent-storage-input-history（用户提问 JSON 数组）
// 不可读：ModularData/ai-agent/database.db（加密二进制，含 AI 回复）
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { SessionSourceAdapter, AdapterConfig, DiscoveredSession, ReadResult } from '../types.js';

export const SOURCE_ID = 'trae';

/** 从 workspaceStorage 目录扫描所有 workspace，按项目路径归属 */
export function discover(projectRoot: string, traeDir: string): DiscoveredSession[] {
  // Trae 的 workspaceStorage 在 AppData 下，不在 ~/.trae-cn 下
  const wsDir = path.join(traeDir, 'User', 'workspaceStorage');
  if (!fs.existsSync(wsDir)) return [];

  const root = path.resolve(projectRoot).toLowerCase();
  const out: DiscoveredSession[] = [];

  for (const d of fs.readdirSync(wsDir)) {
    const wsPath = path.join(wsDir, d);
    const wsJson = path.join(wsPath, 'workspace.json');
    const stateDb = path.join(wsPath, 'state.vscdb');

    if (!fs.existsSync(stateDb)) continue;

    // 读 workspace.json 获取项目路径
    let workspacePath = '';
    try {
      const ws = JSON.parse(fs.readFileSync(wsJson, 'utf8')) as { folder?: string; workspace?: string };
      const raw = ws.folder ?? ws.workspace ?? '';
      // URL 编码的 file:// 路径 → 普通路径
      if (raw.startsWith('file:///')) {
        workspacePath = decodeURIComponent(raw.replace('file:///', '').replace(/^([a-z]):/i, '$1:'));
      }
    } catch { /* 无 workspace.json */ }

    if (!workspacePath) continue;
    if (path.resolve(workspacePath).toLowerCase() !== root) continue;

    // 这个 workspace 属于我们的项目 → 检查有没有输入历史
    try {
      const db = new Database(stateDb, { readonly: true });
      const row = db.prepare(
        "SELECT value, length(value) len FROM ItemTable WHERE key = 'icube-ai-agent-storage-input-history'"
      ).get() as { value: string; len: number } | undefined;
      db.close();

      if (row && row.len > 10) { // 非空（排除只有 "[]" 的）
        const stat = fs.statSync(stateDb);
        const sid = `trae-${d}`;
        out.push({
          source: SOURCE_ID,
          sourceSessionId: sid,
          sourceFile: stateDb,
          title: `Trae 对话（${d.slice(0, 8)}）`,
          createdAt: new Date(stat.birthtime).toISOString(),
          updatedAt: new Date(stat.mtime).toISOString(),
          sizeBytes: stat.size,
          mtimeMs: stat.mtimeMs,
        });
      }
    } catch { /* 跳过坏库 */ }
  }
  return out;
}

export async function readNew(ds: DiscoveredSession, _cursor: unknown): Promise<ReadResult> {
  // Trae 的输入历史是全量的 JSON 数组，不支持增量——每次读全部
  // 用 cursor 标记"上次读过的长度"来跳过无变化的情况
  const cur = (_cursor ?? {}) as { lastLen?: number };
  const db = new Database(ds.sourceFile, { readonly: true });
  try {
    const row = db.prepare(
      "SELECT value, length(value) len FROM ItemTable WHERE key = 'icube-ai-agent-storage-input-history'"
    ).get() as { value: string; len: number } | undefined;

    if (!row || row.len <= (cur.lastLen ?? 0)) {
      return { messages: [], badLines: 0, cursor: cur }; // 无变化
    }

    // 解析输入历史 JSON
    let inputs: Array<{ inputText?: string }> = [];
    try {
      inputs = JSON.parse(row.value);
    } catch { return { messages: [], badLines: 1, cursor: { lastLen: row.len } }; }

    const messages: ReadResult['messages'] = [];
    for (let i = 0; i < inputs.length; i++) {
      const text = inputs[i]?.inputText?.trim();
      if (!text || text.length < 2) continue;
      messages.push({
        role: 'user', // 只能拿到用户输入；AI 回复加密不可读
        content: text,
        seqNum: i + 1,
        createdAt: undefined, // 输入历史没有时间戳
      });
    }

    return { messages, badLines: 0, cursor: { lastLen: row.len } };
  } finally {
    db.close();
  }
}

export const adapter: SessionSourceAdapter = {
  id: SOURCE_ID,
  displayName: 'Trae',
  discover(root, config) {
    return discover(root, config.traeDir as string);
  },
  async readNew(ds, cursor, _config) {
    return readNew(ds, cursor);
  },
  watchRoots(_root, config) {
    const wsDir = path.join(config.traeDir as string, 'User', 'workspaceStorage');
    return fs.existsSync(wsDir) ? [wsDir] : [];
  },
  healthCheck(_root, config) {
    const dir = config.traeDir as string;
    if (!fs.existsSync(dir)) return `目录不存在：${dir}（未安装 Trae 可忽略）`;
    const wsDir = path.join(dir, 'User', 'workspaceStorage');
    return fs.existsSync(wsDir) ? null : `workspaceStorage 不存在：${wsDir}`;
  },
};
