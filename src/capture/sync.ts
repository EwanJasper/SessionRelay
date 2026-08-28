// 捕获同步引擎（技术方案 §5.1，T20 事务边界：消息批量与水位同事务推进）
import { createDb, upsertCapturedSession, insertMessage, rollbackSession,
         bumpMessageCount, getCursor, recordCursor } from '../store/db.js';
import type { DB } from '../store/db.js';
import type { RelayConfig } from '../shared/config.js';
import { claudeProjectsDir, zcodeDbPath } from '../shared/config.js';
import { projectIdOf, dbFile } from '../shared/paths.js';
import { loadIgnoreRules, isSessionBlocked } from './ignore.js';
import * as claude from '../adapters/claude-code/adapter.js';
import * as zcode from '../adapters/zcode/adapter.js';
import type { DiscoveredSession } from '../adapters/types.js';
import type { StatsCounter } from '../core/stats/counter.js';

export interface SyncStats {
  mode: string;
  discovered: number;
  newSessions: number;
  newMessages: number;
  resumed: number;
  badLines: number;
  blocked: number;
}

export interface SyncOptions {
  projectRoot: string;
  config: RelayConfig;
  db?: DB;                       // 测试注入；缺省打开 relay.sqlite
  stats?: StatsCounter;
  now?: Date;
  backfillDays?: number;         // init 回填窗口
}

function titleFromMessages(msgs: Array<{ role: string; content: string }>): string | null {
  const first = msgs.find((m) => m.role === 'user' && m.content.trim());
  if (!first) return null;
  return first.content.replace(/\s+/g, ' ').trim().slice(0, 60);
}

export async function runSync(opts: SyncOptions): Promise<SyncStats> {
  const root = opts.projectRoot;
  const cfg = opts.config;
  const mode = cfg.capture.mode;
  const result: SyncStats = { mode, discovered: 0, newSessions: 0, newMessages: 0, resumed: 0, badLines: 0, blocked: 0 };

  if (mode === 'off') return result; // 方针验收：mode off → 零写入

  const own = !opts.db;
  const db = opts.db ?? createDb(dbFile(root));
  const projectId = cfg.identity.project_id ?? projectIdOf(root);
  const ignoreRules = loadIgnoreRules(root);
  const backfillCutoffMs = opts.backfillDays
    ? (opts.now ?? new Date()).getTime() - opts.backfillDays * 86400_000
    : -Infinity;

  try {
    for (const source of cfg.capture.sources) {
      let discovered: DiscoveredSession[] = [];
      if (source === 'claude-code') discovered = claude.discover(root, claudeProjectsDir(cfg));
      else if (source === 'zcode') discovered = zcode.discover(root, zcodeDbPath(cfg));
      else continue;

      for (const ds of discovered) {
        result.discovered++;
        if (ds.mtimeMs < backfillCutoffMs) continue;
        // 第一层 ignore（发现期）：source:/glob 基于已知信息，零读取成本
        if (isSessionBlocked(ignoreRules, { source: ds.source, title: ds.title ?? null, sourceFile: ds.sourceFile })) {
          result.blocked++;
          opts.stats?.increment('blocked_by_ignore');
          continue;
        }
        await ingestOne(db, ds, { mode, projectId, cfg, result, stats: opts.stats, ignoreRules });
      }
    }
  } finally {
    if (own) db.close();
  }
  return result;
}

