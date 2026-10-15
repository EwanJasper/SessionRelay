import { describe, it, expect } from 'vitest';
import {
  extractFiles, extractTopics, extractDecisions, extractQuestions,
  countCodeBlocks, extractMessages, summaryRule, extractKeyExchanges, stripInjected, looksInjected, isNegativeDecision,
  extractEnvFacts, extractCorrections, sanitizeMsgs, stripInjected, stripMnemeMemory, quotesBalanced, type Msg,
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

describe('P5 · Phase 3 修复A：「不用」不再是决策触发词（1015 F9 修一半的收尾）', () => {
  const msg = (role: 'user' | 'assistant', content: string, seq = 1): Msg =>
    ({ role, content, seqNum: seq, createdAt: '2026-10-15T10:00:00Z' });

  // 实测样本（两库 88 条该分支命中，逐条判读 85–90% 是用户指令/口语而非决策）
  it('「你不用管过程」不作决策', () => {
    const d = extractDecisions([msg('user', '接下来你不用管，明天下午前后看生产日志的终态总结就行')]);
    expect(d).toHaveLength(0);
  });

  it('「不用每章都烧朱雀额度」不作决策', () => {
    const d = extractDecisions([msg('user', '不用每章都烧朱雀额度，两首都在自动归档的轨道上')]);
    expect(d).toHaveLength(0);
  });

  it('「旧会话不用删，放着就行」不作决策（语义恰是保留）', () => {
    const d = extractDecisions([msg('user', '旧会话不用删，放着就行')]);
    expect(d).toHaveLength(0);
  });

  it('「不用强调网文就是中文写作吧」不作决策', () => {
    const d = extractDecisions([msg('user', '不用强调网文就是中文写作吧还有主攻这个moe的会好点')]);
    expect(d).toHaveLength(0);
  });

  // 同族其余四条实测保留率良好，必须不误伤
  it('「直接用 exe 路径后台启动」仍是决策', () => {
    const d = extractDecisions([msg('user', '直接用 exe 路径后台启动，然后用 pid 接管')]);
    expect(d).toHaveLength(1);
    expect(d[0].text).toMatch(/直接用 exe 路径/);
  });

  it('「优先用 batch_extract.py」仍是决策', () => {
    const d = extractDecisions([msg('user', '优先用 batch_extract.py 抓 arXiv HTML 全文落 Markdown 缓存再精读')]);
    expect(d).toHaveLength(1);
    expect(d[0].text).toMatch(/优先用 batch_extract/);
  });

  it('「不用」出现在句中（非句首锚定）本来就不命中，行为不变', () => {
    const d = extractDecisions([msg('user', '这个东西其实不用改，我们用现在的方案继续推进就行')]);
    expect(d).toHaveLength(0);
  });
});

describe('P6 · Phase 3 修复B：引号不配对=腰斩碎片（plausibleDecision 扩族）', () => {
  const msg = (role: 'user' | 'assistant', content: string, seq = 1): Msg =>
    ({ role, content, seqNum: seq, createdAt: '2026-10-15T10:00:00Z' });

  // 实测样本：两库 83/30 条引号不配对，样例几乎全是"讨论决策的散文"
  it('「采用宿主 CLI 弹性探测"与 10-14"自包含 vendor"字面直接冲突」不作决策', () => {
    const d = extractDecisions([msg('assistant', '采用宿主 CLI 弹性探测"与 10-14"自包含 vendor"字面直接冲突，所以不能只按字面判')]);
    expect(d).toHaveLength(0);
  });

  it('「决定论"误命中在 extractDecisions 的 DECISION_STRONG 里」不作决策', () => {
    const d = extractDecisions([msg('assistant', '决定论"误命中在 `extractDecisions` 的 `DECISION_STRONG` 里，这是词中误命中')]);
    expect(d).toHaveLength(0);
  });

  it('JSON 残片「改为 Apache-2.0", "done": true」不作决策', () => {
    const d = extractDecisions([msg('assistant', '改为 Apache-2.0", "done": true, "evidence": "p1b/package.json:5 现为')]);
    expect(d).toHaveLength(0);
  });

  it('「决定 → 会话要等满 10 分钟…然后才有第一条"近期决策」不作决策', () => {
    const d = extractDecisions([msg('assistant', '决定 → 会话要等满 10 分钟空闲才会被判定、提取决策 → 然后才有第一条"近期决策')]);
    expect(d).toHaveLength(0);
  });

  // 反向：引号配对的真决策必须不误伤
  it('「决定"写哪个库"——绑定必须两段式」引号配对，仍是决策', () => {
    const d = extractDecisions([msg('user', '我们决定"写哪个库"——绑定必须两段式，模型只提议')]);
    expect(d).toHaveLength(1);
    expect(d[0].text).toMatch(/写哪个库/);
  });

  it('「改为"优先返回已建库的，同时记住路径存在但未建库的那个"」仍是决策', () => {
    const d = extractDecisions([msg('user', '改为"优先返回已建库的，同时记住路径存在但未建库的那个"')]);
    expect(d).toHaveLength(1);
    expect(d[0].text).toMatch(/优先返回已建库/);
  });

  it('反引号包裹标识符的真决策不受影响（故意不查反引号）', () => {
    const d = extractDecisions([msg('user', '改用 `fileURLToPath()` 正确处理编码，直接从 URL 得到文件路径')]);
    expect(d).toHaveLength(1);
    expect(d[0].text).toMatch(/fileURLToPath/);
  });

  it('「改用 PowerShell 的 `Get-CimInstance`」仍是决策', () => {
    const d = extractDecisions([msg('user', '改用 PowerShell 的 `Get-CimInstance` 查进程')]);
    expect(d).toHaveLength(1);
    expect(d[0].text).toMatch(/Get-CimInstance/);
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

describe('技能目录块剥离（无 XML 外壳的第二种注入；≥3 行连续才算目录）', () => {
  // 红队 1014 F5：单行判据把用户自己的 kebab-case 清单整行剥掉（实测 129 条消息中招），
  //   '- `web-vitals`: 决定把前端监控库换成 web-vitals，弃用旧的自研埋点' —— 整行消失，
  //   真决策既进不了 decisions 也进不了 search_text，双双失明。
  // 故改成块判据（≥3 行连续）。客户端注入的目录是 10+ 行的长列表，用户自己的清单
  // 通常 1-2 行且夹在散文里。实测分布：≥3 行 63 处 / 恰好 2 行 55 处 / 单行 5 处。
  const CATALOG = [
    '- `steel-manning`: 最强反方论证：先构建反方论证，再决定接受、修订或坚持',
    '- `ppt-master`: AI-driven presentation builder',
    '- `executing-plans`: 有一份写好的实施计划要执行时使用',
    '- `paper-polish`: 顶刊标准润色',
  ].join('\n');

  it('≥3 行连续的技能目录块被剥掉', () => {
    const s = stripInjected('好的，我们用 PostgreSQL。\n' + CATALOG);
    expect(s).not.toContain('steel-manning');
    expect(s).not.toContain('ppt-master');
    expect(s).not.toContain('修订或坚持');
    expect(s).toContain('我们用 PostgreSQL');
  });

  it('用户自己写的单行清单项不被误杀（红队 F5 的格式）', () => {
    const t = '- `web-vitals`: 决定把前端监控库换成 web-vitals，弃用旧的自研埋点';
    expect(stripInjected(t)).toContain('web-vitals');
    expect(stripInjected(t)).toContain('弃用旧的自研埋点');
  });

  it('用户自己写的两行清单也不被误杀', () => {
    const t = '- `deepseek-v4-flash-0731`: 认 `none`（实测能真关掉思考）\n- `zhipu-vision`: 聊天看图主力，默认档';
    expect(stripInjected(t)).toContain('deepseek-v4-flash-0731');
    expect(stripInjected(t)).toContain('zhipu-vision');
  });

  it('用户自己写的普通列表项不被误杀（无反引号，判据本来就不命中）', () => {
    const t = '- 第一件事：把数据库迁完\n- 第二件事：补测试';
    expect(stripInjected(t)).toBe(t);
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

// ── 1014 深夜：无标签注入的清洗盲区 ──
// 客户端把 XML 外壳剥掉之后才把系统上下文存进 user 消息，所以成对标签规则一条都匹配不到。
// 实测 D:\agent1super：4361 条消息带同一句 TodoWrite 提醒，占全部 search_text 的 18.7%，
// topics 里 10.7% 是它的英文虚词残片。这个盲区的症状是"索引胀大 + topics 变脏"而不是
// 简报出错，所以一直没被发现。
describe('stripInjected：无标签注入（客户端剥掉外壳后的系统上下文）', () => {
  const TODO = "The TodoWrite tool hasn't been used recently. If you're working on tasks that would benefit from tracking progress, consider using the TodoWrite tool to track progress. Also consider cleaning up the todo list if has become stale. Only use it if it's relevant to the current work. This is just a gentle reminder - ignore if not applicable.";

  it('剥掉整段 TodoWrite 提醒', () => {
    expect(stripInjected(TODO).trim()).toBe('');
  });
  it('剥掉提醒但保留同一消息里的用户真话', () => {
    const mixed = TODO + '\n\n我们决定改用 pwsh 直查 SQL';
    const out = stripInjected(mixed);
    expect(out).not.toMatch(/TodoWrite/);
    expect(out).toContain('我们决定改用 pwsh 直查 SQL');
  });
  it('剥掉运行时上下文快照三段', () => {
    const ctx = 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\nCurrent DSH file policy: workspace-write. Any available operation enforced by the DSH file sandbox may modify files under the session workspace: "D:\agent1super".\n\nApproval policy: ask. Operations that require approval may ask through the configured answerers.\n\n用户真话在这里';
    const out = stripInjected(ctx);
    expect(out).not.toMatch(/Current runtime context/);
    expect(out).not.toMatch(/Current DSH file policy/);
    expect(out).not.toMatch(/Approval policy/);
    expect(out).toContain('用户真话在这里');
  });
  it('剥掉会话目标暂停提示', () => {
    const out = stripInjected('The active session goal is paused. Do not continue pursuing it unless the user resumes or replaces the goal.\n\n继续干活');
    expect(out).not.toMatch(/session goal is paused/);
    expect(out).toContain('继续干活');
  });
  it('不剥用户的待办清单——那是信息不是样板', () => {
    const todo = 'Here are the existing contents of your todo list:\n\n[1. [in_progress] preflight 环境检查\n2. [pending] 安装缺失组件';
    expect(stripInjected(todo)).toContain('preflight 环境检查');
  });
  it('looksInjected 与 stripInjected 同源：存量污染检得出', () => {
    expect(looksInjected(TODO)).toBe(true);
    expect(looksInjected('Current runtime context. This snapshot supersedes earlier runtime-context snapshots.')).toBe(true);
    // 用户真话不能误报
    expect(looksInjected('我们决定改用 pwsh 直查 SQL，拿到 registry 原始 packument')).toBe(false);
  });
});

// ── Phase 2 · 环境事实 / 纠正更正抽取 ──────────────────────────────────
// 判别式与误报源清单来自 docs/调研-环境事实与更正抽取-20261014.md §3.2/§3.3。
// ⚠️ 这两个函数当前**不接入任何写路径**，只供 Phase 0 精度测量。
// 门禁（§4.5）：分组 precision 总 ≥90% 且最低族 ≥80%；负对照库 ≤3 条；supersede ≥85%。
// 不过就停，登记重新评估条件——本项目已经两次"没量精度就接会灌噪声"。
describe('P8 · extractEnvFacts：主语+规格+谓词三要素', () => {
  const msg = (role: 'user' | 'assistant', content: string, seq = 1): Msg =>
    ({ role, content, seqNum: seq, createdAt: '2026-10-15T10:00:00Z' });

  it('「我显存只有 8G」抽成事实，slot=显存', () => {
    const f = extractEnvFacts([msg('user', '我显存只有 8G，跑不动 35B')]);
    expect(f).toHaveLength(1);
    expect(f[0].slot).toBe('显存');
    expect(f[0].values).toContain('8G');
  });
  it('「本机 Node 是 24」抽成事实', () => {
    const f = extractEnvFacts([msg('user', '本机 Node 是 24，Python 3.13')]);
    expect(f.length).toBeGreaterThanOrEqual(1);
    expect(f.some((x) => x.slot === 'Node')).toBe(true);
  });
  it('「我把 ctx 扩到 49152」抽成事实（真实 supersede 案例）', () => {
    const f = extractEnvFacts([msg('user', '我把 qwen9 的 ctx 扩到 49152，之前 32K 被吃满')]);
    expect(f).toHaveLength(1);
    expect(f[0].values).toContain('49152');
  });
  it('「现在开机启动 15 个 g」抽成事实（同槽两值并列）', () => {
    const f = extractEnvFacts([msg('user', '我内存条加之前 16g 开机启动占差不多 4 个 g，现在开机启动 15 个 g')]);
    expect(f.length).toBeGreaterThanOrEqual(1);
  });

  // ── 九类误报源各至少一条（§3.3）──
  it('A 假设句不抽：「如果升级了之后还能跑」', () => {
    expect(extractEnvFacts([msg('user', '如果显存升级了之后还能跑吗')])).toHaveLength(0);
  });
  it('B 问助手不抽：整句都在问助手，没有陈述', () => {
    expect(extractEnvFacts([msg('user', '你的是什么版本？')])).toHaveLength(0);
  });
  it('B 问句里夹带的真事实仍要抽（按句切分，不问的不冤枉好数据）', () => {
    const f = extractEnvFacts([msg('user', '你的是什么版本？我的显存是 8G')]);
    expect(f).toHaveLength(1);
    expect(f[0].slot).toBe('显存');
  });
  it('C 归属错位不抽：助手报告粘进 user 消息', () => {
    expect(extractEnvFacts([msg('user', '报告说本机现状：pwsh 未安装，显存 8GB 是旧数据')])).toHaveLength(0);
  });
  it('D 项目/小说内容不抽：「守门人不是同一个人活了30年」', () => {
    expect(extractEnvFacts([msg('user', '守门人不是同一个人活了30年，而是三代人，这个设定很重要')])).toHaveLength(0);
  });
  it('H 模型名像规格不抽：「3.8 flash 需要多少显存」', () => {
    // 主语族不命中（"3.8 flash"不是我/本机）→ 不收
    expect(extractEnvFacts([msg('user', '3.8 flash 需要多少显存才能跑')])).toHaveLength(0);
  });
  it('assistant 消息不挖（归属错位是头号误报源）', () => {
    expect(extractEnvFacts([msg('assistant', '我的显存是 8G，本机 Node 24')])).toHaveLength(0);
  });
  it('注入块不产出事实', () => {
    const injected = '我显存 8G\nThe TodoWrite tool hasn\'t been used recently. This is just a gentle reminder - ignore if not applicable.';
    const f = extractEnvFacts([msg('user', injected)]);
    expect(f.every((x) => !/TodoWrite/.test(x.text))).toBe(true);
  });
});

describe('P9 · extractCorrections：强触发族 + 结构/语境/语气', () => {
  const msg = (role: 'user' | 'assistant', content: string, seq = 1): Msg =>
    ({ role, content, seqNum: seq, createdAt: '2026-10-15T10:00:00Z' });

  it('「我说错了」命中 strong', () => {
    const c = extractCorrections([msg('user', '我说错了，那个结论要改')]);
    expect(c).toHaveLength(1);
    expect(c[0].family).toBe('strong');
  });
  it('「上次那个结论错了」命中 context', () => {
    const c = extractCorrections([msg('user', '上次那个结论错了，得重新看')]);
    expect(c).toHaveLength(1);
    expect(c[0].family).toBe('context');
  });
  it('「不是X而是Y」命中 struct', () => {
    const c = extractCorrections([msg('user', '这个不是bug，而是feature，文档要改')]);
    expect(c).toHaveLength(1);
    expect(c[0].family).toBe('struct');
  });
  it('「不对啊」命中 tone', () => {
    const c = extractCorrections([msg('user', '不对啊，你搞反了方向')]);
    expect(c).toHaveLength(1);
  });

  // ── 误报源 ──
  it('F「没错」是反向语义，不抽', () => {
    expect(extractCorrections([msg('user', '节点没错正常但是网站测试就说超时')])).toHaveLength(0);
  });
  it('E tag 问句不抽：「是不是这个嘛」', () => {
    expect(extractCorrections([msg('user', '是不是这个嘛你看这个日式对不对嘛')])).toHaveLength(0);
  });
  it('I 句首「不是」=话轮标记，非纠正', () => {
    expect(extractCorrections([msg('user', '不是那现在来说其实他不是就只有查文档吗')])).toHaveLength(0);
  });
  it('assistant 消息不挖', () => {
    expect(extractCorrections([msg('assistant', '我说错了，刚才那条要改')])).toHaveLength(0);
  });
});

// ── 第三个注入盲区（1015 Phase 2 Phase 0 实测发现）─────────────────────
describe('P10 · 第三个注入盲区：mneme 记忆块 + Approval prompts 措辞', () => {
  const msg = (role: 'user' | 'assistant', content: string, seq = 1): Msg =>
    ({ role, content, seqNum: seq, createdAt: '2026-10-15T10:00:00Z' });

  const MNEME = `呃派3个或者4个子代理你看一下
A: 

Q: ？
A: 

[记忆库] 来自 dsh-mneme 的跨会话记忆（用户偏好与高优先级项目/决策）：
- [project] 音乐生产项目上下文（重要性 4）：音乐生产项目涉及 ACE-Step / HOT-Step 环境与电台账号计划。
- [preference] 用户偏好：安排长活爬虫棒精读论文全文（重要性 5）：用户令：安排两人或更多长时间接续爬取最新相关论文全文。

Current DSH file policy: danger-full-access. The DSH file sandbox does not restrict file modifications by available operations.

Approval prompts are disabled in this session: actions that require approval are rejected automatically.`;

  it('mneme 记忆块从抽取路径剥掉', () => {
    const out = sanitizeMsgs([msg('user', MNEME)])[0].content;
    expect(out).not.toMatch(/\[记忆库\]/);
    expect(out).not.toMatch(/dsh-mneme/);
    expect(out).not.toMatch(/- \[project\]/);
    expect(out).not.toMatch(/- \[preference\]/);
  });
  it('剥掉 mneme 块后，用户自己的话还在', () => {
    const out = sanitizeMsgs([msg('user', MNEME)])[0].content;
    expect(out).toMatch(/派3个或者4个子代理/);
  });
  it('Approval prompts are disabled 也剥掉（原规则只认 Approval policy: ask.）', () => {
    const out = sanitizeMsgs([msg('user', MNEME)])[0].content;
    expect(out).not.toMatch(/Approval prompts are disabled/);
    expect(out).not.toMatch(/Current DSH file policy/);
  });
  it('索引路径（stripInjected）保留 mneme 内容——有检索价值', () => {
    // searchTextOf 走的是 stripInjected，不走 stripMnemeMemory，所以 ACE-Step 仍可搜到
    expect(stripInjected(MNEME)).toMatch(/ACE-Step/);
    expect(stripInjected(MNEME)).not.toMatch(/Approval prompts are disabled/);
  });
  it('mneme 块在文末（无尾随空行）也剥得掉', () => {
    const t = '用户原话在这里\n[记忆库] 来自 dsh-mneme 的跨会话记忆：\n- [project] X（重要性 4）：Y';
    const out = sanitizeMsgs([msg('user', t)])[0].content;
    expect(out).not.toMatch(/\[记忆库\]/);
    expect(out).toMatch(/用户原话在这里/);
  });
  it('不含 [记忆库] 的消息不受影响', () => {
    const t = '我显存 8G，跑不动 35B，你查一下';
    expect(sanitizeMsgs([msg('user', t)])[0].content).toBe(t);
  });
  it('Phase 2 的误报源因此减少：mneme 记忆不再被当成用户的环境事实', () => {
    const msgs = sanitizeMsgs([msg('user', MNEME)]);
    expect(extractEnvFacts(msgs)).toHaveLength(0);
  });
});

describe('P11 · quotesBalanced 极性版（1015 升级：修撇号误杀 + 拦跨句撕裂引文）', () => {
  const msg = (role: 'user' | 'assistant', content: string, seq = 1): Msg =>
    ({ role, content, seqNum: seq, createdAt: '2026-10-15T10:00:00Z' });

  // 旧版的两个真 bug（外部专家方案 2.1 指出，本机实测两库各 1 条已中招）
  it('英文所有格（直撇号）不再误杀', () => {
    expect(quotesBalanced("决定改用 user's local directory 存配置")).toBe(true);
  });
  it('英文缩写（直撇号）不再误杀', () => {
    expect(quotesBalanced("不再用 don't-ask 模式")).toBe(true);
  });
  it('英文所有格（弯撇号 U+2019）不再误杀——这是外部专家声称做了但代码漏做的一条', () => {
    expect(quotesBalanced('决定改用 user\u2019s local directory 存配置')).toBe(true);
  });
  it('反引号代码段内的引号不计入（旧版会误杀）', () => {
    expect(quotesBalanced('改为匹配 `raw.match(/"/g)` 规则')).toBe(true);
    expect(quotesBalanced("统一用 `sed 's/\"//g'` 处理")).toBe(true);
  });

  // 极性检查：跨句撕裂引文（Phase 3 之后简报里残留的散文噪声之一）
  it('跨句撕裂引文（弯引号）被拒', () => {
    expect(quotesBalanced('决定用 X\u201d，但对话里最值钱的往往是\u201c试过 X，失败了')).toBe(false);
  });
  it('跨句撕裂引文（直引号）被拒', () => {
    expect(quotesBalanced('决定用 X"，但对话里最值钱的往往是"试过 X，失败了')).toBe(false);
  });
  it('先出现闭引号（弯）即拒', () => {
    expect(quotesBalanced('决定\u201d写哪个库\u201c——绑定必须两段式')).toBe(false);
  });

  // 反向：合法真决策一件不能误伤
  it('合法真决策「改为"…那个"」仍放过', () => {
    expect(quotesBalanced('改为\u201c优先返回已建库的，同时记住路径存在但未建库的那个\u201d')).toBe(true);
  });
  it('合法真决策「决定"写哪个库"」仍放过', () => {
    expect(quotesBalanced('决定"写哪个库"——绑定必须两段式')).toBe(true);
  });
  it('无反引号无引号的普通真决策仍放过', () => {
    expect(quotesBalanced('改用 node:sqlite 同步直查 SQL（5ms）')).toBe(true);
  });
  it('端到端：英文所有格决策现在真能抽出来', () => {
    const d = extractDecisions([msg('user', "我们决定改用 user's local directory 存配置")]);
    expect(d).toHaveLength(1);
    expect(d[0].text).toMatch(/user's local directory/);
  });
  it('端到端：跨句撕裂引文仍抽不出决策', () => {
    const d = extractDecisions([msg('user', '决定用 X"，但对话里最值钱的往往是"试过 X，失败了')]);
    expect(d).toHaveLength(0);
  });
});

describe('P13 · HTML 实体解码（1015，消灭 topics 里的 quot 假词）', () => {
  const msg = (role: 'user' | 'assistant', content: string, seq = 1): Msg =>
    ({ role, content, seqNum: seq, createdAt: '2026-10-15T10:00:00Z' });

  it('&quot; 解码为 "，不再被英文词元正则拆出 quot 假词', () => {
    const raw = '<summary>Agent general-purpose task &quot;调查 Flash-Next 参数&quot; completed.</summary>';
    const clean = stripInjected(raw);
    expect(clean).not.toMatch(/&quot;/);
    expect(extractTopics([msg('user', clean)])).not.toContain('quot');
  });
  it('端到端：走 extractMessages（生产入口）不再产出 quot 假词', () => {
    // 注意：extractTopics 本身不剥注入——生产链路是 extractMessages → sanitizeMsgs → extractTopics。
    // 直接调 extractTopics 传原始文本是绕过链路，不是代码缺陷。
    const raw = '<summary>Agent general-purpose task &quot;调查 Flash-Next 参数&quot; completed.</summary>';
    const meta = extractMessages([msg('user', raw)]);
    expect(meta.topics).not.toContain('quot');
    expect(meta.topics).toContain('调查');
  });
  it('其余实体一并解码', () => {
    const out = stripInjected('a &lt;div&gt; b &amp; c &#39;d&#39; &nbsp;e');
    expect(out).toContain('<div>');
    expect(out).toContain('&');
    expect(out).toContain("'d'");
    expect(out).not.toMatch(/&(?:quot|apos|#39|lt|gt|amp|nbsp);/);
  });
  it('用户自己写的 &lt;div&gt; 解码后仍保留（不在注入名单里）', () => {
    expect(stripInjected('我在 HTML 里写了 &lt;div class=&quot;x&quot;&gt;')).toContain('<div class="x">');
  });
  it('解码不造出新伪标签：先剥注入再解码（顺序不能反）', () => {
    const raw = '&lt;system-reminder&gt;这是注入&lt;/system-reminder&gt;正文';
    const clean = stripInjected(raw);
    expect(clean).not.toMatch(/system-reminder/);
  });
  it('解码后的引号参与 quotesBalanced 判定（不会误杀）', () => {
    expect(quotesBalanced('我们决定改用 &quot;better-sqlite3&quot; 连接池')).toBe(true);
  });
  it('正常无实体文本不受影响', () => {
    const t = '我显存 8G，跑不动 35B';
    expect(stripInjected(t)).toBe(t);
  });
  it('直查 stripInjected 也能解码（不依赖 sanitizeMsgs）', () => {
    expect(stripInjected('用 &quot;better-sqlite3&quot; 连接池')).toContain('"better-sqlite3"');
    expect(stripInjected('用 &quot;better-sqlite3&quot; 连接池')).not.toContain('&quot;');
  });
});
