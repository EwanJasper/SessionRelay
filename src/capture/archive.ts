// 归档引擎（隐私与数据生命周期设计 / 归档方案 v0.2）
// 归档 = 删除消息正文，保留决策/话题/摘要骨架（99.4% 空间回收）
// 硬删 = 彻底删除含 sessions 行（不可恢复，除非源文件还在）
import type { DB } from '../store/db.js';
import { listSessions, getSessionFull, countMessages, insertCleanupLog, insertCleanupDetail } from '../store/db.js';
import type { SessionRow } from '../store/db.js';
import type { RelayConfig } from '../shared/config.js';

export interface ArchiveCriteria {
  days?: number;
  before?: string;
  sizeMb?: number;
  source?: string;
  /** [fork 1011] D26：按 origin 分窗（workflow 7d / 普通 60d）——runArchive 只支持精确匹配 */
  origin?: string;
  sessionIds?: string[];
}

export interface ArchiveOptions extends ArchiveCriteria {
  hard?: boolean;
  dryRun?: boolean;
  includeProtected?: boolean;
  /** 审计署名：'manual'（CLI 默认）| 'auto'（D26 守护定期执行） */
  triggeredBy?: string;
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
  // [fork 0922] days/sizeMb 为 0 是合法值（"归档 0 天前"="全归档"边界语义由调用方定），
  // 原实现的 truthy 判断把 0 当"未提供"→ cutoff 退化成 9999-12-31、预算退化成无限——
  // 用户要 0 条实际归档全部（配 --hard 即灾难）。改显式 != null 判定。
  const cutoff = opts.days != null && Number.isFinite(opts.days)
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
    if (opts.origin) {
      conds.push('origin = ?');
      params.push(opts.origin);
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
      triggeredBy: opts.triggeredBy ?? 'manual',
      mode: opts.hard ? 'hard' : 'archive',
      criteria: JSON.stringify({ days: opts.days, before: opts.before, source: opts.source, origin: opts.origin }),
    });
  }

  // 按体积限制（如果指定了 sizeMb；0 也按 0 尊重，同上）
  let bytesBudget = opts.sizeMb != null && Number.isFinite(opts.sizeMb) ? opts.sizeMb * 1024 * 1024 : Infinity;

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


// ── D26 自动归档（[fork 1011] 守护定期执行；策略用户已拍板：默认启用/60d/7d/增量式 VACUUM） ──

export interface AutoArchivePolicy {
  /** 普通会话热窗（天） */
  hotDays: number;
  /** workflow 子代理会话热窗（天） */
  workflowDays: number;
  /** 守护检查节奏（分钟） */
  checkEveryMin: number;
}

export interface AutoArchiveResult {
  workflowArchived: number;
  hotArchived: number;
  /** 本次是否执行了启用式 VACUUM（auto_vacuum NONE → INCREMENTAL，一次性） */
  vacuumEnabled: boolean;
  /** incremental_vacuum 回收的空页数 */
  freedPages: number;
}

/** 从 RelayConfig 归一化策略；archive.enabled === false 时返回 null（纯手动模式） */
export function autoArchivePolicyOf(cfg: RelayConfig): AutoArchivePolicy | null {
  const a = cfg.archive;
  if (a?.enabled === false) return null;
  return {
    hotDays: a?.hot_days ?? 60,
    workflowDays: a?.workflow_days ?? 7,
    checkEveryMin: a?.check_every_min ?? 60,
  };
}

/** 检查一次自动归档（守护按 checkEveryMin 调用；首次顺带启用增量式 VACUUM）。
 * 双通道顺序关键：先 workflow（7d 窗）后普通（60d 窗）——workflow 会话的 7~60 天
 * 区间在第一通道清零后，普通通道不会再提前蒸发它们。
 * 保护规则/复活/审计全部复用 runArchive；triggered_by 记 'auto' 供 cleanup_log 区分。 */
export function autoArchiveProject(db: DB, policy: AutoArchivePolicy): AutoArchiveResult {
  const result: AutoArchiveResult = { workflowArchived: 0, hotArchived: 0, vacuumEnabled: false, freedPages: 0 };
  // ① 增量式 VACUUM 启用（一次性）：auto_vacuum=NONE 时切 INCREMENTAL 并 VACUUM 重建
  //    （71MB 库实测秒级）；之后 PRAGMA 持久生效，incremental_vacuum 小步回收即可
  const mode = db.pragma('auto_vacuum', { simple: true }) as number;
  if (mode === 0) {
    db.pragma('auto_vacuum = INCREMENTAL');
    db.exec('VACUUM');
    result.vacuumEnabled = true;
  }
  // ② workflow 通道
  if (policy.workflowDays > 0) {
    result.workflowArchived = runArchive(db, { origin: 'workflow', days: policy.workflowDays, triggeredBy: 'auto' }).archived;
  }
  // ③ 普通通道（workflow 已清，剩余即普通/手动源）
  if (policy.hotDays > 0) {
    result.hotArchived = runArchive(db, { days: policy.hotDays, triggeredBy: 'auto' }).archived;
  }
  // ④ 增量回收空页
  const before = db.pragma('freelist_count', { simple: true }) as number;
  db.pragma('incremental_vacuum');
  result.freedPages = Math.max(0, before - (db.pragma('freelist_count', { simple: true }) as number));
  return result;
}