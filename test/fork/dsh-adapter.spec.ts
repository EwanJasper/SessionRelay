// [fork 1011] DSH 适配器回归锁：slug 编码（5 组实测数据固化）、discover 归属、
// 帧增量读取、截断尾帧容错、事件映射过滤。格式依据 docs/design-dsh-adapter.md。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { dshSessionSlug } from '../../src/adapters/dsh/format.js';
import { adapter } from '../../src/adapters/dsh/index.js';
import type { AdapterConfig, DiscoveredSession } from '../../src/adapters/types.js';

// ── 真实数据固化的 slug 对（10-11 凌晨从 ~/.dsh/sessions 逐一核对） ──
const REAL_SLUG_PAIRS: Array<[string, string]> = [
  ['D:\\agent1super', '--D-agent1super--'],
  ['E:\\music player', '--E-music~0020player--'],
  ['E:\\mc整合包', '--E-mc~6574~5408~5305--'],
  ['D:\\agent1super\\tmp\\docx-build', '--D-agent1super-tmp-docx-build--'],
  ['E:\\work', '--E-work--'],
];

describe('fork · DSH slug 编码', () => {
  it('5 组真实 (路径, slug) 对全部命中的同向编码', () => {
    for (const [p, slug] of REAL_SLUG_PAIRS) {
      expect(dshSessionSlug(p)).toBe(slug);
    }
  });
});

// ── 夹具：tmp 会话库（真实 zstd 帧） ──
let tmp = '';
let projRoot = '';
let sessionsDir = '';
let cfg: AdapterConfig;
const uuid1 = 'aaaaaaaa-1111-2222-3333-444444444444';
const uuid2 = 'bbbbbbbb-1111-2222-3333-444444444444';

function frame(lines: string[]): Buffer {
  return zlib.zstdCompressSync(Buffer.from(lines.join('\n') + '\n'));
}
function writeSession(uuid: string, cwd: string, depth: number, frames: Buffer[], opts: { bareDir?: boolean; group?: string; parent?: string } = {}): void {
  // [B2] DSH 两种目录命名都真实存在：老 = session-<uuid>，新 = 裸 <uuid>。
  // 同一组里混存（实测 --D-agent1super-- 22 个目录里 15 带前缀 / 7 裸）。
  const dirName = opts.bareDir ? uuid : 'session-' + uuid;
  const d = path.join(sessionsDir, opts.group ?? dshSessionSlug(projRoot), dirName);
  fs.mkdirSync(d, { recursive: true });
  const header = JSON.stringify({
    type: 'session', version: 4, id: uuid, createdAt: Date.now(),
    cwd, isSeeded: false, delegationDepth: depth, agentPreset: 'ptc',
    ...(opts.parent ? { parentSession: opts.parent } : {}),
  });
  fs.writeFileSync(path.join(d, 'session.v4.jsonl.zstd'), Buffer.concat([frame([header]), ...frames]));
}
function ev(type: string, seq: number, data: Record<string, unknown> = {}): string {
  // 真实事件载荷形状（10-11 逆向）：内容一律在 data 下，不在顶层
  return JSON.stringify({ type, seq, time: 1791600000000 + seq, data });
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-adapter-'));
  projRoot = path.join(tmp, 'proj');
  fs.mkdirSync(projRoot, { recursive: true });
  sessionsDir = path.join(tmp, 'sessions');
  cfg = { sessionsDir };
});

afterEach(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* Windows 句柄延迟重试 */ }
});

