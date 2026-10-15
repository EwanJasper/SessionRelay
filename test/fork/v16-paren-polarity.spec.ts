// [1015 v16 回归] 括号**极性**守卫：数量配对不够，顺序错同样是残片。
//
// 病历（m1 简报审计逐条溯源）：`弃用）、`backups\gh-clones-20261013`（冗余 clone` 与
// `采用宿主探测）；Z9 PR #3 拆三批方案 ✅；Z10 …（当时 260 passed` 两条都进了简报，
// 因为旧守卫只数**数量**——恰好 1 个 ）+ 1 个 （，数量配对，于是放行；但顺序是"先闭后开"，
// 说明是从 `（已弃用）、…（冗余 clone）` 这种长句内部截出来的。
//
// 实测（真实库全量决策，去重后）：agent1super 拒 35 条、music 拒 13 条，逐条读完全部是碎片，
// 0 条真决策被误杀（唯一 borderline 是 music 的一条"决定】① …"枚举残片，本身也已残缺）。
//
// 双向断言：该拒的必须拒 + 真决策（含反引号里的 `foo()`）一条都不许杀。
import { describe, it, expect } from 'vitest';
import { parenDepthOk } from '../../src/core/extract/extract.js';

describe('[v16] 括号极性守卫', () => {
  it('① 先闭后开 = 从括号内部截出的残片 → 拒', () => {
    expect(parenDepthOk('弃用）、`backups\\gh-clones-20261013\\`（冗余 clone')).toBe(false);
    expect(parenDepthOk('采用宿主探测）；Z9 PR #3 拆三批方案 ✅；Z10 核心库测试维护（当时 260 passed')).toBe(false);
    expect(parenDepthOk('选择文件」（灰色圆角按钮')).toBe(false);
  });

  it('② 正常决策（含嵌套与反引号里的函数调用）一条都不许杀', () => {
    expect(parenDepthOk('改用 `fileURLToPath()` 处理路径（正确处理编码）')).toBe(true);
    expect(parenDepthOk('改用 `raw.match(/"/g)` 规则匹配引号')).toBe(true);
    expect(parenDepthOk('决定把裁决器从 IF 链改成状态机（三态：待定/采用/弃用）')).toBe(true);
    expect(parenDepthOk('没有括号的普通决策')).toBe(true);
    expect(parenDepthOk('')).toBe(true);
  });

  it('③ 反引号里的 ) 不算文本括号（`foo()` 不该触发极性负)', () => {
    // 若忘了先剥内联代码，这一条会被误杀——正是 quotesBalanced 的同一个坑
    expect(parenDepthOk('改用 `writeFileSync()` 落盘，再 `close()` 释放')).toBe(true);
  });
});
