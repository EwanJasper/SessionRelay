// 归档引擎（隐私与数据生命周期设计 / 归档方案 v0.2）
// 归档 = 删除消息正文，保留决策/话题/摘要骨架（99.4% 空间回收）
// 硬删 = 彻底删除含 sessions 行（不可恢复，除非源文件还在）
import type { DB } from '../store/db.js';
import { listSessions, getSessionFull, countMessages, insertCleanupLog, insertCleanupDetail } from '../store/db.js';
import type { SessionRow } from '../store/db.js';

export interface ArchiveCriteria {
  days?: number;
  before?: string;
  sizeMb?: number;
  source?: string;
  sessionIds?: string[];
}

export interface ArchiveOptions extends ArchiveCriteria {
  hard?: boolean;
  dryRun?: boolean;
  includeProtected?: boolean;
}

export interface ArchiveResult {
  archived: number;
  skipped: number;
  bytesFreed: number;
  details: Array<{
    sessionId: string;
    title: string | null;
    source: string;
    messageCount: number;
    decisionCount: number;
    skipped?: boolean;
    skipReason?: string;
  }>;
}

/** 保护规则：这些会话不归档 */
function isProtected(s: SessionRow): string | null {
  if (s.state === 'active') return 'active';
  if (s.origin === 'imported') return 'imported';
  if (s.origin === 'note') return 'note';
  // user_tags 含 "保留" 的检查需要 getSessionFull，在调用方做
  return null;
}

export function runArchive(db: DB, opts: ArchiveOptions): ArchiveResult {
  const result: ArchiveResult = { archived: 0, skipped: 0, bytesFreed: 0, details: [] };
  const now = new Date();
  const cutoff = opts.days
    ? new Date(now.getTime() - opts.days * 86400_000).toISOString()
    : opts.before ?? '9999-12-31';

  // 构建查询条件
  const conds: string[] = ["cleanup_at IS NULL"]; // 已归档的不再归档
  const params: unknown[] = [];

  if (opts.sessionIds?.length) {
    conds.push(`id IN (${opts.sessionIds.map(() => '?').join(',')})`);
    params.push(...opts.sessionIds);
  } else {
    conds.push(`COALESCE(last_event_at, created_at) < ?`);
    params.push(cutoff);
    if (opts.source) {
      conds.push('source = ?');
      params.push(opts.source);
    }
  }

  // 查询候选会话
  const candidates = db.prepare(`
    SELECT id, source, source_session_id, state, origin, title, created_at, last_event_at, message_count
    FROM sessions WHERE ${conds.join(' AND ')}
    ORDER BY COALESCE(last_event_at, created_at) ASC
  `).all(...params) as SessionRow[];

  // 记录 cleanup_log（如果不是 dry-run）
  let logId: number | null = null;
  if (!opts.dryRun && candidates.length > 0) {
    logId = insertCleanupLog(db, {
      triggeredBy: 'manual',
      mode: opts.hard ? 'hard' : 'archive',
      criteria: JSON.stringify({ days: opts.days, before: opts.before, source: opts.source }),
    });
  }

  // 按体积限制（如果指定了 sizeMb）
  let bytesBudget = opts.sizeMb ? opts.sizeMb * 1024 * 1024 : Infinity;

  for (const s of candidates) {
    // 保护规则
    if (!opts.includeProtected) {
      const protectedReason = isProtected(s);
      if (protectedReason) {
        result.skipped++;
        result.details.push({ sessionId: s.id, title: s.title, source: s.source, messageCount: s.message_count, decisionCount: 0, skipped: true, skipReason: protectedReason });
        continue;
      }
      // 检查 user_tags
      const full = getSessionFull(db, s.id);
      if (full?.userTags?.includes('保留')) {
        result.skipped++;
        result.details.push({ sessionId: s.id, title: s.title, source: s.source, messageCount: s.message_count, decisionCount: 0, skipped: true, skipReason: '保留标签' });
        continue;
      }
    }

    const msgCount = s.message_count;
    const decisions = getSessionFull(db, s.id)?.decisions?.length ?? 0;

    // 估算释放字节数（每条消息约 5KB 含 search_text + FTS）
    const estBytes = msgCount * 5 * 1024;

    if (opts.dryRun) {
      result.details.push({ sessionId: s.id, title: s.title, source: s.source, messageCount: msgCount, decisionCount: decisions });
      result.bytesFreed += estBytes;
      continue;
    }

    // 执行归档
    if (opts.hard) {
      // 硬删除：删除 sessions 行（messages/向量级联删除）
      db.prepare('DELETE FROM sessions WHERE id = ?').run(s.id);
    } else {
      // 归档：删除 messages，保留 sessions 行
      db.prepare('DELETE FROM messages WHERE session_id = ?').run(s.id);
      db.prepare('UPDATE sessions SET cleanup_at = ?, message_count = 0, original_message_count = ? WHERE id = ?')
        .run(now.toISOString(), msgCount, s.id);
      // 语义联动（design-semantic §3.2）：正文删除=向量语义过期；标题/话题仍走 FTS meta 路
      db.prepare('DELETE FROM session_vectors WHERE session_id = ?').run(s.id);
    }

    // 记录审计明细
    if (logId !== null) {
      insertCleanupDetail(db, {
        cleanupLogId: logId,
        sessionId: s.id,
        title: s.title,
        source: s.source,
        messageCount: msgCount,
        decisionCount: decisions,
      });
    }

    result.archived++;
    result.bytesFreed += estBytes;
    bytesBudget -= estBytes;
    if (bytesBudget <= 0) break; // 体积够了
  }

  // 更新 cleanup_log 的统计
  if (!opts.dryRun && logId !== null) {
    db.prepare('UPDATE cleanup_log SET sessions_affected = ?, sessions_skipped = ?, bytes_freed = ? WHERE id = ?')
      .run(result.archived, result.skipped, result.bytesFreed, logId);
  }

  return result;
}

/** 查看归档历史 */
export function getArchiveHistory(db: DB, opts?: { verbose?: boolean; sessionId?: string }): unknown {
  if (opts?.sessionId) {
    return db.prepare(`
      SELECT cl.*, cd.session_id, cd.title, cd.source, cd.message_count, cd.decision_count
      FROM cleanup_log cl
      JOIN cleanup_detail cd ON cd.cleanup_log_id = cl.id
      WHERE cd.session_id LIKE ?
      ORDER BY cl.created_at DESC
    `).all(opts.sessionId + '%');
  }
  if (opts?.verbose) {
    const logs = db.prepare('SELECT * FROM cleanup_log ORDER BY created_at DESC LIMIT 20').all();
    for (const log of logs) {
      (log as Record<string, unknown>).details = db.prepare(
        'SELECT session_id, title, source, message_count, decision_count FROM cleanup_detail WHERE cleanup_log_id = ?'
      ).all((log as Record<string, unknown>).id);
    }
    return logs;
  }
  return db.prepare('SELECT * FROM cleanup_log ORDER BY created_at DESC LIMIT 20').all();
}
