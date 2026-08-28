// ZCode Adapter 最小实现（规格：docs/adapters/zcode-format.md，Spike S5）
// 存储：~/.zcode/cli/db/db.sqlite（WAL 活动库，只读连接）
// 水位：message.rowid（append-only，单调）——T34 库型源游标
// 提前落地说明：方针原排 Phase 3；因 S5 规格已齐且本机验证需要国产源，Phase 1 先落
// 最小读取面（discover/readNew），end-signals 精化与 files 提取仍在 Phase 3。
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { DiscoveredSession, ReadResult } from '../types.js';

export const SOURCE_ID = 'zcode';

export function discover(projectRoot: string, dbPath: string): DiscoveredSession[] {
  if (!fs.existsSync(dbPath)) return [];
  const z = new Database(dbPath, { readonly: true });
  try {
    z.pragma('busy_timeout = 3000');
    const rows = z
      .prepare('SELECT id, title, time_created, time_updated FROM session WHERE lower(directory) = lower(?)')
      .all(path.resolve(projectRoot)) as Array<{ id: string; title: string; time_created: number; time_updated: number }>;
    return rows.map((r) => ({
      source: SOURCE_ID,
      sourceSessionId: r.id,
      sourceFile: `zcode:${r.id}`,
      title: r.title,
      createdAt: new Date(r.time_created).toISOString(),
      updatedAt: new Date(r.time_updated).toISOString(),
      sizeBytes: 0,
      mtimeMs: r.time_updated,
    }));
  } finally {
    z.close();
  }
}

export function readNew(ds: DiscoveredSession, dbPath: string, cursor: unknown): ReadResult {
  const cur = (cursor ?? {}) as { rowid?: number };
  if (!fs.existsSync(dbPath)) return { messages: [], badLines: 0, cursor: cur };
  const z = new Database(dbPath, { readonly: true });
  try {
    z.pragma('busy_timeout = 3000');
    const rows = z
      .prepare('SELECT id AS mid, rowid AS mrowid, sequence, time_created, data FROM message WHERE session_id = ? AND rowid > ? ORDER BY rowid')
      .all(ds.sourceSessionId, cur.rowid ?? 0) as Array<{ mid: string; mrowid: number; sequence: number | null; time_created: number; data: string }>;
    const selectParts = z.prepare(
      `SELECT data FROM part WHERE message_id = ? AND json_extract(data, '$.type') = 'text' ORDER BY sequence, rowid`
    );
    const messages: ReadResult['messages'] = [];
    for (const r of rows) {
      let role: string;
      try {
        role = JSON.parse(r.data).role;
      } catch {
        continue;
      }
      const parts = selectParts.all(r.mid) as Array<{ data: string }>;
      const content = parts
        .map((p) => { try { return (JSON.parse(p.data).text ?? '') as string; } catch { return ''; } })
        .join('\n')
        .trim();
      if (!content) continue; // 纯工具/步骤消息，水位照常推进
      messages.push({
        role: role === 'user' ? 'user' : 'assistant',
        content,
        seqNum: r.sequence ?? r.mrowid, // 确定性序号（§3.1 契约 1）
        createdAt: new Date(r.time_created).toISOString(),
      });
    }
    const maxRowid = rows.length > 0 ? rows[rows.length - 1].mrowid : cur.rowid ?? 0;
    return { messages, badLines: 0, cursor: { rowid: maxRowid } };
  } finally {
    z.close();
  }
}
