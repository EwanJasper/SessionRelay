// 全局经验层 S1：作用域隔离 / 定级冻结 / 中文检索 / 衰减退休 / 导出
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openGlobal, addLesson, listLessons, searchLessons, maintainLessons, exportMarkdown, liveImportance, GRADES, INJECT_THRESHOLD, type LessonRow } from '../../src/store/global.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ses-lesson-'));
const mk = () => openGlobal(path.join(tmp, Math.random().toString(36).slice(2) + '.sqlite'));

describe('[1016 S1] 全局经验层', () => {
  it('作用域隔离：project 只在本工作区可见，global 谁都可见', () => {
    const db = mk();
    addLesson(db, { text: '甲项目的经验', workspaceId: '/proj/a' });
    addLesson(db, { text: '全局通吃', scope: 'global' });
    const a = listLessons(db, { workspaceId: '/proj/a' }).map((r) => r.text);
    const b = listLessons(db, { workspaceId: '/proj/b' }).map((r) => r.text);
    expect(a).toContain('甲项目的经验');
    expect(b).not.toContain('甲项目的经验');
    expect(b).toContain('全局通吃');
    db.close();
  });

  it('定级冻结：给了定级但没给来源 → 降为 inferred', () => {
    const db = mk();
    const r = addLesson(db, { text: '无来源断言', grade: 'verified-tool', workspaceId: '/p' });
    expect(r.reason).toContain('inferred');
    const row = listLessons(db, { workspaceId: '/p' })[0];
    expect(row.grade).toBe('inferred');
    expect(liveImportance(row)).toBeLessThan(INJECT_THRESHOLD);
    db.close();
  });

  it('定级基础分与阈值照抄实测值', () => {
    expect([GRADES['verified-tool'], GRADES['verified-user'], GRADES['verified-file'], GRADES.inferred]).toEqual([9, 7.5, 6, 1.5]);
    expect(INJECT_THRESHOLD).toBe(6);
  });

  it('中文检索：换词能命中', () => {
    const db = mk();
    addLesson(db, { text: '改完插件源码必须先删 dist 再重建', workspaceId: '/p' });
    expect(searchLessons(db, '插件', { workspaceId: '/p' }).length).toBeGreaterThan(0);
    db.close();
  });

  it('老经验会退休，但退休后仍可被检索到', () => {
    const db = mk();
    const { id } = addLesson(db, { text: '很快退休的经验', grade: 'verified-file', sourceRef: 'x:1', workspaceId: '/p' });
    db.prepare('UPDATE lessons SET created_at = ? WHERE id = ?').run(new Date(Date.now() - 400 * 86400000).toISOString(), id);
    expect(maintainLessons(db).retired).toBeGreaterThan(0);
    expect((db.prepare('SELECT * FROM lessons WHERE id = ?').get(id) as LessonRow).status).toBe('retired');
    expect(searchLessons(db, '退休', { workspaceId: '/p' }).length).toBe(1);
    db.close();
  });

  it('Markdown 导出', () => {
    const db = mk();
    addLesson(db, { text: '导出看看', workspaceId: '/p' });
    expect(exportMarkdown(db)).toContain('导出看看');
    db.close();
  });
});