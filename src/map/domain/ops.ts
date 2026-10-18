// 地图层的纯操作：草稿 → 校验 → 新草稿（契约 §2 不变式 + §4.1 片段语义）。
//
// 三条纪律：
//   · **绝不改入参**：每次操作返回一份新页。落盘只发生在 store/apply.ts 一处。
//   · **判定分两层**：op 自己需要的身份检查（update/remove 找得到目标吗、declare 撞 id 了吗）
//     在应用片段时立刻拒；跨对象的整体一致性**只判最终图**（validatePage）——契约 §4.1
//     明确允许「同批内先声明边再声明端点」，逐片段全量校验会把这条正当用法打回去。
//   · **拒绝是返回值**：看板/守护每轮都走这条路，抛一次就把整轮采集打断。
//
// 码的分工（§4.3 已定稿）：**找不到目标 = NOT_FOUND**，已存在还 declare / 一切不变式违反 = REFUSED。
// 「东西不在」与「被拒绝」是两件事——调用方（agent）按码分支，hint 再好也替代不了码。
//
// 为什么 declare 撞 id 是拒绝而不是幂等跳过（§4.1）：幂等跳过会把「我以为新建了一个对象」
// 变成一声不响的什么都不做——本仓库最嫌恶的故障。要改已存在的对象就写 update，语义显式。
//
// 为什么删层/组/泳道"有成员即拒"：把成员静默搬走等于账本替你做了决定。mellos 的 removeGroup
// 会顺手清掉成员的 group，这里**故意不照抄**：契约 §4.1 写的是"不静默搬移成员"；泳道同理——
// 把成员悄悄挪成"没有泳道"也是一次搬移，只是更隐蔽。

import {
  LABEL_MAX,
  BODY_MAX,
  describeValue,
  isRecord,
  optionalText,
  readEntryArray,
  unknownKeysError,
  EDGE_FIELDS,
  EDGE_PATCH_FIELDS,
  EDGE_IDENTITY_FIELDS,
  FRAGMENT_FIELDS,
  GROUP_FIELDS,
  IDENTITY_FIELDS,
  LANE_FIELDS,
  LAYER_FIELDS,
  NODE_FIELDS,
  REMOVE_FIELDS,
  requireId,
  requireRank,
  requireText,
  optionalId,
  optionalStatus,
  readOk,
  textError,
  type Read,
} from '../semantics/validate.js';
import { contextError, readContext, readSources, sourcesError } from './context.js';
import {
  err,
  mapIdError,
  mapRankError,
  mapStatusError,
  ok,
  refused,
  type MapGroup,
  type MapLane,
  type MapLayer,
  type MapNode,
  type MapPage,
  type Res,
} from './types.js';

// ───────────────────────────── 判据：整页不变式 ─────────────────────────────

const layerOf = (page: MapPage, id: string): MapLayer | undefined => page.layers.find((l) => l.id === id);
const groupOf = (page: MapPage, id: string): MapGroup | undefined => page.groups.find((g) => g.id === id);
const nodeOf = (page: MapPage, id: string): MapNode | undefined => page.nodes.find((n) => n.id === id);
const edgeIndexOf = (page: MapPage, from: string, to: string): number =>
  page.edges.findIndex((e) => e.from === from && e.to === to);

/**
 * 契约 §2 的七条不变式，逐条判；返回第一条被违反的说明，或 undefined。
 *
 * 为什么整页判一次而不是每个 op 各判各的：不变式之间会互相影响（改一个层的 rank 可能让
 * 两条层外的边不再向下），逐点判必然漏。这里**只此一份**，declare/update/remove 与文件解析
 * 全都汇到它——判据重复实现一次就会漂移一次。
 */
