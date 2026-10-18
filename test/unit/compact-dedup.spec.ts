// L1 去重合并回归：判据要能吃重复、又不能吃掉"展开说明"和"相反结论"
import { describe, it, expect } from 'vitest';
import { compactItems, isNearDuplicate } from '../../src/core/compact/dedup.js';

const it_ = (text: string, at: string, kind = 'decision') => ({ text, at, kind });

describe('压缩 L1 · 确定性去重合并', () => {
  it('同一件事说两遍 → 合并，保留新的，并记下频次', () => {
    const r = compactItems([
      it_('改用免管理员的启动文件夹方案', '2026-10-16T10:00:00Z'),
      it_('改用免管理员的启动文件夹方案', '2026-10-17T10:00:00Z'),
    ]);
    expect(r.kept.length).toBe(1);
    expect(r.kept[0].at).toBe('2026-10-17T10:00:00Z');
    expect((r.kept[0] as Record<string, unknown>).dupCount).toBe(2);
    expect((r.kept[0] as Record<string, unknown>).firstSeen).toBe('2026-10-16T10:00:00Z');
  });

  it('极性相反不合并（那是冲突，交给 needs_review 而不是悄悄删掉一条）', () => {
    expect(isNearDuplicate('改用 gh CLI 查', '改用 gh CLI 查，不要用 curl').dup).toBe(false);
  });

  it('长度差太多的不合并（长的是展开，不是重复）', () => {
    const short = '布局用两层纸';
    const long = '布局用两层纸：外层是背景与规线，内层是内容与卡片，两层之间的间距用 8px 网格统一，颜色分别取自 --bg 与 --sheet';
    expect(isNearDuplicate(short, long).dup).toBe(false);
  });

  it('不同主题不合并（即使都短）', () => {
    expect(isNearDuplicate('搜索要按长度打折', '包体要压到 20MB 以内').dup).toBe(false);
  });

  it('三条重复只留一条，另两条进 absorbed', () => {
    const r = compactItems([
      it_('项目根必须有 .sessionrelay 才算项目', '2026-01-01T00:00:00Z'),
      it_('项目根必须有 .sessionrelay 才算项目', '2026-02-01T00:00:00Z'),
      it_('项目根必须有 .sessionrelay 才算项目', '2026-03-01T00:00:00Z'),
    ]);
    expect(r.kept.length).toBe(1);
    expect(r.groups[0].absorbed.length).toBe(2);
  });
});
