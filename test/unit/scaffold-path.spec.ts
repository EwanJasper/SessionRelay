import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pickScaffold, rewriteQuery } from '../../src/core/tokenize/rewrite.js';
import { openRelayDb } from '../../src/cli/ui.js';

/**
 * 「剔问句外壳」这条路的判据（2026-10-18）。
 *
 * 病历：`pickScaffold` 从 1016 就写好了，rewrite.ts 的文件头注释也一直写着
 *   「剔问句外壳 + 手写同义家族 + CJK bigram 展开」三个手段，但**生产代码从没调用过它**。
 *   测试只测它自己（pickScaffold 返回什么），所以永远是绿的 —— 它没有「被接进检索」的证据。
 *   这是最难发现的一类死代码：git blame 正常、单测通过、运行不报错。
 *
 * 所以这里不放「函数返回什么」，放**接线事实**。
 */
const ENGINE = fs.readFileSync(path.join(process.cwd(), 'src/search-svc/engine.ts'), 'utf8');

describe('剔问句外壳 · 接线判据', () => {
  it('pickScaffold 在生产代码里**真的被调用**（不是死代码）', () => {
    expect(ENGINE.includes('pickScaffold(')).toBe(true);
  });

  it('这条路挂在主检索里，而不是只存在于注释中', () => {
    expect(ENGINE.includes('opts.coreOnly')).toBe(true);
    expect(ENGINE.includes('coreTokens')).toBe(true);
  });

  it('它是 AND 路（不传 orUnits），且关掉融合的统一长度惩罚（lengthNorm: false）', () => {
    // 这两条都是易错点：① 传 orUnits 就退化成同义词那条 OR 路（只能补队尾，永远改善不了 hit@1）；
    // ② 不关 lengthNorm 会被罚两次（融合那一步还会再乘一次）。
    const seg = ENGINE.slice(ENGINE.indexOf('opts.coreOnly'));
    const line = seg.slice(0, seg.indexOf('paths.push'));
    expect(line.includes('lengthNorm: false')).toBe(true);
    expect(line.includes('orUnits')).toBe(false);
  });
});

describe('剔外壳 · 语义边界', () => {
  it('全是外壳词时不触发（没有实词可搜）', () => {
    const t = ['请问', '这个', '怎么', '吗'];
    const scaffold = new Set(pickScaffold(t));
    expect(t.filter((x) => !scaffold.has(x))).toEqual([]);
  });

  it('没有外壳词时也不触发（省一次查询）', () => {
    const t = ['PostgreSQL', '迁移'];
    expect(pickScaffold(t)).toEqual([]);
  });

  it('「那个/这个」这类指示词必须算外壳（实测失败题里它们占了大头）', () => {
    // 病历：`给那个编辑器列的问题清单，最高优先级那条是什么` 排到第 9；
    //   真信号只有「问题清单」，其余全是外壳。
    expect(pickScaffold(['那个', '编辑器', '问题', '清单'])).toEqual(['那个']);
  });
});
