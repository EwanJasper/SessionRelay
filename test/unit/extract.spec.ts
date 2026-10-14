import { describe, it, expect } from 'vitest';
import {
  extractFiles, extractTopics, extractDecisions, extractQuestions,
  countCodeBlocks, extractMessages, summaryRule, extractKeyExchanges, type Msg,
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


describe('P2+ · key_exchanges 关键往返', () => {
  it('含决策的往返优先提取', () => {
    const msgs: Msg[] = [
      { role: 'user', content: '我们决定了用 PostgreSQL 作为主库，分区按月', seqNum: 1 },
      { role: 'assistant', content: '好的，这是一个明智的选择，因为分区表支持更好', seqNum: 2 },
      { role: 'user', content: '好的', seqNum: 3 },  // 太短不配对
      { role: 'user', content: '今天的天气怎么样', seqNum: 4 },  // 无决策无问题
      { role: 'assistant', content: '晴天', seqNum: 5 },
    ];
    const ex = extractKeyExchanges(msgs);
    expect(ex.length).toBeGreaterThanOrEqual(1);
    expect(ex[0].reason).toContain('决策');
    expect(ex[0].userSeq).toBe(1);
  });

  it('上限 8 组', () => {
    const msgs: Msg[] = [];
    for (let i = 0; i < 20; i++) {
      msgs.push({ role: 'user', content: '为什么这里要这样设计一个很长的问题需要讨论清楚' + i, seqNum: i * 2 + 1 });
      msgs.push({ role: 'assistant', content: '因为架构考虑' + i, seqNum: i * 2 + 2 });
    }
    expect(extractKeyExchanges(msgs).length).toBeLessThanOrEqual(8);
  });

  it('extractMessages 输出包含 keyExchanges', () => {
    const meta = extractMessages([
      { role: 'user', content: '决定了采用 Redis 做缓存', seqNum: 1 },
      { role: 'assistant', content: '好的', seqNum: 2 },
    ]);
    expect(meta.keyExchanges).toBeDefined();
    expect(meta.keyExchanges.length).toBeGreaterThanOrEqual(1);
  });
});

// ── [fork 1013] 审计 P4：转述/引用过滤 + 词中误命中 ──
// 依据：E:\music player\docs\sessionrelay-审计报告-20261013.md
// P4：未决问题会收录用户消息里转述的他人文本；同一份粘贴报告产出 3 条近似条目。
// P4b：「决定论」被 DECISION_STRONG 的"决定"命中（抽样 28 条里出现 2 次）。
describe('P4 · 转述过滤（复审：粘贴的报告不是我的决策/问题）', () => {
  it('「助手最后停在向用户提问"…"」不作未决问题', () => {
    const q = extractQuestions([
      msg('user', '此外助手最后停在向用户提问（"要我把这两项也一并按推荐处理掉，还是继续推进别的？"），你看怎么弄'),
    ]);
    expect(q.map(x => x.q)).not.toContainEqual(expect.stringMatching(/助手最后停在/));
  });

  it('「报告原文说…」不作决策', () => {
    const d = extractDecisions([
      msg('user', '报告原文说"最终选用 Postgres 而非 MySQL"，这个结论你怎么看'),
    ]);
    expect(d.map(x => x.text)).not.toContainEqual(expect.stringMatching(/^最终选用 Postgres/));
  });

  it('blockquote 行（> 开头）的问句不进未决清单', () => {
    const q = extractQuestions([
      msg('user', '> 需要确认这是否影响向后兼容？\n我这边先看看'),
    ]);
    expect(q).toHaveLength(0);
  });

  it('用户自己问的真问题仍然收录（不能过度过滤）', () => {
    const q = extractQuestions([
      msg('user', '我们这套方案要不要现在就升级内核？我还没定'),
    ]);
    expect(q.length).toBeGreaterThanOrEqual(1);
    expect(q[0].q).toMatch(/升级内核/);
  });
});

describe('P4b · 词中误命中（触发词出现在更长词内部时不算决策）', () => {
  it('「决定论」不是决策', () => {
    const d = extractDecisions([
      msg('user', '决定论 规则明确，能算出来 象棋残局这种场景'),
    ]);
    expect(d.map(x => x.text)).not.toContainEqual(expect.stringMatching(/决定论/));
  });

  it('「选择性」「放弃治疗」等复合词不误命中', () => {
    const d = extractDecisions([
      msg('user', '选择性忽略一部分字段；放弃治疗这个想法不现实'),
    ]);
    expect(d).toHaveLength(0);
  });

  it('真决策「决定改用 X」不受影响', () => {
    const d = extractDecisions([msg('user', '我们决定改用 SQLite 做本地索引')]);
    expect(d).toHaveLength(1);
    expect(d[0].text).toMatch(/改用 SQLite/);
  });
});

describe('P4c · 词中误命中补遗（简报实测暴露的新样本）', () => {
  it('「决定性旁证」不是决策', () => {
    const d = extractDecisions([msg('user', '决定性旁证：你自己的订阅里写着答案')]);
    expect(d.map(x => x.text)).not.toContainEqual(expect.stringMatching(/决定性/));
  });
  it('「确定性」不是决策', () => {
    const d = extractDecisions([msg('user', '这个系统的确定性很强，同样的输入必然得到同样的输出')]);
    expect(d).toHaveLength(0);
  });
  it('真决策「决定采用」不受连带影响', () => {
    const d = extractDecisions([msg('user', '我们决定采用渐进式披露做上下文注入')]);
    expect(d).toHaveLength(1);
    expect(d[0].text).toMatch(/渐进式披露/);
  });
});

describe('P4d · 未决问题显示归一化（1014：压口语不丢信息）', () => {
  const msg = (role: 'user' | 'assistant', content: string, seq = 1): Msg =>
    ({ role, content, seqNum: seq, createdAt: '2026-10-14T10:00:00Z' });

  it('口语填充被压掉，真疑问保留', () => {
    const q = extractQuestions([msg('user', '呃，就是active，就是这个现在这个UU配的这个档，这个我是有pro的，我有pro账号，但是为什么没有那个呢？')]);
    expect(q).toHaveLength(1);                          // 不拒绝——这是真问题
    expect(q[0].q).toMatch(/为什么没有那个/);            // 核心疑问保留
    expect(q[0].q.length).toBeLessThan(56);              // 但比原文短
  });

  it('第二个样本同样压缩且保留疑问', () => {
    const q = extractQuestions([msg('user', '还有那个谷歌那边，我们做的谷歌那边的话，为什么模型只有那个3.8flash？')]);
    expect(q).toHaveLength(1);
    expect(q[0].q).toMatch(/为什么模型只有/);
  });

  it('本来就干净的问题不被改动', () => {
    const q = extractQuestions([msg('user', '为什么量化之后算术能力下降这么多？')]);
    expect(q).toHaveLength(1);
    expect(q[0].q).toBe('为什么量化之后算术能力下降这么多？');
  });

  it('短问句完整保留（注意：<8 字符被既有守卫挡掉，用 10 字符的真实短问）', () => {
    const q = extractQuestions([msg('user', '这个插件要怎么用起来？')]);
    expect(q).toHaveLength(1);
    expect(q[0].q).toContain('怎么用');
  });
});
