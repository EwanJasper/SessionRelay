// [T1] 地图内核 · 存储：严格解析、原子保存、锁、revision、事务（契约 §2/§3/§4.1）。
//
// 用真夹具（真临时目录、真文件）而不是 mock fs：这里要证明的正是**磁盘上的字节没变**——
// 那是 mock 证明不了的东西（"拒绝时文件字节不变"是这条链最硬的一条承诺）。
//
// 双向断言：该写的时候写对了 + 该拒的时候一个字节都没动。
import { describe, beforeAll, afterAll, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_PAGE,
  initMap,
  listPages,
  mapDirOf,
  pagePathOf,
  readPage,
  readPageIfExists,
} from '../../src/map/store/page.js';
import { applyPatch, type MapPatch } from '../../src/map/store/apply.js';
import { parseMapPatch, parsePatchText } from '../../src/map/patch.js';
import { revisionOf, serializePage } from '../../src/map/store/format.js';
import { writeFileAtomic } from '../../src/map/store/atomic.js';
import { lockPathOf, withMapLock } from '../../src/map/store/lock.js';

let tmp = '';
let root = '';
let seq = 0;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'srelay-map-'));
  root = path.join(tmp, 'proj');
  fs.mkdirSync(root, { recursive: true });
});
afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** 每个用例一个独立的项目根：并发的用例不许互相看见对方的锁与文件。 */
function freshRoot(): string {
  seq += 1;
  const r = path.join(tmp, 'p' + String(seq));
  fs.mkdirSync(r, { recursive: true });
  return r;
}

/** §4.1 的一条 declare 片段：两层三点一条边（合法图）。 */
function seedPatch(over: Partial<MapPatch> = {}): MapPatch {
  return {
    expectedRevision: 'absent',
    operations: [
      {
        op: 'declare',
        data: {
          title: '种子图',
          layers: [
            { id: 'core', name: '内核', rank: 0 },
            { id: 'app', name: '应用', rank: 1 },
          ],
          groups: [{ id: 'store', label: '存储', layer: 'core' }],
          lanes: [{ id: 'agent', label: 'agent' }],
          nodes: [
            { id: 'map-types', label: '类型', layer: 'core', status: 'done', evidence: 'vitest 12/12' },
            { id: 'map-store', label: '地图存储', layer: 'core', status: 'doing', group: 'store', lane: 'agent' },
            { id: 'map-cli', label: 'CLI', layer: 'app', status: 'todo' },
          ],
          edges: [{ from: 'map-cli', to: 'map-store', label: 'uses' }],
        },
      },
    ],
    ...over,
  };
}

function readBytes(file: string): string {
  return fs.readFileSync(file, 'utf8');
}

function tmpFilesIn(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));
  } catch {
    return [];
  }
}

