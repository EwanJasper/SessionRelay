import { describe, it, expect } from 'vitest';
import {
  normalize,
  segment,
  parseQuery,
  unitExpr,
  toSearchText,
} from '../../../src/core/tokenize/tokenizer.js';

describe('S1 分词器 · normalize', () => {
  it('全角转半角 + 小写 + 空白折叠', () => {
    expect(normalize('ＪＷＴ　ｔｏｋｅｎ　Ｔｅｓｔ')).toBe('jwt token test');
  });
});

describe('S1 分词器 · segment', () => {
  it('中英混合：认证与 jwt 均为词元', () => {
    const toks = segment('用 JWT 做认证');
    expect(toks).toContain('jwt');
    expect(toks).toContain('认证');
  });

  it('标识符保持单 token（src/db/query.ts 不可拆）', () => {
    const toks = segment('看下 src/db/query.ts 的实现', { keepSingles: false });
    expect(toks).toContain('src/db/query.ts');
  });

  it('查询模式丢弃单字 CJK（区分度）', () => {
    const toks = segment('我们讨论了建索引的方案', { keepSingles: false });
    expect(toks).toContain('索引');
    expect(toks).toContain('方案');
    expect(toks).not.toContain('了');
    expect(toks).not.toContain('的');
  });

  it('索引模式保留单字且保持位置（"按月"非词典词 → 按|月 相邻）', () => {
    const toks = toSearchText('按月分区方案');
    // 短语查询 C5 依赖该序列的位置连续性
    expect(toks.split(' ').slice(0, 4)).toEqual(['按', '月', '分区', '方案']);
  });
});

describe('S1 分词器 · 查询解析', () => {
  it('连写关键词拆为多个 AND 单元（认证方案 → 认证 + 方案）', () => {
    const { units } = parseQuery('认证方案');
    const flat = units.map((u) => u[0]);
    expect(flat).toContain('认证');
    expect(flat).toContain('方案');
    expect(units.every((u) => u.length === 1)).toBe(true);
  });

  it('空格分隔关键词各成单元（数据库 分区）', () => {
    const { units } = parseQuery('数据库 分区');
    const flat = units.map((u) => u[0]);
    expect(flat).toContain('数据库');
    expect(flat).toContain('分区');
  });

  it('引号短语保留完整 token 序列（含单字）', () => {
    const { units } = parseQuery('"按月分区"');
    expect(units.length).toBe(1);
    expect(units[0]).toEqual(['按', '月', '分区']);
  });

  it('表达式生成', () => {
    expect(unitExpr(['索引'])).toBe('"索引"');
    expect(unitExpr(['按', '月', '分区'])).toBe('"按 月 分区"');
  });
});