describe('fork · DSH discover', () => {
  it('按 slug 组发现会话，uuid/时间/来源正确；他项目根返回空', () => {
    writeSession(uuid1, projRoot, 0, [frame([ev('user/message', 10, { content: [{ type: 'text', text: '你好' }] })])]);
    const out = adapter.discover(projRoot, cfg) as DiscoveredSession[];
    expect(out.length).toBe(1);
    expect(out[0].source).toBe('dsh');
    expect(out[0].sourceSessionId).toBe(uuid1);
    expect(out[0].sourceFile).toContain(uuid1);
    expect(out[0].originHint).toBeUndefined();
    // 另一个项目根（未建组）→ 空
    expect(adapter.discover(path.join(tmp, 'other'), cfg)).toEqual([]);
  });

  it('[B2] 裸 uuid 目录（新版 DSH 命名）也要发现——只认 session- 前缀=静默漏采', () => {
    const uuid3 = 'cccccccc-1111-2222-3333-444444444444';
    writeSession(uuid3, projRoot, 0, [frame([ev('user/message', 7, { content: [{ type: 'text', text: '新版命名' }] })])], { bareDir: true });
    const out = adapter.discover(projRoot, cfg) as DiscoveredSession[];
    expect(out.map((s) => s.sourceSessionId)).toContain(uuid3);
  });

  it('[B2] 委派会话按 parentSession 链归到发起它的项目（父在别的组）', () => {
    const parentUuid = 'dddddddd-1111-2222-3333-444444444444';
    const childUuid = 'eeeeeeee-1111-2222-3333-444444444444';
    // 父会话在【本项目组】里，cwd = 项目根
    writeSession(parentUuid, projRoot, 0, [frame([ev('user/message', 3, { content: [{ type: 'text', text: '父会话' }] })])]);
    // 子会话（subagent）落在【另一个组】（实测：subagent 的 cwd 是它自己的工作目录 E:\work）
    writeSession(childUuid, path.join(tmp, 'workdir'), 1,
      [frame([ev('user/message', 4, { content: [{ type: 'text', text: '子任务' }] })])],
      { group: '--tmp-workdir--', parent: 'session-' + parentUuid });
    const out = adapter.discover(projRoot, cfg) as DiscoveredSession[];
    const child = out.find((s) => s.sourceSessionId === childUuid);
    expect(child, '委派会话应归到发起它的项目').toBeTruthy();
    expect(child?.originHint).toBe('workflow');   // 仍是施工日志：不进简报（既有纪律不变）
  });

  it('delegationDepth > 0 标注 workflow（子代理碎片不进决策）', () => {
    writeSession(uuid2, projRoot, 2, [frame([ev('user/message', 5, { content: [{ type: 'text', text: '子任务' }] })])]);
    const out = adapter.discover(projRoot, cfg) as DiscoveredSession[];
    expect(out.find(s => s.sourceSessionId === uuid2)?.originHint).toBe('workflow');
  });
});