export function pageInvariantError(page: MapPage): string | undefined {
  const pageIdErr = mapIdError(page.id, '页 id');
  if (pageIdErr !== undefined) return pageIdErr;
  const titleErr = textError(page.title, 'title', LABEL_MAX);
  if (titleErr !== undefined) return titleErr;
  if (page.kind !== undefined) {
    const e = textError(page.kind, 'kind', LABEL_MAX);
    if (e !== undefined) return e;
  }
  if (page.context !== undefined) {
    const e = contextError(page.context);
    if (e !== undefined) return e;
  }

  const layerIds = new Set<string>();
  for (const [i, l] of page.layers.entries()) {
    const where = 'layers[' + String(i) + ']';
    const idErr = mapIdError(l.id, where + '.id');
    if (idErr !== undefined) return idErr;
    if (layerIds.has(l.id)) return '层 id 重复："' + l.id + '"（层 id 必须唯一）';
    layerIds.add(l.id);
    const nameErr = textError(l.name, where + '.name', LABEL_MAX);
    if (nameErr !== undefined) return nameErr;
    const rankErr = mapRankError(l.rank);
    if (rankErr !== undefined) return where + '.rank ' + rankErr;
  }

  const laneIds = new Set<string>();
  for (const [i, l] of page.lanes.entries()) {
    const where = 'lanes[' + String(i) + ']';
    const idErr = mapIdError(l.id, where + '.id');
    if (idErr !== undefined) return idErr;
    if (laneIds.has(l.id)) return '泳道 id 重复："' + l.id + '"';
    laneIds.add(l.id);
    const labelErr = textError(l.label, where + '.label', LABEL_MAX);
    if (labelErr !== undefined) return labelErr;
  }

  // 节点与分组**共用一个 id 命名空间**（§2.1）：两者在图里都是块，一个 id 只能是一个块，
  // 否则远焦把它聚成一个盒子时，同名的那一个永远点不开。
  const boxOwner = new Map<string, '节点' | '分组'>();
  for (const [i, g] of page.groups.entries()) {
    const where = 'groups[' + String(i) + ']';
    const idErr = mapIdError(g.id, where + '.id');
    if (idErr !== undefined) return idErr;
    const owner = boxOwner.get(g.id);
    if (owner !== undefined) {
      return owner === '分组'
        ? '分组 id 重复："' + g.id + '"（每个分组只能声明一次）'
        : 'id "' + g.id + '" 同时是节点与分组：节点与分组共用一个 id 命名空间（图里都是块，一个 id 只能是一个块）';
    }
    boxOwner.set(g.id, '分组');
    const labelErr = textError(g.label, where + '.label', LABEL_MAX);
    if (labelErr !== undefined) return labelErr;
    if (!layerIds.has(g.layer)) {
      return where + ' 分组 "' + g.id + '" 引用了不存在的层 "' + g.layer + '"（分组只在层内聚簇）';
    }
  }

  for (const [i, n] of page.nodes.entries()) {
    const where = 'nodes[' + String(i) + ']';
    const idErr = mapIdError(n.id, where + '.id');
    if (idErr !== undefined) return idErr;
    const owner = boxOwner.get(n.id);
    if (owner !== undefined) {
      return owner === '节点'
        ? '节点 id 重复："' + n.id + '"（节点 id 必须唯一）'
        : 'id "' + n.id + '" 同时是分组与节点：节点与分组共用一个 id 命名空间（图里都是块，一个 id 只能是一个块）';
    }
    boxOwner.set(n.id, '节点');
    const labelErr = textError(n.label, where + '.label', LABEL_MAX);
    if (labelErr !== undefined) return labelErr;
    if (!layerIds.has(n.layer)) {
      return where + ' 节点 "' + n.id + '" 引用了不存在的层 "' + n.layer + '"（每个节点必须属于一个已存在的层）';
    }
    const statusErr = mapStatusError(n.status);
    if (statusErr !== undefined) return where + '.status ' + statusErr;
    if (n.evidence !== undefined) {
      const e = textError(n.evidence, where + '.evidence', BODY_MAX);
      if (e !== undefined) return e;
    }
    if (n.detail !== undefined) {
      const e = textError(n.detail, where + '.detail', BODY_MAX);
      if (e !== undefined) return e;
    }
    if (n.group !== undefined) {
      const g = groupOf(page, n.group);
      if (g === undefined) return where + ' 节点 "' + n.id + '" 引用了不存在的分组 "' + n.group + '"';
      if (g.layer !== n.layer) {
        return (
          where + ' 节点 "' + n.id + '"（层 ' + n.layer + '）加入的分组 "' + n.group + '" 属于层 ' + g.layer +
          '：分组只在同一层内聚合（把它挪到同层，或换个分组）'
        );
      }
    }
    if (n.lane !== undefined && !laneIds.has(n.lane)) {
      return where + ' 节点 "' + n.id + '" 引用了不存在的泳道 "' + n.lane + '"';
    }
    if (n.sources !== undefined) {
      const e = sourcesError(n.sources, where + '.sources');
      if (e !== undefined) return e;
    }
  }

  const layerIdOfNode = new Map(page.nodes.map((n) => [n.id, n.layer]));
  const seenEdges = new Set<string>();
  for (const [i, e] of page.edges.entries()) {
    const where = 'edges[' + String(i) + ']';
    const fromErr = mapIdError(e.from, where + '.from');
    if (fromErr !== undefined) return fromErr;
    const toErr = mapIdError(e.to, where + '.to');
    if (toErr !== undefined) return toErr;
    const fromLayer = layerIdOfNode.get(e.from);
    if (fromLayer === undefined) return where + ' 的起点 "' + e.from + '" 不存在（边不能指向不存在的节点）';
    const toLayer = layerIdOfNode.get(e.to);
    if (toLayer === undefined) return where + ' 的终点 "' + e.to + '" 不存在（边不能指向不存在的节点）';
    const key = e.from + '\u0000' + e.to;
    if (seenEdges.has(key)) {
      return '边 "' + e.from + ' → ' + e.to + '" 重复：边的身份就是 from+to（没有独立 edge id），重复即身份冲突';
    }
    seenEdges.add(key);
    if (e.from === e.to) {
      return where + ' 是自环（"' + e.from + '" 使用自己）：边只能严格指向下层';
    }
    const fromRank = layerOf(page, fromLayer)?.rank;
    const toRank = layerOf(page, toLayer)?.rank;
    if (fromRank === undefined || toRank === undefined) continue;
    if (fromRank <= toRank) {
      return fromRank === toRank
        ? '同层边被拒："' + e.from + '" 与 "' + e.to + '" 都在层 "' + fromLayer + '"（rank ' + String(fromRank) +
          '）：要么 "' + e.to + '" 其实是更底层的概念（放到下层去），要么两者本就是一个节点（合并）'
        : '边 "' + e.from + '"（层 ' + fromLayer + ' rank ' + String(fromRank) + '）→ "' + e.to + '"（层 ' +
          toLayer + ' rank ' + String(toRank) + '）不是严格向下：如果 "' + e.to + '" 才是使用者就把箭头反过来，' +
          '否则调整所在层的 rank（图天生无环，靠的就是这条）';
    }
    if (e.label !== undefined) {
      const labelErr = textError(e.label, where + '.label', LABEL_MAX);
      if (labelErr !== undefined) return labelErr;
    }
  }
  return undefined;
}

