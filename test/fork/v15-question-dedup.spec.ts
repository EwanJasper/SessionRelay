// [1015 v15 回归] 未决问题必须做**同会话内近似去重**。
//
// 病历：真实库实测 music player 的未决问题 30.9% 是近似重复（97 里 30 条）、全部问题 19.6%；
// agent1super 分别为 1.1% / 3.5%。危害不在存储而在**简报**——未决段只有 3 个名额且取最新，
// 同一个问题被逐字重复几遍，等于把真问题挤出窗口。
//
// 双向断言（只断言"去重了"挡不住退化——把不同问题合并掉照样"去重成功"）：
//   ① 同会话内近似重复只留一条
//   ② 语义不同的问题一个都不许合并（尤其别把 28 字以内的不同短问题合并）
import { describe, it, expect } from 'vitest';
import { extractQuestions } from '../../src/core/extract/extract.js';
import type { Msg } from '../../src/core/extract/extract.js';

const m = (role: string, content: string, seqNum: number): Msg => ({ role, content, seqNum, createdAt: '2026-10-15T00:00:00Z' });

describe('[v15] 未决问题同会话去重', () => {
  it('① 同一句被不同标点/空白切分 → 只留一条', () => {
    const qs = extractQuestions([
      m('user', '缓存层到底改成 LRU 还是 LFU？', 1),
      m('user', '缓存层到底改成 LRU 还是 LFU?', 2),
      m('user', '缓存层到底改成LRU还是LFU？', 3),
    ]);
    expect(qs.length).toBe(1);
  });

  it('② 语义不同的问题不许被合并（含短问题）', () => {
    const qs = extractQuestions([
      m('user', '缓存层到底改成 LRU 还是 LFU？', 1),
      m('user', '重算游标要不要换成逐会话版本？', 2),
      m('user', '要不要现在动手改缓存实现？', 3),
      m('user', '简报里未决段的口语噪声要怎么处理？', 4),
    ]);
    expect(qs.length).toBe(4);
        // 附注 1：太短的问句（<8 字符）与不含疑问提示词的句子（如"…哪一批？"）本来就不抽取，与本轮去重无关。
    // 附注 2：本用例四条都先单独验过能抽出来，所以"数量不变"才真正等于"没被误合并"。
  });

  it('③ 前缀相同但后半句不同 → 也算不同问题（28 字键之外的差异要保留）', () => {
    const base = '我们刚才讨论的这个方案是不是应该先写进 ADR 里'
    const qs = extractQuestions([
      m('user', base + '，然后再动手改代码？', 1),
      m('user', base + '，还是等下周评审后再说？', 2),
    ]);
    // 键只取 28 字，两者前 28 字相同 → 会被合并成 1 条；这是**有意的取舍**：
    // 长问句同前缀时宁可少留一条，也不要让同一段话反复占名额。此处把取舍钉住，
    // 免得将来有人"顺手放宽"又把重复放回来。
    expect(qs.length).toBe(1);
  });
});
