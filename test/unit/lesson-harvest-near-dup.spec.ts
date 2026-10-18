// [1021 A5] 近重复"只标注不丢弃"的回归测试。
//
// 为什么必须有这条：本来的设计是"近重复 ⇒ 当作重复遇到 ⇒ bump hits ⇒ 不进库"，
// 实测发现 isNearDuplicate(0.8) 会误杀（「改了A就没B」vs「改了A就没C」都判重；
// 短句调阈值无效），一旦"判重就丢"，被误杀的真经验再也找不回来。
// 所以改成：**精确重复才 bump hits；近重复照常写草稿，只在 source_ref 里标注**。
// 这条测试就是为了钉住"不许丢"这个行为。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDb } from '../../src/store/db.js';
import { dbFile } from '../../src/shared/paths.js';
import { openGlobal, addLesson, maintainLessons } from '../../src/store/global.js';
import { harvestCandidates, harvestLessons } from '../../src/core/extract/lesson-harvest.js';

let tmp = '';
const MSG = '这里踩坑了：改完插件源码必须重新 vendor，否则插件自测跑的是旧副本，白白浪费两小时。';

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-h4-'));
  process.env.SRELAY_GLOBAL_HOME = path.join(tmp, 'global');
});
afterEach(() => {
  delete process.env.SRELAY_GLOBAL_HOME;
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
});

/** 造一个只有一条消息的项目库 */
function seedProject(dir: string, msg: string): ReturnType<typeof createDb> {
  fs.mkdirSync(path.join(dir, '.sessionrelay'), { recursive: true });
  const db = createDb(dbFile(dir));
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO sessions (id, source, source_session_id, project_id, origin, state, created_at, last_event_at)'
    + " VALUES ('s1','dsh','dsh-1','p1','auto','active',?,?)"
  ).run(now, now);
  db.prepare('INSERT INTO messages (session_id, role, content, seq_num, created_at) VALUES (?,?,?,?,?)')
    .run('s1', 'user', msg, 1, now);
  return db;
}

describe('经验采集 · 近重复只标注不丢弃', () => {
  it('近重复（多一个句号）仍会写成草稿，并标注疑似同义 + 给旧条目打待复核', () => {
    // 先算出抽出来的那句话，再据此造"多一个句号"的近重复 —— 保证确定性
    const cands = harvestCandidates([{ role: 'user', content: MSG, seqNum: 1, sessionId: 's1' }]);
    expect(cands.length).toBeGreaterThan(0);
    const text = cands[0]!.text;

    const gdb = openGlobal();
    const wsId = 'ws-test';
    const seeded = addLesson(gdb as never, {
      text: text + '。',          // 只多一个句号：不是精确重复，但足够像
      quote: text,
      sourceRef: 'seed:s1',
      route: 'user-message',
      grade: 'verified-user',
      scope: 'global',
      status: 'draft',
    } as never);
    // 前置条件：确实不是精确重复（否则测的就不是近重复那条路）
    expect(text + '。').not.toBe(text);

    const pdb = seedProject(path.join(tmp, 'proj'), MSG);
    const rep = harvestLessons(gdb as never, pdb as never, wsId, { days: 7 });

    // ① 候选没被丢掉
    expect(rep.fresh).toBe(1);
    // ② 近重复被识别出来
    expect(rep.nearDup).toBe(1);
    // ③ 真的写进了草稿
    expect(rep.written).toBe(1);
    // ④ 写入的那条带"疑似同义"标注
    const row = gdb.prepare('SELECT source_ref FROM lessons WHERE text = ?').get(text) as { source_ref?: string };
    expect(String(row?.source_ref ?? '')).toContain('疑似');
    // ⑤ 旧条目被打上待复核，但状态一个字不动
    const old = gdb.prepare('SELECT needs_review, status FROM lessons WHERE id = ?').get(seeded.id) as
      { needs_review?: number; status?: string };
    expect(old.needs_review).toBe(1);
    expect(old.status).toBe('draft');
  });

  // [红队 S1] 去重必须按可见性过滤，否则先采集的项目会把后采集项目自己的经验吞掉。
  it('两个项目采到同一句：各自都要写进自己的库（不许 A 吞掉 B）', () => {
    const gdb = openGlobal();
    const a = seedProject(path.join(tmp, 'projA'), MSG);
    const b = seedProject(path.join(tmp, 'projB'), MSG);

    const ra = harvestLessons(gdb as never, a as never, 'ws-A', { days: 7 });
    const rb = harvestLessons(gdb as never, b as never, 'ws-B', { days: 7 });

    expect(ra.written).toBeGreaterThan(0);
    // 修复前这里是 0：A 写过之后，B 的候选被判"已存在"，自己那条永久写不进去
    expect(rb.written).toBe(ra.written);

    const rows = gdb.prepare("SELECT workspace_id, COUNT(*) AS n FROM lessons WHERE scope='project' GROUP BY workspace_id")
      .all() as Array<{ workspace_id?: string; n: number }>;
    const map = new Map(rows.map((r) => [String(r.workspace_id), Number(r.n)]));
    expect(map.get('ws-A')).toBe(ra.written);
    expect(map.get('ws-B')).toBe(rb.written);
  });

  it('精确重复走另一条路：bump hits，不写新行', () => {
    const cands = harvestCandidates([{ role: 'user', content: MSG, seqNum: 1, sessionId: 's1' }]);
    const text = cands[0]!.text;
    const gdb = openGlobal();
    addLesson(gdb as never, {
      text, quote: text, sourceRef: 'seed:s1', route: 'user-message',
      grade: 'verified-user', scope: 'global', status: 'draft',
    } as never);

    const pdb = seedProject(path.join(tmp, 'proj2'), MSG);
    const rep = harvestLessons(gdb as never, pdb as never, 'ws-test', { days: 7 });

    expect(rep.fresh).toBe(0);
    expect(rep.repeated).toBe(1);
    const row = gdb.prepare('SELECT hits FROM lessons WHERE text = ?').get(text) as { hits?: number };
    expect(Number(row?.hits ?? 0)).toBeGreaterThanOrEqual(1);
  });
});

