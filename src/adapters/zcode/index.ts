// ZCode Adapter（统一接口版，改进方案 改动1 + 改动2 compaction 摘要）
// 存储：~/.zcode/cli/db/db.sqlite（WAL 活动库，只读连接）
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { SessionSourceAdapter, AdapterConfig, DiscoveredSession, ReadResult, CompactionInfo } from '../types.js';

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
    // 改动 2：compaction 摘要 part 查询
    const selectCompParts = z.prepare(
      `SELECT p.data, p.time_created FROM part p
       WHERE p.session_id = ?
         AND json_extract(p.data, '$.type') = 'compaction'
         AND p.time_created > ?
       ORDER BY p.time_created`
    );

    const messages: ReadResult['messages'] = [];
    let maxSeq = 0;
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
      if (!content) continue;
      const seq = r.sequence ?? r.mrowid;
      messages.push({
        role: role === 'user' ? 'user' : 'assistant',
        content,
        seqNum: seq,
        createdAt: new Date(r.time_created).toISOString(),
      });
      maxSeq = Math.max(maxSeq, seq);
    }

    // 改动 2：捕获 compaction 摘要（AI 生成的压缩摘要存为 system 角色消息）
    const cursorObj = cur as { rowid?: number; lastCompaction?: number };
    const compParts = selectCompParts.all(ds.sourceSessionId, cursorObj.lastCompaction ?? 0) as Array<{ data: string; time_created: number }>;
    for (const cp of compParts) {
      try {
        const data = JSON.parse(cp.data);
        // 从 summaryMessageId 找摘要的 text part
        let summaryText = '';
        if (data.summaryMessageId) {
          const summaryParts = z.prepare(
            `SELECT data FROM part WHERE message_id = ? AND json_extract(data, '$.type') = 'text' ORDER BY sequence, rowid`
          ).all(data.summaryMessageId) as Array<{ data: string }>;
          summaryText = summaryParts
            .map((p) => { try { return (JSON.parse(p.data).text ?? '') as string; } catch { return ''; } })
            .join('\n')
            .trim();
        }
        if (summaryText) {
          maxSeq += 1;
          messages.push({
            role: 'system',
            content: `[上下文压缩摘要] ${summaryText.slice(0, 2000)}`,
            seqNum: maxSeq,
            createdAt: new Date(cp.time_created).toISOString(),
          });
        }
      } catch { /* 坏 compaction part 跳过 */ }
    }

    const maxRowid = rows.length > 0 ? rows[rows.length - 1].mrowid : cur.rowid ?? 0;
    const lastComp = compParts.length > 0 ? compParts[compParts.length - 1].time_created : (cursorObj.lastCompaction ?? 0);
    return { messages, badLines: 0, cursor: { rowid: maxRowid, lastCompaction: lastComp } };
  } finally {
    z.close();
  }
}

// ── 改动 3：compaction 检测 ──
export function detectCompaction(ds: DiscoveredSession, dbPath: string): CompactionInfo | null {
  if (!fs.existsSync(dbPath)) return null;
  const z = new Database(dbPath, { readonly: true });
  try {
    z.pragma('busy_timeout = 3000');
    const comp = z.prepare(`
      SELECT data, time_created FROM part
      WHERE session_id = ?
        AND json_extract(data, '$.type') = 'compaction'
      ORDER BY time_created DESC LIMIT 1
    `).get(ds.sourceSessionId) as { data: string; time_created: number } | undefined;
    if (!comp) return null;
    const data = JSON.parse(comp.data);
    // 估算被删消息数：压缩前后 token 差 / 平均每条消息约 500 token
    const estimated = Math.max(0, Math.floor(
      ((data.preCompactTokenCount ?? 0) - (data.truePostCompactTokenCount ?? 0)) / 500
    ));
    return {
      compactedAt: new Date(comp.time_created).toISOString(),
      estimatedDeleted: estimated,
      summaryMessageId: data.summaryMessageId,
    };
  } finally {
    z.close();
  }
}

// ── 统一接口导出（注册表用） ──
export const adapter: SessionSourceAdapter = {
  id: SOURCE_ID,
  displayName: 'ZCode',
  discover(root, config) {
    return discover(root, config.dbPath as string);
  },
  async readNew(ds, cursor, config) {
    return Promise.resolve(readNew(ds, config.dbPath as string, cursor));
  },
  watchRoots(_root, config) {
    const dbPath = config.dbPath as string;
    return fs.existsSync(dbPath) ? [path.dirname(dbPath)] : [];
  },
  healthCheck(_root, config) {
    const dbPath = config.dbPath as string;
    if (!fs.existsSync(dbPath)) return `数据库不存在：${dbPath}（未安装 ZCode 可忽略）`;
    try {
      const z = new Database(dbPath, { readonly: true });
      z.close();
      return null;
    } catch (e) {
      return `只读探测失败：${(e as Error).message}`;
    }
  },
  detectCompaction(ds, config) {
    return detectCompaction(ds, config.dbPath as string);
  },
};
