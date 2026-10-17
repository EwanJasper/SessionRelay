// 全量重建（方针原则 4：源文件是唯一事实源，库是可重建的索引；T31 FTS rebuild）
// 语义：按当前配置从源重新摄取（尊重 mode 与 ignore）；imported 会话无本地源 → 从旧库整体搬迁；
//       旧库保留为 .bak（安全网）。守护运行中拒绝（写竞争），--force 可越过（自担风险）。
import fs from 'node:fs';
import { createDb, openExisting, dueIdle, markPending, confirmSession, isNoteSession } from '../store/db.js';
import { dbFile } from '../shared/paths.js';
import type { DB } from '../store/db.js';
import type { RelayConfig } from '../shared/config.js';
import { runSync } from './sync.js';
import { insertImportedSession, insertImportedMessage } from '../store/db.js';
import { isDaemonAlive } from '../shared/lock.js';

export interface RebuildResult {
  autoSessions: number;
  importedPreserved: number;
  /** [1021 审查 #01] 整行搬迁的笔记数（无本地源文件的一类） */
  notesPreserved: number;
  /** 非致命提示（如会话链接对端已不在迁移集）；致命失败会 throw，不会走这里 */
  warnings: string[];
  bakFile: string;
}

/**
 * 把「无本地源文件」的会话**整行**搬到新库：会话行（保 id / 状态 / 派生列）+ 正文。
 *
 * 为什么必须保 id：笔记 id 会被外部引用（用户贴过的 id、forget 快照、会话链接）；
 * 换 id 等于把引用悄悄打断。为什么正文要重插后重映射 msgId：决策/未决条目里的
 * `msgId` 是**旧库 messages.id**，搬完后消息 id 变了，不回映射的话出处回跳会误报"原文已归档"。
 * 返回搬过去的消息条数。
 */