describe('分级自动：能自证的自动过，不能自证的才找人', () => {
  /** 铺一条已存在的经验，并把 hits 预置成指定值 */
  function seedExisting(gdb: ReturnType<typeof openGlobal>, text: string, grade: string, hits: number) {
    const ins = addLesson(gdb as never, {
      text, quote: text, sourceRef: 'seed:s1', route: grade === 'verified-user' ? 'user-message' : 'none',
      grade, scope: 'global', status: 'draft',
    } as never);
    gdb.prepare('UPDATE lessons SET hits = ? WHERE id = ?').run(hits, ins.id);
    return ins;
  }

  it('用户原话反复出现 ≥3 次 ⇒ 自动升 verified（不用人点头）', () => {
    const gdb = openGlobal();
    const text = harvestCandidates([{ role: 'user', content: MSG, seqNum: 1, sessionId: 's1' }])[0]!.text;
    const ins = seedExisting(gdb, text, 'verified-user', 2);   // 再来一次就满 3

    const pdb = seedProject(path.join(tmp, 'autoA'), MSG);
    const rep = harvestLessons(gdb as never, pdb as never, 'ws-auto', { days: 7 });

    expect(rep.autoPromoted).toBe(1);
    const row = gdb.prepare('SELECT status, grade, hits FROM lessons WHERE id = ?').get(ins.id) as
      { status?: string; grade?: string; hits?: number };
    expect(row.status).toBe('verified');
    expect(row.grade).toBe('verified-user');
    expect(Number(row.hits)).toBeGreaterThanOrEqual(3);
  });

  it('只出现过一次的用户原话仍是 draft（一次不算证据）', () => {
    const gdb = openGlobal();
    const text = harvestCandidates([{ role: 'user', content: MSG, seqNum: 1, sessionId: 's1' }])[0]!.text;
    const ins = seedExisting(gdb, text, 'verified-user', 0);

    const pdb = seedProject(path.join(tmp, 'autoB'), MSG);
    const rep = harvestLessons(gdb as never, pdb as never, 'ws-auto2', { days: 7 });

    expect(rep.autoPromoted).toBe(0);
    expect((gdb.prepare('SELECT status FROM lessons WHERE id = ?').get(ins.id) as { status?: string }).status).toBe('draft');
  });

  it('inferred 永远不自动升（哪怕 hits 拉满）', () => {
    const gdb = openGlobal();
    const text = harvestCandidates([{ role: 'user', content: MSG, seqNum: 1, sessionId: 's1' }])[0]!.text;
    const ins = seedExisting(gdb, text, 'inferred', 10);

    const pdb = seedProject(path.join(tmp, 'autoC'), MSG);
    const rep = harvestLessons(gdb as never, pdb as never, 'ws-auto3', { days: 7 });

    expect(rep.autoPromoted).toBe(0);
    expect((gdb.prepare('SELECT status FROM lessons WHERE id = ?').get(ins.id) as { status?: string }).status).toBe('draft');
  });
});

describe('经验维护 · [红队 S2] 反悔次数必须能累加', () => {
  it('source_ref 很长时 ×N 也不能被截断吃掉（否则 30 轮上限永不触发）', () => {
    const gdb = openGlobal();
    const longRef = 'D:/some/very/long/path/'.repeat(18).slice(0, 390); // 390 字符，正是红队实测的边界
    const ins = addLesson(gdb as never, {
      text: '这是一条反复出现的推断经验',
      quote: '原句',
      sourceRef: longRef,
      route: 'none',
      grade: 'inferred',
      scope: 'global',
      status: 'draft',
    } as never);
    // 让它够格被"拦下"：inferred + hits 达标
    gdb.prepare('UPDATE lessons SET hits = 5, needs_review = 0, created_at = ? WHERE id = ?')
      .run(new Date().toISOString(), ins.id);

    maintainLessons(gdb as never);
    const r1 = gdb.prepare('SELECT source_ref FROM lessons WHERE id = ?').get(ins.id) as { source_ref?: string };
    const s1 = String(r1?.source_ref ?? '');
    expect(s1.length).toBeLessThanOrEqual(400);
    // 修复前：整串 slice(0,400) 把末尾的 ×1 切掉，这里会是 false，计数永远回到 0
    expect(/×1$/.test(s1)).toBe(true);

    maintainLessons(gdb as never);
    const r2 = gdb.prepare('SELECT source_ref FROM lessons WHERE id = ?').get(ins.id) as { source_ref?: string };
    expect(/×2$/.test(String(r2?.source_ref ?? ''))).toBe(true);
  });
});
