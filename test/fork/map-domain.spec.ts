// [T1] 地图内核 · 领域不变式：契约 §2 的七条**逐条反例** + §4.1 片段语义。
//
// 为什么逐条反例而不是只测正例：这一层的全部价值就是"结构坏了就拒"。正例只能证明它能跑，
// 反例才能证明它拦得住——而看板是拿地图当唯一可信来源的，拦不住就等于把假结构画给人看。
//
// 每条反例都断言三件事：ok === false、错误码 REFUSED、以及**关键那句文案**（人要照着它去改）。
import { describe, expect, it } from 'vitest';
import {
  applyMapOp,
  declareFragment,
  removeFragment,
  updateFragment,
  validatePage,
} from '../../src/map/domain/ops.js';
import { parsePageText, revisionOf, serializePage } from '../../src/map/store/format.js';
import {
  emptyPage,
  mapIdError,
  mapRankError,
  mapStatusError,
  type MapPage,
  type MapStatus,
} from '../../src/map/domain/types.js';
import { contextError, sourcesError } from '../../src/map/domain/context.js';
import {
  MAP_MODULE,
  STATUS_GLYPHS,
  isBoardStatusCell,
  kanbanCells,
  kanbanStatusCell,
} from '../../src/map/semantics/vocabulary.js';

/** 一份**合法**的底图：每条反例都只在它的副本上破坏一处，才能单独定位到那一条不变式。 */
function base(): MapPage {
  return {
    id: 'map',
    title: '地图内核',
    layers: [
      { id: 'core', name: '内核', rank: 0 },
      { id: 'app', name: '应用', rank: 1 },
    ],
    groups: [{ id: 'store', label: '存储', layer: 'core' }],
    lanes: [
      { id: 'agent', label: 'agent' },
      { id: 'human', label: '人' },
    ],
    nodes: [
      { id: 'map-types', label: '类型', layer: 'core', status: 'todo' },
      { id: 'map-store', label: '地图存储', layer: 'core', status: 'doing', group: 'store', lane: 'agent' },
      { id: 'map-cli', label: 'CLI', layer: 'app', status: 'done', evidence: 'vitest 12/12 通过' },
    ],
    edges: [{ from: 'map-cli', to: 'map-store', label: 'uses' }],
  };
}

function broken(mutate: (page: MapPage) => void): MapPage {
  const page = base();
  mutate(page);
  return page;
}

/** 断言被拒，并返回那句文案（断言"拦得住"不够，还要断言"说清了怎么改"）。 */
function refusal(page: MapPage): string {
  const got = validatePage(page);
  expect(got.ok).toBe(false);
  if (got.ok) return ''; // 不可达：上一行已经断言失败
  expect(got.error.code).toBe('REFUSED');
  return got.error.message;
}

