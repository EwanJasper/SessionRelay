// 页文件的格式：确定性序列化 + 严格解析（其余模块都靠这两条承诺）。
//
//   P1. parsePage 接受的东西**一定**满足 §2 的不变式：解析的最后一步就是 validatePage。
//       于是手改/坏掉的文件不可能把违反不变式的图偷渡进进程（边界处校验，内部代码随后可信）。
//   P2. 序列化是**确定性**的：同样的逻辑内容 → 同样的字节。因此
//       revision = sha256(serializePage(page)) 稳定、可跨机器比较——expectedRevision 全靠它。
//
// 严格读为什么是纪律而不是洁癖：地图会被写回。把 {"nodes":{…}} 宽容成"没有节点"，
// 下一次保存就把它写成空图——宽容在这里不是容错，是毁文件。
//
// 数组为什么排序：层的上下由 rank 决定，分组/节点/边没有顺序语义（看板行序由 bridge 按 §5 另算），
// 排序让「同一张图换个 op 顺序写出来」字节一致，diff 与 revision 才有意义。
// ⚠️ 泳道**不排序**：声明顺序 = 从左到右的渲染顺序，是内容本身，由 laneOrder 显式控制。

import { createHash } from 'node:crypto';
import {
  BODY_MAX,
  LABEL_MAX,
  describeValue,
  isRecord,
  optionalText,
  readArray,
  optionalId,
  requireId,
  requireRank,
  requireText,
  unknownKeysError,
  EDGE_FIELDS,
  GROUP_FIELDS,
  LANE_FIELDS,
  LAYER_FIELDS,
  NODE_FIELDS,
  PAGE_FIELDS,
} from '../semantics/validate.js';
import { contextError, readContext, readSources } from '../domain/context.js';
import { validatePage } from '../domain/ops.js';
import {
  err,
  mapStatusError,
  ok,
  type MapContext,
  type MapEdge,
  type MapGroup,
  type MapLane,
  type MapLayer,
  type MapNode,
  type MapPage,
  type MapStatus,
  type Res,
  type SourceRef,
} from '../domain/types.js';

/** 文件格式版本。只有配了迁移方案才准加。 */
export const MAP_FILE_VERSION = 1;

/** Windows 编辑器（记事本、某些 PowerShell 重定向）会在 UTF-8 前加 BOM，JSON.parse 会因此炸。
 *  BOM 对 UTF-8 文件没有意义，这里剥掉——否则"你的地图坏了"其实只是一个看不见的字符。 */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function byString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function layerBody(l: MapLayer): Record<string, unknown> {
  return { id: l.id, name: l.name, rank: l.rank };
}

function nodeBody(n: MapNode): Record<string, unknown> {
  return {
    id: n.id,
    label: n.label,
    layer: n.layer,
    status: n.status,
    ...(n.evidence !== undefined ? { evidence: n.evidence } : {}),
    ...(n.detail !== undefined ? { detail: n.detail } : {}),
    ...(n.group !== undefined ? { group: n.group } : {}),
    ...(n.lane !== undefined ? { lane: n.lane } : {}),
    ...(n.sources !== undefined
      ? { sources: n.sources.map((s: SourceRef) => ({ path: s.path, ...(s.sha256 !== undefined ? { sha256: s.sha256 } : {}) })) }
      : {}),
  };
}

function edgeBody(e: MapEdge): Record<string, unknown> {
  return { from: e.from, to: e.to, ...(e.label !== undefined ? { label: e.label } : {}) };
}

function contextBody(c: MapContext): Record<string, unknown> {
  return {
    ...(c.summary !== undefined ? { summary: c.summary } : {}),
    ...(c.next !== undefined ? { next: c.next } : {}),
    ...(c.updated !== undefined ? { updated: c.updated } : {}),
  };
}

/**
 * 规范化后的页对象：键序固定、可选字段缺省即不写、数组排序（泳道除外）。
 * 键序固定不是为了好看——JSON.stringify 按插入顺序输出，键序不定 revision 就不定。
 */
export function canonicalPage(page: MapPage): Record<string, unknown> {
  return {
    version: MAP_FILE_VERSION,
    title: page.title,
    ...(page.kind !== undefined ? { kind: page.kind } : {}),
    layers: [...page.layers].sort((a, b) => a.rank - b.rank || byString(a.id, b.id)).map(layerBody),
    ...(page.groups.length > 0
      ? {
          groups: [...page.groups]
            .sort((a, b) => byString(a.id, b.id))
            .map((g): Record<string, unknown> => ({ id: g.id, label: g.label, layer: g.layer })),
        }
      : {}),
    // 泳道保持声明顺序：顺序是内容（从左到右的渲染顺序），由 laneOrder 显式控制
    ...(page.lanes.length > 0
      ? { lanes: page.lanes.map((l: MapLane): Record<string, unknown> => ({ id: l.id, label: l.label })) }
      : {}),
    nodes: [...page.nodes].sort((a, b) => byString(a.id, b.id)).map(nodeBody),
    edges: [...page.edges].sort((a, b) => byString(a.from, b.from) || byString(a.to, b.to)).map(edgeBody),
    ...(page.context !== undefined ? { context: contextBody(page.context) } : {}),
  };
}

