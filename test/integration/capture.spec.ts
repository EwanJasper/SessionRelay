// Phase 1 捕获链集成测试（方针 §12 Phase 1 验收项的自动化对应）
// 覆盖：入库/幂等/resume 回滚/判定两阶段/三档模式/ignore/zcode 假库
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { runSync } from '../../src/capture/sync.js';
import { resetConn } from '../../src/adapters/zcode/index.js';
import { runJudge } from '../../src/capture/judge.js';
import { createDb, countsByState, listSessions, getSession, countMessages } from '../../src/store/db.js';
import { defaultConfig, type RelayConfig } from '../../src/shared/config.js';
import { projectIdOf } from '../../src/shared/paths.js';
import { searchSessions } from '../../src/search-svc/engine.js';

const TMP = path.resolve('test/.tmp/p1');
const PROJECT = path.join(TMP, 'myapp');          // 假项目根
const CLAUDE_BASE = path.join(TMP, 'claude-projects');
const ZCODE_DB = path.join(TMP, 'zcode', 'db.sqlite');
const PID = projectIdOf(PROJECT);

beforeAll(() => {
  for (let i = 0; i < 3; i++) { try { fs.rmSync(TMP, { recursive: true, force: true }); break; } catch { /* retry */ } }
  fs.mkdirSync(PROJECT, { recursive: true });
  fs.mkdirSync(path.join(PROJECT, '.sessionrelay'), { recursive: true });
});

afterAll(() => {
  resetConn(); // 释放 ZCode 缓存连接（否则 Windows 无法删除 db.sqlite）
  for (let i = 0; i < 3; i++) { try { fs.rmSync(TMP, { recursive: true, force: true }); return; } catch { /* retry */ } }
});

const cfg = (over: Partial<RelayConfig['capture']> = {}): RelayConfig => ({
  ...defaultConfig(),
  capture: {
    ...defaultConfig().capture,
    claude_projects_dir: CLAUDE_BASE,
    zcode_db_path: ZCODE_DB,
    ...over,
  },
});

const claudeLine = (i: number, role: 'user' | 'assistant', text: string, ts = `2026-08-2${Math.min(8, 1 + i % 8)}T10:00:00Z`) =>
  JSON.stringify({ type: role, message: { role, content: text }, timestamp: ts, sessionId: 'sess-a', cwd: PROJECT, isSidechain: false });

function writeClaudeSession(id: string, lines: string[]) {
  // 目录 slug 与 Claude Code 命名规则一致：D:\x\y → D--x-y
  const slug = PROJECT.replace(/[\\/:]/g, '-');
  const dir = path.join(CLAUDE_BASE, slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), lines.join('\n') + '\n');
  return path.join(dir, `${id}.jsonl`);
}