/** 整页校验：ok(page) 或 REFUSED（带第一条被违反的说明）。 */
export function validatePage(page: MapPage): Res<MapPage> {
  const bad = pageInvariantError(page);
  return bad === undefined ? ok(page) : refused(bad);
}

// ───────────────────────────── 片段应用 ─────────────────────────────

export type MapOpName = 'declare' | 'update' | 'remove';

export interface MapOpInput {
  op: string;
  data: unknown;
}

/** 片段里这个键「被提起」了吗：undefined 当没提（JSON 里也不会出现 undefined）。 */
function mentioned(frag: Record<string, unknown>, key: string): boolean {
  return frag[key] !== undefined;
}

/** 可选字段的三态归并（§4.1）：没提起 → 保持原值；null → 清掉；有值 → 替换。 */
function mergeOptional<T>(
  frag: Record<string, unknown>,
  key: string,
  current: T | undefined,
  read: () => Read<T | undefined>,
): Read<T | undefined> {
  return mentioned(frag, key) ? read() : readOk(current);
}

/**
 * 标量字段（title / kind / context）。
 * 它们没有 id，因此「declare 拒绝已存在」这条规则对它们不适用：**两边都按 update 处理**。
 * 这样一条 declare 片段就能既建页又立标题（文件不存在时 applyPatch 从空页起手）。
 */
function applyScalars(page: MapPage, frag: Record<string, unknown>): Res<MapPage> {
  let next = page;
  if (mentioned(frag, 'title')) {
    const t = requireText(frag, 'title', 'data', LABEL_MAX);
    if (!t.ok) return refused(t.message);
    next = { ...next, title: t.value };
  }
  if (mentioned(frag, 'kind')) {
    const k = optionalText(frag, 'kind', 'data', LABEL_MAX, true);
    if (!k.ok) return refused(k.message);
    if (k.value === undefined) {
      const { kind: _cleared, ...rest } = next;
      next = rest;
    } else {
      next = { ...next, kind: k.value };
    }
  }
  if (mentioned(frag, 'context')) {
    const c = readContext(frag, 'context', 'data', true);
    if (!c.ok) return refused(c.message);
    if (c.value === undefined) {
      const { context: _cleared, ...rest } = next;
      next = rest;
    } else {
      next = { ...next, context: c.value };
    }
  }
  return ok(next);
}

function applyLayerOrderDeclare(page: MapPage, entries: Array<Record<string, unknown>>): Res<MapPage> {
  const layers = [...page.layers];
  for (const [i, raw] of entries.entries()) {
    const where = 'data.layers[' + String(i) + ']';
    const unk = unknownKeysError(raw, LAYER_FIELDS, where);
    if (unk !== undefined) return refused(unk);
    const id = requireId(raw, 'id', where);
    if (!id.ok) return refused(id.message);
    if (layers.some((l) => l.id === id.value)) {
      return refused(
        '层 "' + id.value + '" 已存在：declare 只新建（幂等跳过会让"我以为建了"变成一声不响的什么都没做）',
        '要改已存在的层就写 update',
      );
    }
    const name = requireText(raw, 'name', where, LABEL_MAX);
    if (!name.ok) return refused(name.message);
    const rank = requireRank(raw, 'rank', where);
    if (!rank.ok) return refused(rank.message);
    layers.push({ id: id.value, name: name.value, rank: rank.value });
  }
  return ok({ ...page, layers });
}

function applyLayersUpdate(page: MapPage, entries: Array<Record<string, unknown>>): Res<MapPage> {
  const layers = [...page.layers];
  for (const [i, raw] of entries.entries()) {
    const where = 'data.layers[' + String(i) + ']';
    const unk = unknownKeysError(raw, LAYER_FIELDS, where);
    if (unk !== undefined) return refused(unk);
    const id = requireId(raw, 'id', where);
    if (!id.ok) return refused(id.message);
    const at = layers.findIndex((l) => l.id === id.value);
    if (at < 0) return err('NOT_FOUND', '层 "' + id.value + '" 不存在：update 只能改已存在的对象', '要新建就写 declare');
    const cur = layers[at]!;
    let name = cur.name;
    let rank = cur.rank;
    if (mentioned(raw, 'name')) {
      const got = requireText(raw, 'name', where, LABEL_MAX);
      if (!got.ok) return refused(got.message);
      name = got.value;
    }
    if (mentioned(raw, 'rank')) {
      const got = requireRank(raw, 'rank', where);
      if (!got.ok) return refused(got.message);
      rank = got.value;
    }
    layers[at] = { id: cur.id, name, rank };
  }
  return ok({ ...page, layers });
}

