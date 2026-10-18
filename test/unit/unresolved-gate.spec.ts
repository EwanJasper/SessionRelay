// [1021 方案 B] 未决段降级三道闸的单测。
// 依据：docs/research/2026-10-18-U-A未决段处置调研.md §4「方案 B（推荐）」。
// 三件事各自独立、各自可测：① 残片守卫 ② 同会话唯一 ③ 7 天观察期。
// 约定：**每一条判据都要能说出理由字符串**（容错不许静默），所以断言里连 reason 一起钉。
import { describe, it, expect } from 'vitest';
import {
  extractQuestions, unresolvedFragmentReason, bracketsBalanced,
  UNRESOLVED_PER_SESSION, UNRESOLVED_PROBATION_DAYS,
} from '../../src/core/extract/extract.js';

type M = { role: 'user' | 'assistant'; content: string; seqNum: number; createdAt?: string };
const mk = (content: string, seqNum: number, at?: string, role: M['role'] = 'user'): M =>
  ({ role, content, seqNum, ...(at ? { createdAt: at } : {}) });
const daysAgo = (n: number): string => new Date(Date.now() - n * 86400_000).toISOString();
const BT = String.fromCharCode(96);   // 反引号（本文件里大量出现，避免转义地狱）

describe('① 残片守卫 · 每条判据一个用例（理由字符串逐条钉死）', () => {
  // 真实样本来自 agent1super 库 185 条候选（改前逐条看过）
  const cases: Array<[string, string, string]> = [
    // [lead 复核修正] 裸编号**不再直接拦**：剥掉编号后，用剥后文本重跑下面所有判据。
    // 反引号包着的编号仍是残片（剥完没有任何判据能抓住它 —— 实测见下方 kept 列表的注释）。
    ['markdown 转义编号（反引号包着）仍拦', BT + '12. ' + BT + '之前他妈上下我不就叫你提PR吗？', 'head-list-marker-escaped'],
    ['整条只有编号/数字 → 仍拦（落到 too-short）', '12. ', 'too-short'],
    // [R1] 带问号的散文残片不再由 ascii-prose 拦（含问号 = 问句形状），但引号不配对仍兜住
    ['剥掉编号后仍是英文散文垃圾（引号不配对兜住）', '4. later with frustration: "之前他妈上下我不就叫你提PR吗？', 'unbalanced-quote'],
    ['剥掉编号后仍是 ASR 机械重复', '2) 你说呃审体机代价是调召回召回，这什么意思？', 'asr-repeat'],
    ['行首英文散文残片（ASR 转写，带问号 → 落到引号不配对）', 'later with frustration: "之前他妈上下我不就叫你提PR吗？', 'unbalanced-quote'],
    // [R1] 英文散文**陈述**（无问号 + 行首连续 3 个英文词）才是这条判据的本命
    ['英文散文残片（无问号，3 词）', 'later he said the config was wrong', 'head-ascii-prose'],
    ['英文散文残片（无问号，截断的 what about）', 'what about the token', 'head-ascii-prose'],
    ['行首闭引号 = 从句子中段切出', '” - “再查查思考可以怎么配置？', 'head-closing-punct'],
    ['行首开括号 = 括号补注被单独切出', '（顺序不同是否算漂移？', 'head-open-bracket'],
    ['字面反斜杠n 的多行残片（markdown 转义）', '[推断]\\n\\n---\\n\\n## 关键证据\\n\\n### Q1：训练数据里回复长度应该怎么分布？', 'escaped-newline'],
    ['代码/表格/流程图残片', 'seq] --> L1[L1: 零拷贝语篇块剥离] L1 -->|剥掉 Table / Quote', 'code-or-table'],
    ['引号不配对 = 腰斩', '查清楚呗还有现在就是我的设计就是不同模型可以加载“Sequential Thinking这种啊？', 'unbalanced-quote'],
    ['括号不配对 = 腰斩', '你的共享任务：task-3（存储层清洗：记忆库会一直变大吗？', 'unbalanced-bracket'],
    ['句尾落在连接词上 = 话没说完', '那就按这个顺序来，还有和？', 'dangling-conjunction'],
    ['去掉语气词后没有实义（"你清楚了吗"）', '你清楚了吗？', 'too-short'],
    ['去掉语气词后没有实义（"还是别的"）', '还是别的？', 'too-short'],
    ['延后型空壳（只说了以后再说）', '这个以后再说？', 'deferral-shell'],
    ['口述机械重复（ASR 把词吐两遍）', '你说呃审体机代价是调召回召回，这什么意思？', 'asr-repeat'],
  ];
  for (const [name, text, reason] of cases) {
    it(name + ' → ' + reason, () => {
      expect(unresolvedFragmentReason(text)).toBe(reason);
    });
  }

  // 反向：真问题一个都不许被残片守卫误伤
  const kept = [
    '你目前主要在用哪个框架？',
    '要我现在装 Python 吗？',
    BT + 'os.homedir()' + BT + ' 大小写/符号链接有坑吗？',   // 行首反引号包代码是合法引用
    '为什么量化之后算术能力下降这么多？',
    '这个插件要怎么用起来？',
    '之后哪些要呢？',                            // 剩 5 字：真问题，阈值刻意放在 5
    '这套方案要不要现在就升级内核？',
    '非常非常重要的一点：缓存策略到底怎么定？',   // "非常非常"是正常汉语，不是 ASR 重复
    // [lead 复核修正] 列表编号是**前置条件**、不是内容证据：剥掉后正文是完整真问题就放行
    '4. 空态「还没有书」还在吗（书丢了没）？',
    '2. 后面最终形态怎么说？',
    '2) 找出只增不减的东西：messages 是否永久保留？',
    '12.5 秒够吗？',                              // 小数点不是列表编号，不许剥
    // [R1 红队终审] 以小写英文标识符开头的**真问题**，一条都不许拦（真实库候选池里这类有 10 条）
    'redis 挂了怎么办？',
    'api 429 怎么绕？',
    'token 什么时候过期？',
    'sqlite vacuum 会锁库吗？',
    'llama.cpp 还是别的？',                        // 真实库样本；碎片由 session-cap 处理，不由本判据
    'should I use redis for the cache?',           // 英文问句：含问号 ⇒ 不是散文残片
    'redis 挂了怎么处理',                          // 无问号但只有 1 个英文词 ⇒ 不是散文
  ];
  for (const text of kept) {
    it('不误伤真问题：' + text.slice(0, 18), () => {
      expect(unresolvedFragmentReason(text)).toBeNull();
    });
  }
});

