import { describe, it, expect } from 'vitest';
import { foldNearDuplicates, lengthRatioGate } from '../../src/core/compact/fold.js';

const r = (text: string, at: string) => ({ text, at });

describe('呈现层折叠', () => {
  it('近重复折叠成一条 + dupCount，且**保持输入顺序**', () => {
    const rows = [r('改用免管理员的启动文件夹方案', '2026-10-16'), r('别的决策', '2026-10-16'), r('改用免管理员的启动文件夹方案', '2026-10-17')];
    const out = foldNearDuplicates(rows, 0.8, lengthRatioGate);
    expect(out.folded).toBe(1);
    expect(out.rows.length).toBe(2);
    expect(out.rows[0].text).toBe('改用免管理员的启动文件夹方案');   // 代表 = 最新那条
    expect((out.rows[0] as Record<string, unknown>).dupCount).toBe(2);
    expect(out.rows[1].text).toBe('别的决策');                        // 顺序未变
  });
  it('[生产 bug 回归] 长度比门挡住"前缀相同但长度差 3.88 倍"的粘连噪声', () => {
    const clean = '采用 Vite 作为前端构建工具';
    const noise = clean + '：旧方案是 Turbopack，SES 的决策- 改用 Turbopack 当场丢弃- 决定改不';
    expect(lengthRatioGate(clean, noise)).toBe(false);            // 长度比门拦住
    const out = foldNearDuplicates([r(noise, '2026-10-16'), r(clean, '2026-10-17')], 0.8, lengthRatioGate);
    expect(out.folded).toBe(0);                                   // 不许把干净的吞掉
  });
  it('[1017 回归] prefer：置顶条目必须当代表（否则被更新的同组决策顶掉）', () => {
    const old = { text: '选择器改当前会话', at: '2026-09-10', pinned: true };
    const fresh = { text: '选择器改当前会话', at: '2026-10-17', pinned: false };
    const out = foldNearDuplicates([fresh, old], 0.8, lengthRatioGate, { prefer: (d) => d.pinned === true });
    expect(out.folded).toBe(1);
    expect(out.rows[0]).toBe(old);          // 不是"最新的那条"，而是被置顶的那条
    expect(out.rows[0].pinned).toBe(true);
  });
  it('prefer 不重排：代表放回本组首次出现的位置', () => {
    const a = { text: '选择器改当前会话', at: '2026-09-10', pinned: true };
    const b = { text: '别的决策', at: '2026-10-15' };
    const c = { text: '选择器改当前会话', at: '2026-10-17' };
    const out = foldNearDuplicates([a, b, c], 0.8, lengthRatioGate, { prefer: (d) => d.pinned === true });
    expect(out.rows.map((x) => x.text)).toEqual(['选择器改当前会话', '别的决策']);
  });
  it('空输入与单条不炸', () => {
    expect(foldNearDuplicates([], 0.8, lengthRatioGate).rows.length).toBe(0);
    expect(foldNearDuplicates([r('x', '2026-01-01')], 0.8, lengthRatioGate).rows.length).toBe(1);
  });
});