describe('[T1] §2 不变式逐条反例', () => {
  it('⓪ 正例先过关：合法图必须通过（否则后面的反例都无意义）', () => {
    const got = validatePage(base());
    expect(got.ok).toBe(true);
  });

  it('① id 唯一（节点与分组共用一个命名空间）+ id 语法', () => {
    expect(refusal(broken((p) => p.nodes.push({ id: 'map-types', label: '重复', layer: 'core', status: 'todo' })))).toContain(
      '节点 id 重复',
    );
    expect(refusal(broken((p) => p.groups.push({ id: 'store', label: '重复分组', layer: 'core' })))).toContain('分组 id 重复');
    expect(refusal(broken((p) => p.groups.push({ id: 'map-types', label: '撞名', layer: 'core' })))).toContain(
      '共用一个 id 命名空间',
    );
    expect(refusal(broken((p) => (p.nodes[0]!.id = 'Bad_ID')))).toContain('id 语法');
    expect(refusal(broken((p) => p.layers.push({ id: 'core', name: '重复层', rank: 2 })))).toContain('层 id 重复');
    expect(mapIdError('map-store')).toBeUndefined();
    expect(mapIdError('')).toBeDefined();
    expect(mapIdError('a'.repeat(65))).toBeDefined();
  });

  it('② 每个节点必须属于一个已存在的层', () => {
    expect(refusal(broken((p) => (p.nodes[0]!.layer = 'ghost')))).toContain('不存在的层');
  });

  it('③ 边只能严格向下：同层边、上行边、自环、重边一律拒', () => {
    expect(
      refusal(
        broken((p) => {
          p.nodes.push({ id: 'map-ops', label: '操作', layer: 'core', status: 'todo' });
          p.edges.push({ from: 'map-ops', to: 'map-types' });
        }),
      ),
    ).toContain('同层边');
    expect(refusal(broken((p) => p.edges.push({ from: 'map-types', to: 'map-cli' })))).toContain('不是严格向下');
    expect(refusal(broken((p) => p.edges.push({ from: 'map-types', to: 'map-types' })))).toContain('自环');
    expect(refusal(broken((p) => p.edges.push({ from: 'map-cli', to: 'map-store' })))).toContain('重复');
    expect(refusal(broken((p) => p.edges.push({ from: 'map-cli', to: 'ghost' })))).toContain('不存在');
  });

  it('④ group 必须存在且与其成员同层；node.group / node.lane 引用必须存在', () => {
    expect(refusal(broken((p) => (p.nodes[1]!.group = 'ghost')))).toContain('不存在的分组');
    expect(refusal(broken((p) => (p.nodes[2]!.group = 'store')))).toContain('分组只在同一层内聚合');
    expect(refusal(broken((p) => (p.nodes[0]!.lane = 'ghost')))).toContain('不存在的泳道');
    expect(refusal(broken((p) => p.groups.push({ id: 'tool', label: '工具', layer: 'ghost' })))).toContain('不存在的层');
  });

  it('⑤ status ∈ 闭合词表（mellos 的 planned / in-progress 都要被拒）', () => {
    expect(refusal(broken((p) => (p.nodes[0]!.status = 'in-progress' as MapStatus)))).toContain('不在闭合词表里');
    expect(refusal(broken((p) => (p.nodes[0]!.status = 'planned' as MapStatus)))).toContain('不在闭合词表里');
    expect(mapStatusError('doing')).toBeUndefined();
    expect(mapStatusError('done')).toBeUndefined();
    expect(mapStatusError('DONE')).toBeDefined();
    expect(mapStatusError(1)).toBeDefined();
  });

  it('⑥ rank 是 0..99 的整数；文本拒绝控制字符与超长', () => {
    expect(refusal(broken((p) => (p.layers[0]!.rank = -1)))).toContain('rank');
    expect(refusal(broken((p) => (p.layers[0]!.rank = 100)))).toContain('rank');
    expect(refusal(broken((p) => (p.layers[0]!.rank = 1.5)))).toContain('整数');
    expect(refusal(broken((p) => (p.layers[0]!.rank = Number.NaN)))).toContain('整数');
    expect(mapRankError(0)).toBeUndefined();
    expect(mapRankError(99)).toBeUndefined();
    expect(refusal(broken((p) => (p.nodes[0]!.label = 'a'.repeat(121))))).toContain('超长');
    expect(refusal(broken((p) => (p.nodes[0]!.label = '坏\u0007字符')))).toContain('控制字符');
    expect(refusal(broken((p) => (p.nodes[0]!.evidence = 'e'.repeat(2001))))).toContain('超长');
    expect(refusal(broken((p) => (p.title = 'T'.repeat(121))))).toContain('超长');
  });

  it('⑦ 未知字段一律拒绝（绝不静默丢弃：写回会毁掉手改的文件）', () => {
    const declared = applyMapOp(base(), {
      op: 'declare',
      data: { nodes: [{ id: 'n1', label: 'N', layer: 'core', submap: 'child' }] },
    });
    expect(declared.ok).toBe(false);
    if (!declared.ok) {
      expect(declared.error.code).toBe('REFUSED');
      expect(declared.error.message).toContain('未知字段');
      expect(declared.error.message).toContain('submap');
    }
    // 片段自己的键也不许拼错（laneOrder 写成 laneorder 是最容易发生的那种）
    const typo = applyMapOp(base(), { op: 'declare', data: { laneorder: ['agent', 'human'] } });
    expect(typo.ok).toBe(false);
    if (!typo.ok) expect(typo.error.message).toContain('未知字段');
    // 文件里也一样：未知字段让整份文件读不出来
    const raw = JSON.parse(serializePage(base())) as Record<string, unknown>;
    (raw['nodes'] as Array<Record<string, unknown>>)[0]!['submap'] = 'child';
    const parsed = parsePageText(JSON.stringify(raw), 'map.json', 'map');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.code).toBe('INVALID_STORE');
      expect(parsed.error.message).toContain('未知字段');
    }
  });
});

