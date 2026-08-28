// Phase 3.5 验收（方针 §十二）：导出→导入→可检索（归化 T21）；HANDOFF 可读含署名；
// 脱敏默认开；篡改拒绝；zip-slip 拒绝；隔离导入/release；scope 尊重；幂等往返。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { createDb, insertSession, insertMessage, confirmSession, getSessionFull, countMessages, listSessions } from '../../src/store/db.js';
import { defaultConfig, saveConfig } from '../../src/shared/config.js';
import { dbFile, projectIdOf } from '../../src/shared/paths.js';
import { runExport } from '../../src/relay/export.js';
import { runImport, runRelease } from '../../src/relay/import.js';
import { searchSessions } from '../../src/search-svc/engine.js';
import { listDecisions } from '../../src/store/db.js';
import { unzipSync, strFromU8 } from 'fflate';

const TMP = path.resolve('test/.tmp/hop');
const PROJ_A = path.join(TMP, 'projA'); // 张三
const PROJ_B = path.join(TMP, 'projB'); // 小王
const PID_A = projectIdOf(PROJ_A);
const PID_B = projectIdOf(PROJ_B);
const PKG = path.join(TMP, 'myapp-handoff.hop');

beforeAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  for (const p of [PROJ_A, PROJ_B]) {
    fs.mkdirSync(path.join(p, '.sessionrelay'), { recursive: true });
    saveConfig(p, { ...defaultConfig(), identity: { project_id: projectIdOf(p), author: p === PROJ_A ? '张三' : '小王' } });
  }
  // 张三的库：决策会话 + 含密钥会话
  const db = createDb(dbFile(PROJ_A));
  insertSession(db, { id: 'dec100000000000001', source: 'claude-code', sourceSessionId: 'a1', projectId: PID_A, createdAt: '2026-08-20T08:00:00Z', title: '数据库选型' });
  insertMessage(db, { sessionId: 'dec100000000000001', role: 'user', content: '数据库怎么选？', seqNum: 1, createdAt: '2026-08-20T08:00:00Z' });
  insertMessage(db, { sessionId: 'dec100000000000001', role: 'assistant', content: '决定采用 PostgreSQL，因为数据量按月增长。文件 src/db/schema.sql', seqNum: 2, createdAt: '2026-08-20T08:05:00Z' });
  db.prepare('UPDATE sessions SET last_event_at=? WHERE id=?').run('2026-08-20T08:05:00Z', 'dec100000000000001');
  confirmSession(db, 'dec100000000000001', '2026-08-20T09:00:00Z');
  insertSession(db, { id: 'sec100000000000001', source: 'zcode', sourceSessionId: 'a2', projectId: PID_A, createdAt: '2026-08-21T08:00:00Z', title: '部署密钥配置' });
  insertMessage(db, { sessionId: 'sec100000000000001', role: 'user', content: '连接串是 postgres://admin:S3cretPwd@db.internal:5432/prod，密码别外传', seqNum: 1, createdAt: '2026-08-21T08:00:00Z' });
  insertMessage(db, { sessionId: 'sec100000000000001', role: 'assistant', content: '收到。另外 AKIAIOSFODNN7EXAMPLE 是测试用的 key', seqNum: 2, createdAt: '2026-08-21T08:05:00Z' });
  db.prepare('UPDATE sessions SET last_event_at=? WHERE id=?').run('2026-08-21T08:05:00Z', 'sec100000000000001');
  confirmSession(db, 'sec100000000000001', '2026-08-21T09:00:00Z');
  db.close();
});
afterAll(() => { fs.rmSync(TMP, { recursive: true, force: true }); });

const cfgA = () => ({ ...defaultConfig(), identity: { project_id: PID_A, author: '张三' } });
const cfgB = () => ({ ...defaultConfig(), identity: { project_id: PID_B, author: '小王' } });

