// ui 数据装配（design-dashboard §4.3/§4.4）：白名单、聚合、增长、缓存路径。
// 环境纪律：SRELAY_REGISTRY_DIR 重定向到临时目录，绝不污染真实家目录注册表。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createDb, insertSession, insertMessage } from '../../src/store/db.js';
import { dbFile, projectIdOf } from '../../src/shared/paths.js';
import { touchRegistry } from '../../src/shared/registry.js';
import { defaultConfig, saveConfig } from '../../src/shared/config.js';
import { uiOverview, uiProject, uiSessions, uiGrowth, uiSession, uiSessionMessages, uiSessionSearch, uiProjectHealth, closeAllDbs, NotRegistered, SessionNotFound } from '../../src/ui/api.js';

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

  it('growth：今昨两桶共 3 条', () => {
    const g = uiGrowth(PROJ_A, 7);
    expect(g.reduce((n, x) => n + x.msgs, 0)).toBe(3);
    expect(g.length).toBeGreaterThanOrEqual(2);
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
