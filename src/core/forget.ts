// 会话遗忘核心（design-dashboard U14：CLI forget 与 ui 仪表盘共用的同一执行路径）。
// 语义与 cli/forget 完全一致：审计入库 → 删除（FK CASCADE 同步 messages/links，FTS 触发器联动）
// → 防复活双闸（ignore session: 规则主 + 墓碑次；note/imported 不在复活路径上，跳过）。
// 调用方保证 row 是执行时刻的最新数据（CLI 靠乐观锁快照，UI 单请求内重读）。
import {
  insertTombstone, insertForgetLog, finalizeForgetLog, insertForgetDetail,
  type DB, type SessionFull,
} from '../store/db.js';
import { appendSessionIgnoreRule } from '../capture/ignore.js';

/** note/imported 无本地源文件，不在复活路径上——跳过双闸（设计 §3.6） */
export const needsBarriers = (row: SessionFull): boolean => row.origin !== 'imported' && row.source !== 'note';

export interface ForgetResult {
  id: string;
  messageCount: number;
  barriers: boolean;
}

/** 执行遗忘：事务（审计→删除→墓碑→收尾）+ 库外 ignore 规则（失败时墓碑兜底） */
export function forgetSession(
  db: DB,
  root: string,
  row: SessionFull,
  meta: { triggeredBy: string; criteria: string },
): ForgetResult {
  const now = new Date().toISOString();
  const isNote = row.source === 'note';
  const del = db.transaction(() => {
    const logId = insertForgetLog(db, { triggeredBy: meta.triggeredBy, mode: isNote ? 'note' : 'session', criteria: meta.criteria });
    insertForgetDetail(db, {
      forgetLogId: logId, sessionId: row.id, title: row.title, source: row.source,
      messageCount: row.messageCount, createdAt: row.createdAt,
    });
    const changes = db.prepare('DELETE FROM sessions WHERE id = ?').run(row.id).changes;
    if (needsBarriers(row)) insertTombstone(db, row.source, row.sourceSessionId, now);
    finalizeForgetLog(db, logId, changes, row.messageCount);
    return changes;
  });
  const changes = del();
  // 库外文件操作（顺序：先库后文件；文件失败时墓碑在库内兜底）
  if (changes > 0 && needsBarriers(row)) {
    try { appendSessionIgnoreRule(root, row.source, row.sourceSessionId); } catch { /* 墓碑已兜底 */ }
  }
  if (changes === 0) throw new Error(`会话 ${row.id} 已不存在（可能已被删除）`);
  return { id: row.id, messageCount: row.messageCount, barriers: needsBarriers(row) };
}