describe('P3.5 · HOP 交接全链路', () => {
  it('导出：HANDOFF.md 可读含署名；密钥默认脱敏 + 报告', () => {
    const db = createDb(dbFile(PROJ_A));
    const r = runExport({ root: PROJ_A, cfg: cfgA(), db, all: true, output: PKG });
    db.close();
    expect(r.sessionCount).toBe(2);
    expect(r.redactionHits).toBeGreaterThanOrEqual(2);

    const raw = unzipSync(new Uint8Array(fs.readFileSync(PKG)));
    const file = (n: string) => strFromU8(raw[n]);
    const handoff = file('summary/HANDOFF.md');
    expect(handoff).toContain('# 项目交接文档');
    expect(handoff).toContain('决定采用 PostgreSQL');
    expect(handoff).toContain('src/db/schema.sql');
    expect(handoff).toContain('由会话接力 SessionRelay 生成'); // T19 署名
    // 脱敏：正文与决策不含明文
    const allText = Object.keys(raw).map((k) => file(k)).join('\n');
    expect(allText).not.toContain('S3cretPwd');
    expect(allText).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(allText).toContain('[已脱敏');
    expect(file('summary/redaction-report.txt')).toContain('db-conn');
    expect(JSON.parse(file('manifest.json')).format).toBe('hop/1.0');
  });

  it('导入（小王）：归化后可检索、决策可见（验收：导入即可答）', () => {
    const db = createDb(dbFile(PROJ_B));
    const r = runImport({ root: PROJ_B, cfg: cfgB(), db, pkgPath: PKG, from: '张三' });
    expect(r.imported).toBe(2);
    // 归化（T21）：project_id 已是 B 的，检索命中
    const hits = searchSessions(db, { project: PID_B, query: 'PostgreSQL 数据库' });
    // 导入重建规范 ID：hash(source:source_session_id)——按身份查找
    const rows = listSessions(db, { projectId: PID_B });
    const idDec = rows.find((x) => x.source_session_id === 'a1')!.id;
    const idSec = rows.find((x) => x.source_session_id === 'a2')!.id;
    // 注意：a2 的连接串已被脱敏 → 不再含 postgresql 词元（脱敏生效的正确表现）
    expect(hits.map((h) => h.sessionId)).toContain(idDec);
    const decs = listDecisions(db, PID_B);
    expect(decs.some((d) => d.text.includes('PostgreSQL'))).toBe(true);
    // 溯源字段
    const full = getSessionFull(db, idDec)!;
    expect(full.origin).toBe('imported');
    expect(full.importedFrom).toBe('张三');
    expect(full.originProject).toBe(PID_A);
    db.close();
  });

  it('幂等往返：重复导入全跳过；再导出会话文件 hash 稳定（除 manifest）', () => {
    const db = createDb(dbFile(PROJ_B));
    const r2 = runImport({ root: PROJ_B, cfg: cfgB(), db, pkgPath: PKG });
    expect(r2.imported).toBe(0);
    expect(r2.skipped).toBe(2);

    // 同库（小王）两次导出 → 除 manifest 外逐文件一致（时间戳只出现在 manifest）
    const PKG2 = path.join(TMP, 'roundtrip2.hop');
    const PKG3 = path.join(TMP, 'roundtrip3.hop');
    runExport({ root: PROJ_B, cfg: cfgB(), db, all: true, output: PKG2 });
    runExport({ root: PROJ_B, cfg: cfgB(), db, all: true, output: PKG3 });
    const h = (p: string) => { const u = unzipSync(new Uint8Array(fs.readFileSync(p))); return Object.fromEntries(Object.keys(u).filter((k) => k !== 'manifest.json').map((k) => [k, strFromU8(u[k])])); };
    const a = h(PKG2); const b = h(PKG3);
    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
    for (const k of Object.keys(a)) expect(b[k], `文件漂移：${k}`).toBe(a[k]);
    // 包内容再次导入 → 全跳过（fingerprint 幂等）
    const r3 = runImport({ root: PROJ_B, cfg: cfgB(), db, pkgPath: PKG2 });
    expect(r3.imported).toBe(0);
    db.close();
  });

  it('篡改拒绝：改一个字节 → 整体拒绝（sha256 完整性）', () => {
    const u = unzipSync(new Uint8Array(fs.readFileSync(PKG)));
    const files: Record<string, Uint8Array> = { ...u };
    files['sessions/dec100000000000001.json'] = strToU8(strFromU8(files['sessions/dec100000000000001.json']).replace('PostgreSQL', 'MySQL'));
    const tampered = path.join(TMP, 'tampered.hop');
    fs.writeFileSync(tampered, zipSync(files));
    const db = createDb(dbFile(PROJ_B));
    expect(() => runImport({ root: PROJ_B, cfg: cfgB(), db, pkgPath: tampered })).toThrow(/完整性/);
    db.close();
  });

  it('zip-slip 拒绝：包内路径越界', () => {
    const evil = path.join(TMP, 'evil.hop');
    fs.writeFileSync(evil, zipSync({ 'manifest.json': strToU8('{}'), '../evil.txt': strToU8('x') }));
    const db = createDb(dbFile(PROJ_B));
    expect(() => runImport({ root: PROJ_B, cfg: cfgB(), db, pkgPath: evil })).toThrow();
    db.close();
  });

  it('隔离导入：摘要可检索、正文不可见；release 放行后正文入库', () => {
    const PROJ_C = path.join(TMP, 'projC');
    fs.mkdirSync(path.join(PROJ_C, '.sessionrelay'), { recursive: true });
    saveConfig(PROJ_C, { ...defaultConfig(), identity: { project_id: projectIdOf(PROJ_C) } });
    const db = createDb(dbFile(PROJ_C));
    const cfgC = { ...defaultConfig(), identity: { project_id: projectIdOf(PROJ_C) } };
    const r = runImport({ root: PROJ_C, cfg: cfgC, db, pkgPath: PKG, quarantine: true });
    expect(r.quarantined).toBe(2);
    // 元数据可检索（meta 命中），正文为 0
    const hits = searchSessions(db, { project: cfgC.identity.project_id!, query: '数据库选型' });
    expect(hits.length).toBeGreaterThanOrEqual(1);
    const row = listSessions(db, { projectId: cfgC.identity.project_id! }).find((s) => s.source_session_id === 'a1')!;
    expect(countMessages(db, row.id)).toBe(0);
    expect(row.summary_rule).toBeTruthy(); // 摘要可见
    // release 放行
    const rel = runRelease({ root: PROJ_C, db, idPrefix: row.id });
    expect(rel.released).toBe(1);
    expect(countMessages(db, row.id)).toBe(2);
    db.close();
  });

  it('导出尊重 scope（B 档契约）', () => {
    const db = createDb(dbFile(PROJ_A));
    fs.writeFileSync(path.join(PROJ_A, '.sessionrelay', 'scope.json'),
      JSON.stringify({ version: '1.0', mode: 'predicate', filters: { sources: ['zcode'] }, issued_at: new Date().toISOString() }));
    const scoped = path.join(TMP, 'scoped.hop');
    const r = runExport({ root: PROJ_A, cfg: cfgA(), db, output: scoped });
    expect(r.sessionCount).toBe(1); // 只导出 zcode 会话
    fs.rmSync(path.join(PROJ_A, '.sessionrelay', 'scope.json'));
    db.close();
  });
});