describe('[T1] 页：initMap / readPage / listPages', () => {
  it('initMap 建空图；再 init 一次 → CONFLICT，且文件一个字节不变（绝不覆盖）', () => {
    const p = freshRoot();
    const first = initMap(p, '看板适配改造');
    expect(first.ok).toBe(true);
    const file = pagePathOf(p, DEFAULT_PAGE);
    expect(fs.existsSync(file)).toBe(true);
    const before = readBytes(file);
    expect(before).toContain('"version": 1');
    expect(before).toContain('看板适配改造');

    const second = initMap(p, '想盖掉它');
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.code).toBe('CONFLICT');
      expect(second.error.hint).toBeTruthy();
    }
    expect(readBytes(file)).toBe(before);
  });

  it('readPage：没有地图是 NOT_FOUND；readPageIfExists 说 undefined（投影靠这个区分"还没建"与"坏了"）', () => {
    const p = freshRoot();
    const missing = readPage(p);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe('NOT_FOUND');
    const maybe = readPageIfExists(p);
    expect(maybe.ok).toBe(true);
    if (maybe.ok) expect(maybe.value).toBeUndefined();
  });

  it('页 id 语法：readPage/applyPatch 都拒（页 id 是路径的一部分，未校验的 id 能走出去）', () => {
    const p = freshRoot();
    for (const bad of ['../evil', 'Bad', 'a/b', '.hidden']) {
      const got = readPage(p, bad);
      expect(got.ok).toBe(false);
      if (!got.ok) expect(got.error.code).toBe('INVALID_ARGUMENT');
      const applied = applyPatch(p, seedPatch({ page: bad }));
      expect(applied.ok).toBe(false);
      if (!applied.ok) expect(applied.error.code).toBe('INVALID_ARGUMENT');
    }
  });

  it('listPages：默认页排最前，其余按 id；坏页大声失败而不是静默少报', () => {
    const p = freshRoot();
    expect(initMap(p, 'A').ok).toBe(true);
    const other = applyPatch(p, { page: 'core', expectedRevision: 'absent', operations: seedPatch().operations });
    expect(other.ok).toBe(true);
    const listed = listPages(p);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.map((x) => x.id)).toEqual(['map', 'core']);
    expect(listed.value[1]).toMatchObject({ title: '种子图', nodes: 3, edges: 1 });
    expect(listed.value[1]!.revision).toMatch(/^[a-f0-9]{64}$/);

    // 手写一份坏页：整次 list 失败并指名道姓，绝不"少报一个页"
    fs.writeFileSync(pagePathOf(p, 'broken'), '{ not json', 'utf8');
    const after = listPages(p);
    expect(after.ok).toBe(false);
    if (!after.ok) {
      expect(after.error.code).toBe('INVALID_STORE');
      expect(after.error.message).toContain('broken.json');
    }
  });
});