/** 规范化 JSON 文本：2 空格缩进、LF、结尾一个换行。字节确定，所以哈希可比。 */
export function serializePage(page: MapPage): string {
  return JSON.stringify(canonicalPage(page), null, 2) + '\n';
}

/** revision = 规范化 JSON 的 sha256（契约 §1：`revision（= 规范化内容 sha256）`）。 */
export function revisionOf(page: MapPage): string {
  return createHash('sha256').update(serializePage(page), 'utf8').digest('hex');
}

/**
 * 严格解析一份页数据。
 * @param raw - JSON.parse 之后的值。
 * @param path - 出错文案里说的文件路径（人要知道去改哪个文件）。
 * @param id - 页 id：**不是文件里的字段**，由文件名给出。
 * @returns 页，或 INVALID_STORE（形状不对 / 结构违规，两者都是"数据坏"，CLI 都是退出码 1）。
 */
export function parsePage(raw: unknown, path: string, id: string): Res<MapPage> {
  const bad = (message: string, where?: string): Res<never> =>
    err(
      'INVALID_STORE',
      message,
      '按 §2 数据契约改好这个文件（或删掉重建）：坏文件既不静默修，也不会被下一次保存覆盖成别的样子',
      where === undefined ? undefined : { where },
    );

  if (!isRecord(raw)) return bad(path + ' 的根不是对象（现在是 ' + describeValue(raw) + '）', '根');
  const rootUnk = unknownKeysError(raw, PAGE_FIELDS, path + ' 的根对象');
  if (rootUnk !== undefined) return bad(rootUnk, '根');
  if (raw['version'] !== MAP_FILE_VERSION) {
    return bad(
      path + ' 的 version 现在是 ' + describeValue(raw['version']) + '，本版只认 ' + String(MAP_FILE_VERSION),
      'version',
    );
  }
  const title = requireText(raw, 'title', path + ' 的根对象', LABEL_MAX);
  if (!title.ok) return bad(title.message, 'title');
  const kind = optionalText(raw, 'kind', path + ' 的根对象', LABEL_MAX);
  if (!kind.ok) return bad(kind.message, 'kind');

  const layersRaw = readArray(raw, 'layers', path + ' 的根对象', 'required');
  if (!layersRaw.ok) return bad(layersRaw.message, 'layers');
  const layers: MapLayer[] = [];
  for (const [i, item] of layersRaw.value.entries()) {
    const where = 'layers[' + String(i) + ']';
    if (!isRecord(item)) return bad(path + ' 的 ' + where + ' 必须是对象（现在是 ' + describeValue(item) + '）', where);
    const unk = unknownKeysError(item, LAYER_FIELDS, where);
    if (unk !== undefined) return bad(path + '：' + unk, where);
    const id2 = requireId(item, 'id', where);
    if (!id2.ok) return bad(path + ' 的 ' + id2.message, where);
    const name = requireText(item, 'name', where, LABEL_MAX);
    if (!name.ok) return bad(path + ' 的 ' + name.message, where);
    const rank = requireRank(item, 'rank', where);
    if (!rank.ok) return bad(path + ' 的 ' + rank.message, where);
    layers.push({ id: id2.value, name: name.value, rank: rank.value });
  }

  const groupsRaw = readArray(raw, 'groups', path + ' 的根对象', 'optional');
  if (!groupsRaw.ok) return bad(groupsRaw.message, 'groups');
  const groups: MapGroup[] = [];
  for (const [i, item] of (groupsRaw.value ?? []).entries()) {
    const where = 'groups[' + String(i) + ']';
    if (!isRecord(item)) return bad(path + ' 的 ' + where + ' 必须是对象（现在是 ' + describeValue(item) + '）', where);
    const unk = unknownKeysError(item, GROUP_FIELDS, where);
    if (unk !== undefined) return bad(path + '：' + unk, where);
    const id2 = requireId(item, 'id', where);
    if (!id2.ok) return bad(path + ' 的 ' + id2.message, where);
    const label = requireText(item, 'label', where, LABEL_MAX);
    if (!label.ok) return bad(path + ' 的 ' + label.message, where);
    const layer = requireId(item, 'layer', where);
    if (!layer.ok) return bad(path + ' 的 ' + layer.message, where);
    groups.push({ id: id2.value, label: label.value, layer: layer.value });
  }

  const lanesRaw = readArray(raw, 'lanes', path + ' 的根对象', 'optional');
  if (!lanesRaw.ok) return bad(lanesRaw.message, 'lanes');
  const lanes: MapLane[] = [];
  for (const [i, item] of (lanesRaw.value ?? []).entries()) {
    const where = 'lanes[' + String(i) + ']';
    if (!isRecord(item)) return bad(path + ' 的 ' + where + ' 必须是对象（现在是 ' + describeValue(item) + '）', where);
    const unk = unknownKeysError(item, LANE_FIELDS, where);
    if (unk !== undefined) return bad(path + '：' + unk, where);
    const id2 = requireId(item, 'id', where);
    if (!id2.ok) return bad(path + ' 的 ' + id2.message, where);
    const label = requireText(item, 'label', where, LABEL_MAX);
    if (!label.ok) return bad(path + ' 的 ' + label.message, where);
    lanes.push({ id: id2.value, label: label.value });
  }

  const nodesRaw = readArray(raw, 'nodes', path + ' 的根对象', 'required');
  if (!nodesRaw.ok) return bad(nodesRaw.message, 'nodes');
  const nodes: MapNode[] = [];
  for (const [i, item] of nodesRaw.value.entries()) {
    const where = 'nodes[' + String(i) + ']';
    if (!isRecord(item)) return bad(path + ' 的 ' + where + ' 必须是对象（现在是 ' + describeValue(item) + '）', where);
    const unk = unknownKeysError(item, NODE_FIELDS, where);
    if (unk !== undefined) return bad(path + '：' + unk, where);
    const id2 = requireId(item, 'id', where);
    if (!id2.ok) return bad(path + ' 的 ' + id2.message, where);
    const label = requireText(item, 'label', where, LABEL_MAX);
    if (!label.ok) return bad(path + ' 的 ' + label.message, where);
    const layer = requireId(item, 'layer', where);
    if (!layer.ok) return bad(path + ' 的 ' + layer.message, where);
    const statusErr = mapStatusError(item['status']);
    if (statusErr !== undefined) return bad(path + ' 的 ' + where + '.status ' + statusErr, where + '.status');
    const evidence = optionalText(item, 'evidence', where, BODY_MAX);
    if (!evidence.ok) return bad(path + ' 的 ' + evidence.message, where);
    const detail = optionalText(item, 'detail', where, BODY_MAX);
    if (!detail.ok) return bad(path + ' 的 ' + detail.message, where);
    const group = optionalId(item, 'group', where);
    if (!group.ok) return bad(path + ' 的 ' + group.message, where);
    const lane = optionalId(item, 'lane', where);
    if (!lane.ok) return bad(path + ' 的 ' + lane.message, where);
    const sources = readSources(item, 'sources', where);
    if (!sources.ok) return bad(path + ' 的 ' + sources.message, where);
    nodes.push({
      id: id2.value,
      label: label.value,
      layer: layer.value,
      status: item['status'] as MapStatus,
      ...(evidence.value !== undefined ? { evidence: evidence.value } : {}),
      ...(detail.value !== undefined ? { detail: detail.value } : {}),
      ...(group.value !== undefined ? { group: group.value } : {}),
      ...(lane.value !== undefined ? { lane: lane.value } : {}),
      ...(sources.value !== undefined ? { sources: sources.value } : {}),
    });
  }

  const edgesRaw = readArray(raw, 'edges', path + ' 的根对象', 'required');
  if (!edgesRaw.ok) return bad(edgesRaw.message, 'edges');
  const edges: MapEdge[] = [];
  for (const [i, item] of edgesRaw.value.entries()) {
    const where = 'edges[' + String(i) + ']';
    if (!isRecord(item)) return bad(path + ' 的 ' + where + ' 必须是对象（现在是 ' + describeValue(item) + '）', where);
    const unk = unknownKeysError(item, EDGE_FIELDS, where);
    if (unk !== undefined) return bad(path + '：' + unk, where);
    const from = requireId(item, 'from', where);
    if (!from.ok) return bad(path + ' 的 ' + from.message, where);
    const to = requireId(item, 'to', where);
    if (!to.ok) return bad(path + ' 的 ' + to.message, where);
    const label = optionalText(item, 'label', where, LABEL_MAX);
    if (!label.ok) return bad(path + ' 的 ' + label.message, where);
    edges.push({ from: from.value, to: to.value, ...(label.value !== undefined ? { label: label.value } : {}) });
  }

  const context = readContext(raw, 'context', path + ' 的根对象');
  if (!context.ok) return bad(context.message, 'context');

  const page: MapPage = {
    id,
    title: title.value,
    ...(kind.value !== undefined ? { kind: kind.value } : {}),
    layers,
    groups,
    lanes,
    nodes,
    edges,
    ...(context.value !== undefined ? { context: context.value } : {}),
  };

  // 解析的最后一步就是整页不变式（P1）：文件形状对 ≠ 结构对。
  const check = validatePage(page);
  if (!check.ok) {
    return err(
      'INVALID_STORE',
      path + ' 违反结构不变式：' + check.error.message,
      '手改的文件要按 §2 的七条不变式改对；坏文件不会被静默修正，也不会被下一次保存悄悄改写',
      { refused: check.error },
    );
  }
  return ok(page);
}

/** 解析文本（剥 BOM + JSON.parse + 严格形状）。JSON 语法错也是 INVALID_STORE。 */
export function parsePageText(text: string, path: string, id: string): Res<MapPage> {
  let raw: unknown;
  try {
    raw = JSON.parse(stripBom(text));
  } catch (e) {
    return err(
      'INVALID_STORE',
      path + ' 不是合法 JSON：' + (e instanceof Error ? e.message : String(e)),
      '手改过的文件先过一遍 JSON 校验；拿不准就删掉重建',
    );
  }
  return parsePage(raw, path, id);
}