describe('fork · DSH readNew', () => {
  it('首读全量：user/assistant 入库、reasoning 与 tool 事件不入、seq 做游标', async () => {
    writeSession(uuid1, projRoot, 0, [
      frame([
        ev('user/message', 10, { content: [{ type: 'text', text: '问题：用什么数据库' }] }),
        ev('tool/call', 15, { callId: 'c1', name: 'web_search', arguments: '{}' }),
        ev('assistant/message', 20, { turn: 1, step: 1, message: { role: 'assistant', content: [
          { type: 'reasoning', text: '内心戏不该入库' },
          { type: 'text', text: '决定采用 PostgreSQL' },
        ] } }),
        ev('turn/end', 30, { turn: 1, reason: { kind: 'completed' } }),
      ]),
    ]);
    const ds = adapter.discover(projRoot, cfg)[0];
    const r = await adapter.readNew(ds, undefined, cfg);
    expect(r.messages.map(m => m.role)).toEqual(['user', 'assistant']);
    expect(r.messages[0].content).toBe('问题：用什么数据库');
    expect(r.messages[1].content).toBe('决定采用 PostgreSQL');
    expect(r.messages[1].seqNum).toBe(20);
    // 游标语义 = 最后一条【入库】消息的 seq（跳过型事件不推进——映射器日后扩展时，
    // 曾跳过的事件区间仍会被重扫并按新规则收录）；maxSeq 只用作本读去重下限
    expect(r.cursor.lastSeq).toBe(20);
    expect(r.badLines).toBe(0);
  });

  it('游标增量：二读为空，追加新帧只出新消息', async () => {
    const d = path.join(sessionsDir, dshSessionSlug(projRoot), 'session-' + uuid1);
    fs.mkdirSync(d, { recursive: true });
    const fp = path.join(d, 'session.v4.jsonl.zstd');
    fs.writeFileSync(fp, Buffer.concat([
      frame([ev('user/message', 10, { content: [{ type: 'text', text: '第一问' }] })]),
    ]));
    const ds = adapter.discover(projRoot, cfg)[0];
    const r1 = await adapter.readNew(ds, undefined, cfg);
    expect(r1.messages.length).toBe(1);
    const r2 = await adapter.readNew(ds, r1.cursor, cfg);
    expect(r2.messages.length).toBe(0);
    // 追加新帧（真实追加形态：Buffer.concat 旧内容 + 新帧）
    fs.writeFileSync(fp, Buffer.concat([
      fs.readFileSync(fp),
      frame([ev('assistant/message', 20, { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '第一答' }] } })]),
    ]));
    const r3 = await adapter.readNew(ds, r1.cursor, cfg);
    expect(r3.messages.length).toBe(1);
    expect(r3.messages[0].content).toBe('第一答');
    expect(r3.cursor.lastSeq).toBe(20);
  });

  it('截断尾帧不崩不幻读，帧完整后自动补收', async () => {
    const d = path.join(sessionsDir, dshSessionSlug(projRoot), 'session-' + uuid1);
    fs.mkdirSync(d, { recursive: true });
    const fp = path.join(d, 'session.v4.jsonl.zstd');
    fs.writeFileSync(fp, frame([ev('user/message', 10, { content: [{ type: 'text', text: '第一问' }] })]));
    const ds = adapter.discover(projRoot, cfg)[0];
    const r1 = await adapter.readNew(ds, undefined, cfg);
    // 追加一个被切掉尾巴的帧（模拟 DSH 写到一半）
    const full = frame([ev('user/message', 20, { content: [{ type: 'text', text: '第二问' }] })]);
    fs.writeFileSync(fp, Buffer.concat([fs.readFileSync(fp), full.subarray(0, full.length - 6)]));
    const ds2 = adapter.discover(projRoot, cfg)[0];
    const r2 = await adapter.readNew(ds2, r1.cursor, cfg);
    expect(r2.messages.length).toBe(0); // 半帧不幻读
    // 写完剩余字节 → 帧完整 → 补收
    fs.writeFileSync(fp, Buffer.concat([fs.readFileSync(fp), full.subarray(full.length - 6)]));
    const r3 = await adapter.readNew(ds, r2.cursor, cfg);
    expect(r3.messages.map(m => m.content)).toEqual(['第二问']);
  });

  it('坏行计数不中断；多行单帧按行拆分', async () => {
    const d = path.join(sessionsDir, dshSessionSlug(projRoot), 'session-' + uuid1);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'session.v4.jsonl.zstd'), Buffer.concat([
      frame(['这不是 JSON', ev('user/message', 10, { content: [{ type: 'text', text: '正经问题' }] }), '{"type":"x"'].map(l => Buffer.from(l))),
    ]));
    const ds = adapter.discover(projRoot, cfg)[0];
    const r = await adapter.readNew(ds, undefined, cfg);
    expect(r.badLines).toBeGreaterThanOrEqual(1);
    expect(r.messages.map(m => m.content)).toEqual(['正经问题']);
  });
});

describe('fork · DSH healthCheck', () => {
  it('目录不存在给出可忽略说明', () => {
    const msg = adapter.healthCheck?.(projRoot, { sessionsDir: path.join(tmp, 'nope') });
    expect(msg).toContain('目录不存在');
  });
});