function applyLanes(page: MapPage, entries: Array<Record<string, unknown>>, create: boolean): Res<MapPage> {
  const lanes = [...page.lanes];
  for (const [i, raw] of entries.entries()) {
    const where = 'data.lanes[' + String(i) + ']';
    const unk = unknownKeysError(raw, LANE_FIELDS, where);
    if (unk !== undefined) return refused(unk);
    const id = requireId(raw, 'id', where);
    if (!id.ok) return refused(id.message);
    if (create) {
      if (lanes.some((l) => l.id === id.value)) {
        return refused('泳道 "' + id.value + '" 已存在：declare 只新建', '要改标签就写 update');
      }
      const label = requireText(raw, 'label', where, LABEL_MAX);
      if (!label.ok) return refused(label.message);
      lanes.push({ id: id.value, label: label.value });
    } else {
      const at = lanes.findIndex((l) => l.id === id.value);
      if (at < 0) return err('NOT_FOUND', '泳道 "' + id.value + '" 不存在：update 只能改已存在的对象', '要新建就写 declare');
      const cur = lanes[at]!;
      let label = cur.label;
      if (mentioned(raw, 'label')) {
        const got = requireText(raw, 'label', where, LABEL_MAX);
        if (!got.ok) return refused(got.message);
        label = got.value;
      }
      lanes[at] = { id: cur.id, label };
    }
  }
  return ok({ ...page, lanes });
}

/**
 * 泳道顺序（§4.1）：必须是**应用本片段之后**页面上全部泳道各一次。
 * 顺序是内容（声明顺序 = 从左到右的渲染顺序），所以 lanes 数组不排序、也不去重。
 */
function applyLaneOrder(page: MapPage, raw: unknown, where: string): Res<MapPage> {
  if (!Array.isArray(raw)) {
    return refused(where + ' 必须是泳道 id 的数组（现在是 ' + describeValue(raw) + '）');
  }
  const ids: string[] = [];
  for (const [i, item] of raw.entries()) {
    const e = mapIdError(item, where + '[' + String(i) + ']');
    if (e !== undefined) return refused(e);
    ids.push(item as string);
  }
  if (new Set(ids).size !== ids.length) {
    return refused(where + ' 里有重复的泳道 id：泳道顺序必须每个泳道各出现一次');
  }
  const have = new Set(page.lanes.map((l) => l.id));
  const missing = [...have].filter((id) => !ids.includes(id));
  const unknownIds = ids.filter((id) => !have.has(id));
  if (missing.length > 0 || unknownIds.length > 0) {
    return refused(
      where + ' 必须包含**全部**泳道各一次：缺 [' + missing.join('、') + ']，多 [' + unknownIds.join('、') +
        ']（当前泳道：' + ([...have].join('、') || '无') + '）',
      'laneOrder 要和声明/改泳道的那个片段写在一起——它按「应用本片段之后」的泳道集合判定',
    );
  }
  const byId = new Map(page.lanes.map((l) => [l.id, l]));
  return ok({ ...page, lanes: ids.map((id) => byId.get(id) as MapLane) });
}

function applyGroups(page: MapPage, entries: Array<Record<string, unknown>>, create: boolean): Res<MapPage> {
  const groups = [...page.groups];
  for (const [i, raw] of entries.entries()) {
    const where = 'data.groups[' + String(i) + ']';
    const unk = unknownKeysError(raw, GROUP_FIELDS, where);
    if (unk !== undefined) return refused(unk);
    const id = requireId(raw, 'id', where);
    if (!id.ok) return refused(id.message);
    if (create) {
      if (groups.some((g) => g.id === id.value)) {
        return refused('分组 "' + id.value + '" 已存在：declare 只新建', '要改标签就写 update');
      }
      if (page.nodes.some((n) => n.id === id.value)) {
        return refused(
          'id "' + id.value + '" 已经是节点：节点与分组共用一个 id 命名空间（图里都是块，一个 id 只能是一个块）',
        );
      }
      const label = requireText(raw, 'label', where, LABEL_MAX);
      if (!label.ok) return refused(label.message);
      const layer = requireId(raw, 'layer', where);
      if (!layer.ok) return refused(layer.message);
      groups.push({ id: id.value, label: label.value, layer: layer.value });
    } else {
      const at = groups.findIndex((g) => g.id === id.value);
      if (at < 0) return err('NOT_FOUND', '分组 "' + id.value + '" 不存在：update 只能改已存在的对象', '要新建就写 declare');
      const cur = groups[at]!;
      let label = cur.label;
      let layer = cur.layer;
      if (mentioned(raw, 'label')) {
        const got = requireText(raw, 'label', where, LABEL_MAX);
        if (!got.ok) return refused(got.message);
        label = got.value;
      }
      if (mentioned(raw, 'layer')) {
        const got = requireId(raw, 'layer', where);
        if (!got.ok) return refused(got.message);
        layer = got.value;
      }
      groups[at] = { id: cur.id, label, layer };
    }
  }
  return ok({ ...page, groups });
}

