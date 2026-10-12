// ui 仪表盘数据装配（design-dashboard §4）：注册表白名单 + 只读连接 + TTL 缓存。
// 纪律：本模块绝不写任何文件；root 一律先过注册表白名单（U6，防任意目录读取）。
import fs from 'node:fs';
import path from 'node:path';
import { registryCandidates } from '../shared/registry.js';
import { loadConfig } from '../shared/config.js';
import { dbFile, projectIdOf, relayDir } from '../shared/paths.js';
import {
  openReadonly, countsByState, countsBySource, projectSummary, growthByDay,
  listSessions, getSession, getSessionFull, getMessageRange, searchInSession,
  listDecisions, listUnresolved, type DB,
} from '../store/db.js';
import { searchSessions } from '../search-svc/engine.js';
import { openStats } from '../core/stats/counter.js';

/** root 不在注册表（安全边界，server 层转 404） */
export class NotRegistered extends Error {
  constructor(root: string) { super(`project not registered: ${root}`); }
}

/** 会话不存在（server 层转 404） */
export class SessionNotFound extends Error {
  constructor(id: string) { super(`session not found: ${id}`); }
}

// ── 只读连接缓存：文件身份（mtime+size）变了就重开（rebuild 会换库文件） ──
const conns = new Map<string, { db: DB; mtimeMs: number; size: number }>();

function connOf(root: string): DB {
  const f = dbFile(root);
  const st = fs.statSync(f); // 不存在 → 抛错，由调用方转错误卡片
  const hit = conns.get(root);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.db;
  hit?.db.close();
  const db = openReadonly(f);
  conns.set(root, { db, mtimeMs: st.mtimeMs, size: st.size });
  return db;
}

export function closeAllDbs(): void {
  for (const v of conns.values()) v.db.close();
  conns.clear();
}

// ── 聚合缓存（design §4.4：卡片 3s / 增长 30s）──
const TTL_CARD = 3_000;
const TTL_GROWTH = 30_000;
const cardCache = new Map<string, { snap: UiProjectCard; at: number }>();
const growthCache = new Map<string, { snap: Array<{ date: string; msgs: number; sess: number }>; at: number }>();

export interface UiProjectCard {
  root: string; name: string; daemonAlive: boolean; lastActiveAt: string | null;
  mode: string; dbBytes: number;
  sessions: Record<string, number>; bySource: Record<string, number>;
  messageTotal: number; lastEventAt: string | null;
  error?: string;
}

function fileBytes(f: string): number {
  try { return fs.statSync(f).size; } catch { return 0; }
}

function cardOf(c: { root: string; name: string; daemonAlive: boolean; lastActiveAt: string | null }): UiProjectCard {
  let mode = 'full';
  try { mode = loadConfig(c.root).capture.mode; } catch { /* 配置缺失/损坏 → 显示默认 */ }
  const base: UiProjectCard = {
    root: c.root, name: c.name, daemonAlive: c.daemonAlive, lastActiveAt: c.lastActiveAt,
    mode, dbBytes: fileBytes(dbFile(c.root)),
    sessions: {}, bySource: {}, messageTotal: 0, lastEventAt: null,
  };
  try {
    const pid = projectIdOf(c.root);
    const db = connOf(c.root);
    const sum = projectSummary(db, pid);
    return {
      ...base,
      sessions: countsByState(db, pid),
      bySource: countsBySource(db, pid),
      messageTotal: sum.messageTotal,
      lastEventAt: sum.lastEventAt,
    };
  } catch {
    return { ...base, error: '库不可读（可能正在迁移或由更新版本创建）' };
  }
}

export function uiOverview(): { projects: UiProjectCard[]; totals: { projects: number; sessions: number; messages: number; dbBytes: number } } {
  const now = Date.now();
  const projects = registryCandidates().map((c) => {
    const hit = cardCache.get(c.root);
    if (hit && now - hit.at < TTL_CARD) return hit.snap;
    const snap = cardOf(c);
    cardCache.set(c.root, { snap, at: now });
    return snap;
  });
  const totals = {
    projects: projects.length,
    sessions: projects.reduce((n, p) => n + Object.values(p.sessions).reduce((a, b) => a + b, 0), 0),
    messages: projects.reduce((n, p) => n + p.messageTotal, 0),
    dbBytes: projects.reduce((n, p) => n + p.dbBytes, 0),
  };
  return { projects, totals };
}

function mustRegistered(root: string): { root: string; name: string; daemonAlive: boolean; lastActiveAt: string | null } {
  const abs = path.resolve(root);
  const c = registryCandidates().find((x) => path.resolve(x.root) === abs);
  if (!c) throw new NotRegistered(root);
  return c;
}

export function uiProject(root: string) {
  const c = mustRegistered(root);
  const pid = projectIdOf(c.root);
  const db = connOf(c.root);
  // listDecisions 现为时间升序（PR#3 批一将改为降序）：这里统一"最新在前"，两头都成立
  const decisions = listDecisions(db, pid).slice(-10).reverse()
    .map((d) => ({ at: d.at, source: d.source, text: d.text, title: d.title, sessionId: d.sessionId }));
  const sum = projectSummary(db, pid);
  return {
    root: c.root, name: c.name, daemonAlive: c.daemonAlive, lastActiveAt: c.lastActiveAt,
    mode: loadConfig(c.root).capture.mode,
    dbBytes: fileBytes(dbFile(c.root)), logBytes: fileBytes(path.join(relayDir(c.root), 'watch.log')),
    sessions: countsByState(db, pid), bySource: countsBySource(db, pid),
    messageTotal: sum.messageTotal, lastEventAt: sum.lastEventAt,
    decisions, unresolved: listUnresolved(db, pid, 10),
  };
}