describe('[T1] 纯操作：§4.1 片段语义', () => {
  it('declare：默认 status = todo；撞 id 拒绝而不幂等跳过', () => {
    const got = declareFragment(base(), { nodes: [{ id: 'n1', label: '新节点', layer: 'core' }] });
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.value.nodes.find((n) => n.id === 'n1')?.status).toBe('todo');
    const dup = declareFragment(base(), { nodes: [{ id: 'map-store', label: '撞名', layer: 'core' }] });
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.error.message).toContain('已存在');
  });

  it('同一批里先声明边、再声明端点：逐条不判全量，最终图校验兜底', () => {
    const first = applyMapOp(base(), { op: 'declare', data: { edges: [{ from: 'n2', to: 'n1' }] } });
    expect(first.ok).toBe(true); // 端点还不存在也允许——草案里就是这么写的
    if (!first.ok) return;
    const second = applyMapOp(first.value, {
      op: 'declare',
      data: {
        nodes: [
          { id: 'n1', label: '底', layer: 'core' },
          { id: 'n2', label: '上', layer: 'app' },
        ],
      },
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(validatePage(second.value).ok).toBe(true);
  });

  it('update：按 id 改；null 清可选字段；找不到目标 → NOT_FOUND（不是 REFUSED）', () => {
    const cleared = updateFragment(base(), { nodes: [{ id: 'map-cli', evidence: null, group: null }] });
    expect(cleared.ok).toBe(true);
    if (cleared.ok) {
      const node = cleared.value.nodes.find((n) => n.id === 'map-cli')!;
      expect('evidence' in node).toBe(false);
      expect('group' in node).toBe(false);
    }
    const missing = updateFragment(base(), { nodes: [{ id: 'ghost', status: 'done' }] });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      // "东西不在"与"被拒绝"分开两码：调用方（agent）按码分支，hint 再好也替代不了码（§4.3）
      expect(missing.error.code).toBe('NOT_FOUND');
      expect(missing.error.message).toContain('不存在');
      expect(missing.error.hint).toContain('declare');
    }
    // 必填字段给 null → 拒绝（null 只用于可选字段）
    const required = updateFragment(base(), { nodes: [{ id: 'map-cli', label: null }] });
    expect(required.ok).toBe(false);
  });

  it('update：边身份 = from+to，可用 newFrom/newTo 改端点，改到重名要拒', () => {
    const moved = updateFragment(base(), {
      edges: [{ from: 'map-cli', to: 'map-store', newTo: 'map-types', label: 'uses' }],
    });
    expect(moved.ok).toBe(true);
    if (moved.ok) expect(moved.value.edges[0]).toEqual({ from: 'map-cli', to: 'map-types', label: 'uses' });

    const two = base();
    two.edges.push({ from: 'map-cli', to: 'map-types' });
    expect(validatePage(two).ok).toBe(true);
    const clash = updateFragment(two, { edges: [{ from: 'map-cli', to: 'map-types', newTo: 'map-store' }] });
    expect(clash.ok).toBe(false);
    if (!clash.ok) expect(clash.error.message).toContain('重名');
  });

  it('remove：删节点级联删边；删有成员的层/组/泳道一律拒绝（不静默搬移）', () => {
    const removed = removeFragment(base(), { nodes: [{ id: 'map-store' }] });
    expect(removed.ok).toBe(true);
    if (removed.ok) expect(removed.value.edges).toEqual([]);

    const group = removeFragment(base(), { groups: [{ id: 'store' }] });
    expect(group.ok).toBe(false);
    if (!group.ok) expect(group.error.message).toContain('还有成员');
    const layer = removeFragment(base(), { layers: [{ id: 'core' }] });
    expect(layer.ok).toBe(false);
    if (!layer.ok) expect(layer.error.message).toContain('还有节点');
    const lane = removeFragment(base(), { lanes: [{ id: 'agent' }] });
    expect(lane.ok).toBe(false);
    if (!lane.ok) expect(lane.error.message).toContain('还有成员');
    // 空层可以删
    const emptyLayer = removeFragment(base(), { layers: [{ id: 'app' }] });
    expect(emptyLayer.ok).toBe(false); // app 里还有 map-cli
    const okLayer = removeFragment(base(), { layers: [{ id: 'app' }], nodes: [{ id: 'map-cli' }] });
    expect(okLayer.ok).toBe(true);
  });

  it('remove：选择器必须是 {id} / {from,to} 对象，裸字符串与多余键都拒', () => {
    const bare = removeFragment(base(), { nodes: ['map-store'] });
    expect(bare.ok).toBe(false);
    if (!bare.ok) expect(bare.error.message).toContain('必须是对象');
    const extra = removeFragment(base(), { nodes: [{ id: 'map-store', label: '顺手改' }] });
    expect(extra.ok).toBe(false);
    if (!extra.ok) expect(extra.error.message).toContain('未知字段');
    const missing = removeFragment(base(), { edges: [{ from: 'map-cli', to: 'map-types' }] });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.error.code).toBe('NOT_FOUND');
      expect(missing.error.message).toContain('不存在');
    }
  });

  it('laneOrder：必须是「应用本片段之后」全部泳道各一次', () => {
    const reordered = declareFragment(base(), { laneOrder: ['human', 'agent'] });
    expect(reordered.ok).toBe(true);
    if (reordered.ok) expect(reordered.value.lanes.map((l) => l.id)).toEqual(['human', 'agent']);
    const missing = declareFragment(base(), { laneOrder: ['agent'] });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.message).toContain('全部');
    const dup = declareFragment(base(), { laneOrder: ['agent', 'agent'] });
    expect(dup.ok).toBe(false);
    // 同一片段里新声明泳道 + 排序：按"应用之后"的集合判
    const withNew = declareFragment(base(), {
      lanes: [{ id: 'ci', label: 'CI' }],
      laneOrder: ['ci', 'human', 'agent'],
    });
    expect(withNew.ok).toBe(true);
    if (withNew.ok) expect(withNew.value.lanes.map((l) => l.id)).toEqual(['ci', 'human', 'agent']);
  });

  it('空片段是无操作，不是错误；未知操作名是 INVALID_ARGUMENT', () => {
    const noop = applyMapOp(base(), { op: 'update', data: {} });
    expect(noop.ok).toBe(true);
    if (noop.ok) expect(noop.value).toEqual(base());
    const bad = applyMapOp(base(), { op: 'upsert', data: {} });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe('INVALID_ARGUMENT');
    const notRecord = applyMapOp(base(), { op: 'declare', data: [] });
    expect(notRecord.ok).toBe(false);
    if (!notRecord.ok) expect(notRecord.error.code).toBe('INVALID_ARGUMENT');
  });
});

