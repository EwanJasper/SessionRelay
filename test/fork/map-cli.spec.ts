// test/fork/map-cli.spec.ts —— T2：srelay map 的 CLI 契约与退出码（§4 / §4.1 / §4.2 / §4.3）。
//
// 为什么用真夹具 + 真命令，而不是测内部函数：CLI 的契约有一半在**命令外面**——
// 退出码、stderr 那一行、--json 的键集合、"绝不覆盖已有文件"这类纪律，还有分页游标与
// 图变化之间的那声 CONFLICT。这些只有把命令真跑一遍（真目录、真文件、真锁）才证明得了。
//
// 每条用例都标了它锁的是契约的哪一条；含糊处一律按 Lead 的终审裁定写死（见文件末尾小结）。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { MAP_ACTIONS, MAP_EXIT_CODE, cmdMap, type MapCliFlags } from '../../src/cli/map.js';

let tmp = '';
let root = '';

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'map-cli-'));
  root = path.join(tmp, 'proj');
  fs.mkdirSync(path.join(root, '.sessionrelay'), { recursive: true });
  process.exitCode = 0;
});

afterEach(() => {
  process.exitCode = 0;
  delete process.env.SRELAY_PROJECT_ROOT;
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

interface RunResult {
  code: number;
  out: string;
  err: string;
  json: Record<string, unknown> | undefined;
}

const pageFile = (page = 'map'): string => path.join(root, '.sessionrelay', 'map', page + '.json');

/** 跑一次命令，抓住三样东西：退出码、stdout（含 process.stdout.write）、stderr。 */
async function run(action: string, flags: MapCliFlags = {}): Promise<RunResult> {
  const out: string[] = [];
  const errs: string[] = [];
  process.exitCode = 0;
  const log = vi.spyOn(console, 'log').mockImplementation(((...a: unknown[]) => {
    out.push(a.map(String).join(' '));
  }) as never);
  const error = vi.spyOn(console, 'error').mockImplementation(((...a: unknown[]) => {
    errs.push(a.map(String).join(' '));
  }) as never);
  const write = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    out.push(String(chunk));
    return true;
  }) as never);
  try {
    await cmdMap(action, { root, ...flags });
  } finally {
    log.mockRestore();
    error.mockRestore();
    write.mockRestore();
  }
  const text = out.join('\n');
  let json: Record<string, unknown> | undefined;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = undefined;
  }
  return { code: process.exitCode ?? 0, out: text, err: errs.join('\n'), json };
}

