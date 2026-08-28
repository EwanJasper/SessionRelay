import { describe, it, expect } from 'vitest';
import {
  extractFiles, extractTopics, extractDecisions, extractQuestions,
  countCodeBlocks, extractMessages, summaryRule, type Msg,
} from '../../src/core/extract/extract.js';

const msg = (role: 'user' | 'assistant', content: string, seq = 1): Msg =>
  ({ role, content, seqNum: seq, createdAt: '2026-08-28T10:00:00Z' });

describe('P2 · files 提取', () => {
  it('绝对路径与带扩展名相对路径，反斜杠归一', () => {
    const files = extractFiles(['改一下 D:\\src\\db\\query.ts 和 src/auth/jwt.ts 看看']);
    expect(files).toContain('D:/src/db/query.ts');
    expect(files).toContain('src/auth/jwt.ts');
  });
  it('无扩展名普通词不误报，数量上限 20', () => {
    expect(extractFiles(['这个功能怎么实现一下'])).toHaveLength(0);
    const many = Array.from({ length: 40 }, (_, i) => `file${i}.ts`).join(' ');
    expect(extractFiles([many]).length).toBeLessThanOrEqual(20);
  });
});

describe('P2 · topics 提取', () => {
  it('TF + 停用词过滤 + 用户加权', () => {
    const msgs = [
      msg('user', '数据库 数据库 索引 索引 索引 怎么设计'),
      msg('assistant', '索引用 B+树，数据库分区按月'),
    ];
    const topics = extractTopics(msgs);
    expect(topics[0]).toBe('索引'); // 用户双倍权重 + 频次
    expect(topics).toContain('数据库');
    expect(topics).not.toContain('怎么'); // 停用词
  });
});

describe('P2 · decisions 提取', () => {
  it('决策句式命中并带序号出处', () => {
    const decs = extractDecisions([
      msg('assistant', '综合考虑，最终选用 PostgreSQL 作为主库，分区按月。', 3),
      msg('user', '好的，认证方案定为 JWT。', 5),
      msg('assistant', '这个问题我们再看看。', 7),
    ]);
    expect(decs).toHaveLength(2);
    expect(decs[0].text).toContain('PostgreSQL');
    expect(decs[0].seq).toBe(3);
    expect(decs[1].text).toContain('JWT');
  });
  it('去重与上限', () => {
    const msgs = Array.from({ length: 20 }, (_, i) => msg('assistant', `决定采用方案A作为第${i}步`, i + 1));
    expect(extractDecisions(msgs).length).toBeLessThanOrEqual(10);
  });
});

describe('P2 · key_questions 提取', () => {
  it('用户问句提取，尾部提问标记未决', () => {
    const msgs: Msg[] = [
      msg('user', '为什么要用 JWT 做认证？', 1),
      msg('assistant', '因为微服务间无法共享 Session。', 2),
      msg('user', '刷新策略定了吗，如果还没定的话要不要下次再说？', 3),
    ];
    const qs = extractQuestions(msgs);
    expect(qs).toHaveLength(2);
    expect(qs[1].unresolved).toBe(true); // 尾部 + 含"还没"
  });
});

describe('P2 · code_changes 与 summary_rule', () => {
  it('围栏代码块计数', () => {
    expect(countCodeBlocks(['看代码：\n```ts\nx=1\n```\n结束'])).toBe(1);
  });
  it('摘要含决策/未决/数据行', () => {
    const meta = extractMessages([
      msg('user', '索引怎么建？', 1),
      msg('assistant', '决定用 B+树索引', 2),
    ]);
    const s = summaryRule('索引讨论', meta, { messageCount: 2, source: 'zcode', firstAt: '2026-08-28T08:00:00Z', lastAt: '2026-08-28T09:00:00Z' });
    expect(s).toContain('索引讨论');
    expect(s).toContain('决定用 B+树索引');
    expect(s).toContain('2 消息');
  });
});
