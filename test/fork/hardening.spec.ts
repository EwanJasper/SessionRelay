// [fork 0924] 本 fork 新增逻辑的回归锁：origin=workflow 排除 + 决策增量刷新（水位幂等）
// 这两个行为是 mc整合包 实测反馈的根治产物——没有测试锁定就会被无意破坏
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createDb, upsertCapturedSession, insertMessage, markPending, refreshDecisionsIncremental, confirmSession, listDecisions } from '../../src/store/db.js';
import { globalDaemonAlive } from '../../src/capture/watch.js';
import { rotateLogFile } from '../../src/shared/logrotate.js';
import { windowsRunScript } from '../../src/cli/service.js';

let TMP = '';
let db: ReturnType<typeof createDb>;
const PID = 'proj-fork-test';
const ids: Record<string, string> = {};

const ins = (key: string, title: string, origin: 'auto' | 'workflow', msgs: Array<[number, string]>) => {
  const up = upsertCapturedSession(db, {
    source: 'zcode', sourceSessionId: 'src-' + key, projectId: PID, title,
    createdAt: new Date().toISOString(), lastEventAt: new Date().toISOString(), origin,
  });
  ids[key] = up.id;
  for (const [seq, content] of msgs) {
    insertMessage(db, { sessionId: up.id, role: seq % 2 ? 'user' : 'assistant', content, seqNum: seq, createdAt: new Date().toISOString() });
  }
  db.prepare('UPDATE sessions SET message_count = ? WHERE id = ?').run(msgs.length, up.id);
};

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forkrt-'));
  fs.mkdirSync(path.join(TMP, '.sessionrelay'), { recursive: true });
  process.chdir(TMP);
  db = createDb(path.join(TMP, '.sessionrelay', 'relay.sqlite'));
});
afterEach(() => {
  process.chdir(os.tmpdir());
  try { db.close(); } catch { /* 已关 */ }
  for (let i = 0; i < 3; i++) { try { fs.rmSync(TMP, { recursive: true, force: true }); break; } catch { /* Windows 句柄延迟重试 */ } }
});

describe('fork · origin=workflow 排除', () => {
  it('施工会话的决策不进 listDecisions，正主会话的进', () => {
    ins('wf', 'workflow subagent actor#1@1', 'workflow', [[1, '决定主题能不能实现']]);
    ins('main', '正主会话', 'auto', [[1, '决定采用 PostgreSQL 作为主库']]);
    markPending(db, ids.wf, new Date().toISOString());
    markPending(db, ids.main, new Date().toISOString());
    refreshDecisionsIncremental(db, ids.wf);
    refreshDecisionsIncremental(db, ids.main);
    confirmSession(db, ids.wf, new Date().toISOString());
    confirmSession(db, ids.main, new Date().toISOString());
    const rows = listDecisions(db, PID);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every((r) => !/workflow subagent/.test(r.title ?? ''))).toBe(true);
  });
});

describe('fork · 决策增量刷新', () => {
  it('水位之后的新消息追加决策，且幂等去重', () => {
    ins('inc', '增量会话', 'auto', [[1, '决定采用方案 A']]);
    confirmSession(db, ids.inc, new Date().toISOString());
    insertMessage(db, { sessionId: ids.inc, role: 'assistant', content: '决定追加方案 B 作为兜底', seqNum: 2, createdAt: new Date().toISOString() });
    refreshDecisionsIncremental(db, ids.inc);
    refreshDecisionsIncremental(db, ids.inc); // 幂等：二次调用不重复追加
    const rows = listDecisions(db, PID);
    const texts = rows.map((r) => r.text);
    expect(texts.some((t) => t.includes('方案 A'))).toBe(true);
    expect(texts.some((t) => t.includes('方案 B'))).toBe(true);
    expect(texts.filter((t) => t.includes('方案 B')).length).toBe(1);
  });
});

// [fork 1010] 回归锁：project 模式让位全局守护。mc整合包 的 30 次撞锁 + 孤儿实例
// 无限期存活，根因就是 project 模式启动时不问全局守护在不在。
describe('fork · 全局守护探测（project 模式让位）', () => {
  it('全局管道被占 → alive；释放 → 不 alive', async () => {
    // SRELAY_GLOBAL_PIPE 只放管道名，globalPipeName 会拼 \\.\pipe\ 前缀
    const NAME = 'srelay-watch-test-' + process.pid;
    process.env.SRELAY_GLOBAL_PIPE = NAME;
    try {
      const PIPE = '\\\\.\\pipe\\' + NAME;
      const srv = net.createServer();
      await new Promise<void>((res, rej) => { srv.once('error', rej); srv.listen(PIPE, () => res()); });
      expect(await globalDaemonAlive()).toBe(true);
      await new Promise<void>((res) => srv.close(() => res()));
      expect(await globalDaemonAlive()).toBe(false);
    } finally {
      delete process.env.SRELAY_GLOBAL_PIPE;
    }
  });
});

// [fork 1011] 回归锁：日志轮转提升为共享实现后行为不变；global 模式的 cmd
// 不得重定向（cmd 的 >> 追加句柄会把轮转截断顶成 EBUSY——实测 33.7MB 不轮转）
describe('fork · 日志轮转与 cmd 生成', () => {
  it('rotateLogFile：超 1MB 截断留尾，未超不动', () => {
    const tmp = path.join(os.tmpdir(), 'srelay-rot-' + process.pid + '.log');
    try {
      fs.writeFileSync(tmp, ('x'.repeat(99) + '\n').repeat(11_000)); // ~1.1MB
      expect(fs.statSync(tmp).size).toBeGreaterThan(1024 * 1024);
      expect(rotateLogFile(tmp)).toBe(true);
      expect(fs.statSync(tmp).size).toBeLessThanOrEqual(1024 * 1024 + 256);
      const content = fs.readFileSync(tmp, 'utf8');
      expect(content.startsWith('...（日志超 1MB，已截断保留尾部）')).toBe(true);
      expect(rotateLogFile(tmp)).toBe(false);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });

  it('windowsRunScript：global 不重定向（守护自写日志），单项目保持 >>', () => {
    const g = windowsRunScript('D:\tmp-proj', { global: true });
    expect(g).not.toContain('>>');
    const p = windowsRunScript('D:\tmp-proj');
    expect(p).toContain('>>');
    expect(p).toContain('chcp 65001 >nul');
  });
});
