// srelay forget（设计 v4：把删除权交还给人，AI/MCP 保持零删除权）
// 语义：整条会话彻底消失（含决策），双防复活闸（ignore session: 主 + 墓碑次），审计永久可查。
// 选型口诀：空间与老化用 archive；让一条对话彻底消失、永不回来，用 forget。
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../shared/config.js';
import { dbFile, relayDir, findRelayRoot, ignoreFile } from '../shared/paths.js';
import {
  openExisting, createDb, getSessionFull, getLinkedSessions,
  insertTombstone, insertForgetLog, finalizeForgetLog, insertForgetDetail, getForgetHistory,
} from '../store/db.js';
import { appendSessionIgnoreRule } from '../capture/ignore.js';
import { isDaemonAlive } from '../shared/lock.js';
import { die, pc, fmtDate } from './ui.js';
import type { DB } from '../store/db.js';
import type { SessionFull } from '../store/db.js';

export interface ForgetFlags {
  session?: string;
  note?: string;
  all?: boolean;
  yes?: boolean;
  confirm?: string;
  history?: boolean;
  verbose?: boolean;
  json?: boolean;
}

/** 乐观锁快照（设计 §3.6：预览→--yes 两阶段之间守护可能新捕消息，跨进程以文件传递） */
interface PreviewSnapshot {
  id: string;
  messageCount: number;
  decisionCount: number;
  linkCount: number;
  previewedAt: string;
}

const snapshotFile = (root: string) => path.join(relayDir(root), 'forget-pending.json');

function readSnapshot(root: string): PreviewSnapshot | null {
  try { return JSON.parse(fs.readFileSync(snapshotFile(root), 'utf8')) as PreviewSnapshot; } catch { return null; }
}
function writeSnapshot(root: string, s: PreviewSnapshot): void {
  fs.writeFileSync(snapshotFile(root), JSON.stringify(s, null, 2));
}
function clearSnapshot(root: string): void {
  fs.rmSync(snapshotFile(root), { force: true });
}

function ageDays(iso: string | null): string {
  if (!iso) return '未知';
  const d = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(d) || d < 0) return '今天';
  const days = Math.floor(d / 86_400_000);
  if (days === 0) return '今天';
  if (days < 30) return `${days} 天前`;
  if (days < 365) return `${Math.floor(days / 30)} 个月前`;
  return `${(days / 365).toFixed(1)} 年前`;
}

interface ForgetCandidate {
  id: string; title: string | null; source: string; createdAt: string | null; messageCount: number;
}

/**
 * 解析 id 引用（设计 §3.5 前缀歧义防护）：完整 id 精确匹配；前缀先 COUNT，
 * >1 列出候选拒绝（findSessionByPrefix 的 LIKE LIMIT 1 静默取一在删除场景致命，不复用）；
 * 最后兜底 source_session_id 完整匹配（note-xxx 形态）。
 */
function resolveRef(db: DB, ref: string): { ok: true; row: SessionFull } | { ok: false; reason: 'not_found' } | { ok: false; reason: 'ambiguous'; candidates: ForgetCandidate[] } {
  const exact = db.prepare('SELECT id FROM sessions WHERE id = ?').get(ref) as { id: string } | undefined;
  if (exact) {
    const row = getSessionFull(db, exact.id);
    if (row) return { ok: true, row };
  }
  const likes = db.prepare(`
    SELECT id, title, source, created_at, message_count FROM sessions WHERE id LIKE ? ORDER BY COALESCE(last_event_at, created_at) DESC LIMIT 11
  `).all(ref + '%') as Array<{ id: string; title: string | null; source: string; created_at: string; message_count: number }>;
  if (likes.length === 1) {
    const row = getSessionFull(db, likes[0].id);
    if (row) return { ok: true, row };
  }
  if (likes.length > 1) {
    return { ok: false, reason: 'ambiguous', candidates: likes.slice(0, 10).map((r) => ({ id: r.id, title: r.title, source: r.source, createdAt: r.created_at, messageCount: r.message_count })) };
  }
  // source_session_id 完整匹配（note-xxx / 源会话 ID 形态；不做前缀——歧义防护）
  const bySid = db.prepare('SELECT id FROM sessions WHERE source_session_id = ?').get(ref) as { id: string } | undefined;
  if (bySid) {
    const row = getSessionFull(db, bySid.id);
    if (row) return { ok: true, row };
  }
  return { ok: false, reason: 'not_found' };
}

function typeFilterMismatch(f: ForgetFlags, row: SessionFull): string | null {
  if (f.note && row.source !== 'note') return `--note 指定笔记，但 ${row.id} 是 ${row.source} 会话`;
  if (f.session && row.source === 'note') return `--session 指定会话，但 ${row.id} 是笔记（用 --note 或去掉过滤）`;
  return null;
}

/** note/imported 无本地源文件，不在复活路径上——跳过双闸（设计 §3.6） */
const needsBarriers = (row: SessionFull) => row.origin !== 'imported' && row.source !== 'note';