describe('② 同会话唯一（方案 B：一个会话最多贡献 1 条未决）', () => {
  it('同会话两条未决 → 只留 1 条，另一条标 session-cap 且计入 gated', () => {
    const old = daysAgo(60);
    const qs = extractQuestions([
      mk('方案 A 还没定，要不要先做 B？', 1, old),
      mk('还有个问题，缓存策略还没定，要不要先上 C？', 2, old),
    ], { now: new Date() });
    const shown = qs.filter((q) => q.unresolved);
    expect(shown).toHaveLength(UNRESOLVED_PER_SESSION);
    const capped = qs.filter((q) => q.gate === 'session-cap');
    expect(capped).toHaveLength(1);
    expect(capped[0].unresolved).toBe(false);
    expect(qs.gated?.['session-cap']).toBe(1);   // 不静默：拦掉几条、为什么，都记着
  });

  it('两条都属于"真未决"时，留下信息量更大的那条（不是随手留第一条）', () => {
    const old = daysAgo(60);
    // 同一条消息切出完整问句 + 碎片：实词多的应胜出（纯按长度会把碎片留下）
    const qs = extractQuestions([
      mk('你目前主要在用哪个框架？llama.cpp 还是别的？', 1, old),
    ], { now: new Date() });
    const shown = qs.filter((q) => q.unresolved);
    expect(shown).toHaveLength(1);
    expect(shown[0].q).toContain('框架');
  });
});

describe('③ 7 天观察期（新抽到的未决先不直接展示）', () => {
  it('抽到时不足 7 天 → probation：不展示、但留在观察区', () => {
    const qs = extractQuestions([mk('这个压缩它的效率怎么样？', 1, daysAgo(2))], { now: new Date() });
    expect(qs).toHaveLength(1);
    expect(qs[0].unresolved).toBe(false);
    expect(qs[0].probation).toBe(true);
    expect(qs[0].gate).toBe('probation');
    expect(qs.gated?.['probation']).toBe(1);
  });

  it('满 7 天且仍未被回答 → 正常展示（并标明是"熬过观察期"的）', () => {
    const qs = extractQuestions([mk('这个压缩它的效率怎么样？', 1, daysAgo(UNRESOLVED_PROBATION_DAYS + 1))], { now: new Date() });
    expect(qs[0].unresolved).toBe(true);
    expect(qs[0].probation).toBeUndefined();
    expect(qs[0].gate).toBe('unresolved(aged)');
  });

  it('满 7 天但期间已被回答 → 不进未决（观察期的意义：等证据）', () => {
    const t = daysAgo(30);
    // 问题必须落在"会话尾部"才会成为候选（tailAsked = idx >= 0.7*total），
    // 与既有 unresolved-answered.spec 的夹具同形
    const qs = extractQuestions([
      mk('先做别的', 1, t),
      mk('好', 2, t, 'assistant'),
      mk('语义档的量化档位到底应该怎么选？', 3, t),
      mk('量化档位这块，语义档默认用 q8，fp16 在 EmbeddingGemma 上不支持。', 4, t, 'assistant'),
    ], { now: new Date() });
    const hit = qs.find((q) => q.q.includes('量化档位'))!;
    expect(hit).toBeTruthy();
    expect(hit.unresolved).toBe(false);
    expect(hit.gate).toBe('answered');
  });

  it('没有时间戳 → **不启用**观察期（不能证明它"新"就不惩罚，宁可保守）', () => {
    const qs = extractQuestions([mk('这个压缩它的效率怎么样？', 1)]);
    expect(qs[0].unresolved).toBe(true);
    expect(qs[0].probation).toBeUndefined();
    expect(qs[0].gate).toBe('unresolved(no-timestamp)');
  });

  it('观察期内的条目也不占"同会话唯一"的名额（它还没到展示态）', () => {
    const qs = extractQuestions([
      mk('旧的：缓存策略还没定，要不要先上 C？', 1, daysAgo(30)),
      mk('新的：压缩效率还没验证，要不要先测？', 2, daysAgo(1)),
    ], { now: new Date() });
    expect(qs.filter((q) => q.unresolved)).toHaveLength(1);
    expect(qs.filter((q) => q.probation)).toHaveLength(1);
    expect(qs.gated?.['session-cap']).toBeUndefined();
  });
});

describe('④ 判据共用（括号配对只有一份实现）', () => {
  it('bracketsBalanced：配对/不配对', () => {
    expect(bracketsBalanced('（a）')).toBe(true);
    expect(bracketsBalanced('（a')).toBe(false);
    expect(bracketsBalanced('a)')).toBe(false);
  });
  it('决策侧走的是同一份判据（重构后行为不变）', async () => {
    const { passesDecisionTextGuards } = await import('../../src/core/extract/extract.js');
    expect(passesDecisionTextGuards('改用（未闭合的写法')).toBe(false);
    expect(passesDecisionTextGuards('改用（闭合的）写法')).toBe(true);
  });
});
