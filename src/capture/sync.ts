// 捕获同步引擎（技术方案 §5.1 / 改进方案 改动1 注册表化 + 改动3 compaction 警告）
import { createDb, upsertCapturedSession, insertMessage, rollbackSession,
         bumpMessageCount, getCursor, recordCursor } from '../store/db.js';
import type { DB } from '../store/db.js';
import type { RelayConfig } from '../shared/config.js';
import { projectIdOf, dbFile } from '../shared/paths.js';
import { loadIgnoreRules, isSessionBlocked } from './ignore.js';
import { ensureRegistered, get, adapterConfig, list } from '../adapters/registry.js';
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
  warnings: string[];  // 改动 3：compaction 丢数据警告等
}

export interface SyncOptions {
  projectRoot: string;
  config: RelayConfig;
  db?: DB;
  stats?: StatsCounter;
  now?: Date;
  backfillDays?: number;
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
  const result: SyncStats = { mode, discovered: 0, newSessions: 0, newMessages: 0, resumed: 0, badLines: 0, blocked: 0, warnings: [] };

  if (mode === 'off') return result;

  // 改动 1：注册表初始化（含 custom adapter 加载）
  ensureRegistered(root);
  const customResult = ensureRegistered(root);
  for (const err of customResult.errors) result.warnings.push(`custom adapter 加载失败：${err}`);

  const own = !opts.db;
  const db = opts.db ?? createDb(dbFile(root));
  const projectId = cfg.identity.project_id ?? projectIdOf(root);
  const ignoreRules = loadIgnoreRules(root);
  const backfillCutoffMs = opts.backfillDays
    ? (opts.now ?? new Date()).getTime() - opts.backfillDays * 86400_000
    : -Infinity;

  try {
    for (const source of cfg.capture.sources) {
      // 改动 1：从注册表取 adapter（不再 if/else）
      const adapter = get(source);
      if (!adapter) {
        result.warnings.push(`未知会话源：${source}（可用：${list().map(a => a.id).join(', ')}）`);
        continue;
      }
      const aConfig = adapterConfig(cfg, source);
      const discovered = adapter.discover(root, aConfig);

      for (const ds of discovered) {
        result.discovered++;
        if (ds.mtimeMs < backfillCutoffMs) continue;

        // 两层 ignore
        if (isSessionBlocked(ignoreRules, { source: ds.source, title: ds.title ?? null, sourceFile: ds.sourceFile })) {
          result.blocked++;
          opts.stats?.increment('blocked_by_ignore');
          continue;
        }

        await ingestOne(db, ds, { mode, projectId, cfg, result, stats: opts.stats, ignoreRules, source, aConfig });
      }
    }
  } finally {
    if (own) db.close();
  }
  return result;
}

/** 供 save/CLI 使用的发现器（注册表版） */
export function discoverAll(root: string, cfg: RelayConfig): DiscoveredSession[] {
  ensureRegistered(root);
  const out: DiscoveredSession[] = [];
  for (const source of cfg.capture.sources) {
    const adapter = get(source);
    if (!adapter) continue;
    out.push(...adapter.discover(root, adapterConfig(cfg, source)));
  }
  return out;
}

/** 手动 save 专用（D2 并存范式） */
export async function captureSessions(opts: {
  projectRoot: string;
  config: RelayConfig;
  db: DB;
  sessions: DiscoveredSession[];
  stats?: StatsCounter;
}): Promise<SyncStats> {
  const cfg = opts.config;
  const result: SyncStats = { mode: 'manual', discovered: opts.sessions.length, newSessions: 0, newMessages: 0, resumed: 0, badLines: 0, blocked: 0, warnings: [] };
  const ignoreRules = loadIgnoreRules(opts.projectRoot);
  const projectId = cfg.identity.project_id ?? projectIdOf(opts.projectRoot);
  ensureRegistered(opts.projectRoot);

  for (const ds of opts.sessions) {
    if (isSessionBlocked(ignoreRules, { source: ds.source, title: ds.title ?? null, sourceFile: ds.sourceFile })) {
      result.blocked++;
      opts.stats?.increment('blocked_by_ignore');
      continue;
    }
    const adapter = get(ds.source);
    if (!adapter) { result.warnings.push(`未知源：${ds.source}`); continue; }
    await ingestOne(opts.db, ds, { mode: 'full', projectId, cfg, result, stats: opts.stats, ignoreRules, source: ds.source, aConfig: adapterConfig(cfg, ds.source), origin: 'manual' });
  }
  return result;
}

