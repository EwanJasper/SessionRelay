// 归档引擎（隐私与数据生命周期设计 / 归档方案 v0.2）
// 归档 = 删除消息正文，保留决策/话题/摘要骨架（99.4% 空间回收）
// 硬删 = 彻底删除含 sessions 行（不可恢复，除非源文件还在）
import type { DB } from '../store/db.js';
import { listSessions, getSessionFull, countMessages, insertCleanupLog, insertCleanupDetail, isNoteSession } from '../store/db.js';
import type { SessionRow } from '../store/db.js';
import type { RelayConfig } from '../shared/config.js';
// [1017 夜] 自动归档改走 ADR-003 的连续强度模型 —— 判据只留一份，理由见 autoArchiveProject 注释
import { planAging, ARCHIVE_CAP_PER_ROUND, strengthGateOf } from '../core/compact/aging.js';
import type { AgingRow, AgingPlan } from '../core/compact/aging.js';
import { EXTRACT_VERSION } from '../core/extract/version.js';

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
  // [1021 审查 #01 修复] 原判据写的是 `s.origin === 'note'` —— 而 createNoteSession 写的是
  //   source='note' / origin='manual' / state='active'（confirm 后 confirmed）⇒ 该条件**恒为假**，
  //   笔记从来就没被保护过：auto archive 会删光它的正文（笔记唯一的内容载体）。
  //   判据收敛到 store/db.ts 的 isNoteSession（唯一一份），archive 与 rebuild 共用。
  if (isNoteSession(s)) return 'note';
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

  // ── [1021 红队 R7 修复] 整个写入段包进事务 ──
  //   原来：先 INSERT cleanup_log（记一笔「我要归档了」），再逐条删 messages、最后 UPDATE 统计。
  //   全程**没有事务** ⇒ 崩在中途就留下「审计账说归档了 N 条，实际只删了一半」的账实不符，
  //   而且没法重跑（`cleanup_at IS NULL` 条件会让删过的跳过、没删的继续删，但 bytes_freed 永远对不上）。
  //   现在：BEGIN IMMEDIATE 包住「建账 → 删正文 → 记明细 → 结账」，异常整批回滚。
  //   dry-run 不开事务（它本来就不写），所以用 willWrite 而不是无条件 BEGIN。
  const willWrite = !opts.dryRun && candidates.length > 0;
  if (willWrite) db.exec('BEGIN IMMEDIATE');
  // 记录 cleanup_log（如果不是 dry-run）
  let logId: number | null = null;
  if (!opts.dryRun && candidates.length > 0) {
    logId = insertCleanupLog(db, {
      triggeredBy: opts.triggeredBy ?? 'manual',
      mode: opts.hard ? 'hard' : 'archive',
      criteria: JSON.stringify({ days: opts.days, before: opts.before, source: opts.source, origin: opts.origin }),
    });
  }

  try {
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

    // ── [1021 红队 R8 修复] dry-run 原来在这里**直接 continue，绕过了体积预算** ──
    //   后果：`--dry-run --size 100` 报的比 `--size 100` 实际做的**多**，
    //   而 dry-run 的全部意义就是「先看看会做什么」。两边口径必须一致，否则这个功能是骗人的。
    //   修法：dry-run 也走**同一套**预算记账（archived 计数 + bytesFreed + bytesBudget 递减），
    //   只是不真的删数据。这样 dry-run 的条数/字节数就是 apply 的忠实预演。
    if (opts.dryRun) {
      result.details.push({ sessionId: s.id, title: s.title, source: s.source, messageCount: msgCount, decisionCount: decisions });
      result.bytesFreed += estBytes;
      result.archived++;
      bytesBudget -= estBytes;
      if (bytesBudget <= 0) break; // 体积够了（与 apply 同一条退出条件）
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
  if (willWrite) db.exec('COMMIT');   // 账与数据一起落地
  } catch (e) {
    if (willWrite) { try { db.exec('ROLLBACK'); } catch { /* 回滚失败也不掩盖原始错误 */ } }
    throw e;
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
  /** 本轮判据摘要（进守护日志）——"为什么归档它/为什么没动"要能从数字上说清 */
  criteria: string;
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

/** 每轮自动归档的封顶条数（渐变不突变：配置写错也不会一轮清空整库） */
// 上限与强度门已提升到 core/compact/aging.ts（那里无依赖，面板宿主半也能读同一份判据）
export { ARCHIVE_CAP_PER_ROUND, strengthGateOf };

/** 检查一次自动归档（守护按 checkEveryMin 调用；首次顺带启用增量式 VACUUM）。
 *
 * ⚠️ 1017 夜重构：**判据只留一份**。
 * 以前这里是两套并存：本函数自己按时间窗挑（workflow 7d / 普通 30d），而 ADR-003 定下的
 * 连续强度模型 planAging 只被测量脚本用着，**守护根本不走它**。两套判据必然分叉，而且守护这套：
 *   · **没有抽取版本门** ⇒ 会把"还没按当前规则重算过"的会话正文先删掉（结论还没提炼就先删正文，
 *     这是记忆库最不该犯的错）；
 *   · 没有强度这个可解释量 ⇒ 日志里说不出"凭什么归档它"，也调不动（ADR-003 D1 就是为这个来的）。
 * 现在：planAging = **唯一选择器**，runArchive = **唯一执行器**（真删正文的实现，保护规则/审计/复活全在里面）。
 *   · 按 origin 给"下限窗"：workflow 用 workflowDays，其余用 hotDays —— 比窗年轻的绝不碰；
 *   · 强度门由窗推导（strengthGateOf）⇒ 与窗边界重合，只是把同一个边界写成连续量；
 *   · minDecisions 取 0：gate②（extracted_version === 当前版本）已保证"按当前规则抽过"，
 *     抽过而 0 结论 = 确实没结论 ⇒ 正文归档不丢信息（原文在客户端那边），
 *     不这样 0 结论的老会话会永久占着 94% 的正文空间（无界增长的唯一入口）。
 * 双通道顺序关键：先 workflow（7d 窗）后普通（30d 窗）——workflow 会话的 7~30 天
 * 区间在第一通道清零后，普通通道不会再提前蒸发它们。
 * triggered_by 记 'auto' 供 cleanup_log 区分。 */
export function autoArchiveProject(db: DB, policy: AutoArchivePolicy): AutoArchiveResult {
  const result: AutoArchiveResult = { workflowArchived: 0, hotArchived: 0, criteria: '', vacuumEnabled: false, freedPages: 0 };
  // ① 增量式 VACUUM 启用（一次性）：auto_vacuum=NONE 时切 INCREMENTAL 并 VACUUM 重建
  //    （71MB 库实测秒级）；之后 PRAGMA 持久生效，incremental_vacuum 小步回收即可
  const mode = db.pragma('auto_vacuum', { simple: true }) as number;
  if (mode === 0) {
    db.pragma('auto_vacuum = INCREMENTAL');
    db.exec('VACUUM');
    result.vacuumEnabled = true;
  }
  // ② 选择：planAging 是唯一判据（每轮读一次候选列；封顶 ARCHIVE_CAP_PER_ROUND）
  const rows = db.prepare(
    'SELECT id, source, origin, state, last_event_at, message_count, extracted_version, decisions, cleanup_at FROM sessions'
  ).all() as AgingRow[];
  const planFor = (subset: AgingRow[], minAgeDays: number): AgingPlan => minAgeDays > 0
    ? planAging(subset, {
      currentVersion: EXTRACT_VERSION,
      minAgeDays,
      maxStrength: strengthGateOf(minAgeDays),
      minDecisions: 0,                      // 见函数注释：版本门才是真安全网
      cap: ARCHIVE_CAP_PER_ROUND,
    })
    : { archive: [], kept: subset, reasons: {} };

  const workflowRows = rows.filter((r) => String(r.origin || '') === 'workflow');
  const otherRows = rows.filter((r) => String(r.origin || '') !== 'workflow');
  const planWorkflow = planFor(workflowRows, policy.workflowDays);
  const planOther = planFor(otherRows, policy.hotDays);

  // ③ 执行：唯一执行器 runArchive（保护规则/复活/审计都在里面）。
  //    顺序关键：先 workflow 后普通 —— workflow 会话的 7~30 天区间在第一通道清零后，
  //    普通通道不会再提前蒸发它们。
  const runPlan = (plan: AgingPlan): number => plan.archive.length
    ? runArchive(db, { sessionIds: plan.archive.map((r) => r.id), triggeredBy: 'auto' }).archived
    : 0;
  result.workflowArchived = runPlan(planWorkflow);
  result.hotArchived = runPlan(planOther);

  // 判据摘要进日志：planAging 只放候选，这里补上"计划 vs 实际"（实际少 = 被保护规则拦下）
  result.criteria = 'strength≤' + strengthGateOf(policy.hotDays) + '(窗' + policy.hotDays + 'd)'
    + ' / workflow strength≤' + strengthGateOf(policy.workflowDays) + '(窗' + policy.workflowDays + 'd)'
    + ' · 计划 ' + planWorkflow.archive.length + '+' + planOther.archive.length
    + ' · 实际 ' + result.workflowArchived + '+' + result.hotArchived
    + ' · 上限 ' + ARCHIVE_CAP_PER_ROUND + '/轮';

  // ④ 增量回收空页
  const before = db.pragma('freelist_count', { simple: true }) as number;
  db.pragma('incremental_vacuum');
  result.freedPages = Math.max(0, before - (db.pragma('freelist_count', { simple: true }) as number));
  return result;
}