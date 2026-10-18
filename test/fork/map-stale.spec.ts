// [T3] 地图 · 源码失效对账（契约 §3 checkSources / §6 缓存与 8MiB 边界）。
//
// 真夹具（真临时目录、真文件、真哈希）：这里要证明的正是「磁盘上的字节 vs 地图里的指纹」，
// 把 fs mock 掉等于把要证明的东西假设掉了。
//
// 双向断言：该 unchanged 的必须 unchanged，该 changed/unknown 的一个不漏——
// 只测单向（"变了能发现"）会漏掉最坏的一种：**永远说 changed**（那等于没有对账）。
import { describe, beforeAll, afterAll, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serializePage, type MapEdge, type MapNode, type MapPage } from '../../src/map/index.js';
import { HASH_CACHE_NAME, HASH_MAX_BYTES, checkSources, hashCachePath, resolveInsideRoot } from '../../src/map/stale.js';

const sha = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

let tmp = '';
let seq = 0;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'srelay-stale-'));
});
afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** 每个用例一个独立的项目根：并发的用例不许互相看见对方的文件与缓存。 */
function freshRoot(): string {
  seq += 1;
  const root = path.join(tmp, 'p' + String(seq));
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function put(root: string, rel: string, data: string | Buffer): string {
  const abs = path.join(root, rel.split('/').join(path.sep));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, data);
  return abs;
}

function makePage(nodes: MapNode[], edges: MapEdge[] = [], context?: MapPage['context']): MapPage {
  return {
    id: 'map',
    title: 'T3 对账夹具',
    layers: [
      { id: 'core', name: '内核', rank: 0 },
      { id: 'app', name: '应用', rank: 1 },
    ],
    groups: [],
    lanes: [],
    nodes,
    edges,
    ...(context !== undefined ? { context } : {}),
  };
}

/** 落一份合法地图（走内核的确定性序列化：夹具与真实写入口产出同一种字节）。 */
function writeMap(root: string, page: MapPage): string {
  const dir = path.join(root, '.sessionrelay', 'map');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, page.id + '.json');
  fs.writeFileSync(file, serializePage(page), 'utf8');
  return file;
}

function cacheOf(root: string): Record<string, { mtimeMs: number; size: number; sha256: string }> {
  return JSON.parse(fs.readFileSync(hashCachePath(root), 'utf8')) as Record<string, { mtimeMs: number; size: number; sha256: string }>;
}