async function ingestOne(
  db: DB,
  ds: DiscoveredSession,
  ctx: { mode: string; projectId: string; cfg: RelayConfig; result: SyncStats; stats?: StatsCounter; ignoreRules: string[]; source: string; aConfig: import("../adapters/types.js").AdapterConfig; origin?: 'auto' | 'manual' },
): Promise<void> {
  const adapter = get(ds.source);
  if (!adapter) return;

  const cursorBefore = getCursor(db, ds.source, ds.sourceFile);
  const read = await adapter.readNew(ds, cursorBefore, ctx.aConfig);
  ctx.result.badLines += read.badLines;

  // 改动 3：compaction 丢数据检测
  if (adapter.detectCompaction) {
    const compaction = adapter.detectCompaction(ds, ctx.aConfig);
    if (compaction && compaction.estimatedDeleted > 10) {
      const sessionRow = db.prepare(
        'SELECT id FROM sessions WHERE source = ? AND source_session_id = ?'
      ).get(ds.source, ds.sourceSessionId) as { id: string } | undefined;
      if (sessionRow) {
        const hasCompMsg = (db.prepare(
          "SELECT COUNT(*) n FROM messages WHERE session_id = ? AND role = 'system' AND content LIKE '[上下文压缩摘要]%'"
        ).get(sessionRow.id) as { n: number }).n > 0;
        if (!hasCompMsg) {
          ctx.result.warnings.push(
            `⚠️ 会话「${ds.title ?? ds.sourceSessionId}」检测到上下文压缩，约 ${compaction.estimatedDeleted} 条原始消息可能已丢失（建议开启守护 srelay watch --install-service）`
          );
        }
      }
    }
  }

  const firstUserTitle = titleFromMessages(read.messages);
  const lastEventAt = read.messages.length > 0
    ? (read.messages[read.messages.length - 1].createdAt ?? ds.updatedAt ?? new Date().toISOString())
    : ds.updatedAt ?? new Date().toISOString();

  // 两层 ignore：入库前 title 复查
  const { isSessionBlocked: _tmp } = await import('./ignore.js');
  if (_tmp(ctx.ignoreRules, { source: ds.source, title: ds.title ?? firstUserTitle, sourceFile: ds.sourceFile })) {
    ctx.result.blocked++;
    ctx.stats?.increment('blocked_by_ignore');
    db.transaction(() => recordCursor(db, ds.source, ds.sourceFile, read.cursor, { badLines: read.badLines }))();
    return;
  }

  db.transaction(() => {
    const up = upsertCapturedSession(db, {
      source: ds.source,
      sourceSessionId: ds.sourceSessionId,
      projectId: ctx.projectId,
      title: ds.title ?? firstUserTitle,
      createdAt: ds.createdAt ?? lastEventAt,
      lastEventAt,
      sourceFile: ds.sourceFile,
      origin: ctx.origin,
    });
    if (up.isNew) ctx.result.newSessions++;

    if (!up.isNew && up.prevState !== 'active' && read.messages.length > 0) {
      rollbackSession(db, up.id);
      ctx.result.resumed++;
      ctx.stats?.increment('resumed');
    }

    // 会话复活：归档后新消息到达 → 清除 cleanup_at，回到 hot 层
    if (!up.isNew && read.messages.length > 0) {
      db.prepare('UPDATE sessions SET cleanup_at = NULL WHERE id = ? AND cleanup_at IS NOT NULL').run(up.id);
    }

    if (ctx.mode === 'full') {
      let inserted = 0;
      for (const m of read.messages) inserted += insertMessage(db, { sessionId: up.id, role: m.role, content: m.content, seqNum: m.seqNum, createdAt: m.createdAt });
      if (inserted > 0) bumpMessageCount(db, up.id, inserted);
      ctx.result.newMessages += inserted;
    } else {
      bumpMessageCount(db, up.id, read.messages.length);
      ctx.result.newMessages += read.messages.length;
    }

    recordCursor(db, ds.source, ds.sourceFile, read.cursor, {
      badLines: read.badLines,
      suspect: read.badLines > 50,
    });
  })();
}