export async function cmdForget(f: ForgetFlags, refArg?: string): Promise<void> {
  const root = findRelayRoot(process.cwd());
  if (!root) die('未找到 .sessionrelay（本项目尚未初始化）', '在项目根目录运行 srelay init');
  // 写命令不走 requireRoot 的懒启动守护——--all 必须能看见真实守护状态，且守护与删除无并发必要
  const cfg = loadConfig(root);

  // ── 审计历史模式 ──
  if (f.history) {
    const db = openExisting(dbFile(root));
    try {
      const rows = getForgetHistory(db, { verbose: f.verbose });
      if (f.json) { console.log(JSON.stringify(rows, null, 2)); return; }
      if (rows.length === 0) { console.log(pc.dim('（暂无遗忘记录）')); return; }
      for (const row of rows) {
        console.log(`${fmtDate(row.created_at as string)}  ${row.mode} · ${row.sessions_affected} 会话 · ${row.messages_affected} 消息  ${pc.dim(`#${row.id}`)}`);
        if (Array.isArray(row.details)) {
          for (const d of row.details as Array<Record<string, unknown>>) {
            console.log(`    · ${d.session_id} 「${String(d.title ?? '').slice(0, 28)}」 · ${d.message_count}msg · ${d.source}`);
          }
        }
      }
      return;
    } finally { db.close(); }
  }

  // ── 整库重置（--all）──
  if (f.all) {
    await cmdForgetAll(root, cfg, f);
    return;
  }

  // ── 单会话删除 ──
  if (!refArg) {
    console.log(pc.red('用法：srelay forget <id|前缀> [--yes] | --all --confirm <projectId> | --history'));
    process.exit(2);
  }

  const db = openExisting(dbFile(root));
  try {
    const resolved = resolveRef(db, refArg);
    if (!resolved.ok) {
      if (resolved.reason === 'not_found') {
        die(`未找到会话：${refArg}`, '用 srelay list 查看完整 id');
      }
      // 歧义：表格化候选（设计 §3.5 评审 D2），不用一句话 error 打发
      console.log(pc.red(`✗ 前缀「${refArg}」匹配 ${resolved.candidates.length}${resolved.candidates.length === 10 ? '+' : ''} 个会话，拒绝执行：`));
      for (const c of resolved.candidates) {
        console.log(`  ${c.id}  「${(c.title ?? '').slice(0, 24)}」 · ${c.source} · ${(c.createdAt ?? '').slice(0, 10)} · ${c.messageCount}msg`);
      }
      console.log(pc.dim('  用更多字符或完整 id 重试'));
      process.exit(2);
    }
    const row = resolved.row;

    const mismatch = typeFilterMismatch(f, row);
    if (mismatch) die(mismatch);

    const links = getLinkedSessions(db, row.id);
    const decisionCount = row.decisions.length;
    const isNote = row.source === 'note';

    // 预览模式（无 --yes 不删——防误触）
    if (!f.yes) {
      writeSnapshot(root, { id: row.id, messageCount: row.messageCount, decisionCount, linkCount: links.length, previewedAt: new Date().toISOString() });
      if (f.json) {
        console.log(JSON.stringify({
          id: row.id, title: row.title, source: row.source, origin: row.origin, state: row.state,
          createdAt: row.createdAt, ageDays: ageDays(row.createdAt), messageCount: row.messageCount,
          decisionCount, links: links.map((l) => ({ id: l.sessionId, kind: l.kind, direction: l.direction })),
          barriers: needsBarriers(row), reversible: false,
        }, null, 2));
        return;
      }
      console.log(pc.cyan('📊 遗忘预览（不可逆）'));
      console.log('─'.repeat(50));
      console.log(`会话 ${row.id} 「${(row.title ?? row.sourceSessionId).slice(0, 40)}」`);
      console.log(`  来源 ${row.source} · ${(row.createdAt ?? '').slice(0, 10)}（${ageDays(row.createdAt)}）· ${row.messageCount} 条消息 · ${decisionCount} 决策 · imported ${row.origin === 'imported' ? '是' : '否'}`);
      const linkPart = links.length > 0 ? ` · 双向链接（对方 ${links.length} 条：${links.slice(0, 5).map((l) => l.sessionId).join('、')}${links.length > 5 ? '…' : ''}）` : '';
      console.log(`  ${pc.red('移除')}：对话正文 · 决策 · 话题${linkPart}`);
      console.log(`  ${pc.green('保留')}：${isNote || row.origin === 'imported' ? '（无本地源文件，不可重建）' : '原始会话文件（磁盘上不受影响，但本库不再收录）'}`);
      if (needsBarriers(row)) console.log(`  写入防复活闸：ignore session: 规则 + 墓碑`);
      if (row.origin === 'imported') console.log(pc.yellow('  ⚠️ imported 会话：删除后无法 rebuild 找回'));
      console.log(pc.dim('  审计：本次操作将记入 forget_log'));
      console.log(pc.dim('  确认执行加 --yes'));
      return;
    }

    // ── 执行（--yes）：乐观锁 diff（设计 §3.6 并发安全） ──
    const snap = readSnapshot(root);
    if (snap && snap.id === row.id) {
      if (snap.messageCount !== row.messageCount || snap.decisionCount !== decisionCount) {
        die(
          `预览后数据已变化（消息 ${snap.messageCount}→${row.messageCount}，决策 ${snap.decisionCount}→${decisionCount}），已拒绝执行`,
          '守护进程可能新捕了消息；重新运行不带 --yes 的预览确认最新数字后再执行',
        );
      }
    }

    const now = new Date().toISOString();
    const del = db.transaction(() => {
      const logId = insertForgetLog(db, { triggeredBy: 'cli:forget', mode: isNote ? 'note' : 'session', criteria: refArg });
      insertForgetDetail(db, {
        forgetLogId: logId, sessionId: row.id, title: row.title, source: row.source,
        messageCount: row.messageCount, createdAt: row.createdAt,
      });
      const changes = db.prepare('DELETE FROM sessions WHERE id = ?').run(row.id).changes; // FK CASCADE：messages/session_links；FTS 触发器同步
      if (needsBarriers(row)) insertTombstone(db, row.source, row.sourceSessionId, now);
      finalizeForgetLog(db, logId, changes, row.messageCount);
      return changes;
    });
    const changes = del();
    clearSnapshot(root);

    // 库外文件操作（顺序：先库后文件；文件失败时墓碑在库内兜底）
    if (changes > 0 && needsBarriers(row)) {
      try { appendSessionIgnoreRule(root, row.source, row.sourceSessionId); } catch { /* 墓碑已兜底 */ }
    }

    if (changes === 0) die(`会话 ${row.id} 已不存在（可能已被删除）`);
    if (f.json) {
      console.log(JSON.stringify({ ok: true, id: row.id, messageCount: row.messageCount, barriers: needsBarriers(row) }));
      return;
    }
    console.log(pc.green('✓') + ` 已遗忘 ${row.id} 「${(row.title ?? row.sourceSessionId).slice(0, 40)}」（${row.messageCount} 条消息）`);
    if (needsBarriers(row)) {
      console.log(pc.dim(`  防复活闸已写入：${ignoreFile(root).replace(/\\/g, '/')} + 墓碑`));
      console.log(pc.yellow(`  ⚠️ 原始会话文件仍在磁盘（${row.sourceFile ?? ''}），本库不再收录`));
    }
    console.log(pc.dim('  审计已记入 forget_log（srelay forget --history 查看）'));
  } finally {
    db.close();
  }
}

/** --all 整库重置（设计 §3.7）：守护拦截 + --confirm 逐字匹配 + 库三连删 + 库外摘要 */
async function cmdForgetAll(root: string, cfg: ReturnType<typeof loadConfig>, f: ForgetFlags): Promise<void> {
  const alive = isDaemonAlive(root);
  if (alive.alive) {
    die(`守护进程运行中 (pid ${alive.pid})，整库重置会与写入竞争`, '先停止守护（srelay watch --uninstall 或任务管理器结束）再执行');
  }
  const projectId = cfg.identity.project_id ?? root;
  if (f.confirm !== projectId) {
    die(`--all 需要 --confirm <projectId> 逐字确认`, `本项目 id：${projectId}`);
  }

  const main = dbFile(root);
  const stats = { sessions: 0, messages: 0, logs: 0 };
  if (fs.existsSync(main)) {
    const db = openExisting(main);
    try {
      stats.sessions = (db.prepare('SELECT COUNT(*) n FROM sessions').get() as { n: number }).n;
      stats.messages = (db.prepare('SELECT COUNT(*) n FROM messages').get() as { n: number }).n;
      stats.logs = (db.prepare('SELECT COUNT(*) n FROM forget_log').get() as { n: number }).n;
    } finally { db.close(); }
  }

  for (const ext of ['', '-wal', '-shm']) fs.rmSync(main + ext, { force: true });
  const fresh = createDb(main); // 重建空库（schema v3）
  fresh.close();

  // 库外摘要：forget_log 随库删除后的最后一行审计（设计 §3.7）
  const ts = new Date();
  const summaryName = `forgot-at-${ts.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}.txt`;
  fs.writeFileSync(path.join(relayDir(root), summaryName),
    `整库遗忘（srelay forget --all）\n时间：${ts.toISOString()}\n项目：${projectId}\n删除：${stats.sessions} 会话 / ${stats.messages} 消息 / ${stats.logs} 条遗忘审计\n注意：.sessionrelayignore（含全部 session: 防复活规则）已保留——源文件不会再被收录。\n`);

  clearSnapshot(root);
  if (f.json) { console.log(JSON.stringify({ ok: true, ...stats, summary: summaryName })); return; }
  console.log(pc.green('✓') + ` 整库遗忘完成：${stats.sessions} 会话 · ${stats.messages} 消息已抹除，空库已重建`);
  console.log(pc.dim(`  摘要：${summaryName}`));
  console.log(pc.dim(`  .sessionrelayignore 已保留（防复活规则仍在，源文件不会重新入库）`));
}