describe('[T1] applyPatch：事务 / expectedRevision / 落盘', () => {
  it('expectedRevision=absent 建页；revision 是规范化 JSON 的 sha256；再读回来一致', () => {
    const p = freshRoot();
    const got = applyPatch(p, seedPatch());
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.value.applied).toBe(1);
    expect(got.value.page.nodes).toHaveLength(3);
    expect(got.value.revision).toBe(revisionOf(got.value.page));

    const read = readPage(p);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.revision).toBe(got.value.revision);
    expect(read.value.path).toBe(pagePathOf(p, DEFAULT_PAGE));
  });

  it('expectedRevision 不符 → CONFLICT，文件字节不变', () => {
    const p = freshRoot();
    expect(applyPatch(p, seedPatch()).ok).toBe(true);
    const file = pagePathOf(p, DEFAULT_PAGE);
    const before = readBytes(file);
    const conflict = applyPatch(p, {
      expectedRevision: 'f'.repeat(64),
      operations: [{ op: 'update', data: { nodes: [{ id: 'map-cli', status: 'doing' }] } }],
    });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) {
      expect(conflict.error.code).toBe('CONFLICT');
      expect(conflict.error.details).toMatchObject({ expected: 'f'.repeat(64) });
    }
    expect(readBytes(file)).toBe(before);
  });

  it('expectedRevision=absent 但文件已在 → CONFLICT（不许拿"新建"当覆盖）', () => {
    const p = freshRoot();
    expect(applyPatch(p, seedPatch()).ok).toBe(true);
    const file = pagePathOf(p, DEFAULT_PAGE);
    const before = readBytes(file);
    const again = applyPatch(p, seedPatch());
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.code).toBe('CONFLICT');
    expect(readBytes(file)).toBe(before);
  });

  it('正确的 expectedRevision 放行（乐观并发的正常路径）', () => {
    const p = freshRoot();
    const seeded = applyPatch(p, seedPatch());
    expect(seeded.ok).toBe(true);
    if (!seeded.ok) return;
    const updated = applyPatch(p, {
      expectedRevision: seeded.value.revision,
      operations: [{ op: 'update', data: { nodes: [{ id: 'map-cli', status: 'doing', evidence: '接上了' }] } }],
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.value.revision).not.toBe(seeded.value.revision);
    const read = readPage(p);
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.value.page.nodes.find((n) => n.id === 'map-cli')?.status).toBe('doing');
  });

  it('一次事务里第 2 条被拒 → 整批不落盘，文件字节不变（拒绝不留半成品）', () => {
    const p = freshRoot();
    expect(applyPatch(p, seedPatch()).ok).toBe(true);
    const file = pagePathOf(p, DEFAULT_PAGE);
    const before = readBytes(file);
    const mixed = applyPatch(p, {
      operations: [
        { op: 'update', data: { nodes: [{ id: 'map-cli', status: 'blocked' }] } },
        { op: 'declare', data: { nodes: [{ id: 'map-types', label: '撞名', layer: 'core' }] } },
      ],
    });
    expect(mixed.ok).toBe(false);
    if (!mixed.ok) {
      expect(mixed.error.code).toBe('REFUSED');
      expect(mixed.error.details).toMatchObject({ opIndex: 1 });
    }
    expect(readBytes(file)).toBe(before);
  });

  it('页还不存在就 update/remove → NOT_FOUND：不 REFUSED，也绝不凭空建出一个空页', () => {
    const p = freshRoot();
    const upd = applyPatch(p, {
      page: 'ghost',
      expectedRevision: 'absent',
      operations: [{ op: 'update', data: { nodes: [{ id: 'n1', status: 'done' }] } }],
    });
    expect(upd.ok).toBe(false);
    if (!upd.ok) {
      expect(upd.error.code).toBe('NOT_FOUND');
      expect(upd.error.hint).toContain('declare');
    }
    // 空片段最阴：它在空页上是"无操作"，若不拦就会**建出一个空页**——"我没要建页"却多了个文件
    const noop = applyPatch(p, {
      page: 'ghost',
      expectedRevision: 'absent',
      operations: [{ op: 'update', data: {} }],
    });
    expect(noop.ok).toBe(false);
    if (!noop.ok) expect(noop.error.code).toBe('NOT_FOUND');
    expect(fs.existsSync(pagePathOf(p, 'ghost'))).toBe(false);

    // 同一批里先 declare 建页、再 update 改它：正当用法，必须放行
    const mixed = applyPatch(p, {
      page: 'ghost',
      expectedRevision: 'absent',
      operations: [
        {
          op: 'declare',
          data: {
            layers: [{ id: 'core', name: '内核', rank: 0 }],
            nodes: [{ id: 'n1', label: 'N', layer: 'core' }],
          },
        },
        { op: 'update', data: { nodes: [{ id: 'n1', status: 'doing' }] } },
      ],
    });
    expect(mixed.ok).toBe(true);
    if (mixed.ok) expect(mixed.value.page.nodes[0]!.status).toBe('doing');
  });

  it('update/remove 找不到目标 → NOT_FOUND；已存在再 declare 仍是 REFUSED（两码不许混）', () => {
    const p = freshRoot();
    expect(applyPatch(p, seedPatch()).ok).toBe(true);
    const upd = applyPatch(p, { operations: [{ op: 'update', data: { nodes: [{ id: 'ghost', status: 'done' }] } }] });
    expect(upd.ok).toBe(false);
    if (!upd.ok) expect(upd.error.code).toBe('NOT_FOUND');
    const rm = applyPatch(p, { operations: [{ op: 'remove', data: { nodes: [{ id: 'ghost' }] } }] });
    expect(rm.ok).toBe(false);
    if (!rm.ok) expect(rm.error.code).toBe('NOT_FOUND');
    const rmLayer = applyPatch(p, { operations: [{ op: 'remove', data: { layers: [{ id: 'ghost' }] } }] });
    expect(rmLayer.ok).toBe(false);
    if (!rmLayer.ok) expect(rmLayer.error.code).toBe('NOT_FOUND');
    const dup = applyPatch(p, {
      operations: [{ op: 'declare', data: { nodes: [{ id: 'map-cli', label: '撞名', layer: 'app' }] } }],
    });
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.error.code).toBe('REFUSED');
    // 删有成员的层仍然是被拒绝（不变式），不是"不存在"
    const occupied = applyPatch(p, { operations: [{ op: 'remove', data: { layers: [{ id: 'core' }] } }] });
    expect(occupied.ok).toBe(false);
    if (!occupied.ok) expect(occupied.error.code).toBe('REFUSED');
  });

  it('信封：0 条 / 101 条 / 未知键 / 空 expectedRevision 都是 INVALID_ARGUMENT', () => {
    const p = freshRoot();
    const zero = applyPatch(p, { operations: [] });
    expect(zero.ok).toBe(false);
    if (!zero.ok) expect(zero.error.code).toBe('INVALID_ARGUMENT');

    const many = Array.from({ length: 101 }, () => ({ op: 'update' as const, data: {} }));
    const tooMany = applyPatch(p, { operations: many });
    expect(tooMany.ok).toBe(false);
    if (!tooMany.ok) expect(tooMany.error.code).toBe('INVALID_ARGUMENT');

    const unknownKey = applyPatch(p, { operations: seedPatch().operations, oops: 1 } as unknown as MapPatch);
    expect(unknownKey.ok).toBe(false);
    if (!unknownKey.ok) expect(unknownKey.error.message).toContain('未知字段');

    const emptyRev = applyPatch(p, { expectedRevision: '', operations: seedPatch().operations });
    expect(emptyRev.ok).toBe(false);
    if (!emptyRev.ok) expect(emptyRev.error.code).toBe('INVALID_ARGUMENT');
  });

  it('坏文件不会被"当作空页重写"：读不出来就拒绝，字节不变', () => {
    const p = freshRoot();
    const dir = mapDirOf(p);
    fs.mkdirSync(dir, { recursive: true });
    const file = pagePathOf(p, DEFAULT_PAGE);
    fs.writeFileSync(file, '{"version": 1, "title": ', 'utf8');
    const before = readBytes(file);
    const got = applyPatch(p, {
      operations: [{ op: 'declare', data: { layers: [{ id: 'core', name: '内核', rank: 0 }] } }],
    });
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.error.code).toBe('INVALID_STORE');
    expect(readBytes(file)).toBe(before);
  });

  it('内容一字未变时不重写（"跑两次无变化"在时间戳上也是真的）', () => {
    const p = freshRoot();
    expect(applyPatch(p, seedPatch()).ok).toBe(true);
    const file = pagePathOf(p, DEFAULT_PAGE);
    const stBefore = fs.statSync(file);
    const before = readBytes(file);
    const again = applyPatch(p, { operations: [{ op: 'update', data: { nodes: [{ id: 'map-cli', status: 'todo' }] } }] });
    expect(again.ok).toBe(true);
    expect(readBytes(file)).toBe(before);
    expect(fs.statSync(file).mtimeMs).toBe(stBefore.mtimeMs);
  });
});

