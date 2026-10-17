// 接线测试（教训驱动）：判据只有一份实现，但**纯函数单测全绿 ≠ 真路在用**。
//   实测踩到：strengthOfItem 的 recallBoostDays 写好了、纯函数断言也过了，可 maintainLessons
//   当时没把 hits 折算传下去 ⇒ "重放=强化"在真实维护流程里根本不发生（20 天前 hits=1 的
//   inferred 照样被淘汰）。因此本文件**只走真入口** maintainLessons，不直接调纯函数。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openGlobal, addLesson, maintainLessons, type LessonRow } from '../../src/store/global.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ses-strength-wiring-'));
const DAY = 86400000;
const mk = () => openGlobal(path.join(tmp, Math.random().toString(36).slice(2) + '.sqlite'));

/** 造一条指定年龄的经验；hits 直接写库（本测试只验证维护判据，不验证 hits 是怎么涨的） */
function aged(db: ReturnType<typeof mk>, opts: { text: string; grade?: string; ageDays: number; hits?: number; sourceRef?: string }) {
  const { id } = addLesson(db, { text: opts.text, grade: opts.grade as never, sourceRef: opts.sourceRef ?? 'wiring:1', workspaceId: '/p' });
  db.prepare('UPDATE lessons SET created_at = ?, updated_at = ?, hits = ? WHERE id = ?')
    .run(new Date(Date.now() - opts.ageDays * DAY).toISOString(), new Date(Date.now() - opts.ageDays * DAY).toISOString(), opts.hits ?? 0, id);
  return id;
}
const row = (db: ReturnType<typeof mk>, id: number) => db.prepare('SELECT * FROM lessons WHERE id = ?').get(id) as LessonRow;

describe('强度判据的接线（真入口 maintainLessons）', () => {
  it('重放真的续命：20 天前 hits=1 的 inferred 不退休，hits=0 的同龄会退休', () => {
    const db = mk();
    const replayed = aged(db, { text: '被再次采到过的推断', ageDays: 20, hits: 1 });
    const lonely = aged(db, { text: '只出现过一次的推断', ageDays: 20, hits: 0 });
    const r = maintainLessons(db);
    expect(row(db, replayed).status).toBe('draft');       // hits=1 ⇒ S=7+30=37 天 ⇒ exp(-20/37)=0.58 > 1/e
    expect(row(db, lonely).status).toBe('retired');       // hits=0 ⇒ S=观察窗 7 天 ⇒ exp(-20/7)=0.057 < 1/e
    expect(r.retired).toBe(1);
    db.close();
  });

  it('观察窗内的推断不判死（probation），出生不再即死', () => {
    const db = mk();
    const fresh = aged(db, { text: '刚出炉的推断', ageDays: 0, hits: 0 });
    const young = aged(db, { text: '六天前的推断', ageDays: 6, hits: 0 });
    const r = maintainLessons(db);
    expect(row(db, fresh).status).toBe('draft');
    expect(row(db, young).status).toBe('draft');
    expect(r.probation).toBe(2);
    expect(r.retired).toBe(0);
    db.close();
  });

  it('verified-* 与旧线性模型在 60/61 天边界逐日等价（真入口复验）', () => {
    const db = mk();
    const at60 = aged(db, { text: '六十天整', grade: 'verified-file', ageDays: 60, sourceRef: 'a:1' });
    const at61 = aged(db, { text: '六十一天', grade: 'verified-file', ageDays: 61, sourceRef: 'b:2' });
    maintainLessons(db);
    expect(row(db, at60).status).not.toBe('retired');
    expect(row(db, at61).status).toBe('retired');
    db.close();
  });
});
