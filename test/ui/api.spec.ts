// ui 数据装配（design-dashboard §4.3/§4.4）：白名单、聚合、增长、缓存路径。
// 环境纪律：SRELAY_REGISTRY_DIR 重定向到临时目录，绝不污染真实家目录注册表。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createDb, openExisting, insertSession, insertMessage } from '../../src/store/db.js';
import { dbFile, projectIdOf, ignoreFile } from '../../src/shared/paths.js';
import { touchRegistry } from '../../src/shared/registry.js';
import { defaultConfig, saveConfig } from '../../src/shared/config.js';
import { loadTombstones, getForgetHistory } from '../../src/store/db.js';
import { uiOverview, uiProject, uiSessions, uiGrowth, uiSession, uiSessionMessages, uiSessionSearch, uiProjectHealth, uiForgetSession, closeAllDbs, NotRegistered, SessionNotFound } from '../../src/ui/api.js';

const TMP = path.resolve('test/.tmp/ui-api');
const REG = path.join(TMP, 'registry');
const PROJ_A = path.join(TMP, 'proj-a');
const PROJ_B = path.join(TMP, 'proj-b');

process.env.SRELAY_REGISTRY_DIR = REG; // registryDir() 逐次读 env，模块级设置即可

function makeProj(dir: string): void {
  fs.mkdirSync(path.join(dir, '.sessionrelay'), { recursive: true });
  const cfg = defaultConfig();
  cfg.identity.project_id = projectIdOf(dir);
  saveConfig(dir, cfg);
}

beforeAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  makeProj(PROJ_A);
  makeProj(PROJ_B);
  const now = new Date().toISOString();
  const yday = new Date(Date.now() - 86_400_000).toISOString();
  const db = createDb(dbFile(PROJ_A));
  const pid = projectIdOf(PROJ_A);
  insertSession(db, { id: 'sess-a1', source: 'zcode', sourceSessionId: 'z1', projectId: pid, createdAt: now, title: '选型讨论', topics: [] });
  insertSession(db, { id: 'sess-a2', source: 'claude-code', sourceSessionId: 'c1', projectId: pid, createdAt: now, title: '会话二', topics: [] });
  insertMessage(db, { sessionId: 'sess-a1', role: 'user', content: '磁悬浮轴承选型讨论：决定采用 PG', seqNum: 1, createdAt: now });
  insertMessage(db, { sessionId: 'sess-a1', role: 'assistant', content: '好的', seqNum: 2, createdAt: now });
  insertMessage(db, { sessionId: 'sess-a2', role: 'user', content: '昨天的一条历史消息', seqNum: 1, createdAt: yday });
  db.prepare(`UPDATE sessions SET state='confirmed', message_count=2, last_event_at=?, decisions=?, key_questions=? WHERE id='sess-a1'`)
    .run(now, JSON.stringify([{ text: '决定采用 PG', seq: 1, at: now }]), JSON.stringify([{ q: '部署方案？', at: now, unresolved: true }]));
  db.prepare(`UPDATE sessions SET state='active', message_count=1, last_event_at=? WHERE id='sess-a2'`).run(now);
  db.close();
  // B：只有 schema 的空库（overview 不得因空库报错）
  createDb(dbFile(PROJ_B)).close();
  touchRegistry(PROJ_A);
  touchRegistry(PROJ_B);
});

afterAll(() => {
  closeAllDbs();
  fs.rmSync(TMP, { recursive: true, force: true });
  delete process.env.SRELAY_REGISTRY_DIR;
});