function applyNodesDeclare(page: MapPage, entries: Array<Record<string, unknown>>): Res<MapPage> {
  const nodes = [...page.nodes];
  for (const [i, raw] of entries.entries()) {
    const where = 'data.nodes[' + String(i) + ']';
    const unk = unknownKeysError(raw, NODE_FIELDS, where);
    if (unk !== undefined) return refused(unk);
    const id = requireId(raw, 'id', where);
    if (!id.ok) return refused(id.message);
    if (nodes.some((n) => n.id === id.value)) {
      return refused('节点 "' + id.value + '" 已存在：declare 只新建', '要改状态/证据就写 update');
    }
    if (page.groups.some((g) => g.id === id.value)) {
      return refused(
        'id "' + id.value + '" 已经是分组：节点与分组共用一个 id 命名空间（图里都是块，一个 id 只能是一个块）',
      );
    }
    const label = requireText(raw, 'label', where, LABEL_MAX);
    if (!label.ok) return refused(label.message);
    const layer = requireId(raw, 'layer', where);
    if (!layer.ok) return refused(layer.message);
    const status = optionalStatus(raw, 'status', where);
    if (!status.ok) return refused(status.message);
    const evidence = optionalText(raw, 'evidence', where, BODY_MAX);
    if (!evidence.ok) return refused(evidence.message);
    const detail = optionalText(raw, 'detail', where, BODY_MAX);
    if (!detail.ok) return refused(detail.message);
    const group = optionalId(raw, 'group', where);
    if (!group.ok) return refused(group.message);
    const lane = optionalId(raw, 'lane', where);
    if (!lane.ok) return refused(lane.message);
    const sources = readSources(raw, 'sources', where);
    if (!sources.ok) return refused(sources.message);
    nodes.push({
      id: id.value,
      label: label.value,
      layer: layer.value,
      // 省略 status ⇒ todo（"刚登记、还没动"是唯一诚实的默认；done 需要证据，不能是默认值）
      status: status.value ?? 'todo',
      ...(evidence.value !== undefined ? { evidence: evidence.value } : {}),
      ...(detail.value !== undefined ? { detail: detail.value } : {}),
      ...(group.value !== undefined ? { group: group.value } : {}),
      ...(lane.value !== undefined ? { lane: lane.value } : {}),
      ...(sources.value !== undefined ? { sources: sources.value } : {}),
    });
  }
  return ok({ ...page, nodes });
}

function applyNodesUpdate(page: MapPage, entries: Array<Record<string, unknown>>): Res<MapPage> {
  const nodes = [...page.nodes];
  for (const [i, raw] of entries.entries()) {
    const where = 'data.nodes[' + String(i) + ']';
    const unk = unknownKeysError(raw, NODE_FIELDS, where);
    if (unk !== undefined) return refused(unk);
    const id = requireId(raw, 'id', where);
    if (!id.ok) return refused(id.message);
    const at = nodes.findIndex((n) => n.id === id.value);
    if (at < 0) return err('NOT_FOUND', '节点 "' + id.value + '" 不存在：update 只能改已存在的对象', '要新建就写 declare');
    const cur = nodes[at]!;
    let label = cur.label;
    let layer = cur.layer;
    let status = cur.status;
    if (mentioned(raw, 'label')) {
      const got = requireText(raw, 'label', where, LABEL_MAX);
      if (!got.ok) return refused(got.message);
      label = got.value;
    }
    if (mentioned(raw, 'layer')) {
      const got = requireId(raw, 'layer', where);
      if (!got.ok) return refused(got.message);
      layer = got.value;
    }
    if (mentioned(raw, 'status')) {
      const got = optionalStatus(raw, 'status', where);
      if (!got.ok) return refused(got.message);
      if (got.value === undefined) return refused(where + '.status 不能是 null：状态是必填字段');
      status = got.value;
    }
    const evidence = mergeOptional(raw, 'evidence', cur.evidence, () =>
      optionalText(raw, 'evidence', where, BODY_MAX, true),
    );
    if (!evidence.ok) return refused(evidence.message);
    const detail = mergeOptional(raw, 'detail', cur.detail, () =>
      optionalText(raw, 'detail', where, BODY_MAX, true),
    );
    if (!detail.ok) return refused(detail.message);
    const group = mergeOptional(raw, 'group', cur.group, () => optionalId(raw, 'group', where, true));
    if (!group.ok) return refused(group.message);
    const lane = mergeOptional(raw, 'lane', cur.lane, () => optionalId(raw, 'lane', where, true));
    if (!lane.ok) return refused(lane.message);
    const sources = mergeOptional(raw, 'sources', cur.sources, () => readSources(raw, 'sources', where, true));
    if (!sources.ok) return refused(sources.message);
    nodes[at] = {
      id: cur.id,
      label,
      layer,
      status,
      ...(evidence.value !== undefined ? { evidence: evidence.value } : {}),
      ...(detail.value !== undefined ? { detail: detail.value } : {}),
      ...(group.value !== undefined ? { group: group.value } : {}),
      ...(lane.value !== undefined ? { lane: lane.value } : {}),
      ...(sources.value !== undefined ? { sources: sources.value } : {}),
    };
  }
  return ok({ ...page, nodes });
}

