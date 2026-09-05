// forget --all 整库重置（test-forget v3 · D5-D11）
// 独立 fixture：--all 会抹库，必须与其他用例隔离
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createDb, openExisting, insertSession, countsByState } from '../../src/store/db.js';
import { dbFile, ignoreFile, projectIdOf } from '../../src/shared/paths.js';
import { loadConfig } from '../../src/shared/config.js';
import { makeProject, runCli, fakeDaemon } from './helpers.js';

const TMP = path.resolve('test/.tmp/forget-all');
const PROJECT = path.join(TMP, 'app');
const PID = projectIdOf(PROJECT);

beforeAll(() => {
  for (let i = 0; i < 3; i++) { try { fs.rmSync(TMP, { recursive: true, force: true }); break; } catch { /* retry */ } }
  makeProject(PROJECT);
  process.chdir(PROJECT);
  const db = createDb(dbFile(PROJECT));
  insertSession(db, { id: 'aaa10000000000001', source: 'zcode', sourceSessionId: 'z1', projectId: PID, createdAt: '2026-08-20T08:00:00Z', title: '会话一' });
  insertSession(db, { id: 'aaa20000000000001', source: 'zcode', sourceSessionId: 'z2', projectId: PID, createdAt: '2026-08-21T08:00:00Z', title: '会话二' });
  db.close();
  // stats.json 存在（D11 检查 --all 是否保留）
  fs.writeFileSync(path.join(PROJECT, '.sessionrelay', 'stats.json'), JSON.stringify({ counters: { forget: 1 } }));
});

afterAll(() => {
  process.chdir(path.resolve('.'));
  for (let i = 0; 3 > i; i++) { try { fs.rmSync(TMP, { recursive: true, force: true }); return; } catch { /* retry */ } }
});

describe('forget · --all 整库重置', () => {
  it('D5 守护运行中：直接拒绝，库文件不变', async () => {
    const before = fs.statSync(dbFile(PROJECT)).size;
    fakeDaemon(PROJECT);
    const { cmdForget } = await import('../../src/cli/forget.js');
    const r = await runCli(() => cmdForget({ all: true, confirm: PID }));
    expect(r.exitCode).toBe(1);
    expect(r.cap.err.join('\n')).toContain('守护进程运行中');
    expect(fs.statSync(dbFile(PROJECT)).size).toBe(before); // 库未动
    fs.rmSync(path.join(PROJECT, '.sessionrelay', 'lock')); // 停守护，供后续用例
  });

  it('D6 缺 --confirm：拒绝并提示要求', async () => {
    const { cmdForget } = await import('../../src/cli/forget.js');
    const r = await runCli(() => cmdForget({ all: true }));
    expect(r.exitCode).toBe(1);
    expect(r.cap.err.join('\n')).toContain('--confirm');
    expect(fs.existsSync(dbFile(PROJECT))).toBe(true);
  });

  it('D7 --confirm 错误项目 id：逐字匹配失败', async () => {
    const { cmdForget } = await import('../../src/cli/forget.js');
    const r = await runCli(() => cmdForget({ all: true, confirm: 'wrong-project' }));
    expect(r.exitCode).toBe(1);
    expect(r.cap.err.join('\n')).toContain(PID); // 提示正确值
    expect(fs.existsSync(dbFile(PROJECT))).toBe(true);
  });

  it('D8/D9 正确 --confirm：三连删 + 空库重建 + ignore 保留 + forgot-at 摘要', async () => {
    fs.writeFileSync(ignoreFile(PROJECT), 'session:zcode/z1\n'); // 模拟已有防复活规则
    const { cmdForget } = await import('../../src/cli/forget.js');
    const r = await runCli(() => cmdForget({ all: true, confirm: PID }));
    expect(r.exitCode).toBeNull();
    // 空库已重建（当前 schema 版本；v4 起含 session_vectors）
    const db = openExisting(dbFile(PROJECT));
    expect(db.pragma('user_version', { simple: true })).toBeGreaterThanOrEqual(4);
    expect(Object.keys(countsByState(db, PID)).length).toBe(0);
    db.close();
    // ignore 保留（防复活关键：库没了规则还在）
    expect(fs.readFileSync(ignoreFile(PROJECT), 'utf8')).toContain('session:zcode/z1');
    // 摘要文件（forget_log 随库删除后的最后一行审计）
    const dir = fs.readdirSync(path.join(PROJECT, '.sessionrelay'));
    const summary = dir.find((f) => /^forgot-at-\d{8,14}\.txt$/.test(f));
    expect(summary).toBeTruthy();
    const text = fs.readFileSync(path.join(PROJECT, '.sessionrelay', summary!), 'utf8');
    expect(text).toContain('2 会话'); // 删除前统计进了摘要
    expect(text).toContain(PID);
  });

  it('D10 空库后续命令正常（不 crash）', () => {
    const db = openExisting(dbFile(PROJECT));
    expect(() => countsByState(db, PID)).not.toThrow();
    db.close();
    // 新库可正常写入（下次 sync 不受影响）
    const db2 = openExisting(dbFile(PROJECT));
    insertSession(db2, { id: 'bbb10000000000001', source: 'zcode', sourceSessionId: 'z9', projectId: PID, createdAt: '2026-08-25T08:00:00Z', title: '重置后新会话' });
    db2.close();
  });

  it('D11 stats.json：保留（纯事件计数无内容泄漏——钉住实现行为）', () => {
    expect(fs.readFileSync(path.join(PROJECT, '.sessionrelay', 'stats.json'), 'utf8')).toContain('forget');
  });

  it('D8b 二次 --all 在空库上也安全（幂等语义）', async () => {
    const { cmdForget } = await import('../../src/cli/forget.js');
    const r = await runCli(() => cmdForget({ all: true, confirm: PID }));
    expect(r.exitCode).toBeNull();
    expect(fs.existsSync(dbFile(PROJECT))).toBe(true);
    void loadConfig;
  });
});