describe('ui · 数据装配', () => {
  it('overview：注册项目齐全、聚合正确、空库项目不报错', () => {
    const d = uiOverview();
    expect(d.projects.map((p) => p.name).sort()).toEqual(['proj-a', 'proj-b']);
    const a = d.projects.find((p) => p.root === PROJ_A)!;
    expect(a.sessions).toEqual({ confirmed: 1, active: 1 });
    expect(a.bySource).toEqual({ zcode: 1, 'claude-code': 1 });
    expect(a.messageTotal).toBe(3);
    expect(a.error).toBeUndefined();
    const b = d.projects.find((p) => p.root === PROJ_B)!;
    expect(b.error).toBeUndefined();
    expect(b.messageTotal).toBe(0);
    expect(d.totals.projects).toBe(2);
    expect(d.totals.messages).toBe(3);
  });

  it('overview 二次调用走缓存仍正确（§4.4 TTL 路径）', () => {
    const d = uiOverview();
    expect(d.projects.length).toBe(2);
  });

  it('project：构成/决策最新在前/未决问题', () => {
    const d = uiProject(PROJ_A);
    expect(d.decisions[0]!.text).toBe('决定采用 PG');
    expect(d.unresolved[0]!.q).toBe('部署方案？');
    expect(d.sessions['confirmed']).toBe(1);
  });

  it('sessions：状态过滤命中', () => {
    const d = uiSessions(PROJ_A, { state: 'confirmed' });
    expect(d.mode).toBe('list');
    expect(d.rows.map((r) => r.id)).toEqual(['sess-a1']);
  });

  it('growth：今昨两桶共 3 条消息，今日 2 个活跃会话', () => {
    const g = uiGrowth(PROJ_A, 7);
    expect(g.reduce((n, x) => n + x.msgs, 0)).toBe(3);
    expect(g.length).toBeGreaterThanOrEqual(2);
    const today = new Date().toISOString().slice(0, 10);
    expect(g.find((x) => x.date === today)!.sess).toBe(2);
  });

  it('sessions：day 下钻过滤（当天有活动的会话）', () => {
    const today = new Date().toISOString().slice(0, 10);
    const d = uiSessions(PROJ_A, { day: today });
    expect(d.rows.length).toBe(2);
    expect(d.day).toBe(today);
    expect(uiSessions(PROJ_A, { day: '2020-01-01' }).rows.length).toBe(0);
    expect(uiSessions(PROJ_A, { day: 'not-a-date' }).rows.length).toBe(2); // 非法日期忽略
  });

  it('sessions：分页翻页内容必须变化（回归：曾因缺 OFFSET 每页同数据）', () => {
    // 独立项目造 25 个会话，页大小 20 → 第 1 页 20 条，第 2 页 5 条且与第 1 页无重叠
    const PROJ_C = path.join(TMP, 'proj-c');
    makeProj(PROJ_C);
    const db = createDb(dbFile(PROJ_C));
    const pid = projectIdOf(PROJ_C);
    const now = new Date().toISOString();
    for (let i = 1; i <= 25; i++) {
      insertSession(db, { id: 'pc-' + String(i).padStart(2, '0'), source: 'zcode', sourceSessionId: 'zc-' + i, projectId: pid, createdAt: now, title: '会话' + i, topics: [] });
      db.prepare('UPDATE sessions SET last_event_at = ? WHERE id = ?').run(now, 'pc-' + String(i).padStart(2, '0'));
    }
    db.close();
    touchRegistry(PROJ_C);
    const p1 = uiSessions(PROJ_C, {});
    expect(p1.rows.length).toBe(20);
    expect(p1.hasMore).toBe(true);
    const p2 = uiSessions(PROJ_C, { page: 2 });
    expect(p2.rows.length).toBe(5);
    expect(p2.hasMore).toBe(false);
    const ids1 = new Set(p1.rows.map((r) => r.id));
    expect(p2.rows.every((r) => !ids1.has(r.id))).toBe(true); // 两页零重叠
    expect(uiSessions(PROJ_C, { page: 99 }).rows.length).toBe(0); // 越界空页
  });

  it('白名单（U6）：未注册 root 一律 NotRegistered', () => {
    expect(() => uiProject(path.join(TMP, 'not-registered'))).toThrow(NotRegistered);
    expect(() => uiSessions(path.join(TMP, 'not-registered'), {})).toThrow(NotRegistered);
    expect(() => uiGrowth(path.join(TMP, 'not-registered'))).toThrow(NotRegistered);
  });
});