describe('[T1] 严格解析：类型不对即拒，绝不静默丢字段', () => {
  const cases: Array<[string, (raw: Record<string, unknown>) => void, string]> = [
    ['nodes 不是数组', (raw) => (raw['nodes'] = { id: 'a' }), '数组'],
    ['layers 缺失', (raw) => delete raw['layers'], '缺失'],
    ['version 不是 1', (raw) => (raw['version'] = 2), 'version'],
    ['根上有未知键', (raw) => (raw['extra'] = true), '未知字段'],
    ['rank 是字符串', (raw) => ((raw['layers'] as Array<Record<string, unknown>>)[0]!['rank'] = '0'), '必须是数字'],
    ['rank 越界', (raw) => ((raw['layers'] as Array<Record<string, unknown>>)[0]!['rank'] = 100), 'rank'],
    ['status 不在词表', (raw) => ((raw['nodes'] as Array<Record<string, unknown>>)[0]!['status'] = 'planned'), 'status'],
    ['status 缺失', (raw) => delete (raw['nodes'] as Array<Record<string, unknown>>)[0]!['status'], 'status'],
    ['label 是数字', (raw) => ((raw['nodes'] as Array<Record<string, unknown>>)[0]!['label'] = 7), '必须是字符串'],
    ['节点未知字段', (raw) => ((raw['nodes'] as Array<Record<string, unknown>>)[0]!['submap'] = 'child'), '未知字段'],
    ['边指向不存在的节点', (raw) => ((raw['edges'] as Array<Record<string, unknown>>)[0]!['to'] = 'ghost'), '不存在'],
    ['同层边', (raw) => ((raw['edges'] as Array<Record<string, unknown>>)[0]!['from'] = 'map-types'), '同层边'],
  ];

  it('手改坏的文件一律 INVALID_STORE（形状错与结构错都算"数据坏"）', () => {
    for (const [name, mutate, needle] of cases) {
      const p = freshRoot();
      expect(applyPatch(p, seedPatch()).ok).toBe(true);
      const file = pagePathOf(p, DEFAULT_PAGE);
      const raw = JSON.parse(readBytes(file)) as Record<string, unknown>;
      mutate(raw);
      fs.writeFileSync(file, JSON.stringify(raw, null, 2) + '\n', 'utf8');
      const got = readPage(p);
      expect(got.ok, name).toBe(false);
      if (!got.ok) {
        expect(got.error.code, name).toBe('INVALID_STORE');
        expect(got.error.message, name).toContain(needle);
      }
    }
  });

  it('JSON 语法错也是 INVALID_STORE（不是抛异常）', () => {
    const p = freshRoot();
    fs.mkdirSync(mapDirOf(p), { recursive: true });
    fs.writeFileSync(pagePathOf(p, DEFAULT_PAGE), '﻿{ "version": 1, ', 'utf8');
    const got = readPage(p);
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.error.code).toBe('INVALID_STORE');
  });

  it('BOM 被剥掉（记事本手改过的文件不该读成"你的地图坏了"）；缩进/键序变了 revision 不变', () => {
    const p = freshRoot();
    expect(applyPatch(p, seedPatch()).ok).toBe(true);
    const file = pagePathOf(p, DEFAULT_PAGE);
    const parsed = JSON.parse(readBytes(file)) as Record<string, unknown>;
    // 逻辑内容一字不改，只是换成"人手动格式化"的样子：键序颠倒、缩进 4 格、带 BOM
    const reordered: Record<string, unknown> = { nodes: parsed['nodes'], title: parsed['title'], version: parsed['version'] };
    for (const k of ['edges', 'lanes', 'groups', 'layers']) reordered[k] = parsed[k];
    fs.writeFileSync(file, '﻿' + JSON.stringify(reordered, null, 4), 'utf8');

    const read = readPage(p);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const canonical = JSON.parse(serializePage(read.value.page)) as Record<string, unknown>;
    expect(read.value.revision).toBe(revisionOf(read.value.page));
    expect(canonical['title']).toBe('种子图');
  });
});