function applyEdgesDeclare(page: MapPage, entries: Array<Record<string, unknown>>): Res<MapPage> {
  const edges = [...page.edges];
  for (const [i, raw] of entries.entries()) {
    const where = 'data.edges[' + String(i) + ']';
    const unk = unknownKeysError(raw, EDGE_FIELDS, where);
    if (unk !== undefined) return refused(unk);
    const from = requireId(raw, 'from', where);
    if (!from.ok) return refused(from.message);
    const to = requireId(raw, 'to', where);
    if (!to.ok) return refused(to.message);
    if (edges.some((e) => e.from === from.value && e.to === to.value)) {
      return refused(
        '边 "' + from.value + ' → ' + to.value + '" 已存在：边的身份就是 from+to（没有独立 edge id），declare 只新建',
        '要改标签或端点就写 update',
      );
    }
    const label = optionalText(raw, 'label', where, LABEL_MAX);
    if (!label.ok) return refused(label.message);
    edges.push({ from: from.value, to: to.value, ...(label.value !== undefined ? { label: label.value } : {}) });
  }
  return ok({ ...page, edges });
}

function applyEdgesUpdate(page: MapPage, entries: Array<Record<string, unknown>>): Res<MapPage> {
  const edges = [...page.edges];
  for (const [i, raw] of entries.entries()) {
    const where = 'data.edges[' + String(i) + ']';
    const unk = unknownKeysError(raw, EDGE_PATCH_FIELDS, where);
    if (unk !== undefined) return refused(unk);
    const from = requireId(raw, 'from', where);
    if (!from.ok) return refused(from.message);
    const to = requireId(raw, 'to', where);
    if (!to.ok) return refused(to.message);
    const at = edges.findIndex((e) => e.from === from.value && e.to === to.value);
    if (at < 0) {
      return err(
        'NOT_FOUND',
        '边 "' + from.value + ' → ' + to.value + '" 不存在：update 只能改已存在的对象（边身份 = from+to）',
        '要新建就写 declare',
      );
    }
    const cur = edges[at]!;
    let nextFrom = cur.from;
    let nextTo = cur.to;
    if (mentioned(raw, 'newFrom')) {
      const got = requireId(raw, 'newFrom', where);
      if (!got.ok) return refused(got.message);
      nextFrom = got.value;
    }
    if (mentioned(raw, 'newTo')) {
      const got = requireId(raw, 'newTo', where);
      if (!got.ok) return refused(got.message);
      nextTo = got.value;
    }
    const label = mergeOptional(raw, 'label', cur.label, () =>
      optionalText(raw, 'label', where, LABEL_MAX, true),
    );
    if (!label.ok) return refused(label.message);
    if (edges.some((e, idx) => idx !== at && e.from === nextFrom && e.to === nextTo)) {
      return refused(
        '改完的边 "' + nextFrom + ' → ' + nextTo + '" 与已有边重名：边的身份就是 from+to，重复即身份冲突',
      );
    }
    edges[at] = {
      from: nextFrom,
      to: nextTo,
      ...(label.value !== undefined ? { label: label.value } : {}),
    };
  }
  return ok({ ...page, edges });
}

/**
 * declare：新建对象；**已存在的 id 一律拒绝**（§4.1）。
 * 片段内可以先声明边再声明端点——整体一致性交给调用方在最后跑 validatePage。
 */
export function declareFragment(page: MapPage, frag: Record<string, unknown>): Res<MapPage> {
  const unk = unknownKeysError(frag, FRAGMENT_FIELDS, 'data');
  if (unk !== undefined) return refused(unk);
  let next = page;
  const scalars = applyScalars(next, frag);
  if (!scalars.ok) return scalars;
  next = scalars.value;
  const layers = readEntryArray(frag, 'layers', 'data');
  if (!layers.ok) return refused(layers.message);
  if (layers.value !== undefined) {
    const got = applyLayerOrderDeclare(next, layers.value);
    if (!got.ok) return got;
    next = got.value;
  }
  const lanes = readEntryArray(frag, 'lanes', 'data');
  if (!lanes.ok) return refused(lanes.message);
  if (lanes.value !== undefined) {
    const got = applyLanes(next, lanes.value, true);
    if (!got.ok) return got;
    next = got.value;
  }
  if (mentioned(frag, 'laneOrder')) {
    const got = applyLaneOrder(next, frag['laneOrder'], 'data.laneOrder');
    if (!got.ok) return got;
    next = got.value;
  }
  const groups = readEntryArray(frag, 'groups', 'data');
  if (!groups.ok) return refused(groups.message);
  if (groups.value !== undefined) {
    const got = applyGroups(next, groups.value, true);
    if (!got.ok) return got;
    next = got.value;
  }
  const nodes = readEntryArray(frag, 'nodes', 'data');
  if (!nodes.ok) return refused(nodes.message);
  if (nodes.value !== undefined) {
    const got = applyNodesDeclare(next, nodes.value);
    if (!got.ok) return got;
    next = got.value;
  }
  const edges = readEntryArray(frag, 'edges', 'data');
  if (!edges.ok) return refused(edges.message);
  if (edges.value !== undefined) {
    const got = applyEdgesDeclare(next, edges.value);
    if (!got.ok) return got;
    next = got.value;
  }
  return ok(next);
}