describe('P1 · claude-code 捕获链', () => {
  it('首次入库：会话/消息/标题/meta_text', async () => {
    writeClaudeSession('aaa', [
      claudeLine(1, 'user', '我们讨论数据库索引方案'),
      JSON.stringify({ type: 'summary', summary: '非消息行应跳过' }),
      claudeLine(2, 'assistant', '建议按月分区，B+树索引'),
      JSON.stringify({ type: 'user', isSidechain: true, message: { role: 'user', content: '子链跳过' } }),
      'not-json-line',
    ]);
    const db = createDb();
    const s = await runSync({ projectRoot: PROJECT, config: cfg(), db });
    expect(s.discovered).toBe(1);
    expect(s.newSessions).toBe(1);
    expect(s.newMessages).toBe(2);
    expect(s.badLines).toBe(1);
    const rows = listSessions(db, { projectId: PID });
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('我们讨论数据库索引方案');
    expect(rows[0].source).toBe('claude-code');
    expect(rows[0].state).toBe('active');
    expect(rows[0].message_count).toBe(2); // full 模式必须维护计数（list/detail/摘要依赖）
    // 中文检索可用（正文已分词入 FTS）
    const hits = searchSessions(db, { project: PID, query: '索引 分区' });
    expect(hits.map(h => h.sessionId)).toContain(rows[0].id);
    db.close();
  });

  it('重放幂等：offset 回退/重复 sync 零新增（T20 验收）', async () => {
    const db = createDb();
    await runSync({ projectRoot: PROJECT, config: cfg(), db });
    const again = await runSync({ projectRoot: PROJECT, config: cfg(), db });
    expect(again.newSessions).toBe(0);
    expect(again.newMessages).toBe(0);
    const rows = listSessions(db, { projectId: PID });
    expect(countMessages(db, rows[0].id)).toBe(2);
    db.close();
  });

  it('判定两阶段：idle→pending，cooldown→confirmed（fake clock）', async () => {
    const db = createDb();
    await runSync({ projectRoot: PROJECT, config: cfg(), db });
    const rows = listSessions(db, { projectId: PID });
    const sid = rows[0].id;
    const t0 = new Date('2026-08-28T12:00:00Z');
    const j1 = runJudge(db, { projectId: PID, now: new Date(t0.getTime() + 11 * 60_000), idleMin: 10, cooldownH: 6 });
    expect(j1.toPending).toBe(1);
    expect(getSession(db, sid)!.state).toBe('pending_end');
    const j2 = runJudge(db, { projectId: PID, now: new Date(t0.getTime() + 11 * 60_000 + 7 * 3_600_000), idleMin: 10, cooldownH: 6 });
    expect(j2.confirmed).toBe(1);
    expect(getSession(db, sid)!.state).toBe('confirmed');
    db.close();
  });

  it('resume 回滚：confirmed 会话追加新行 → active + 摘要清除', async () => {
    const f = writeClaudeSession('bbb', [claudeLine(1, 'user', '认证方案讨论')]);
    const db = createDb();
    await runSync({ projectRoot: PROJECT, config: cfg(), db });
    const sid = listSessions(db, { projectId: PID }).find(r => r.source_session_id === 'bbb')!.id;
    // 手动 confirmed + 摘要（模拟 Phase 2 副作用）
    db.prepare('UPDATE sessions SET state=?, summary_rule=? WHERE id=?').run('confirmed', '旧摘要', sid);
    fs.appendFileSync(f, claudeLine(2, 'assistant', '用 JWT 做认证') + '\n');
    const s = await runSync({ projectRoot: PROJECT, config: cfg(), db });
    expect(s.resumed).toBe(1);
    const row = getSession(db, sid)!;
    expect(row.state).toBe('active');
    expect(row.summary_rule).toBeNull();
    expect(countMessages(db, sid)).toBe(2);
    db.close();
  });

  it('mode off：零写入（方针验收）', async () => {
    const db = createDb();
    const s = await runSync({ projectRoot: PROJECT, config: cfg({ mode: 'off' }), db });
    expect(s).toMatchObject({ discovered: 0, newSessions: 0, newMessages: 0 });
    expect(listSessions(db, { projectId: PID })).toHaveLength(0);
    db.close();
  });

  it('mode meta：不落正文，仅元数据可搜（方针验收）', async () => {
    writeClaudeSession('meta1', [claudeLine(1, 'user', '部署方案用 K8s 还是 ECS')]);
    const db = createDb();
    await runSync({ projectRoot: PROJECT, config: cfg({ mode: 'meta' }), db });
    const row = listSessions(db, { projectId: PID }).find(r => r.source_session_id === 'meta1')!;
    expect(row.message_count).toBe(1);
    expect(countMessages(db, row.id)).toBe(0); // 无正文
    const hits = searchSessions(db, { project: PID, query: 'K8s 部署' });
    const hit = hits.find(h => h.sessionId === row.id);
    expect(hit).toBeDefined();
    expect(hit!.viaMeta).toBe(true);
    db.close();
  });

  it('ignore 硬边界：source:/title:/glob 三类拦截且计数', async () => {
    writeClaudeSession('sec1', [claudeLine(1, 'user', '薪资讨论记录')]);
    const db = createDb();
    const base = await runSync({ projectRoot: PROJECT, config: cfg({ sources: ['claude-code'] }), db });
    const before = base.blocked;
    fs.writeFileSync(path.join(PROJECT, '.sessionrelayignore'), 'title:薪资\n', 'utf8');
    // 重置水位让 sec1 重新被发现（先删 source_files 行模拟新库）
    db.prepare('DELETE FROM source_files').run();
    db.prepare('DELETE FROM sessions WHERE source_session_id = ?').run('sec1');
    const s = await runSync({ projectRoot: PROJECT, config: cfg(), db });
    expect(s.blocked).toBeGreaterThanOrEqual(1);
    expect(listSessions(db, { projectId: PID }).find(r => r.source_session_id === 'sec1')).toBeUndefined();
    fs.rmSync(path.join(PROJECT, '.sessionrelayignore'));
    db.close();
  });
});