export interface UiSessionRow {
  id: string; source: string; state: string; title: string | null;
  createdAt: string; lastEventAt: string | null; messageCount: number;
  snippet?: string;
}

const PAGE_SIZE = 20;

export function uiSessions(root: string, opts: { state?: string; source?: string; q?: string; page?: number; day?: string }) {
  const c = mustRegistered(root);
  const pid = projectIdOf(c.root);
  const db = connOf(c.root);
  if (opts.q && opts.q.trim()) {
    const hits = searchSessions(db, { project: pid, query: opts.q.trim(), limit: 50 });
    const rows: UiSessionRow[] = [];
    for (const h of hits) {
      const s = getSession(db, h.sessionId);
      if (!s) continue;
      rows.push({
        id: s.id, source: s.source, state: s.state, title: s.title,
        createdAt: s.created_at, lastEventAt: s.last_event_at, messageCount: s.message_count,
        snippet: h.snippet,
      });
    }
    return { mode: 'search' as const, page: 1, hasMore: false, rows };
  }
  const page = Math.max(1, opts.page ?? 1);
  // 图表下钻：当天有活动的会话（last_event_at 落在该日）
  const day = opts.day && /^\d{4}-\d{2}-\d{2}$/.test(opts.day) ? opts.day : null;
  const got = listSessions(db, {
    projectId: pid, state: opts.state || undefined, source: opts.source || undefined,
    limit: PAGE_SIZE + 1, offset: (page - 1) * PAGE_SIZE,
    where: day ? { sql: 'date(COALESCE(s.last_event_at, s.created_at)) = ?', params: [day] } : null,
  });
  const hasMore = got.length > PAGE_SIZE;
  return {
    mode: 'list' as const, page, hasMore, day,
    rows: got.slice(0, PAGE_SIZE).map((s) => ({
      id: s.id, source: s.source, state: s.state, title: s.title,
      createdAt: s.created_at, lastEventAt: s.last_event_at, messageCount: s.message_count,
    })),
  };
}

export function uiGrowth(root: string, days = 30): Array<{ date: string; msgs: number; sess: number }> {
  const c = mustRegistered(root);
  const d = Math.min(90, Math.max(1, days));
  const key = `${c.root}|${d}`;
  const hit = growthCache.get(key);
  if (hit && Date.now() - hit.at < TTL_GROWTH) return hit.snap;
  const snap = growthByDay(connOf(c.root), projectIdOf(c.root), d);
  growthCache.set(key, { snap, at: Date.now() });
  return snap;
}

// ── 会话详情（v1.2：下钻 + 会话内关键词搜索）──

/** 单条消息正文截断上限：超长工具转储不整段回传（全文看 CLI show，ui 是浏览面） */
const MSG_CAP = 4_000;
const MSG_PAGE = 50;

export function uiSession(root: string, id: string) {
  const c = mustRegistered(root);
  const s = getSessionFull(connOf(c.root), id);
  if (!s) throw new SessionNotFound(id);
  return s;
}

export function uiSessionMessages(root: string, id: string, from?: number) {
  const c = mustRegistered(root);
  const db = connOf(c.root);
  const s = getSession(db, id);
  if (!s) throw new SessionNotFound(id);
  const maxSeq = Math.max(s.message_count, 0);
  const f = Math.min(Math.max(1, from ?? 1), Math.max(1, maxSeq - MSG_PAGE + 1));
  const to = Math.min(maxSeq, f + MSG_PAGE - 1);
  const msgs = getMessageRange(db, id, f, to).map((m) => ({
    seq: m.seq_num, role: m.role, at: m.created_at,
    content: m.content.length > MSG_CAP ? m.content.slice(0, MSG_CAP) : m.content,
    truncated: m.content.length > MSG_CAP, fullLen: m.content.length,
  }));
  return { from: f, to, maxSeq, page: Math.floor((f - 1) / MSG_PAGE) + 1, pages: Math.max(1, Math.ceil(maxSeq / MSG_PAGE)), msgs };
}

export function uiSessionSearch(root: string, id: string, q: string) {
  const c = mustRegistered(root);
  const db = connOf(c.root);
  const s = getSession(db, id);
  if (!s) throw new SessionNotFound(id);
  const kw = q.trim();
  if (!kw) return { total: 0, matches: [] };
  return searchInSession(db, id, kw);
}

/** 项目健康（design v1.1 健康区）：watch.log 尾部 + 匿名计数器快照 */
export function uiProjectHealth(root: string) {
  const c = mustRegistered(root);
  const logFile = path.join(relayDir(c.root), 'watch.log');
  let logTail: string[] = [];
  try {
    const st = fs.statSync(logFile);
    const fh = fs.openSync(logFile, 'r');
    try {
      const len = Math.min(st.size, 8_192);
      const buf = Buffer.alloc(len);
      fs.readSync(fh, buf, 0, len, st.size - len);
      logTail = buf.toString('utf8').split(/\r?\n/).filter(Boolean).slice(-40);
    } finally { fs.closeSync(fh); }
  } catch { /* 无日志 → 空 */ }
  return { logTail, stats: openStats(c.root).snapshot() };
}