/** update：按 id（边按 from+to）定位后改字段；null 清可选字段。找不到目标 → REFUSED。 */
export function updateFragment(page: MapPage, frag: Record<string, unknown>): Res<MapPage> {
  const unk = unknownKeysError(frag, FRAGMENT_FIELDS, 'data');
  if (unk !== undefined) return refused(unk);
  let next = page;
  const scalars = applyScalars(next, frag);
  if (!scalars.ok) return scalars;
  next = scalars.value;
  const layers = readEntryArray(frag, 'layers', 'data');
  if (!layers.ok) return refused(layers.message);
  if (layers.value !== undefined) {
    const got = applyLayersUpdate(next, layers.value);
    if (!got.ok) return got;
    next = got.value;
  }
  const lanes = readEntryArray(frag, 'lanes', 'data');
  if (!lanes.ok) return refused(lanes.message);
  if (lanes.value !== undefined) {
    const got = applyLanes(next, lanes.value, false);
    if (!got.ok) return got;
    next = got.value;
  }
  if (mentioned(frag, 'laneOrder')) {
    const got = applyLaneOrder(next, frag['laneOrder'], 'data.laneOrder');
    if (!got.ok) return got;
    next = got.value;
  }
  const groups = readEntryArray(frag, 'groups', 'data');
  if (!groups.ok) return refused(groups.message);
  if (groups.value !== undefined) {
    const got = applyGroups(next, groups.value, false);
    if (!got.ok) return got;
    next = got.value;
  }
  const nodes = readEntryArray(frag, 'nodes', 'data');
  if (!nodes.ok) return refused(nodes.message);
  if (nodes.value !== undefined) {
    const got = applyNodesUpdate(next, nodes.value);
    if (!got.ok) return got;
    next = got.value;
  }
  const edges = readEntryArray(frag, 'edges', 'data');
  if (!edges.ok) return refused(edges.message);
  if (edges.value !== undefined) {
    const got = applyEdgesUpdate(next, edges.value);
    if (!got.ok) return got;
    next = got.value;
  }
  return ok(next);
}

/**
 * remove：只收身份选择器（§4.1），且**不静默搬移成员**——层/组/泳道还有成员就拒（REFUSED）；
 * 选择器指的东西不在 → NOT_FOUND（§4.3）。
 *
 * 处理顺序：先边，再节点，再组/泳道/层。为什么边在前——删节点会级联带走它的边，
 * 若先删节点，同一批里那条边的选择器就会变成「找不到」而拒掉整批。同一件事写两遍是冗余，
 * 但不该因此变成错误。
 */
