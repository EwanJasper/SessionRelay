// L3 端到端：用**假 provider**跑完整链路（分簇 → 提示词 → 解析 → 证据校验 → 审计落库 → 配额）
//
// 为什么必须有这条：本轮没有可用的本地生成模型（ollama list 为空），
// 于是"能跑、有审计、有单测"里**唯一没验过的是"真跑一遍会不会写坏库"**。
// 假 provider 不测模型质量，只测**这条流水线的每一段落点**（这正是最容易出错的部分）。
import { describe, it, expect, beforeEach } from 'vitest';
import { createDb } from '../../src/store/db.js';
import { compressPolicyOf } from '../../src/core/compact/model.js';
import { compressProject, listCompressLogs, compressDetailOf, quotaUsed } from '../../src/core/compact/model-apply.js';

type DB = ReturnType<typeof createDb>;
let db: DB;
const PID = 'proj_test';

/** 三条同主题的旧决策（同会话行上的 JSON 列） */
const DECS = [
  { text: '把归档热窗从 60 天缩短到 30 天，实测 agent1super 省 36.9%', seq: 1, at: '2026-09-01T00:00:00Z' },
  { text: '归档热窗定为 30 天，agent1super 省 36.9%', seq: 2, at: '2026-09-02T00:00:00Z' },
  { text: '热窗参数确认为 30 天（省 36.9%）', seq: 3, at: '2026-09-03T00:00:00Z' },
  { text: '面板左侧加了「记忆台」按钮', seq: 4, at: '2026-09-04T00:00:00Z' },
];

beforeEach(() => {
  db = createDb(':memory:');
  db.prepare(`INSERT INTO sessions (id, source, source_session_id, project_id, title, created_at, state, decisions, origin)
    VALUES (?,?,?,?,?,?,?,?,?)`).run('s1', 'dsh', 'src-1', PID, '归档那轮的会话', '2026-09-01T00:00:00Z', 'confirmed', JSON.stringify(DECS), 'auto');
});

// ⚠️ [1021 · R6] 这里显式把两道**收益闸门**的默认门槛关掉（min_utf8_bytes: 0 / min_saved_ratio: 0）。
//   不是为了"让测试过而放宽测试"——本文件的 fixture 簇只有 ~121 字节，**本来就**够不到默认的 256B 门槛，
//   而下面几条用例断言的是「模型被调用过 / 配额被记过 / 审计落库」。这 6 条原来能绿，靠的正是
//   「旧代码先把模型调用排在闸门前面、出来再判太小」这个缺陷本身（R6 的病）。
//   R6 把闸门提到调用之前以后，被测的簇在调用前就会被判掉 ⇒ 必须显式关掉闸门，这些用例才测得到
//   它本来要测的落点。**闸门自己的行为不在这里测**（由 R6 的专项探针 + model-apply 的注释数字负责）。
//   断言一个字没改。
const policy = (over: Record<string, unknown> = {}) =>
  compressPolicyOf({ compress: { enabled: true, model: 'fake-model', endpoint: 'http://127.0.0.1:1/v1', min_age_days: 0, min_cluster: 2, topic_overlap: 0.30, min_utf8_bytes: 0, min_saved_ratio: 0, ...over } } as never);

