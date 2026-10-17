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
import { openGlobal, addLesson } from '../../src/store/global.js';
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
