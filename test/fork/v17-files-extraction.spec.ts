// [v17 回归] files 抽取：**必须「文件名 + 扩展名」**，且先剥 URL。
//
// 病历：旧正则第一个分支不要求扩展名 → 把任何斜杠串当文件，实测精度仅 26%/33%：
// `/task-id`、`/tool-use-id`、`/status`、`/127.0.0.1`、`D:/agent1super`、`/zcode-context`。
//
// 双向断言：真路径一条都不许丢 + 各类垃圾一条都不许进。
import { describe, it, expect } from 'vitest';
import { extractFiles } from '../../src/core/extract/extract.js';

const one = (s: string) => extractFiles([s]);

describe('[v17] files 抽取重建', () => {
  it('① 真实文件引用都要保住（相对/绝对/中文名/带 @ 与括号）', () => {
    expect(one('看了 src/store/db.ts 与 D:\\agent1super\\docs\\交接-20261015.md')).toContain('src/store/db.ts');
    expect(one('读了 AGENTS.md')).toContain('AGENTS.md');
    expect(one('改 p1b/scripts/corpus-resolve.cjs')).toContain('p1b/scripts/corpus-resolve.cjs');
    expect(one('外部报告存档/SES深度源码审计与全维度演进方案-20261015-原文.md 已归档')).toContain('外部报告存档/SES深度源码审计与全维度演进方案-20261015-原文.md');
    expect(one('装 @scope/pkg/index.mjs')).toContain('@scope/pkg/index.mjs');
  });

  it('② 旧正则的垃圾一条都不许再进', () => {
    const junk = '/task-id /tool-use-id /status /output-file /summary /127.0.0.1 D:/agent1super /zcode-context /docx/HTML/PDF /specs /message E:/music';
    expect(one(junk)).toEqual([]);
  });

  it('③ URL 里的文件不算项目文件', () => {
    expect(one('见 https://github.com/a/b/README.md 与 http://x.test/docs/guide.md')).toEqual([]);
  });

  it('④ 句子残片（超长文件名段）被滤掉', () => {
    const long = '把结论回写到使用速查' + '很'.repeat(60) + '.md';
    expect(one(long)).toEqual([]);
  });
});