export function removeFragment(page: MapPage, frag: Record<string, unknown>): Res<MapPage> {
  const unk = unknownKeysError(frag, REMOVE_FIELDS, 'data');
  if (unk !== undefined) return refused(unk);
  const picked: Partial<Record<(typeof REMOVE_FIELDS)[number], Array<Record<string, unknown>>>> = {};
  for (const key of REMOVE_FIELDS) {
    const got = readEntryArray(frag, key, 'data');
    if (!got.ok) return refused(got.message);
    picked[key] = got.value ?? [];
  }
  let next = page;

  for (const [i, raw] of (picked.edges ?? []).entries()) {
    const where = 'data.edges[' + String(i) + ']';
    const bad = unknownKeysError(raw, EDGE_IDENTITY_FIELDS, where);
    if (bad !== undefined) return refused(bad);
    const from = requireId(raw, 'from', where);
    if (!from.ok) return refused(from.message);
    const to = requireId(raw, 'to', where);
    if (!to.ok) return refused(to.message);
    const at = edgeIndexOf(next, from.value, to.value);
    if (at < 0) {
      return err(
        'NOT_FOUND',
        '要删的边 "' + from.value + ' → ' + to.value + '" 不存在（边身份 = from+to）',
        '要新建就写 declare；删之前先 map read 确认当前图',
      );
    }
    const edges = [...next.edges];
    edges.splice(at, 1);
    next = { ...next, edges };
  }

  for (const [i, raw] of (picked.nodes ?? []).entries()) {
    const where = 'data.nodes[' + String(i) + ']';
    const bad = unknownKeysError(raw, IDENTITY_FIELDS, where);
    if (bad !== undefined) return refused(bad);
    const id = requireId(raw, 'id', where);
    if (!id.ok) return refused(id.message);
    if (nodeOf(next, id.value) === undefined) {
      return err('NOT_FOUND', '要删的节点 "' + id.value + '" 不存在', '要新建就写 declare；删之前先 map read 确认当前图');
    }
    next = {
      ...next,
      nodes: next.nodes.filter((n) => n.id !== id.value),
      // 级联：节点没了，挂在它身上的边也必须没了（否则图里会出现指向空气的箭头）
      edges: next.edges.filter((e) => e.from !== id.value && e.to !== id.value),
    };
  }

  for (const [i, raw] of (picked.groups ?? []).entries()) {
    const where = 'data.groups[' + String(i) + ']';
    const bad = unknownKeysError(raw, IDENTITY_FIELDS, where);
    if (bad !== undefined) return refused(bad);
    const id = requireId(raw, 'id', where);
    if (!id.ok) return refused(id.message);
    if (groupOf(next, id.value) === undefined) {
      return err('NOT_FOUND', '要删的分组 "' + id.value + '" 不存在', '要新建就写 declare');
    }
    const member = next.nodes.find((n) => n.group === id.value);
    if (member !== undefined) {
      return refused(
        '分组 "' + id.value + '" 还有成员（如 "' + member.id + '"）：删组不静默搬移成员',
        '先 update 那些节点把 group 置 null，再把它们一起 remove',
      );
    }
    next = { ...next, groups: next.groups.filter((g) => g.id !== id.value) };
  }

  for (const [i, raw] of (picked.lanes ?? []).entries()) {
    const where = 'data.lanes[' + String(i) + ']';
    const bad = unknownKeysError(raw, IDENTITY_FIELDS, where);
    if (bad !== undefined) return refused(bad);
    const id = requireId(raw, 'id', where);
    if (!id.ok) return refused(id.message);
    if (!next.lanes.some((l) => l.id === id.value)) {
      return err('NOT_FOUND', '要删的泳道 "' + id.value + '" 不存在', '要新建就写 declare');
    }
    const member = next.nodes.find((n) => n.lane === id.value);
    if (member !== undefined) {
      return refused(
        '泳道 "' + id.value + '" 还有成员（如 "' + member.id + '"）：删泳道不静默把成员挪到"没有泳道"',
        '先 update 那些节点把 lane 置 null，再删泳道',
      );
    }
    next = { ...next, lanes: next.lanes.filter((l) => l.id !== id.value) };
  }

  for (const [i, raw] of (picked.layers ?? []).entries()) {
    const where = 'data.layers[' + String(i) + ']';
    const bad = unknownKeysError(raw, IDENTITY_FIELDS, where);
    if (bad !== undefined) return refused(bad);
    const id = requireId(raw, 'id', where);
    if (!id.ok) return refused(id.message);
    if (layerOf(next, id.value) === undefined) {
      return err('NOT_FOUND', '要删的层 "' + id.value + '" 不存在', '要新建就写 declare');
    }
    const occupant = next.nodes.find((n) => n.layer === id.value);
    if (occupant !== undefined) {
      return refused(
        '层 "' + id.value + '" 还有节点（如 "' + occupant.id + '"）：删层不静默搬移成员',
        '先把这些节点换层（update 的 layer）或删掉，再删层',
      );
    }
    const group = next.groups.find((g) => g.layer === id.value);
    if (group !== undefined) {
      return refused(
        '层 "' + id.value + '" 还有分组（如 "' + group.id + '"）：删层不静默搬移成员',
        '先删掉这些分组，再删层',
      );
    }
    next = { ...next, layers: next.layers.filter((l) => l.id !== id.value) };
  }

  return ok(next);
}

/**
 * 一条 patch 操作 → 新草稿。信封之外的形状问题（op 不认识、data 不是对象）算
 * INVALID_ARGUMENT；结构违反算 REFUSED（§4.1）。
 */
export function applyMapOp(page: MapPage, op: unknown): Res<MapPage> {
  if (!isRecord(op)) {
    return err('INVALID_ARGUMENT', '操作必须是 {op, data} 对象', '每条操作写成 {"op":"declare|update|remove","data":{…}}');
  }
  if (typeof op.op !== 'string') {
    return err('INVALID_ARGUMENT', '操作缺少 op 字段', 'op 只认 declare / update / remove');
  }
  if (!isRecord(op.data)) {
    return err(
      'INVALID_ARGUMENT',
      '操作 ' + op.op + ' 的 data 必须是页面片段对象（现在是 ' + describeValue(op.data) + '）',
      'data 的键取自 title/kind/context/layers/groups/lanes/nodes/edges/laneOrder',
    );
  }
  const data = op.data as Record<string, unknown>;
  switch (op.op) {
    case 'declare':
      return declareFragment(page, data);
    case 'update':
      return updateFragment(page, data);
    case 'remove':
      return removeFragment(page, data);
    default:
      return err('INVALID_ARGUMENT', '未知操作 "' + op.op + '"', '只认 declare / update / remove');
  }
}
