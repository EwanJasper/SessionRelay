// U-A 真根治：未决判据的第三维「这句后来被回答了吗」（v21）
//
// 病历（docs/research/2026-10-18-U-A未决段处置调研.md §2.5，实测）：
//   被标 unresolved 的 7 条，其后各有 305~524 条 assistant 消息 —— 7/7 全被答过。
//   原判据只有「位置靠后」与「关键词命中」两维，**没有"是否已被回答"这一维**。
import { describe, it, expect } from 'vitest';
import { extractQuestions, wasAnswered } from '../../src/core/extract/extract.js';

type M = { role: 'user' | 'assistant'; content: string; seqNum: number; createdAt?: string };
const mk = (role: M['role'], content: string, seqNum: number): M => ({ role, content, seqNum });

describe('wasAnswered：回答检测', () => {
  it('后续 assistant 消息里出现足够实词重叠 → 判为已答', () => {
    const msgs = [
      mk('user', '语义档的量化档位到底应该怎么选？', 1),
      mk('assistant', '量化档位这块，语义档默认用 q8，fp16 在 EmbeddingGemma 上不支持。', 2),
    ];
    expect(wasAnswered(msgs as never, 0, '语义档的量化档位到底应该怎么选？')).toBe(true);
  });

  it('后续 assistant 消息完全不相关 → 判为未答（宁缺勿滥）', () => {
    const msgs = [
      mk('user', '语义档的量化档位到底应该怎么选？', 1),
      mk('assistant', '今天的天气不错，另外记得把窗子关一下。', 2),
    ];
    expect(wasAnswered(msgs as never, 0, '语义档的量化档位到底应该怎么选？')).toBe(false);
  });

  it('只共享 1 个实词不算答（中文里偶然重合太常见）', () => {
    const msgs = [
      mk('user', '语义档的量化档位到底应该怎么选？', 1),
      mk('assistant', '语义这个东西其实挺玄的。', 2),
    ];
    expect(wasAnswered(msgs as never, 0, '语义档的量化档位到底应该怎么选？')).toBe(false);
  });

  it('**问题之前**的 assistant 消息不算回答（顺序敏感）', () => {
    const msgs = [
      mk('assistant', '量化档位这块，语义档默认用 q8，fp16 不支持。', 1),
      mk('user', '语义档的量化档位到底应该怎么选？', 2),
    ];
    expect(wasAnswered(msgs as never, 1, '语义档的量化档位到底应该怎么选？')).toBe(false);
  });

  it('看得到的回答超出窗口（默认 12 条）→ 判未答（窗口是故意小的）', () => {
    const msgs: M[] = [mk('user', '语义档的量化档位到底应该怎么选？', 1)];
    for (let i = 0; i < 12; i++) msgs.push(mk('assistant', '无关内容 ' + i, i + 2));
    msgs.push(mk('assistant', '量化档位这块，语义档默认用 q8。', 99));
    expect(wasAnswered(msgs as never, 0, '语义档的量化档位到底应该怎么选？')).toBe(false);
  });

  it('问题本身没有实词 → 不判已答（不能凭空空转）', () => {
    expect(wasAnswered([mk('user', '？？？', 1), mk('assistant', '好的', 2)] as never, 0, '？？？')).toBe(false);
  });
});

describe('extractQuestions：第三维真的接进去了', () => {
  it('会话尾部提问但**已被回答** → unresolved=false（这正是 7/7 的病）', () => {
    const msgs: M[] = [
      mk('user', '先做别的', 1),
      mk('assistant', '好', 2),
      mk('user', '语义档的量化档位到底应该怎么选？', 3),
      mk('assistant', '量化档位这块，语义档默认用 q8，fp16 在 EmbeddingGemma 上不支持。', 4),
    ];
    const qs = extractQuestions(msgs as never);
    const hit = qs.find((q) => q.q.includes('量化档位'));
    expect(hit, '问题本身应该被抽出来').toBeTruthy();
    expect(hit!.unresolved, '已被回答的不该再标未决').toBe(false);
  });

  it('会话尾部提问且**无人回答** → unresolved=true（保留真未决）', () => {
    const msgs: M[] = [
      mk('user', '先做别的', 1),
      mk('assistant', '好', 2),
      mk('user', '语义档的量化档位到底应该怎么选？', 3),
    ];
    const qs = extractQuestions(msgs as never);
    const hit = qs.find((q) => q.q.includes('量化档位'));
    expect(hit).toBeTruthy();
    expect(hit!.unresolved).toBe(true);
  });
});
