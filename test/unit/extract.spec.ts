import { describe, it, expect } from 'vitest';
import {
  extractFiles, extractTopics, extractDecisions, extractQuestions,
  countCodeBlocks, extractMessages, summaryRule, extractKeyExchanges, stripInjected, looksInjected, isNegativeDecision, type Msg,
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

// ═══ 2026-10-14 根修：注入块剥离 + 决策去重 ═══
// 背景：DSH/ZCode 把系统上下文（技能目录等）包在 <system-reminder> 里塞进 user
// 消息正文，提取器按角色过滤也没用。实测 steel-manning 技能说明里的
// "再决定接受、修订或坚持"被当成用户决策，在库里重复 24+19 次，占满简报名额。
describe('stripInjected：注入块不许进提取', () => {
  const msg = (role: 'user' | 'assistant', content: string) => ({ role, content, seqNum: 1 });

  it('system-reminder 成对块被整块剥掉', () => {
    const s = stripInjected('我们最终统一用 PostgreSQL。\n<system-reminder>\n- `steel-manning`: 先构建反方论证，再决定接受、修订或坚持\n</system-reminder>\n剩下这句是真的。');
    expect(s).not.toContain('steel-manning');
    expect(s).not.toContain('system-reminder');
    expect(s).toContain('我们最终统一用 PostgreSQL');
    expect(s).toContain('剩下这句是真的');
  });

  it('注入块里的"决定"不再被提成决策', () => {
    const meta = extractMessages([msg('user',
      '我们最终采用 PostgreSQL 作为主库。\n<system-reminder>\n- `steel-manning`: 先构建反方最强的忠实论证，写明同意与推翻条件，再决定接受、修订或坚持。\n</system-reminder>')]);
    expect(meta.decisions).toHaveLength(1);
    expect(meta.decisions[0].text).toContain('PostgreSQL');
    expect(meta.decisions[0].text).not.toContain('修订或坚持');
  });

  it(' reminder / env / ctx 变体同样剥', () => {
    expect(stripInjected('a<reminder>x</reminder>b')).toBe('a\nb');
    expect(stripInjected('a<environment>x</environment>b')).toBe('a\nb');
    expect(stripInjected('a<context>x</context>b')).toBe('a\nb');
  });

  it('没有注入块时原文不动（不能误伤正常消息）', () => {
    const t = '我们改用 node:sqlite 直查，冷路径从 284ms 降到 5ms。';
    expect(stripInjected(t)).toBe(t);
  });

  it('大小写不敏感', () => {
    expect(stripInjected('a<System-Reminder>x</SYSTEM-REMINDER>b')).toBe('a\nb');
  });
});

describe('决策跨会话去重（与 listUnresolved 同规）', () => {
  const msg = (role: 'user' | 'assistant', content: string) => ({ role, content, seqNum: 1 });

  it('同一会话里重复出现的同一条决策只留一条', () => {
    const meta = extractMessages([
      msg('user', '我们最终统一用 PostgreSQL。'),
      msg('assistant', '好的。'),
      msg('user', '我们最终统一用 PostgreSQL。'),
    ]);
    const same = meta.decisions.filter((d) => d.text.includes('PostgreSQL'));
    expect(same).toHaveLength(1);
  });

  it('去重只按文本，不影响不同决策', () => {
    const meta = extractMessages([
      msg('user', '我们最终统一用 PostgreSQL。'),
      msg('user', '我们最终统一用 REST 规范。'),
    ]);
    expect(meta.decisions).toHaveLength(2);
  });
});

describe('技能目录行剥离（无 XML 外壳的第二种注入）', () => {
  const msg = (role: 'user' | 'assistant', content: string) => ({ role, content, seqNum: 1 });

  it('markdown 列表形态的技能目录行被剥掉', () => {
    const s = stripInjected('好的，我们用 PostgreSQL。\n- `steel-manning`: 最强反方论证：先构建反方论证，再决定接受、修订或坚持\n- `ppt-master`: AI-driven presentation builder');
    expect(s).not.toContain('steel-manning');
    expect(s).not.toContain('ppt-master');
    expect(s).not.toContain('修订或坚持');
    expect(s).toContain('我们用 PostgreSQL');
  });

  it('executing-plans 那种英文技能描述同样剥', () => {
    const s = stripInjected('- `executing-plans`: 有一份写好的实施计划要执行时使用。Use when you have a written implementation plan to execute with review checkpoints.');
    expect(s.trim()).toBe('');
  });

  it('用户自己写的普通列表项不被误杀', () => {
    const t = '- 第一件事：把数据库迁完\n- 第二件事：补测试';
    expect(stripInjected(t)).toBe(t);
  });

  it('中文冒号形态也认', () => {
    const s = stripInjected('- `foo-bar`: 某个技能的描述');
    expect(s.trim()).toBe('');
  });
});

describe('looksInjected：doctor 体检用的注入判定（与 stripInjected 同规则）', () => {
  // ⚠️ 契约在 1014 红队后改过：looksInjected 必须与 stripInjected **逐条同源**。
  // 旧版多一条"裸 HTML 标签"兜底，导致两个方向都出错——合法前端决策被判注入（doctor
  // 永久红灯），而真正要抓的无标签残片又检不出。现在：成对块才判注入；裸标签残片
  // （"…坚持</system-reminder>"这类）交给 doctor 侧的 SKILL.md 原文比对兜底。
  it('成对的 system-reminder 块判为注入', () => {
    const block = '<system-reminder>' + '\n' + '某技能说明' + '\n' + '</system-reminder>';
    expect(looksInjected(block)).toBe(true);
  });
  it('裸闭合标签残片不判注入（由 doctor 的 SKILL.md 比对兜底，不在此误报）', () => {
    expect(looksInjected('决定接受、修订或坚持</system-reminder>')).toBe(false);
  });
  it('技能目录行判为注入', () => {
    expect(looksInjected('- `steel-manning`: 最强反方论证，先构建反方论证')).toBe(true);
    expect(looksInjected('- `executing-plans`: Use when you have a written plan')).toBe(true);
  });
  it('合法前端决策不再被误判为注入（红队 1014 🟠4）', () => {
    expect(looksInjected('决定把 `<div>` 布局换成 `<section>`')).toBe(false);
  });
  it('用户真话不判为注入（不能误报，否则体检天天叫）', () => {
    expect(looksInjected('我们最终统一用 PostgreSQL 作为主库')).toBe(false);
    expect(looksInjected('为什么模型只有那个3.8flash？')).toBe(false);
    expect(looksInjected('改用 pwsh 直接 HTTPS 拉取，拿到 registry 原始 packument')).toBe(false);
  });
});

// ── ADR-001：否定性决策标记 ──
// 只做标记不做抽取：文本早已过 plausibleDecision / DECISION_FALSE_POSITIVE / isQuotedSpeech
// 三道校验，所以这里测的是"标记判得准不准"，不是"抽得全不全"。
describe('isNegativeDecision：给"否掉一条路"的决策打标记（ADR-001）', () => {
  it('切换/放弃族判为否定', () => {
    expect(isNegativeDecision('改用 pwsh 直接 HTTPS 拉取，拿到 registry 原始 packument')).toBe(true);
    expect(isNegativeDecision('放弃了源码编译的路线——官方包自带构建好的成品，更省事也少踩坑')).toBe(true);
    expect(isNegativeDecision('换成官方包，直接装到 `E:\inkos`')).toBe(true);
    expect(isNegativeDecision('不再用 npx 拉上游原版')).toBe(true);
    expect(isNegativeDecision('回退到 v3.1.4 的分支')).toBe(true);
    expect(isNegativeDecision('统一不采用 browser-use')).toBe(true);
  });
  it('拍板采用的决策不判为否定', () => {
    expect(isNegativeDecision('我们最终统一用 PostgreSQL 作为主库')).toBe(false);
    expect(isNegativeDecision('决定采用渐进式披露，省 token 的套路')).toBe(false);
    expect(isNegativeDecision('核心库存储定为 SQLite + FTS5')).toBe(false);
  });
  it('"切换到/改为"故意不判否定——它们是中性的，负面常常并不存在', () => {
    // 实测样本："切换成功——触屏活着（[nav] 只埋路由不埋 tab，虚惊）"是正面句
    expect(isNegativeDecision('切换成功——触屏活着')).toBe(false);
    expect(isNegativeDecision('改为直查 SQL 通道')).toBe(false);
  });
  it('词中误命中防护：中文无词边界，"切换成"里含着"换成"', () => {
    // 与 DECISION_FALSE_POSITIVE（"决定论"≠决定）同一类病，实测已中招
    expect(isNegativeDecision('切换成功了')).toBe(false);
    expect(isNegativeDecision('切换成 v3.1.5 分支')).toBe(false);
    expect(isNegativeDecision('不放弃这条路线')).toBe(false);
    expect(isNegativeDecision('绝不放弃本地优先')).toBe(false);
    expect(isNegativeDecision('并未放弃')).toBe(false);
  });
  it('客套语不是否定决策', () => {
    expect(isNegativeDecision('不用感谢')).toBe(false);
    expect(isNegativeDecision('不用客气')).toBe(false);
  });
  it('失败判定族（不可行/不装…）故意不判——那条路要新建抽取路径，精度未达标', () => {
    expect(isNegativeDecision('本地新常驻大模型不可行')).toBe(false);
    expect(isNegativeDecision('按你的原则不装 chinese-longnovel-skill')).toBe(false);
  });
  it('非字符串/空串不抛', () => {
    expect(isNegativeDecision('')).toBe(false);
    // @ts-expect-error 故意传错类型，验证不抛
    expect(isNegativeDecision(undefined)).toBe(false);
    // @ts-expect-error 故意传错类型，验证不抛
    expect(isNegativeDecision(null)).toBe(false);
  });
});

describe('extractDecisions：kind 字段随决策一起产出（ADR-001）', () => {
  const msgs = (content: string, role = 'user') => [{ role, content, seqNum: 1, createdAt: '2026-10-14T00:00:00.000Z' }];
  it('否定性决策带 kind=negative', () => {
    const d = extractDecisions(msgs('我们改用 pwsh 直接 HTTPS 拉取，拿到 registry 原始 packument'));
    expect(d.length).toBeGreaterThan(0);
    expect(d[0].kind).toBe('negative');
  });
  it('拍板决策带 kind=decision', () => {
    const d = extractDecisions(msgs('我们最终决定采用 PostgreSQL 作为主库'));
    expect(d.length).toBeGreaterThan(0);
    expect(d[0].kind).toBe('decision');
  });
});
