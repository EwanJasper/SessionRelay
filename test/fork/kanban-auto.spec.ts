// [1015 夜 · B1] 看板「自动区」：只刷新模块列 = auto:todos 的行，人写的行一个字节不动。
//
// 用真夹具（临时 ZCode 库 + 临时 progress.md）跑端到端，而不是测纯函数——
// 因为要证明的正是「不碰人写的行」这个契约。
// 双向断言：自动行该刷的刷 + 人写行与子代理待办都不许进来。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { syncKanbanAuto, todoRowsOf } from '../../src/cli/kanban.js';
import type { RelayConfig } from '../../src/shared/config.js';

let tmp = ''; let root = ''; let zdb = '';
const HUMAN = '| 人写的计划行 | 🔄 进行中 | 核心 | 谁也不许动它 |';

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-auto-'));
  root = path.join(tmp, 'proj'); fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'progress.md'),
    ['# 项目看板', '', '| 任务 | 状态 | 模块 | 明细 |', '|---|---|---|---|', HUMAN, ''].join('\n'), 'utf8');
  zdb = path.join(tmp, 'zcode.db');
  const z = new Database(zdb);
  z.exec('CREATE TABLE session (id TEXT, directory TEXT, task_type TEXT)');
  z.exec('CREATE TABLE todo (session_id TEXT, content TEXT, status TEXT, time_updated INTEGER)');
  z.prepare('INSERT INTO session VALUES (?,?,?)').run('s_main', root, 'interactive');
  z.prepare('INSERT INTO session VALUES (?,?,?)').run('s_sub', root, 'subagent_child');
  const now = Date.now();
  z.prepare('INSERT INTO todo VALUES (?,?,?,?)').run('s_main', '真项目待办：把渲染管线换 GeckoLib', 'in_progress', now);
  z.prepare('INSERT INTO todo VALUES (?,?,?,?)').run('s_sub', '子代理待办：Submit structured result', 'in_progress', now);
  z.close();
  process.env.ZCODE_DB_PATH = zdb;
});
afterAll(() => { delete process.env.ZCODE_DB_PATH; fs.rmSync(tmp, { recursive: true, force: true }); });

const cfg = {} as unknown as RelayConfig;

describe('[1015 夜 B1] 看板自动区', () => {
  it('① 待办读取：排除子代理会话的待办', () => {
    const rows = todoRowsOf(root, cfg);
    expect(rows.map((r) => r.content)).toEqual(['真项目待办：把渲染管线换 GeckoLib']);
  });
  it('② 刷新：自动行进表，人写的行逐字保留', () => {
    const r = syncKanbanAuto(root, cfg);
    expect(r.ok).toBe(true);
    const md = fs.readFileSync(path.join(root, 'progress.md'), 'utf8');
    expect(md).toContain(HUMAN);
    expect(md).toContain('真项目待办：把渲染管线换 GeckoLib');
    expect(md).toContain('auto:todos');
    expect(md).not.toContain('Submit structured result');
  });
  it('③ 幂等：再跑一次内容不变（无变化）', () => {
    const before = fs.readFileSync(path.join(root, 'progress.md'), 'utf8');
    const r = syncKanbanAuto(root, cfg);
    expect(r.reason).toContain('无变化');
    expect(fs.readFileSync(path.join(root, 'progress.md'), 'utf8')).toBe(before);
  });
});