async function ingestOne(
  db: DB,
  ds: DiscoveredSession,
  ctx: { mode: string; projectId: string; cfg: RelayConfig; result: SyncStats; stats?: StatsCounter; ignoreRules: string[]; origin?: 'auto' | 'manual' },
): Promise<void> {
  // 读新内容（在事务外读源，事务内只写库）
  const cursorBefore = getCursor(db, ds.source, ds.sourceFile);
  const read = ds.source === 'claude-code'
    ? await claude.readNew(ds, cursorBefore)
    : zcode.readNew(ds, zcodeDbPath(ctx.cfg), cursorBefore);
  ctx.result.badLines += read.badLines;

  const firstUserTitle = titleFromMessages(read.messages);
  // 第二层 ignore（入库前）：title: 规则需要解析出的标题——数据仍不落库（隐私硬边界）
  if (isSessionBlocked(ctx.ignoreRules, { source: ds.source, title: ds.title ?? firstUserTitle, sourceFile: ds.sourceFile })) {
    ctx.result.blocked++;
    ctx.stats?.increment('blocked_by_ignore');
    db.transaction(() => recordCursor(db, ds.source, ds.sourceFile, read.cursor, { badLines: read.badLines }))();
    return;
  }
  const lastEventAt = read.messages.length > 0
    ? (read.messages[read.messages.length - 1].createdAt ?? ds.updatedAt ?? new Date().toISOString())
    : ds.updatedAt ?? new Date().toISOString();

  db.transaction(() => {
    const up = upsertCapturedSession(db, {
      source: ds.source,
      sourceSessionId: ds.sourceSessionId,
      projectId: ctx.projectId,
      title: ds.title ?? firstUserTitle, // ZCode 有原生 title；claude-code 用首问
      createdAt: ds.createdAt ?? lastEventAt,
      lastEventAt,
      sourceFile: ds.sourceFile,
      origin: ctx.origin,
    });
    if (up.isNew) ctx.result.newSessions++;

    // 非 active 会话来了新行 → RESUMED 回滚（方针 §6.1；rollback 只由 sync/watch 触发，T23）
    if (!up.isNew && up.prevState !== 'active' && read.messages.length > 0) {
      rollbackSession(db, up.id);
      ctx.result.resumed++;
      ctx.stats?.increment('resumed');
    }

    if (ctx.mode === 'full') {
      let inserted = 0;
      for (const m of read.messages) inserted += insertMessage(db, { sessionId: up.id, role: m.role, content: m.content, seqNum: m.seqNum, createdAt: m.createdAt });
      ctx.result.newMessages += inserted;
    } else {
      // meta 模式：不落正文，只累计计数（方针 §6.2）
      bumpMessageCount(db, up.id, read.messages.length);
      ctx.result.newMessages += read.messages.length;
    }

    recordCursor(db, ds.source, ds.sourceFile, read.cursor, {
      badLines: read.badLines,
      suspect: read.badLines > 50, // 格式漂移预警（方针风险 #11）
    });
  })();
}

/** 手动 save 专用（D2 并存范式）：绕过 mode 检查（off 模式下唯一入口），ignore 硬边界仍然生效 */
export async function captureSessions(opts: {
  projectRoot: string;
  config: RelayConfig;
  db: DB;
  sessions: DiscoveredSession[];
  stats?: StatsCounter;
}): Promise<SyncStats> {
  const cfg = opts.config;
  const result: SyncStats = { mode: 'manual', discovered: opts.sessions.length, newSessions: 0, newMessages: 0, resumed: 0, badLines: 0, blocked: 0 };
  const ignoreRules = loadIgnoreRules(opts.projectRoot);
  const projectId = cfg.identity.project_id ?? projectIdOf(opts.projectRoot);
  for (const ds of opts.sessions) {
    if (isSessionBlocked(ignoreRules, { source: ds.source, title: ds.title ?? null, sourceFile: ds.sourceFile })) {
      result.blocked++;
      opts.stats?.increment('blocked_by_ignore');
      continue;
    }
    await ingestOne(opts.db, ds, { mode: 'full', projectId, cfg, result, stats: opts.stats, ignoreRules, origin: 'manual' });
  }
  return result;
}

/** 供 save/CLI 使用的发现器（与 runSync 同源） */
export function discoverAll(root: string, cfg: RelayConfig): DiscoveredSession[] {
  const out: DiscoveredSession[] = [];
  for (const source of cfg.capture.sources) {
    if (source === 'claude-code') out.push(...claude.discover(root, claudeProjectsDir(cfg)));
    else if (source === 'zcode') out.push(...zcode.discover(root, zcodeDbPath(cfg)));
  }
  return out;
}
