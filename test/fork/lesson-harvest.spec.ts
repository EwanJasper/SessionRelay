// 规则抽取（S2）：只产草稿、必须能回指、等级不吹牛
import { describe, it, expect } from 'vitest';
import { harvestCandidates } from '../../src/core/extract/lesson-harvest.js';

describe('[1016 S2] 经验规则抽取', () => {
  it('刨得出「踩坑/根因」这类句子', () => {
    const out = harvestCandidates([{ role: 'assistant', content: '这次踩坑了。根因是 tmp 名固定导致并发写冲突。', seqNum: 3, sessionId: 's1' }]);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].text).toContain('根因');
    expect(out[0].sourceRef).toBe('s1:3');
  });

  it('用户说的 = verified-user；助手说的 = inferred（等级不吹牛）', () => {
    const fromUser = harvestCandidates([{ role: 'user', content: '注意不要用固定 tmp 名，会踩坑。', seqNum: 1, sessionId: 's' }]);
    const fromBot = harvestCandidates([{ role: 'assistant', content: '注意不要用固定 tmp 名，会踩坑。', seqNum: 1, sessionId: 's' }]);
    expect(fromUser[0].level).toBe('verified-user');
    expect(fromBot[0].level).toBe('inferred');
  });

  it('普通句子不误收（没有踩坑类词就一条不收）', () => {
    expect(harvestCandidates([{ role: 'user', content: '今天天气不错，我们去吃饭吧。', seqNum: 1, sessionId: 's' }])).toEqual([]);
  });

  it('同句去重', () => {
    const m = { role: 'user' as const, content: '以后要注意先删 dist 再重建。', seqNum: 1, sessionId: 's' };
    expect(harvestCandidates([m, { ...m, seqNum: 2 }]).length).toBe(1);
  });
});