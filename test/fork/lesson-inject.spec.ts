// 经验注入的两道闸 + 预算（设计 §11.2 / §11.5）
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openGlobal, addLesson, pickForInjection } from '../../src/store/global.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ses-pick-'));
const mk = () => openGlobal(path.join(tmp, Math.random().toString(36).slice(2) + '.sqlite'));

describe('[1016 S2] 经验注入的两道闸', () => {
  it('闸 1：**草稿永远不进注入层**（这是「不能随便入库」的落地）', () => {
    const db = mk();
    addLesson(db, { text: '无来源的草稿', scope: 'global' });   // 默认 draft
    expect(pickForInjection(db, { workspaceId: '/p' })).toEqual([]);
    db.close();
  });

  it('有证据的显式录入 → verified → 能进', () => {
    const db = mk();
    addLesson(db, { text: '有证据的经验', scope: 'global', grade: 'verified-user', sourceRef: 'x:1' });
    expect(pickForInjection(db, { workspaceId: '/p' }).length).toBe(1);
    db.close();
  });

  it('闸 2：与本轮无具体重合 → 不注入（常用词不算数）', () => {
    const db = mk();
    addLesson(db, { text: 'pnpm 版本必须不低于 10.34', scope: 'global', grade: 'verified-tool', sourceRef: 'x:1' });
    expect(pickForInjection(db, { workspaceId: '/p', query: '帮我把这个 README 改写一下' })).toEqual([]);
    expect(pickForInjection(db, { workspaceId: '/p', query: 'pnpm 装不上怎么办' }).length).toBe(1);
    db.close();
  });

  it('没有 query（ZCode 开场）→ 退化为按重要度给最重要的几条', () => {
    const db = mk();
    addLesson(db, { text: '甲经验', scope: 'global', grade: 'verified-tool', sourceRef: 'x:1' });
    addLesson(db, { text: '乙经验', scope: 'global', grade: 'verified-file', sourceRef: 'x:2' });
    expect(pickForInjection(db, { workspaceId: '/p' }).length).toBe(2);
    db.close();
  });

  it('预算：超 maxChars 就截（默认 200 字符 / 3 条）', () => {
    const db = mk();
    for (let i = 0; i < 6; i++) addLesson(db, { text: '很长的经验条目' + i + 'x'.repeat(60), scope: 'global', grade: 'verified-tool', sourceRef: 'x:' + i });
    const picked = pickForInjection(db, { workspaceId: '/p', maxChars: 200 });
    expect(picked.length).toBeLessThanOrEqual(3);
    expect(picked.map((r) => r.text).join('').length).toBeLessThanOrEqual(200);
    db.close();
  });
});