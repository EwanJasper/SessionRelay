// 全量重建（方针原则 4：源文件是唯一事实源，库是可重建的索引；T31 FTS rebuild）
// 语义：按当前配置从源重新摄取（尊重 mode 与 ignore）；imported 会话无本地源 → 从旧库整体搬迁；
//       旧库保留为 .bak（安全网）。守护运行中拒绝（写竞争），--force 可越过（自担风险）。
import fs from 'node:fs';
import { createDb, openExisting, dueIdle, markPending, confirmSession } from '../store/db.js';
import { dbFile } from '../shared/paths.js';
import type { DB } from '../store/db.js';
import type { RelayConfig } from '../shared/config.js';
import { runSync } from './sync.js';
import { insertImportedSession, insertImportedMessage } from '../store/db.js';
import { isDaemonAlive } from '../shared/lock.js';

export interface RebuildResult {
  autoSessions: number;
  importedPreserved: number;
  bakFile: string;
}

export async function runRebuild(opts: { root: string; cfg: RelayConfig; force?: boolean }): Promise<RebuildResult> {
  const alive = isDaemonAlive(opts.root);
  if (alive.alive && !opts.force) {
    throw new Error(`守护进程运行中 (pid ${alive.pid})，重建会与写入竞争。先停止守护（或任务管理器结束），或使用 --force 自担风险。`);
  }

  const main = dbFile(opts.root);
  const bak = `${main}.bak-${Date.now().toString(36)}`;
  const tmp = `${main}.rebuild`;
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const ext of ['-wal', '-shm']) fs.rmSync(tmp + ext, { force: true });

  const oldDb = fs.existsSync(main) ? openExisting(main) : null;
  const fresh = createDb(tmp);

  try {
    // 1) 从源全量重摄取（无时间窗；mode=off 时为 0 条——按设计）
    const s = await runSync({ projectRoot: opts.root, config: opts.cfg, db: fresh });

    // 1.5) 状态从事实推导：静默已超冷却期的会话直接补走 pending→confirmed
    //      （否则重建后全部回 active，决策/摘要要再等 6h 冷却——状态损失）
    //      归档保护：cleanup_at 非空的会话不 confirm（保持归档状态）
    {
      const pid = opts.cfg.identity.project_id ?? opts.root;
      const nowIso = new Date().toISOString();
      const coolCutoff = new Date(Date.now() - opts.cfg.capture.cooldown_hours * 3_600_000).toISOString();
      for (const id of dueIdle(fresh, pid, coolCutoff)) {
        const row = fresh.prepare('SELECT cleanup_at FROM sessions WHERE id = ?').get(id) as { cleanup_at: string | null } | undefined;
        if (row?.cleanup_at) continue; // 已归档，保持归档状态
        markPending(fresh, id, nowIso);
        confirmSession(fresh, id, nowIso);
      }
    }

    // 2) 搬迁 imported 会话（它们没有本地源文件，rebuild 唯一无法重建的类别）
    let preserved = 0;
    if (oldDb) {
      const olds = oldDb.prepare("SELECT id FROM sessions WHERE origin = 'imported'").all() as Array<{ id: string }>;
      for (const { id } of olds) {
        const r = oldDb.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Record<string, unknown>;
        const j = <T,>(v: unknown, fb: T): T => { try { return v == null ? fb : JSON.parse(String(v)) as T; } catch { return fb; } };
        const { id: _drop, ..._rest } = { id };
        const res = insertImportedSession(fresh, {
          source: String(r.source), sourceSessionId: String(r.source_session_id),
          projectId: String(r.project_id), title: (r.title as string | null) ?? null,
          createdAt: String(r.created_at), lastEventAt: (r.last_event_at as string | null) ?? null,
          messageCount: Number(r.message_count ?? 0),
          topics: j<string[]>(r.topics, []), decisions: j(r.decisions, []),
          summaryRule: (r.summary_rule as string | null) ?? null, author: (r.author as string | null) ?? null,
          importedFrom: (r.imported_from as string | null) ?? null, originProject: (r.origin_project as string | null) ?? null,
          contentHash: (r.content_hash as string | null) ?? null, sourceFile: (r.source_file as string | null) ?? null,
        });
        if (res.skipped) { preserved++; continue; }
        const msgs = oldDb.prepare('SELECT seq_num, role, content, created_at FROM messages WHERE session_id = ? ORDER BY seq_num').all(id) as Array<{ seq_num: number; role: string; content: string; created_at: string | null }>;
        for (const m of msgs) insertImportedMessage(fresh, res.id, { seq: m.seq_num, role: m.role, content: m.content, createdAt: m.created_at });
        preserved++;
      }
    }

    // 3) FTS 显式重建（T31：外部内容表批量重灌后必须执行，否则"数据在但搜不到"）
    fresh.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')");
    fresh.exec("INSERT INTO sessions_fts(sessions_fts) VALUES('rebuild')");

    // 4) checkpoint + 原子换库
    fresh.pragma('wal_checkpoint(TRUNCATE)');
    oldDb?.pragma('wal_checkpoint(TRUNCATE)');
    fresh.close();
    oldDb?.close();
    if (fs.existsSync(main)) fs.renameSync(main, bak);
    for (const ext of ['-wal', '-shm']) {
      if (fs.existsSync(main + ext)) fs.renameSync(main + ext, bak + ext);
    }
    fs.renameSync(tmp, main);
    return { autoSessions: s.newSessions, importedPreserved: preserved, bakFile: bak };
  } catch (e) {
    try { fresh.close(); } catch { /* 已关 */ }
    try { oldDb?.close(); } catch { /* 已关 */ }
    fs.rmSync(tmp, { force: true });
    fs.rmSync(tmp + '-wal', { force: true });
    fs.rmSync(tmp + '-shm', { force: true });
    throw e;
  }
}