describe('[T3] checkSources 三态', () => {
  it('① unchanged：内容与基线一致（且 consumers 给的是入边来源）', () => {
    const root = freshRoot();
    put(root, 'src/a.ts', 'AAA');
    writeMap(
      root,
      makePage([
        { id: 'proof', label: '有指纹的节点', layer: 'app', status: 'done', sources: [{ path: 'src/a.ts', sha256: sha('AAA') }] },
        { id: 'base', label: '被依赖的节点', layer: 'core', status: 'doing' },
      ], [{ from: 'proof', to: 'base', label: 'uses' }]),
    );
    const got = checkSources(root);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.value.page).toBe('map');
    expect(got.value.nodes.map((n) => n.id)).toEqual(['base', 'proof']);
    expect(got.value.nodes[0]).toEqual({ id: 'base', label: '被依赖的节点', state: 'unchanged', changed: [], unknown: [], consumers: ['proof'] });
    expect(got.value.nodes[1]).toEqual({ id: 'proof', label: '有指纹的节点', state: 'unchanged', changed: [], unknown: [], consumers: [] });
  });

  it('② changed：内容与基线不符', () => {
    const root = freshRoot();
    put(root, 'src/a.ts', 'AAA');
    writeMap(root, makePage([{ id: 'n1', label: 'n1', layer: 'core', status: 'done', sources: [{ path: 'src/a.ts', sha256: sha('AAA') }] }]));
    put(root, 'src/a.ts', 'AAAA');
    const got = checkSources(root);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.value.nodes[0]?.state).toBe('changed');
    expect(got.value.nodes[0]?.changed).toEqual(['src/a.ts']);
    expect(got.value.nodes[0]?.unknown).toEqual([]);
  });

  it('③ changed：有基线但文件没了（东西不在了，就是变了）', () => {
    const root = freshRoot();
    writeMap(root, makePage([{ id: 'n1', label: 'n1', layer: 'core', status: 'done', sources: [{ path: 'src/gone.ts', sha256: sha('曾在') }] }]));
    const got = checkSources(root);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.value.nodes[0]?.state).toBe('changed');
    expect(got.value.nodes[0]?.changed).toEqual(['src/gone.ts']);
  });

  it('④ unknown：无基线（没 sha256 的 source 永远算不出来，但不许说成 changed）', () => {
    const root = freshRoot();
    put(root, 'src/a.ts', 'AAA');
    writeMap(
      root,
      makePage([
        { id: 'n1', label: '无基线', layer: 'core', status: 'done', sources: [{ path: 'src/a.ts' }] },
        { id: 'n2', label: '无 sources', layer: 'core', status: 'done' },
        { id: 'n3', label: '空 sources', layer: 'core', status: 'done', sources: [] },
      ]),
    );
    const got = checkSources(root);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.value.nodes[0]?.state).toBe('unknown');
    expect(got.value.nodes[0]?.unknown).toEqual(['src/a.ts']);
    expect(got.value.nodes[0]?.changed).toEqual([]);
    // 没有任何 source 声明的节点算 unchanged：它没做证据声明，也就无从"对不上账"。
    expect(got.value.nodes[1]?.state).toBe('unchanged');
    expect(got.value.nodes[2]?.state).toBe('unchanged');
  });

  it('⑤ unknown：项目外路径（判据可测 + 地图解析器同步拒绝）', () => {
    const root = freshRoot();
    // 判据本身：项目内 / 穿越 / 绝对 / 盘符
    expect(resolveInsideRoot(root, 'src/a.ts')).toEqual({ abs: path.join(root, 'src', 'a.ts'), inside: true, rel: 'src/a.ts' });
    expect(resolveInsideRoot(root, 'a/../../b.ts').inside).toBe(false);
    expect(resolveInsideRoot(root, '../outside.txt').inside).toBe(false);
    expect(resolveInsideRoot(root, '/etc/passwd').inside).toBe(false);
    expect(resolveInsideRoot(root, 'C:/Windows/system32/x.txt').inside).toBe(false);
    expect(resolveInsideRoot(root, '').inside).toBe(false);
    // 一致性：合法地图文件根本写不进这种路径（解析器在边界就拦掉了），
    // 所以上面那条判据是"溜进来时"的最后一道防线，而不是主防线。
    put(root, 'outside.txt', 'X');
    writeMap(root, makePage([{ id: 'n1', label: 'n1', layer: 'core', status: 'done', sources: [{ path: '../outside.txt', sha256: sha('X') }] }]));
    const got = checkSources(root);
    expect(got.ok).toBe(false);
    if (got.ok) return;
    expect(got.error.code).toBe('INVALID_STORE');
  });

  it('⑥ 8MiB 边界：刚好 8MiB 照常算，超过 8MiB 记 unknown', () => {
    const root = freshRoot();
    const exact = Buffer.alloc(HASH_MAX_BYTES, 0x61);
    put(root, 'big/exact.bin', exact);
    put(root, 'big/over.bin', Buffer.concat([exact, Buffer.from('x')]));
    writeMap(
      root,
      makePage([
        { id: 'exact', label: '刚好 8MiB', layer: 'core', status: 'done', sources: [{ path: 'big/exact.bin', sha256: sha(exact) }] },
        { id: 'over', label: '超过 8MiB', layer: 'core', status: 'done', sources: [{ path: 'big/over.bin', sha256: sha(exact) }] },
      ]),
    );
    const got = checkSources(root);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.value.nodes.find((n) => n.id === 'exact')?.state).toBe('unchanged');
    expect(got.value.nodes.find((n) => n.id === 'over')?.state).toBe('unknown');
    expect(got.value.nodes.find((n) => n.id === 'over')?.unknown).toEqual(['big/over.bin']);
  });

  it('⑦ ids：只报选中的节点（空的 ids = 不过滤）', () => {
    const root = freshRoot();
    put(root, 'src/a.ts', 'AAA');
    writeMap(
      root,
      makePage([
        { id: 'n1', label: 'n1', layer: 'core', status: 'done', sources: [{ path: 'src/a.ts', sha256: sha('AAA') }] },
        { id: 'n2', label: 'n2', layer: 'core', status: 'todo' },
      ]),
    );
    const one = checkSources(root, 'map', ['n2']);
    expect(one.ok).toBe(true);
    if (one.ok) expect(one.value.nodes.map((n) => n.id)).toEqual(['n2']);
    const all = checkSources(root, 'map', []);
    expect(all.ok).toBe(true);
    if (all.ok) expect(all.value.nodes.map((n) => n.id)).toEqual(['n1', 'n2']);
  });
});
describe('[T3] 缓存（§6 开销预算）', () => {
  it('⑧ 命中就不重算、size/mtime 变了才重算，且都回填缓存', () => {
    const root = freshRoot();
    const abs = put(root, 'src/a.ts', 'AAA');
    const node = (hash: string): MapNode => ({ id: 'n1', label: 'n1', layer: 'core', status: 'done', sources: [{ path: 'src/a.ts', sha256: hash }] });
    writeMap(root, makePage([node(sha('AAA'))]));

    const first = checkSources(root);
    expect(first.ok).toBe(true);
    const st1 = fs.statSync(abs);
    expect(cacheOf(root)['src/a.ts']).toEqual({ mtimeMs: st1.mtimeMs, size: st1.size, sha256: sha('AAA') });

    // 篡改缓存里的哈希（mtime/size 原样）：命中缓存 → 拿缓存值比对 → changed。
    // 这一步正是"真的走了缓存"的证据：若每次重算，这里仍然会是 unchanged。
    fs.writeFileSync(hashCachePath(root), JSON.stringify({ 'src/a.ts': { mtimeMs: st1.mtimeMs, size: st1.size, sha256: 'f'.repeat(64) } }), 'utf8');
    const second = checkSources(root);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.value.nodes[0]?.state).toBe('changed');

    // 内容 + size 都变了：必须重算，并把被篡改的缓存覆盖回真哈希
    put(root, 'src/a.ts', 'AAA-changed');
    const third = checkSources(root);
    expect(third.ok).toBe(true);
    if (third.ok) expect(third.value.nodes[0]?.state).toBe('changed');
    expect(cacheOf(root)['src/a.ts']?.sha256).toBe(sha('AAA-changed'));

    // 只动 mtime（内容不变）：缓存不命中 → 重算 → 基线跟上后仍是 unchanged，且缓存 mtime 被更新
    fs.utimesSync(abs, new Date(), new Date(Date.now() + 60000));
    const st4 = fs.statSync(abs);
    expect(st4.mtimeMs).not.toBe(cacheOf(root)['src/a.ts']?.mtimeMs);
    writeMap(root, makePage([node(sha('AAA-changed'))]));
    const fourth = checkSources(root);
    expect(fourth.ok).toBe(true);
    if (fourth.ok) expect(fourth.value.nodes[0]?.state).toBe('unchanged');
    expect(cacheOf(root)['src/a.ts']?.mtimeMs).toBe(st4.mtimeMs);
  });

  it('⑨ 只读：地图文件字节不变，目录里只多出 .hash-cache.json', () => {
    const root = freshRoot();
    put(root, 'src/a.ts', 'AAA');
    const file = writeMap(root, makePage([{ id: 'n1', label: 'n1', layer: 'core', status: 'done', sources: [{ path: 'src/a.ts', sha256: sha('AAA') }] }]));
    const dir = path.dirname(file);
    const bytesBefore = fs.readFileSync(file);
    const dirBefore = fs.readdirSync(dir).sort();
    expect(dirBefore).toEqual(['map.json']);

    checkSources(root);
    checkSources(root);

    expect(fs.readFileSync(file).equals(bytesBefore)).toBe(true);
    expect(fs.readdirSync(dir).sort()).toEqual([...dirBefore, HASH_CACHE_NAME].sort());
  });

  it('⑩ 烂缓存不许把对账拖挂（缓存是派生物，不是数据源）', () => {
    const root = freshRoot();
    put(root, 'src/a.ts', 'AAA');
    writeMap(root, makePage([{ id: 'n1', label: 'n1', layer: 'core', status: 'done', sources: [{ path: 'src/a.ts', sha256: sha('AAA') }] }]));
    fs.writeFileSync(hashCachePath(root), '这不是 JSON{{{', 'utf8');
    const got = checkSources(root);
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.value.nodes[0]?.state).toBe('unchanged');
    fs.writeFileSync(hashCachePath(root), JSON.stringify({ 'src/a.ts': { mtimeMs: 'x', size: null, sha256: 7 }, 'other.ts': null }), 'utf8');
    const again = checkSources(root);
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.value.nodes[0]?.state).toBe('unchanged');
  });
});

describe('[T3] checkSources 不抛（预期失败是返回值）', () => {
  it('⑪ 没地图 / 坏页 / 页 id 非法 / 根不存在 / 根为空', () => {
    const root = freshRoot();
    const none = checkSources(root);
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.error.code).toBe('NOT_FOUND');

    const dir = path.join(root, '.sessionrelay', 'map');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'map.json'), '{"version":1,"title":"x","layers":[],"nodes":[],"edges":[],"bogus":1}', 'utf8');
    const broken = checkSources(root);
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.error.code).toBe('INVALID_STORE');

    const badId = checkSources(root, '../escape');
    expect(badId.ok).toBe(false);
    if (!badId.ok) expect(badId.error.code).toBe('INVALID_ARGUMENT');

    const ghost = checkSources(path.join(tmp, 'no-such-project-dir'));
    expect(ghost.ok).toBe(false);
    if (!ghost.ok) expect(ghost.error.code).toBe('NOT_FOUND');

    const empty = checkSources('');
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error.code).toBe('INVALID_ARGUMENT');
  });
});