describe('P1 · zcode 捕获链（假库）', () => {
  function buildFakeZcodeDb() {
    fs.mkdirSync(path.dirname(ZCODE_DB), { recursive: true });
    const z = new Database(ZCODE_DB);
    z.exec(`
      CREATE TABLE session (id text primary key, project_id text, directory text not null, title text not null,
                            time_created integer not null, time_updated integer not null);
      CREATE TABLE message (id text primary key, session_id text not null, time_created integer not null, data text not null, sequence integer);
      CREATE TABLE part (id text primary key, message_id text not null, session_id text not null,
                         time_created integer, time_updated integer, data text not null, sequence integer);
    `);
    const insS = z.prepare('INSERT INTO session VALUES (?,?,?,?,?,?)');
    insS.run('sess_z1', 'proj_x', PROJECT, '讨论检索排序方案', 1787800000000, 1787800600000);
    const insM = z.prepare('INSERT INTO message VALUES (?,?,?,?,?)');
    const insP = z.prepare('INSERT INTO part VALUES (?,?,?,?,?,?,?)');
    let seq = 0;
    const addMsg = (mid: string, role: string, texts: string[]) => {
      seq += 1;
      insM.run(mid, 'sess_z1', 1787800000000 + seq, JSON.stringify({ role, time: { created: 1 } }), seq);
      texts.forEach((t, i) => insP.run(`${mid}_p${i}`, mid, 'sess_z1', 1, 1, JSON.stringify({ type: 'text', text: t }), i));
    };
    addMsg('m1', 'user', ['检索排序怎么设计']);
    addMsg('m2', 'assistant', ['bm25 为主，近期加权', '（第二段文本应拼接）']);
    addMsg('m3', 'assistant', []); // 纯工具消息：无 text part → 跳过但水位推进
    return z;
  }

  it('discover 按 directory 归属 + readNew 拼接 parts + 幂等', async () => {
    buildFakeZcodeDb().close();
    const db = createDb();
    const s1 = await runSync({ projectRoot: PROJECT, config: cfg(), db });
    expect(s1.newSessions).toBeGreaterThanOrEqual(1);
    const row = listSessions(db, { projectId: PID }).find(r => r.source === 'zcode');
    expect(row).toBeDefined();
    expect(row!.title).toBe('讨论检索排序方案'); // ZCode 原生 title 直接采用
    expect(countMessages(db, row!.id)).toBe(2);
    const s2 = await runSync({ projectRoot: PROJECT, config: cfg(), db });
    expect(s2.newMessages).toBe(0);
    // 中文检索命中 ZCode 会话正文
    const hits = searchSessions(db, { project: PID, query: 'bm25 排序' });
    expect(hits.map(h => h.sessionId)).toContain(row!.id);
    db.close();
  });

  it('zcode 增量：假库追加消息后捕获新行', async () => {
    const z = new Database(ZCODE_DB);
    z.prepare('INSERT INTO message VALUES (?,?,?,?,?)').run('m9', 'sess_z1', 1787900000000, JSON.stringify({ role: 'user' }), 9);
    z.prepare('INSERT INTO part VALUES (?,?,?,?,?,?,?)').run('m9_p0', 'm9', 'sess_z1', 1, 1, JSON.stringify({ type: 'text', text: '追加：评估召回率' }), 0);
    z.close();
    const relay = createDb();
    await runSync({ projectRoot: PROJECT, config: cfg(), db: relay });
    await runSync({ projectRoot: PROJECT, config: cfg(), db: relay });
    const row = listSessions(relay, { projectId: PID }).find(r => r.source === 'zcode')!;
    expect(countMessages(relay, row!.id)).toBe(3);
    relay.close();
  });
});