describe('[T1] 确定性序列化与 revision', () => {
  it('同一张图换个声明顺序 → 字节与 revision 都一致（正因如此 expectedRevision 才可比）', () => {
    const forward = emptyPage('map', 'T');
    const a1 = declareFragment(forward, {
      layers: [
        { id: 'core', name: '内核', rank: 0 },
        { id: 'app', name: '应用', rank: 1 },
      ],
      nodes: [
        { id: 'b', label: 'B', layer: 'app', status: 'doing' },
        { id: 'a', label: 'A', layer: 'core' },
      ],
    });
    expect(a1.ok).toBe(true);
    const backward = emptyPage('map', 'T');
    const a2 = declareFragment(backward, {
      nodes: [
        { id: 'a', label: 'A', layer: 'core' },
        { id: 'b', label: 'B', layer: 'app', status: 'doing' },
      ],
      layers: [
        { id: 'app', name: '应用', rank: 1 },
        { id: 'core', name: '内核', rank: 0 },
      ],
    });
    expect(a2.ok).toBe(true);
    if (!a1.ok || !a2.ok) return;
    expect(serializePage(a1.value)).toBe(serializePage(a2.value));
    expect(revisionOf(a1.value)).toBe(revisionOf(a2.value));
  });

  /** 规范化后的数组顺序（层按 rank、组/节点按 id、边按 from,to）：文件里存的就是这个顺序。 */
  function canonical(page: MapPage): MapPage {
    const by = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    return {
      ...page,
      layers: [...page.layers].sort((a, b) => a.rank - b.rank || by(a.id, b.id)),
      groups: [...page.groups].sort((a, b) => by(a.id, b.id)),
      nodes: [...page.nodes].sort((a, b) => by(a.id, b.id)),
      edges: [...page.edges].sort((a, b) => by(a.from, b.from) || by(a.to, b.to)),
    };
  }

  it('往返：serialize → parse 得到同一张图（数组按规范化顺序）；再 serialize 字节不变', () => {
    const text = serializePage(base());
    const parsed = parsePageText(text, 'map.json', 'map');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual(canonical(base()));
    expect(serializePage(parsed.value)).toBe(text);
  });

  it('泳道顺序是内容：顺序不同 → revision 不同（它由 laneOrder 显式控制）', () => {
    const a = base();
    const b = base();
    b.lanes = [{ id: 'human', label: '人' }, { id: 'agent', label: 'agent' }];
    expect(validatePage(a).ok).toBe(true);
    expect(validatePage(b).ok).toBe(true);
    expect(revisionOf(a)).not.toBe(revisionOf(b));
  });
});

