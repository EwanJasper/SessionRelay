// 冲突消解（新话压旧话）回归：判据必须保守 —— 宁可漏判，也不许乱杀一条真经验
import { describe, it, expect } from 'vitest';
import { findSupersedeConflicts, subjectTokens, hasNegation, type LessonRow } from '../../src/store/global.js';

const row = (id: number, text: string, extra: Partial<LessonRow> = {}): LessonRow => ({
  id, scope: 'global', workspace_id: null, domain: null, text, grade: 'verified-tool',
  importance: 8, status: 'verified', hits: 0, uses: 0, needs_review: 0,
  created_at: '2026-01-0' + (id % 9 + 1) + 'T00:00:00Z',
  updated_at: '2026-01-0' + (id % 9 + 1) + 'T00:00:00Z',
  ...extra,
});

describe('冲突消解 · 新话压旧话', () => {
  // 判据是**严格**的（实测教训：宽松版在真库上 4 对全误判）。所以正例必须共享 ≥3 个**具体**词。
  it('同一主题、极性相反、新的更近 → 判为冲突，且**旧的是被退休的那条**', () => {
    const older = row(1, '插件打包后必须把 dist 重新复制进 vendor 目录，否则自测跑的是旧代码',
      { updated_at: '2026-01-01T00:00:00Z' });
    const newer = row(2, '不用再把 dist 复制进 vendor 目录了，构建会自动同步',
      { updated_at: '2026-06-01T00:00:00Z' });
    const pairs = findSupersedeConflicts([older, newer]);
    expect(pairs.length).toBe(1);
    expect(pairs[0].olderId).toBe(1);
    expect(pairs[0].newerId).toBe(2);
  });

  it('极性相同不判冲突（两条都是正面说法）', () => {
    const a = row(1, '搜索排序要按长度打折');
    const b = row(2, '搜索排序要按长度打折，而且要在打分阶段做', { updated_at: '2026-06-01T00:00:00Z' });
    expect(findSupersedeConflicts([a, b])).toEqual([]);
  });

  it('主题不重叠不判冲突（都带否定词也不行）', () => {
    const a = row(1, '不要用全局变量存状态');
    const b = row(2, '不要在没有备份时删库', { updated_at: '2026-06-01T00:00:00Z' });
    expect(findSupersedeConflicts([a, b])).toEqual([]);
  });

  it('跨作用域不判冲突（全局经验与项目经验互不覆盖）', () => {
    const a = row(1, '布局用两层纸');
    const b = row(2, '不要用两层纸做布局', { scope: 'project', workspace_id: 'D:/x', updated_at: '2026-06-01T00:00:00Z' });
    expect(findSupersedeConflicts([a, b])).toEqual([]);
  });

  it('非 verified 不参与（草稿/已退休不该被拿来压别人）', () => {
    const a = row(1, '项目根必须有 .sessionrelay 才算项目');
    const b = row(2, '不要要求 .sessionrelay 了', { status: 'draft', updated_at: '2026-06-01T00:00:00Z' });
    expect(findSupersedeConflicts([a, b])).toEqual([]);
  });

  it('[实测教训] 只靠泛词重叠不算冲突 —— 这就是第一版 4 对误判的原因', () => {
    const a = row(1, '实验开关必须作用于所有代码路径，否则对照组是脏的，会话实测结果不可信');
    const b = row(2, '界面上能不能用必须与真实闸门共用判据，否则会话实测时显示与实际不一致',
      { updated_at: '2026-06-01T00:00:00Z' });
    expect(findSupersedeConflicts([a, b])).toEqual([]);
  });

  it('判定工具本身：实词与否定词识别', () => {
    expect([...subjectTokens('重新 vendor 插件')].some((t) => t === 'vendor')).toBe(true);
    expect(hasNegation('不要再 vendor')).toBe(true);
    expect(hasNegation('要重新 vendor')).toBe(false);
  });
});
