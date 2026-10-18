import { describe, it, expect } from 'vitest';
import {
  normalize,
  segment,
  parseQuery,
  unitExpr,
  toSearchText,
  activeTokenizerKind,
  setTokenizer,
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

// ── ADR-002：bigram 分词器 ──
// 背景：config.ts 早就声明 search.tokenizer: 'jieba' | 'bigram'，但 tokenizer.ts
// 长期只有 jieba 一条实现——配置里写 bigram 什么都不发生且不报错。
// 这三个不变量钉住它：① bigram 路线真的不碰词典；② setTokenizer 真的换行为；
// ③ 索引与查询共用同一实现（否则词元不一致是中文检索最大的隐性 bug 源）。
describe('S1x bigram 分词器（ADR-002）', () => {
  it('默认是 jieba', () => {
    expect(activeTokenizerKind()).toBe('jieba');
  });

  it('bigram 路线产出单字 + 相邻字对，不依赖词典', () => {
    setTokenizer('bigram');
    try {
      const toks = segment('为什么简报是空的', { keepSingles: true });
      expect(toks).toContain('为什');
      expect(toks).toContain('什么');
      expect(toks).toContain('简报');
      expect(toks).toContain('是空');
      // 单字也在（短语位置保真，与 jieba 路线同规）
      expect(toks).toContain('简');
      // 词典词不该出现——bigram 路线没有"词"的概念
      expect(toks).not.toContain('为什么');
    } finally {
      setTokenizer('jieba');
    }
  });

  it('非 CJK 标识符在两条路上都保留原样', () => {
    setTokenizer('bigram');
    try {
      const toks = segment('better-sqlite3 原生 binding', { keepSingles: true });
      expect(toks).toContain('better-sqlite3');
      expect(toks).toContain('binding');
      expect(toks).toContain('原生');
    } finally {
      setTokenizer('jieba');
    }
  });

  it('setTokenizer 真的切换行为（不是空操作）', () => {
    const jiebaOut = toSearchText('为什么简报是空的');
    setTokenizer('bigram');
    let bigramOut = '';
    try { bigramOut = toSearchText('为什么简报是空的'); } finally { setTokenizer('jieba'); }
    expect(jiebaOut).not.toBe(bigramOut);
    expect(activeTokenizerKind()).toBe('jieba'); // finally 恢复了默认
  });

  it('索引与查询共用同一实现：切到 bigram 后查询词元能在索引词元里找到', () => {
    setTokenizer('bigram');
    try {
      const idx = toSearchText('我们决定改用 pwsh 直查 SQL，弃用子进程');
      const q = parseQuery('"改用 pwsh"');
      // 引号短语的每个词元都必须出现在索引文本里，否则这条查询永远查不到自己
      for (const unit of q.units) {
        for (const t of unit) expect(idx.split(' ')).toContain(t);
      }
    } finally {
      setTokenizer('jieba');
    }
  });

  it('keepSingles=false 时丢弃单字（区分度），两条路同规', () => {
    setTokenizer('bigram');
    try {
      const toks = segment('为什么简报是空的', { keepSingles: false });
      expect(toks).not.toContain('简');
      expect(toks).toContain('简报');
    } finally {
      setTokenizer('jieba');
    }
  });
});

describe('P12 · parseQuery 冗余子词剔除（1015，外部专家方案 3.5 合入）', () => {
  it('「数据库重算游标」剔除 数据/据库 两个冗余子词，只留 3 个单元', () => {
    expect(parseQuery('数据库重算游标').units.map((x) => x[0])).toEqual(['数据库', '重算', '游标']);
  });
  it('无冗余子词的查询一条不动', () => {
    expect(parseQuery('守护进程').units.map((x) => x[0])).toEqual(['守护', '进程']);
    expect(parseQuery('node:sqlite 直查').units.map((x) => x[0])).toEqual(['node', 'sqlite', '直查']);
  });
  it('显式短语单元不受影响（用户加引号的动不得）', () => {
    const u = parseQuery('"数据库" 重算').units;
    expect(u[0].length).toBeGreaterThan(1);
  });
  it('全部词元都是冗余时不会把查询弄空', () => {
    expect(parseQuery('数据库').units.length).toBeGreaterThan(0);
  });
  it('英文查询不受影响', () => {
    expect(parseQuery('better-sqlite3').units.map((x) => x[0]).length).toBeGreaterThan(0);
  });
  it('实测收益：真实引擎上「数据库重算游标」从 28 条收到 6 条', () => {
    // 这一条是行为锚点，不是性能断言——性能数字见 docs/外部顾问团报告-20261015.md §2-F
    const before = parseQuery('数据库重算游标').units.length;
    expect(before).toBe(3);
  });
});