function writeTmp(name: string, content: string): string {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

function jsonFile(name: string, value: unknown): string {
  return writeTmp(name, JSON.stringify(value, null, 2));
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

const errCode = (r: RunResult): unknown => (r.json?.['error'] as Record<string, unknown> | undefined)?.['code'];
const summary = (r: RunResult): Record<string, unknown> => r.json?.['summary'] as Record<string, unknown>;
const items = (r: RunResult): Array<Record<string, unknown>> => r.json?.['items'] as Array<Record<string, unknown>>;

const TITLE = '看板适配改造';

/** 一张有真结构的小图：两层 + 一条严格向下的边（§2.3）。 */
function seedPatch(): unknown {
  return {
    operations: [
      {
        op: 'declare',
        data: {
          title: TITLE,
          context: { summary: '把地图接进看板', next: '先做投影' },
          layers: [
            { id: 'core', name: '地图内核', rank: 1 },
            { id: 'base', name: '基座', rank: 0 },
          ],
          nodes: [
            { id: 'map-store', label: '地图存储', layer: 'core', status: 'doing', evidence: '单测 12/12 通过' },
            { id: 'map-ops', label: '地图操作', layer: 'core', status: 'done', evidence: '不变式 7 条' },
            { id: 'map-types', label: '类型与判据', layer: 'base', status: 'done', evidence: '纯函数' },
          ],
          edges: [{ from: 'map-ops', to: 'map-types', label: 'uses' }],
        },
      },
    ],
  };
}

async function seed(): Promise<void> {
  const r = await run('apply', { file: jsonFile('seed.json', seedPatch()), json: true });
  expect(r.code).toBe(0);
  expect(fs.existsSync(pageFile())).toBe(true);
}

describe('① 退出码三分法与错误形状（§4 / §4.1）', () => {
  it('动作表就是契约里的九个', () => {
    expect([...MAP_ACTIONS]).toEqual(['init', 'read', 'apply', 'declare', 'update', 'remove', 'check', 'export', 'import']);
  });

  it('退出码映射表就是契约 §4.1 的三分法', () => {
    for (const c of ['NOT_FOUND', 'INVALID_ARGUMENT', 'REFUSED', 'CONFLICT', 'INVALID_STORE'] as const) {
      expect(MAP_EXIT_CODE[c]).toBe(1); // 把输入改对
    }
    for (const c of ['BUSY', 'LOCK_UNAVAILABLE', 'SAVE_FAILED'] as const) {
      expect(MAP_EXIT_CODE[c]).toBe(2); // 值得重跑
    }
  });

  it('未知动作 → INVALID_ARGUMENT，退出码 1', async () => {
    const r = await run('frobnicate', { json: true });
    expect(r.code).toBe(1);
    expect(errCode(r)).toBe('INVALID_ARGUMENT');
    expect(r.err.split('\n')[0]).toMatch(/^INVALID_ARGUMENT：/);
  });

  it('失败时 stderr 是「错误码：说明（建议动作）」一行，且 --json 形状是 {ok:false,error:{code,message,hint}}', async () => {
    await run('init', { json: true });
    const r = await run('init', { json: true }); // 已存在 → CONFLICT（绝不覆盖）
    expect(r.code).toBe(1);
    const line = r.err.split('\n')[0] ?? '';
    expect(line).toMatch(/^CONFLICT：/); // 错误码打头
    expect(line).toContain('（'); // 建议动作在括号里
    expect(r.json?.['ok']).toBe(false);
    expect(Object.keys(r.json?.['error'] as Record<string, unknown>).sort()).toEqual(['code', 'hint', 'message']);
    expect(errCode(r)).toBe('CONFLICT');
  });

  it('拿不到页锁 → 退出码 2（BUSY / LOCK_UNAVAILABLE 属"值得重跑"那一类）', async () => {
    await seed();
    const lock = pageFile() + '.lock';
    fs.writeFileSync(lock, String(process.pid), 'utf8'); // 活的持锁者：不许被当成僵尸偷走
    try {
      const r = await run('apply', {
        file: jsonFile('p2.json', { operations: [{ op: 'update', data: { nodes: [{ id: 'map-ops', status: 'todo' }] } }] }),
        json: true,
      });
      expect(r.code).toBe(2);
      expect(['BUSY', 'LOCK_UNAVAILABLE']).toContain(errCode(r));
    } finally {
      fs.rmSync(lock, { force: true });
    }
  });
});

describe('② init（§4 / §4.1 默认标题）', () => {
  it('建空地图：退出码 0，默认标题 = 项目根目录名', async () => {
    const r = await run('init', { json: true });
    expect(r.code).toBe(0);
    expect(r.json?.['ok']).toBe(true);
    expect(r.json?.['page']).toBe('map');
    expect(fs.readFileSync(pageFile(), 'utf8')).toContain('"title": "proj"');
  });

  it('--title 生效；已存在时 CONFLICT 且文件字节不变', async () => {
    expect((await run('init', { title: '自定义标题' })).code).toBe(0);
    const before = fs.readFileSync(pageFile(), 'utf8');
    expect(before).toContain('自定义标题');
    const again = await run('init', { json: true });
    expect(again.code).toBe(1);
    expect(errCode(again)).toBe('CONFLICT');
    expect(fs.readFileSync(pageFile(), 'utf8')).toBe(before);
  });
});

describe('③ apply / declare / update / remove（§4.1 / §4.3）', () => {
  it('apply 是主写入口：一条 declare 建页 + 层 + 节点 + 边，返回 revision 与计数', async () => {
    await seed();
    const r = await run('read', { json: true, resource: 'map' });
    expect(r.code).toBe(0);
    expect(r.json?.['title']).toBe(TITLE);
    expect(r.json?.['counts']).toEqual({ layers: 2, groups: 0, lanes: 0, nodes: 3, edges: 1 });
  });

  it('apply 信封的键集合严格：多余键 → INVALID_ARGUMENT（内核 unknownKeysError 兜）', async () => {
    const f = jsonFile('bad-envelope.json', { operations: [{ op: 'declare', data: {} }], bogus: 1 });
    const r = await run('apply', { file: f, json: true });
    expect(r.code).toBe(1);
    expect(errCode(r)).toBe('INVALID_ARGUMENT');
    expect(fs.existsSync(pageFile())).toBe(false); // 被拒时一个字节都没落盘
  });

  it('空 operations / 缺 operations → INVALID_ARGUMENT', async () => {
    expect((await run('apply', { file: jsonFile('empty.json', { operations: [] }), json: true })).code).toBe(1);
    expect((await run('apply', { file: jsonFile('none.json', {}), json: true })).code).toBe(1);
  });

  it('缺 --file → INVALID_ARGUMENT，hint 说清单操作糖装的是什么', async () => {
    const r = await run('declare', { json: true });
    expect(r.code).toBe(1);
    expect(errCode(r)).toBe('INVALID_ARGUMENT');
    expect(String((r.json?.['error'] as Record<string, unknown>)['hint'])).toContain('页面片段');
  });

  it('单操作糖的 --file 装的是页面片段本身（不是 {op,data} 信封）', async () => {
    await seed();
    const frag = { nodes: [{ id: 'map-bridge', label: '看板桥接', layer: 'core', status: 'todo' }] };
    const r = await run('declare', { file: jsonFile('frag.json', frag), json: true });
    expect(r.code).toBe(0);
    expect(r.json?.['applied']).toBe(1);
    const read = await run('read', { json: true, resource: 'nodes' });
    expect(items(read).map((n) => n['id'])).toContain('map-bridge');
  });

  it('给单操作糖喂信封 → INVALID_ARGUMENT（并指名道姓说清楚）', async () => {
    await seed();
    const r = await run('declare', {
      file: jsonFile('envelope-to-sugar.json', { op: 'declare', data: { nodes: [] } }),
      json: true,
    });
    expect(r.code).toBe(1);
    expect(errCode(r)).toBe('INVALID_ARGUMENT');
    expect(String((r.json?.['error'] as Record<string, unknown>)['message'])).toContain('页面片段本身');
  });

  it('单操作糖允许 --file - 从 stdin 读', async () => {
    await seed();
    const realRead = fs.readFileSync;
    const spy = vi.spyOn(fs, 'readFileSync').mockImplementation(((p: unknown, ...rest: unknown[]) => {
      if (p === 0) {
        return JSON.stringify({ nodes: [{ id: 'from-stdin', label: '从 stdin 来', layer: 'base', status: 'todo' }] });
      }
      return (realRead as (...a: unknown[]) => unknown)(p, ...rest);
    }) as never);
    try {
      const r = await run('declare', { file: '-', json: true });
      expect(r.code).toBe(0);
      expect(fs.readFileSync(pageFile(), 'utf8')).toContain('from-stdin');
    } finally {
      spy.mockRestore();
    }
  });

  it('update 目标不存在 → NOT_FOUND（不是 REFUSED），退出码 1', async () => {
    await seed();
    const r = await run('update', { file: jsonFile('u.json', { nodes: [{ id: 'nope', status: 'todo' }] }), json: true });
    expect(r.code).toBe(1);
    expect(errCode(r)).toBe('NOT_FOUND');
  });

  it('update 改状态；remove 只吃身份选择器', async () => {
    await seed();
    const u = await run('update', { file: jsonFile('u2.json', { nodes: [{ id: 'map-ops', status: 'doing', evidence: null }] }), json: true });
    expect(u.code).toBe(0);
    const after = await run('read', { json: true, resource: 'nodes' });
    expect(items(after).find((n) => n['id'] === 'map-ops')?.['status']).toBe('doing');
    const rm = await run('remove', { file: jsonFile('rm.json', { nodes: [{ id: 'map-ops' }] }), json: true });
    expect(rm.code).toBe(0);
    const last = await run('read', { json: true, resource: 'nodes' });
    expect(items(last).map((n) => n['id'])).toEqual(['map-store', 'map-types']);
  });

  it('拒绝时文件字节不变（事务语义）', async () => {
    await seed();
    const before = fs.readFileSync(pageFile(), 'utf8');
    const r = await run('declare', { file: jsonFile('dup.json', { nodes: [{ id: 'map-store', label: '重复', layer: 'core' }] }), json: true });
    expect(r.code).toBe(1);
    expect(errCode(r)).toBe('REFUSED'); // 已存在的 id 再 declare → REFUSED（§4.3-4）
    expect(fs.readFileSync(pageFile(), 'utf8')).toBe(before);
  });
});

describe('④ read：resource / 分页 / 游标 / --fields（§4.2）', () => {
  it('没建图时 read → NOT_FOUND / 1', async () => {
    const r = await run('read', { json: true });
    expect(r.code).toBe(1);
    expect(errCode(r)).toBe('NOT_FOUND');
  });

  it('--resource map 给整页摘要（层按 rank 高在上，带每层节点数）', async () => {
    await seed();
    const r = await run('read', { json: true, resource: 'map' });
    const layers = r.json?.['layers'] as Array<Record<string, unknown>>;
    expect(layers.map((l) => l['id'])).toEqual(['core', 'base']);
    expect(layers[0]?.['nodes']).toBe(2);
    expect(r.json?.['revision']).toBeTypeOf('string');
  });

  it('默认 resource = map；不认识的 resource → INVALID_ARGUMENT', async () => {
    await seed();
    expect((await run('read', { json: true })).json?.['resource']).toBe('map');
    const bad = await run('read', { json: true, resource: 'nope' });
    expect(bad.code).toBe(1);
    expect(errCode(bad)).toBe('INVALID_ARGUMENT');
  });

  it('nodes 分页：--limit 2 → 第二页用 --cursor 原样续读', async () => {
    await seed();
    const p1 = await run('read', { json: true, resource: 'nodes', limit: 2 });
    expect(p1.json?.['total']).toBe(3);
    expect(items(p1).map((n) => n['id'])).toEqual(['map-ops', 'map-store']);
    const cursor = String(p1.json?.['nextCursor']);
    expect(cursor).not.toBe('undefined');
    const p2 = await run('read', { json: true, resource: 'nodes', limit: 2, cursor });
    expect(items(p2).map((n) => n['id'])).toEqual(['map-types']);
    expect(p2.json?.['nextCursor']).toBeUndefined();
  });

  it('两次读之间图变了 → CONFLICT（并提示从头重读）', async () => {
    await seed();
    const p1 = await run('read', { json: true, resource: 'nodes', limit: 1 });
    const cursor = String(p1.json?.['nextCursor']);
    await run('apply', { file: jsonFile('touch.json', { operations: [{ op: 'update', data: { nodes: [{ id: 'map-store', status: 'done' }] } }] }), json: true });
    const r = await run('read', { json: true, resource: 'nodes', limit: 1, cursor });
    expect(r.code).toBe(1);
    expect(errCode(r)).toBe('CONFLICT');
  });

  it('游标格式非法 → INVALID_ARGUMENT（说它是不透明字符串）', async () => {
    await seed();
    const r = await run('read', { json: true, resource: 'nodes', cursor: 'not-a-cursor' });
    expect(r.code).toBe(1);
    expect(errCode(r)).toBe('INVALID_ARGUMENT');
    expect(String((r.json?.['error'] as Record<string, unknown>)['hint'])).toContain('不透明');
  });

  it('游标不通用：换了 resource → INVALID_ARGUMENT', async () => {
    await seed();
    const p1 = await run('read', { json: true, resource: 'nodes', limit: 1 });
    const cursor = String(p1.json?.['nextCursor']);
    const r = await run('read', { json: true, resource: 'edges', cursor });
    expect(r.code).toBe(1);
    expect(errCode(r)).toBe('INVALID_ARGUMENT');
  });

  it('--limit 默认 30、上限 100：超了是 INVALID_ARGUMENT（不静默截断）', async () => {
    await seed();
    expect((await run('read', { json: true, resource: 'nodes', limit: 100 })).code).toBe(0);
    expect((await run('read', { json: true, resource: 'nodes', limit: 101 })).code).toBe(1);
    expect((await run('read', { json: true, resource: 'nodes', limit: 0 })).code).toBe(1);
    expect((await run('read', { json: true, resource: 'nodes', limit: 'x' })).code).toBe(1);
    expect((await run('read', { json: true, resource: 'nodes' })).json?.['limit']).toBe(30);
  });

  it('--fields 只挑字段，但 identity 永远保留', async () => {
    await seed();
    const r = await run('read', { json: true, resource: 'nodes', fields: 'label' });
    expect(Object.keys(items(r)[0] ?? {}).sort()).toEqual(['id', 'label']);
    const e = await run('read', { json: true, resource: 'edges', fields: 'label' });
    expect(Object.keys(items(e)[0] ?? {}).sort()).toEqual(['from', 'label', 'to']);
  });

  it('--fields 未知字段 / 用在非 list resource 上 → INVALID_ARGUMENT', async () => {
    await seed();
    expect((await run('read', { json: true, resource: 'nodes', fields: 'nope' })).code).toBe(1);
    expect((await run('read', { json: true, resource: 'map', fields: 'label' })).code).toBe(1);
  });

  it('该拒绝的组合一律说出来，不静默忽略：--status 只给 nodes、--resource map 不吃分页', async () => {
    await seed();
    expect((await run('read', { json: true, resource: 'edges', status: 'done' })).code).toBe(1);
    expect((await run('read', { json: true, resource: 'map', limit: 5 })).code).toBe(1);
    expect((await run('read', { json: true, resource: 'pages', page: 'map' })).code).toBe(1);
    expect((await run('read', { json: true, resource: 'nodes', status: 'bogus' })).code).toBe(1);
  });

  it('--status 过滤 nodes；--ids 找不到就说 NOT_FOUND', async () => {
    await seed();
    const r = await run('read', { json: true, resource: 'nodes', status: 'done' });
    expect(r.json?.['total']).toBe(2);
    const miss = await run('read', { json: true, resource: 'nodes', ids: 'ghost' });
    expect(miss.code).toBe(1);
    expect(errCode(miss)).toBe('NOT_FOUND');
  });

  it('--resource pages / layers / edges 各自的形状', async () => {
    await seed();
    const pages = await run('read', { json: true, resource: 'pages' });
    expect(items(pages)[0]?.['id']).toBe('map');
    const layers = await run('read', { json: true, resource: 'layers' });
    expect(items(layers).map((l) => l['id'])).toEqual(['core', 'base']);
    const edges = await run('read', { json: true, resource: 'edges' });
    expect(items(edges)[0]?.['from']).toBe('map-ops');
  });
});

describe('⑤ check 与 read --resource changes 同源同结构（§4.2 / §4.3）', () => {
  async function seedWithSource(content: string, declaredHash: string): Promise<void> {
    fs.writeFileSync(path.join(root, 'atomic.ts'), content, 'utf8');
    const patch = {
      operations: [
        {
          op: 'declare',
          data: {
            layers: [{ id: 'base', name: '基座', rank: 0 }],
            nodes: [
              {
                id: 'map-store',
                label: '地图存储',
                layer: 'base',
                status: 'done',
                evidence: '单测全绿',
                sources: [{ path: 'atomic.ts', sha256: declaredHash }],
              },
            ],
          },
        },
      ],
    };
    const r = await run('apply', { file: jsonFile('seed-src.json', patch), json: true });
    expect(r.code).toBe(0);
  }

  it('sources 没变 → check 退出码 0，summary 全 unchanged', async () => {
    await seedWithSource('same-bytes', sha256('same-bytes'));
    const r = await run('check', { json: true });
    expect(r.code).toBe(0);
    expect(summary(r)).toEqual({ total: 1, changed: 0, unknown: 0, unchanged: 1 });
  });

  it('默认只报告（退出码 0）；--fail-on-changed 才判失败（退出码 1）', async () => {
    await seedWithSource('new-bytes', sha256('old-bytes'));
    const soft = await run('check', { json: true });
    expect(soft.code).toBe(0);
    expect(summary(soft)['changed']).toBe(1);
    const hard = await run('check', { json: true, failOnChanged: true });
    expect(hard.code).toBe(1);
    expect(hard.err).toContain('fail-on-changed');
    const node = (hard.json?.['nodes'] as Array<Record<string, unknown>>)[0];
    expect(node?.['state']).toBe('changed');
    expect(node?.['changed']).toEqual(['atomic.ts']);
  });

  it('read --resource changes 与 map check 结构一致（同一次对账，两者 nodes/summary/page 相等）', async () => {
    await seedWithSource('new-bytes', sha256('old-bytes'));
    const a = await run('check', { json: true });
    const b = await run('read', { json: true, resource: 'changes' });
    expect(b.json?.['resource']).toBe('changes');
    expect(b.json?.['page']).toEqual(a.json?.['page']);
    expect(b.json?.['summary']).toEqual(a.json?.['summary']);
    expect(b.json?.['nodes']).toEqual(a.json?.['nodes']);
  });

  it('check 只认 --page / --ids / --fail-on-changed / --json；收窄用 --ids', async () => {
    await seedWithSource('x', sha256('x'));
    expect((await run('check', { json: true, limit: 5 })).code).toBe(1);
    const r = await run('check', { json: true, ids: 'map-store' });
    expect(r.code).toBe(0);
    expect(r.json?.['nodes']).toHaveLength(1);
  });

  it('还没建图 → NOT_FOUND（check 只对账，不建图）', async () => {
    const r = await run('check', { json: true });
    expect(r.code).toBe(1);
    expect(errCode(r)).toBe('NOT_FOUND');
  });
});

describe('⑥ export / import（§4.1 / §4.2）', () => {
  it('export --md 出人看的表格（含标题与节点）', async () => {
    await seed();
    const r = await run('export', { md: true });
    expect(r.code).toBe(0);
    expect(r.out).toContain('# ' + TITLE);
    expect(r.out).toContain('map-store');
    expect(r.out).toContain('地图存储');
  });

  it('export --d2 出 D2 源（层带 + 真边）', async () => {
    await seed();
    const r = await run('export', { d2: true });
    expect(r.code).toBe(0);
    expect(r.out).toContain('classes: {');
    expect(r.out).toContain('"map-ops" -> "map-types"');
  });

  it('export --mmd 走 bridge（T3）：--json 给出 text', async () => {
    await seed();
    const r = await run('export', { json: true, mmd: true });
    expect(r.code).toBe(0);
    expect(r.json?.['format']).toBe('mmd');
    expect(String(r.json?.['text']).length).toBeGreaterThan(0);
  });

  it('--out 写到文件（相对项目根），--out - 回到 stdout', async () => {
    await seed();
    const r = await run('export', { md: true, out: 'docs/map.md', json: true });
    expect(r.code).toBe(0);
    expect(r.json?.['format']).toBe('md');
    expect(fs.readFileSync(path.join(root, 'docs', 'map.md'), 'utf8')).toContain('# ' + TITLE);
    const dash = await run('export', { md: true, out: '-' });
    expect(dash.out).toContain('# ' + TITLE);
  });

  it('--mmd/--md/--d2 只能给一个', async () => {
    await seed();
    const r = await run('export', { json: true, mmd: true, md: true });
    expect(r.code).toBe(1);
    expect(errCode(r)).toBe('INVALID_ARGUMENT');
  });

  it('--to 不配 --json → INVALID_ARGUMENT（§4.2）', async () => {
    await seed();
    const r = await run('export', { to: 'docs/map.json' }); // 没有 --json → 连 JSON 错误都不该有，只有 stderr 那一行
    expect(r.code).toBe(1);
    expect(r.err.split('\n')[0]).toMatch(/^INVALID_ARGUMENT：/);
    expect(fs.existsSync(path.join(root, 'docs', 'map.json'))).toBe(false);
  });

  it('--json --to 写快照：幂等（第二次 overwritten），且 --to 不许跑出仓库', async () => {
    await seed();
    const a = await run('export', { json: true, to: 'docs/map.json' });
    expect(a.code).toBe(0);
    expect(a.json?.['overwritten']).toBe(false);
    const abs = path.join(root, 'docs', 'map.json');
    expect(fs.existsSync(abs)).toBe(true);
    const b = await run('export', { json: true, to: 'docs/map.json' });
    expect(b.json?.['overwritten']).toBe(true);
    expect(fs.readFileSync(abs, 'utf8')).toBe(fs.readFileSync(pageFile(), 'utf8')); // 快照 = 页文件的字节
    expect((await run('export', { json: true, to: '../escape.json' })).code).toBe(1);
    expect((await run('export', { json: true, to: path.join(tmp, 'abs.json') })).code).toBe(1);
  });

  it('--to 目标是别人的文件 → REFUSED（不覆盖人写的东西）', async () => {
    await seed();
    // --to 是相对**项目根**解析的：夹具要放在根里，否则它只是个不存在的目标（新建成功，测不到 REFUSED）
    fs.writeFileSync(path.join(root, 'notes.txt'), '这是我手写的笔记，谁也别动', 'utf8');
    const r = await run('export', { json: true, to: 'notes.txt' });
    expect(r.code).toBe(1);
    expect(errCode(r)).toBe('REFUSED');
    expect(fs.readFileSync(path.join(root, 'notes.txt'), 'utf8')).toBe('这是我手写的笔记，谁也别动');
  });

  it('快照能原样恢复到一个新页（层/节点/边都在）', async () => {
    await seed();
    expect((await run('export', { json: true, to: 'docs/map.json' })).code).toBe(0);
    const r = await run('import', { from: 'docs/map.json', page: 'core', json: true });
    expect(r.code).toBe(0);
    expect(r.json?.['imported']).toEqual({ layers: 2, nodes: 3, edges: 1 });
    const back = await run('read', { json: true, page: 'core', resource: 'map' });
    expect(back.json?.['counts']).toEqual({ layers: 2, groups: 0, lanes: 0, nodes: 3, edges: 1 });
    expect(back.json?.['title']).toBe(TITLE);
  });

  it('import 目标已存在 → REFUSED（绝不覆盖）', async () => {
    await seed();
    const r = await run('import', { from: 'progress.md', json: true });
    expect(r.code).toBe(1);
    expect(errCode(r)).toBe('REFUSED');
  });
});

describe('⑦ import --from progress.md：单层初稿（§4.1）', () => {
  const PROGRESS = [
    '# 项目看板',
    '',
    '| 任务 | 状态 | 模块 | 明细 |',
    '|---|---|---|---|',
    '| 地图存储 | 🔄 进行中 | 核心 | atomic + lock |',
    '| 类型与判据 | ✅ 完成 | 核心 | 7 条不变式 |',
    '| 看板桥接 | ⛔ 阻塞 | 核心 | 等 T3 落盘 |',
    '| 回归的边 | ⬜ 待办 | 核心 | 还没开始 |',
    '',
  ].join('\n');

  it('四行 → n1..n4（行序 1 基）、状态映射、detail = 明细列、单层 plan rank 0、零边', async () => {
    fs.writeFileSync(path.join(root, 'progress.md'), PROGRESS, 'utf8');
    const r = await run('import', { from: 'progress.md', json: true });
    expect(r.code).toBe(0);
    expect(r.json?.['imported']).toBe(4);
    expect(r.json?.['edges']).toBe(0);
    const nodes = await run('read', { json: true, resource: 'nodes' });
    const list = items(nodes);
    expect(list.map((n) => n['id'])).toEqual(['n1', 'n2', 'n3', 'n4']);
    expect(list.map((n) => n['status'])).toEqual(['doing', 'done', 'blocked', 'todo']);
    expect(list[0]?.['label']).toBe('地图存储');
    expect(list[0]?.['detail']).toBe('atomic + lock');
    expect(list.every((n) => n['layer'] === 'plan')).toBe(true);
    const layers = await run('read', { json: true, resource: 'layers' });
    expect(items(layers)).toEqual([{ id: 'plan', name: '计划（自 progress.md 导入）', rank: 0, nodes: 4 }]);
    const edges = await run('read', { json: true, resource: 'edges' });
    expect(edges.json?.['total']).toBe(0); // 依赖列是人话 → 不猜边
  });

  it('只搬人写的行：auto:todos / auto:map 一律跳过，并报出跳了几行（Lead 终审）', async () => {
    fs.writeFileSync(
      path.join(root, 'progress.md'),
      [
        '# 项目看板',
        '',
        '| 任务 | 状态 | 模块 | 明细 |',
        '|---|---|---|---|',
        '| 人写的计划一 | 🔄 进行中 | 核心 | 明细 A |',
        '| ZCode 机器待办 | ⬜ 待办 | auto:todos | 来自 ZCode 待办（10-18） |',
        '| 地图自己的投影 | 🔄 进行中 | auto:map | 源自地图 |',
        '| 人写的计划二 | ✅ 完成 | 核心 | 明细 B |',
        '',
      ].join('\n'),
      'utf8',
    );
    const r = await run('import', { from: 'progress.md', json: true });
    expect(r.code).toBe(0);
    expect(r.json?.['imported']).toBe(2);
    expect(r.json?.['skipped']).toBe(2);
    const nodes = await run('read', { json: true, resource: 'nodes' });
    const list = items(nodes);
    // 行序只数被搬进来的行：机器行每次 sync 都在变，不能让人写节点的 id 跟着它漂
    expect(list.map((n) => n['id'])).toEqual(['n1', 'n2']);
    expect(list.map((n) => n['label'])).toEqual(['人写的计划一', '人写的计划二']);
    expect(fs.readFileSync(pageFile(), 'utf8')).not.toContain('机器');
    // 人类摘要里要有「跳过 N 行机器行」这句证据
    const human = await run('import', { from: 'progress.md', page: 'p2' });
    expect(human.code).toBe(0);
    expect(human.out).toContain('跳过 2 行机器行');
  });

  it('progress.md 里只有机器行 → REFUSED（迁移要的是人写过的计划）', async () => {
    fs.writeFileSync(
      path.join(root, 'progress.md'),
      [
        '| 任务 | 状态 | 模块 | 明细 |',
        '|---|---|---|---|',
        '| ZCode 机器待办 | ⬜ 待办 | auto:todos | 来自 ZCode 待办 |',
        '| 地图投影 | 🔄 进行中 | auto:map | 源自地图 |',
        '',
      ].join('\n'),
      'utf8',
    );
    const r = await run('import', { from: 'progress.md', json: true });
    expect(r.code).toBe(1);
    expect(errCode(r)).toBe('REFUSED');
    expect(fs.existsSync(pageFile())).toBe(false);
  });

  it('没有 progress.md → NOT_FOUND；别的 .md → INVALID_ARGUMENT（解析器只有一份）', async () => {
    const miss = await run('import', { from: 'progress.md', json: true });
    expect(miss.code).toBe(1);
    expect(errCode(miss)).toBe('NOT_FOUND');
    fs.writeFileSync(path.join(root, 'other.md'), '| 任务 | 状态 | 模块 | 明细 |\n|---|---|---|---|\n| x | ✅ 完成 | m | d |\n', 'utf8');
    const other = await run('import', { from: 'other.md', json: true });
    expect(other.code).toBe(1);
    expect(errCode(other)).toBe('INVALID_ARGUMENT');
  });

  it('progress.md 存在但没有可解析的看板行 → REFUSED', async () => {
    fs.writeFileSync(path.join(root, 'progress.md'), '# 只有标题，没有表\n', 'utf8');
    const r = await run('import', { from: 'progress.md', json: true });
    expect(r.code).toBe(1);
    expect(errCode(r)).toBe('REFUSED');
  });

  it('--from 不是快照（坏 JSON / 坏页）→ INVALID_ARGUMENT / INVALID_STORE', async () => {
    fs.writeFileSync(path.join(root, 'bad.json'), '{ 这不是 JSON }', 'utf8');
    const bad = await run('import', { from: 'bad.json', json: true });
    expect(bad.code).toBe(1);
    expect(errCode(bad)).toBe('INVALID_STORE');
    fs.writeFileSync(
      path.join(root, 'half.json'),
      JSON.stringify({ version: 1, title: 'x', layers: [], nodes: [], edges: [], 多余: 1 }),
      'utf8',
    );
    const half = await run('import', { from: 'half.json', json: true });
    expect(half.code).toBe(1);
    expect(errCode(half)).toBe('INVALID_STORE');
    const miss = await run('import', { from: 'nope.json', json: true });
    expect(miss.code).toBe(1);
    expect(errCode(miss)).toBe('NOT_FOUND');
  });
});

describe('⑧ 项目根：不给 --root 时用 requireRoot()', () => {
  it('SRELAY_PROJECT_ROOT 指向的项目被认领', async () => {
    process.env.SRELAY_PROJECT_ROOT = root;
    const out: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation(((...a: unknown[]) => {
      out.push(a.map(String).join(' '));
    }) as never);
    process.exitCode = 0;
    try {
      await cmdMap('init', { title: '走 requireRoot' });
    } finally {
      log.mockRestore();
    }
    expect(process.exitCode ?? 0).toBe(0);
    expect(fs.readFileSync(pageFile(), 'utf8')).toContain('走 requireRoot');
    expect(out.length).toBeGreaterThan(0);
  });
});
