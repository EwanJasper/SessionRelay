import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openGlobal, addLesson, visibleWhere } from '../../src/store/global.js';

let home = '';
let oldHome: string | undefined;

/**
 * #7 全局层隔离 · admissibility 回归（研究报告 §1.1 建议 #2，引 2610.07309）
 *
 * 判据：**「过滤跨项目条目」不得改变「项目内条目排序」**。
 * 换句话说：别的项目多记几条经验，不能让我这个项目的经验排序发生变化。
 *
 * 现状说明（诚实登记）：我们**没有**报告原本建议的 project_id 列，
 * 而是用 scope + workspace_id 做结构性隔离（visibleWhere 是唯一判据）。
 * 两者在"查询侧带 project 维度"这一点上等价，所以改用回归测试把它钉住，
 * 而不是为一个已经满足的性质再加一列。
 */
function seed(ws: string, texts: string[], grade = 'verified-user' as const) {
  const gdb = openGlobal();
  const ids: number[] = [];
  for (const t of texts) {
    const r = addLesson(gdb as never, {
      text: t, sourceRef: 'src:' + ws, grade, scope: 'project' as const, workspaceId: ws,
    } as never);
    ids.push(r.id);
  }
  gdb.close();
  return ids;
}

function orderFor(ws: string): string[] {
  const gdb = openGlobal();
  const w = visibleWhere({ workspaceId: ws });
  const rows = gdb.prepare('SELECT text FROM lessons WHERE ' + w.sql + ' ORDER BY importance DESC, id ASC')
    .all(...(w.params as never[])) as Array<{ text: string }>;
  gdb.close();
  return rows.map((r) => r.text);
}

describe('全局经验层 · 跨项目条目不许影响项目内排序', () => {
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'srelay-ns-'));
    oldHome = process.env.SRELAY_GLOBAL_HOME;
    process.env.SRELAY_GLOBAL_HOME = home;
  });
  afterEach(() => {
    if (oldHome === undefined) delete process.env.SRELAY_GLOBAL_HOME; else process.env.SRELAY_GLOBAL_HOME = oldHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('别的项目追加经验后，本项目经验排序逐位不变', () => {
    seed('ws-a', ['A 项目经验一', 'A 项目经验二', 'A 项目经验三']);
    const before = orderFor('ws-a');
    expect(before.length).toBe(3);

    // 另一个项目灌一堆，其中包含和 A 极像的文本（最容易串味的情况）
    seed('ws-b', ['A 项目经验一', 'B 项目经验甲', 'B 项目经验乙', 'B 项目经验丙']);

    expect(orderFor('ws-a')).toEqual(before);
  });

  it('A 看不见 B 的条目（结构性隔离，不是事后过滤）', () => {
    seed('ws-a', ['只有 A 知道的事']);
    seed('ws-b', ['只有 B 知道的事']);
    const a = orderFor('ws-a');
    expect(a).toContain('只有 A 知道的事');
    expect(a.some((t) => t.includes('只有 B 知道'))).toBe(false);
  });

  it('domain 作用域是「同领域共享」，不是「人人可见」', () => {
    const gdb = openGlobal();
    addLesson(gdb as never, {
      text: '写作类项目共用的一条', sourceRef: 'src:dom', grade: 'verified-user',
      scope: 'domain' as const, domain: 'writing',
    } as never);
    gdb.close();
    // 非 writing 领域看不到
    const other = orderFor('ws-a');
    expect(other.some((t) => t.includes('写作类项目共用'))).toBe(false);
    // writing 领域能看到
    const gdb2 = openGlobal();
    const w = visibleWhere({ workspaceId: 'ws-a', domain: 'writing' });
    const rows = gdb2.prepare('SELECT text FROM lessons WHERE ' + w.sql).all(...(w.params as never[])) as Array<{ text: string }>;
    gdb2.close();
    expect(rows.some((r) => r.text.includes('写作类项目共用'))).toBe(true);
  });
});