function copySessionVerbatim(id: string, oldDb: DB, fresh: DB, warnings: string[]): number {
  const row = oldDb.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) return 0;
  const cols = Object.keys(row);
  fresh.prepare(`INSERT OR REPLACE INTO sessions (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
    .run(...cols.map((c) => row[c] as never));
  const msgs = oldDb.prepare('SELECT seq_num, role, content, created_at FROM messages WHERE session_id = ? ORDER BY seq_num')
    .all(id) as Array<{ seq_num: number; role: string; content: string; created_at: string | null }>;
  for (const m of msgs) insertImportedMessage(fresh, id, { seq: m.seq_num, role: m.role, content: m.content, createdAt: m.created_at });
  remapAnchorMsgIds(fresh, id);
  // 会话链接：只搬与这条会话有关的边；对端没搬过来时 FK 会拒绝，属预期（记 warning，不静默）
  try {
    const links = oldDb.prepare('SELECT session_id, linked_session_id, kind, created_at FROM session_links WHERE session_id = ? OR linked_session_id = ?')
      .all(id, id) as Array<{ session_id: string; linked_session_id: string; kind: string; created_at: string }>;
    let dropped = 0;
    for (const l of links) {
      try {
        fresh.prepare('INSERT OR IGNORE INTO session_links (session_id, linked_session_id, kind, created_at) VALUES (?,?,?,?)')
          .run(l.session_id, l.linked_session_id, l.kind, l.created_at);
      } catch { dropped++; }
    }
    if (dropped > 0) warnings.push(`会话 ${id}：${dropped} 条链接因对端会话未迁移而失效`);
  } catch (e) {
    warnings.push(`会话 ${id}：链接表读取失败（${(e as Error).message}）`);
  }
  return msgs.length;
}

/** 把决策/未决条目里的 msgId 按 seq 映射到新库的消息 id；映射不到就删掉该字段
 *  （宁缺勿假：留着旧 id 会让读取端以为"有 msgId 但查不到" ⇒ 误报"原文已归档"）。 */
function remapAnchorMsgIds(db: DB, sessionId: string): void {
  const map = new Map<number, number | string>();
  for (const r of db.prepare('SELECT id, seq_num FROM messages WHERE session_id = ?').all(sessionId) as Array<{ id: number | string; seq_num: number }>) {
    map.set(Number(r.seq_num), r.id);
  }
  const row = db.prepare('SELECT decisions, key_questions FROM sessions WHERE id = ?').get(sessionId) as { decisions: string | null; key_questions: string | null } | undefined;
  if (!row) return;
  const fix = (raw: string | null): string | null => {
    if (!raw) return raw;
    let arr: Array<Record<string, unknown>>;
    try { arr = JSON.parse(raw); } catch { return raw; }
    if (!Array.isArray(arr)) return raw;
    let changed = false;
    for (const d of arr) {
      if (!d || d.msgId === undefined) continue;
      const m = map.get(Number(d.seq));
      if (m !== undefined) { if (d.msgId !== m) { d.msgId = m; changed = true; } }
      else { delete d.msgId; changed = true; }
    }
    return changed ? JSON.stringify(arr) : raw;
  };
  const dec = fix(row.decisions);
  const qs = fix(row.key_questions);
  if (dec !== row.decisions || qs !== row.key_questions) {
    db.prepare('UPDATE sessions SET decisions = ?, key_questions = ? WHERE id = ?').run(dec, qs, sessionId);
  }
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

    // 2) 搬迁「无法从源文件重建」的会话 —— rebuild 唯一做不到的事。
    //    · imported（origin='imported'）：已有类别
    //    · note（[1021 审查 #01 修复]）：createNoteSession 写 source='note' / origin='manual'，
    //      同样**没有本地源文件**；原白名单只认 origin='imported' ⇒ 一重建笔记就从新库消失。
    //      判据用 store/db.ts 的 isNoteSession（唯一一份，不许在这里另写一套 origin/source 猜测）。
    //    · 笔记按**原 id 整行搬迁**（含正文/派生列）：它的 id 已被外部引用（用户贴过、forget 快照、
    //      会话链接），换 id 等于把引用悄悄打断。
    //    任何一条「无源会话」搬不过去 = 重建后真的丢数据 ⇒ 中止重建（旧库尚未被替换），不许静默。
    let preserved = 0;
    let notesPreserved = 0;
    const migrateWarnings: string[] = [];
    const migrateFailures: string[] = [];
    if (oldDb) {
      const olds = oldDb.prepare('SELECT id, source, origin FROM sessions').all() as Array<{ id: string; source: string; origin: string }>;
      for (const old of olds) {
        const id = old.id;
        if (isNoteSession(old)) {
          try {
            const msgs = copySessionVerbatim(id, oldDb, fresh, migrateWarnings);
            notesPreserved++;
            if (msgs === 0) migrateWarnings.push(`笔记 ${id}：搬迁后正文 0 条（原库该笔记可能已被归档/清空）`);
          } catch (e) { migrateFailures.push(`笔记 ${id} 搬迁失败：${(e as Error).message}`); }
          continue;
        }
        if (old.origin !== 'imported') continue;
        const r = oldDb.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Record<string, unknown>;
        const j = <T,>(v: unknown, fb: T): T => { try { return v == null ? fb : JSON.parse(String(v)) as T; } catch { return fb; } };
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
        // imported 的决策里若带旧库 msgId，同样按 seq 重映射（否则出处回跳误报"原文已归档"）
        remapAnchorMsgIds(fresh, res.id);
        preserved++;
      }
    }
    if (migrateFailures.length > 0) {
      throw new Error('有 ' + migrateFailures.length + ' 条「无源文件会话」没能搬迁，已中止重建（旧库未动）：' + migrateFailures.slice(0, 5).join('；'));
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
    return { autoSessions: s.newSessions, importedPreserved: preserved, notesPreserved, warnings: migrateWarnings, bakFile: bak };
  } catch (e) {
    try { fresh.close(); } catch { /* 已关 */ }
    try { oldDb?.close(); } catch { /* 已关 */ }
    fs.rmSync(tmp, { force: true });
    fs.rmSync(tmp + '-wal', { force: true });
    fs.rmSync(tmp + '-shm', { force: true });
    throw e;
  }
}