describe('ui · 会话详情（v1.2）', () => {
  it('session：元信息含决策/关键问题/主题', () => {
    const m = uiSession(PROJ_A, 'sess-a1');
    expect(m.title).toBe('选型讨论');
    expect(m.messageCount).toBe(2);
    expect(m.decisions[0]!.text).toBe('决定采用 PG');
    expect(m.decisions[0]!.seq).toBe(1);
    expect(m.questions[0]!.q).toBe('部署方案？');
    expect(m.questions[0]!.unresolved).toBe(true);
    expect(() => uiSession(PROJ_A, 'nope')).toThrow(SessionNotFound);
  });

  it('messages：范围、钳制与截断标记', () => {
    const d = uiSessionMessages(PROJ_A, 'sess-a1', 1);
    expect(d.from).toBe(1); expect(d.to).toBe(2); expect(d.maxSeq).toBe(2);
    expect(d.pages).toBe(1);
    expect(d.msgs.map((m) => m.seq)).toEqual([1, 2]);
    expect(d.msgs[0]!.truncated).toBe(false);
    const clamped = uiSessionMessages(PROJ_A, 'sess-a1', 999);
    expect(clamped.from).toBe(1); // 超界钳回首页
  });

  it('search：原文命中、片段含关键词、转义不误配', () => {
    const hit = uiSessionSearch(PROJ_A, 'sess-a1', '磁悬浮');
    expect(hit.total).toBe(1);
    expect(hit.matches[0]!.seq).toBe(1);
    expect(hit.matches[0]!.snippet).toContain('磁悬浮');
    expect(uiSessionSearch(PROJ_A, 'sess-a1', '').total).toBe(0);
    expect(uiSessionSearch(PROJ_A, 'sess-a1', '%').total).toBe(0); // % 不当通配符
    expect(uiSessionSearch(PROJ_A, 'sess-a1', '不存在词xyz').total).toBe(0);
  });

  it('health：日志尾部与计数器快照', () => {
    fs.writeFileSync(path.join(PROJ_A, '.sessionrelay', 'watch.log'), 'line1\nline2\ntail-line3\n', 'utf8');
    const h = uiProjectHealth(PROJ_A);
    expect(h.logTail).toEqual(['line1', 'line2', 'tail-line3']);
    expect(h.stats).toEqual({});
    const h2 = uiProjectHealth(PROJ_B); // 无日志 → 空
    expect(h2.logTail).toEqual([]);
  });
});

describe('ui · 会话遗忘（v1.4 · U14：与 CLI forget 同核心）', () => {
  const PROJ_D = path.join(TMP, 'proj-d');
  const now = new Date().toISOString();

  it('独立项目造会话并预热缓存', () => {
    makeProj(PROJ_D);
    const db = createDb(dbFile(PROJ_D));
    const pid = projectIdOf(PROJ_D);
    insertSession(db, { id: 'fd-1', source: 'zcode', sourceSessionId: 'zd-1', projectId: pid, createdAt: now, title: '待遗忘的会话', topics: [] });
    insertMessage(db, { sessionId: 'fd-1', role: 'user', content: '内容', seqNum: 1, createdAt: now });
    db.prepare(`UPDATE sessions SET state='confirmed', message_count=1, last_event_at=? WHERE id='fd-1'`).run(now);
    db.close();
    touchRegistry(PROJ_D);
    uiOverview(); uiGrowth(PROJ_D, 7); // 预热卡片与增长缓存
  });

  it('forget：删除生效 + 墓碑 + ignore 规则 + 审计 + 缓存失效', () => {
    const r = uiForgetSession(PROJ_D, 'fd-1');
    expect(r.messageCount).toBe(1);
    expect(r.barriers).toBe(true); // zcode 捕获会话 → 写防复活闸
    // 会话已消失
    expect(() => uiSession(PROJ_D, 'fd-1')).toThrow(SessionNotFound);
    // 缓存立即失效：overview 反映 0 会话
    const d = uiOverview().projects.find((p) => p.root === PROJ_D)!;
    expect(Object.values(d.sessions).reduce((a, b) => a + b, 0)).toBe(0);
    // 防复活双闸：墓碑 + ignore 规则
    const db2 = openExisting(dbFile(PROJ_D));
    expect(loadTombstones(db2).has('zcode:zd-1')).toBe(true);
    expect(getForgetHistory(db2).length).toBe(1); // 审计
    db2.close();
    expect(fs.readFileSync(ignoreFile(PROJ_D), 'utf8')).toContain('session:zcode/zd-1');
    // 幂等性：再删同一条 → SessionNotFound（不再报"已不存在"内部错误）
    expect(() => uiForgetSession(PROJ_D, 'fd-1')).toThrow(SessionNotFound);
  });
});
