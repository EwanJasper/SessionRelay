// [1015 夜 · 出口③] DSH 采集层：只收**真正的用户输入**，注入类（含压缩摘要）在源头上丢。
//
// 实测（6534 事件的真实会话）：user/message 的 source.kind 有 6 种，其中 time-context / agent-instructions /
// runtime-context / model-selection / compact-checkpoint 全是机器塞的，合计 29K 字 = 用户消息总量的 45%。
// 压缩摘要是主库 48h 窗内那 4 条污染决策的来源。
//
// 双向断言：注入类必须丢 + 真用户输入与老格式（无 kind）必须留。
import { describe, it, expect } from 'vitest';
import { mapLine } from '../../src/adapters/dsh/index.js';

const ev = (kind: unknown, text: string) =>
  JSON.stringify({ type: 'user/message', seq: 1, time: 1792072295994, data: { content: [{ type: 'text', text }], source: kind === undefined ? undefined : { kind } } });

describe('[1015 夜] DSH 注入来源不入库', () => {
  it('① 五类注入一律丢', () => {
    for (const k of ['time-context', 'agent-instructions', 'runtime-context', 'model-selection', 'compact-checkpoint']) {
      expect(mapLine(ev(k, '内容')).kind).toBe('skip');
    }
  });
  it('② 真用户输入必须留（含语音原话）', () => {
    const r = mapLine(ev('user', '呃，先不动手吧'));
    expect(r.kind).toBe('message');
    if (r.kind === 'message') { expect(r.role).toBe('user'); expect(r.content).toContain('先不动手') }
  });
  it('③ 老格式（没有 source.kind）照旧收 —— 向后兼容，交给下游 stripInjected', () => {
    expect(mapLine(ev(undefined, '继续')).kind).toBe('message');
  });
  it('④ 助手消息不受影响', () => {
    const a = JSON.stringify({ type: 'assistant/message', seq: 2, time: 1, data: { message: { content: [{ type: 'text', text: '好的' }] } } });
    const r = mapLine(a);
    expect(r.kind).toBe('message');
    if (r.kind === 'message') expect(r.role).toBe('assistant');
  });
});