describe('[T1] 原子写与锁', () => {
  it('并发：锁被持有时 applyPatch 返回 BUSY（不是异常），且不动别人的锁', async () => {
    const p = freshRoot();
    expect(applyPatch(p, seedPatch()).ok).toBe(true);
    const file = pagePathOf(p, DEFAULT_PAGE);
    const before = readBytes(file);
    const lock = lockPathOf(file);
    fs.writeFileSync(lock, '999999', 'utf8');
    const got = applyPatch(p, { operations: [{ op: 'update', data: { nodes: [{ id: 'map-cli', status: 'done' }] } }] });
    expect(got.ok).toBe(false);
    if (!got.ok) {
      expect(got.error.code).toBe('BUSY');
      // 抢不到不该抛，也不该假成功
      expect(got.error.hint).toBeTruthy();
    }
    expect(readBytes(file)).toBe(before);
    expect(fs.existsSync(lock)).toBe(true); // 别人的锁还归别人
    fs.rmSync(lock, { force: true });
    // 锁放掉之后同一批操作就能过（说明 BUSY 只是"稍后重试"）
    const retry = applyPatch(p, { operations: [{ op: 'update', data: { nodes: [{ id: 'map-cli', status: 'done' }] } }] });
    expect(retry.ok).toBe(true);
    expect(fs.existsSync(lock)).toBe(false); // 正常路径释放干净
  });

  it('僵尸锁兜底：超过 10s 的锁按僵尸清掉，写入照常成功', () => {
    const p = freshRoot();
    expect(applyPatch(p, seedPatch()).ok).toBe(true);
    const file = pagePathOf(p, DEFAULT_PAGE);
    const lock = lockPathOf(file);
    fs.writeFileSync(lock, '1', 'utf8');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old);
    const got = applyPatch(p, { operations: [{ op: 'update', data: { nodes: [{ id: 'map-cli', status: 'done' }] } }] });
    expect(got.ok).toBe(true);
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('withMapLock 透出临界区结论；临界区真抛了也要把锁放掉（守护路径按 §5 自己 try/catch）', () => {
    const p = freshRoot();
    const file = pagePathOf(p, 'extra');
    const inner = withMapLock(file, () => ({ ok: false as const, error: { code: 'REFUSED' as const, message: '里面拒了' } }));
    expect(inner.ok).toBe(false);
    if (!inner.ok) expect(inner.error.message).toBe('里面拒了');
    expect(fs.existsSync(lockPathOf(file))).toBe(false);

    // 临界区里真抛出（= bug，不是数据问题）：异常照旧往上走，但**锁必须已经放掉**，
    // 否则一次 bug 会变成"这个页永久 BUSY"，比 bug 本身更难查
    expect(() =>
      withMapLock(file, () => {
        throw new Error('临界区里的意外');
      }),
    ).toThrow('临界区里的意外');
    expect(fs.existsSync(lockPathOf(file))).toBe(false);
  });

  it('原子写：目标是个目录 → SAVE_FAILED（可重试码），且不留 *.tmp', () => {
    const p = freshRoot();
    const dir = path.join(p, 'occupied');
    fs.mkdirSync(dir, { recursive: true });
    const got = writeFileAtomic(dir, 'x');
    expect(got.ok).toBe(false);
    if (!got.ok) {
      expect(got.error.code).toBe('SAVE_FAILED');
      expect(got.error.details).toMatchObject({ path: dir });
    }
    expect(tmpFilesIn(p)).toEqual([]);
  });

  it('原子写：父目录不存在会建出来；成功后没有 temp 残留', () => {
    const p = freshRoot();
    const file = path.join(p, 'a', 'b', 'map.json');
    const got = writeFileAtomic(file, '{"ok":true}');
    expect(got.ok).toBe(true);
    expect(readBytes(file)).toBe('{"ok":true}');
    expect(tmpFilesIn(path.join(p, 'a', 'b'))).toEqual([]);
  });

  it('落盘失败时旧内容一字不改（原子写的后置条件）', () => {
    const p = freshRoot();
    const file = path.join(p, 'map.json');
    expect(writeFileAtomic(file, 'v1').ok).toBe(true);
    const got = writeFileAtomic(file + path.sep + 'sub', 'v2');
    expect(got.ok).toBe(false);
    expect(readBytes(file)).toBe('v1');
  });
});

describe('[T1] patch 信封（zod）', () => {
  it('parseMapPatch：合法信封通过，未知键/空数组/坏 op 都是 INVALID_ARGUMENT', () => {
    const good = parseMapPatch({ page: 'core', expectedRevision: 'absent', operations: [{ op: 'declare', data: {} }] });
    expect(good.ok).toBe(true);
    for (const bad of [
      { operations: [] },
      { operations: [{ op: 'upsert', data: {} }] },
      { operations: [{ op: 'declare', data: [] }] },
      { operations: [{ op: 'declare', data: {} }], page: '../evil' },
      { operations: [{ op: 'declare', data: {} }], extra: 1 },
      'not an object',
    ]) {
      const got = parseMapPatch(bad);
      expect(got.ok, JSON.stringify(bad)).toBe(false);
      if (!got.ok) {
        expect(got.error.code).toBe('INVALID_ARGUMENT');
        expect(got.error.message).toBeTruthy();
      }
    }
  });

  it('parsePatchText：JSON 语法错是 INVALID_ARGUMENT（绝不抛）；BOM 容忍', () => {
    const bad = parsePatchText('{ oops');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe('INVALID_ARGUMENT');
    const bom = parsePatchText('﻿' + JSON.stringify({ operations: [{ op: 'declare', data: {} }] }));
    expect(bom.ok).toBe(true);
  });

  it('信封校验与 applyPatch 一致：parse 出来的东西一定能喂给 applyPatch', () => {
    const p = freshRoot();
    const parsed = parsePatchText(JSON.stringify(seedPatch()));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const applied = applyPatch(p, parsed.value);
    expect(applied.ok).toBe(true);
  });
});