describe('[T1] 状态 → 看板字形（§5 唯一一份）', () => {
  it('五种状态的字形与文案', () => {
    expect(STATUS_GLYPHS).toEqual({ todo: '⬜', doing: '🔄', blocked: '⛔', done: '✅', regressed: '⛔' });
    expect(kanbanStatusCell('todo')).toBe('⬜ 待办');
    expect(kanbanStatusCell('doing')).toBe('🔄 进行中');
    expect(kanbanStatusCell('blocked')).toBe('⛔ 阻塞');
    expect(kanbanStatusCell('done')).toBe('✅ 完成');
    expect(kanbanStatusCell('regressed')).toBe('⛔ 回归');
  });

  it('明细列补充：无证据 / 已做过又坏了 / 源码已变', () => {
    expect(kanbanCells('done', { hasEvidence: true })).toEqual({ status: '✅ 完成', note: '' });
    expect(kanbanCells('done', {})).toEqual({ status: '✅ 完成', note: '无证据' });
    expect(kanbanCells('regressed', {})).toEqual({ status: '⛔ 回归', note: '已做过又坏了' });
    expect(kanbanCells('doing', { stale: true, stalePath: 'src/map/store/atomic.ts' })).toEqual({
      status: '⛔ 待复验',
      note: '⚠ 源码已变：atomic.ts',
    });
  });

  it('模块列固定 auto:map；状态列前缀可被判据识别', () => {
    expect(MAP_MODULE).toBe('auto:map');
    expect(isBoardStatusCell('🔄 进行中')).toBe(true);
    expect(isBoardStatusCell('⛔ 待复验')).toBe(true);
    expect(isBoardStatusCell('跑着')).toBe(false);
  });
});

describe('[T1] sources / context 判据', () => {
  it('sources：相对路径、正斜杠、无穿越、小写 64 位 sha256', () => {
    expect(sourcesError([{ path: 'src/map/store/atomic.ts', sha256: 'a'.repeat(64) }])).toBeUndefined();
    expect(sourcesError([{ path: 'src/a.ts' }])).toBeUndefined();
    expect(sourcesError([{ path: '/abs/a.ts' }])).toContain('相对路径');
    expect(sourcesError([{ path: 'a/../b.ts' }])).toContain('穿越');
    expect(sourcesError([{ path: 'a\\b.ts' }])).toContain('反斜杠');
    expect(sourcesError([{ path: 'C:/a.ts' }])).toContain('冒号');
    expect(sourcesError([{ path: '' }])).toContain('不能为空');
    expect(sourcesError([{ path: 'a.ts', sha256: 'A'.repeat(64) }])).toContain('sha256');
    expect(sourcesError([{ path: 'a.ts', extra: 1 }])).toContain('未知字段');
    expect(sourcesError('x')).toContain('数组');
    expect(sourcesError(Array.from({ length: 101 }, () => ({ path: 'a.ts' })))).toContain('最多');
  });

  it('context：长度与控制字符；制表符/换行故意放行，\\r 不放行（否则跨平台 revision 会漂）', () => {
    expect(contextError({ summary: '一句', next: '下一步', updated: '2026-10-18T04:41:00+08:00' })).toBeUndefined();
    expect(contextError({ summary: 'a\tb\nc' })).toBeUndefined();
    expect(contextError({ summary: 'a\rb' })).toContain('控制字符');
    expect(contextError({ next: 'x'.repeat(2001) })).toContain('超长');
    expect(contextError({ unknown: 1 })).toContain('未知字段');
    expect(contextError([])).toContain('对象');
  });
});