describe('L3 端到端（假 provider）', () => {
  it('dry-run 不写任何东西', async () => {
    const calls: string[] = [];
    const provider = { name: 'fake', complete: async (p: string) => { calls.push(p); return JSON.stringify({ items: [{ text: '热窗定为 30 天', evidence: ['1', '2'] }] }); } };
    const r = await compressProject(db, PID, policy(), { apply: false, provider, now: Date.parse('2026-10-17T00:00:00Z') });
    expect(calls.length, 'dry-run 也不该白跑——它要调模型才能给出候选').toBeGreaterThan(0);
    expect(r.logId, 'dry-run 不写审计').toBeNull();
    expect(listCompressLogs(db), 'dry-run 不留 compress_log').toEqual([]);
    expect(compressDetailOf(db, 1), 'dry-run 不留 compress_detail').toEqual([]);
  });

  it('apply 写审计，且**原文快照**在 compress_detail 里（这是回滚的唯一依据）', async () => {
    // 证据编号必须落在**本簇**的条目范围内：实测这一簇只有 2 条（第 3 条同义决策的重叠度不够），
    // 所以用 ['1','2']。这条本身也顺带证明了 validateEvidence 真的在校验范围（写 ['1','3'] 会被丢弃）。
    const provider = { name: 'fake', complete: async () => JSON.stringify({ items: [{ text: '热窗定为 30 天（两条同义合并）', evidence: ['1', '2'] }] }) };
    const r = await compressProject(db, PID, policy(), { apply: true, provider, now: Date.parse('2026-10-17T00:00:00Z') });
    expect(r.logId).toBeTruthy();
    const logs = listCompressLogs(db);
    expect(logs).toHaveLength(1);
    expect(logs[0].scope).toBe('decisions');
    expect(logs[0].status).toBe('applied');
    const details = compressDetailOf(db, r.logId!);
    expect(details.length).toBeGreaterThan(0);
    const originals = JSON.parse(String(details[0].originals)) as Array<{ id: string; text: string }>;
    // 原文快照必须**含全文**（不是截断的摘要），否则回滚要猜
    expect(originals.some((o) => o.text.includes('把归档热窗从 60 天缩短到 30 天'))).toBe(true);
    expect(JSON.parse(String(details[0].evidence_ids)).length).toBeGreaterThanOrEqual(2);
  });

  it('抽不出证据 → 整簇丢弃，**不写审计**（宁缺勿滥，也不留空账）', async () => {
    const provider = { name: 'fake', complete: async () => JSON.stringify({ items: [{ text: '一条没有证据的合并' }] }) };
    const r = await compressProject(db, PID, policy(), { apply: true, provider, now: Date.parse('2026-10-17T00:00:00Z') });
    expect(r.itemsOut).toBe(0);
    expect(r.discarded).toBeGreaterThan(0);
    expect(listCompressLogs(db), '没有真合并就不该留 compress_log（否则审计里全是空账）').toEqual([]);
  });

  it('模型调用失败 → 记进日志、不崩、不写审计', async () => {
    const logs: string[] = [];
    const provider = { name: 'fake', complete: async () => { throw new Error('connection refused'); } };
    const r = await compressProject(db, PID, policy(), { apply: true, provider, log: (s) => logs.push(s), now: Date.parse('2026-10-17T00:00:00Z') });
    expect(r.calls).toBeGreaterThan(0);
    expect(r.itemsOut).toBe(0);
    expect(logs.join('\n')).toContain('调用失败');
    expect(listCompressLogs(db)).toEqual([]);
  });

  it('配额**落库**：调用计数进了 compress_quota（重启不重置）', async () => {
    const provider = { name: 'fake', complete: async () => JSON.stringify({ items: [] }) };
    await compressProject(db, PID, policy(), { apply: true, provider, now: Date.parse('2026-10-17T00:00:00Z') });
    const used = quotaUsed(db, 'project', Date.parse('2026-10-17T00:00:00Z'));
    expect(used).toBeGreaterThan(0);
    const row = db.prepare('SELECT key, used FROM compress_quota').get() as { key: string; used: number };
    expect(row.key).toMatch(/^l3:project:\d+$/);
    // 换一个小时后是新的窗口（旧计数不该跟着走）
    expect(quotaUsed(db, 'project', Date.parse('2026-10-17T05:00:00Z'))).toBe(0);
  });

  it('单轮调用上限真的挡住（max_calls_per_round=1 时只调一次）', async () => {
    let n = 0;
    const provider = { name: 'fake', complete: async () => { n++; return JSON.stringify({ items: [] }); } };
    await compressProject(db, PID, policy({ max_calls_per_round: 1 }), { apply: true, provider, now: Date.parse('2026-10-17T00:00:00Z') });
    expect(n).toBe(1);
  });

  it('关掉 projects 线 → **明说原因**，不静默跳过', async () => {
    const provider = { name: 'fake', complete: async () => '{}' };
    const r = await compressProject(db, PID, policy({ projects: false }), { apply: true, provider });
    expect(r.blocked).toContain('关掉');
  });

  it('太新的条目不动（min_age_days 闸）', async () => {
    let called = 0;
    const provider = { name: 'fake', complete: async () => { called++; return JSON.stringify({ items: [] }); } };
    // 会话创建于 2026-09-01，now 设成当天 ⇒ 条龄 0 天 < min_age_days 7
    await compressProject(db, PID, policy({ min_age_days: 7 }), { apply: true, provider, now: Date.parse('2026-09-01T01:00:00Z') });
    expect(called, '没有够老的条目就不该调模型').toBe(0);
  });
});
