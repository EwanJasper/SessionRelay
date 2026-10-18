// 地图层的「形状卫生」判据：未知字段 / 控制字符 / 超长 —— 全系统只在这里判一次。
//
// 为什么单列一个模块：三条入口都要判同一套规则——文件解析（store/format.ts）、补丁片段
// （domain/ops.ts）、页元数据（domain/context.ts）。散成三份的下场是第一天一致、第二天漂移，
// 而这类漂移的表现恰好是「手改的文件被静默改写」：本仓库最嫌恶的那种故障。
//
// 为什么返回 \`string | undefined\`（原因文案）而不是 Res：这一层不认识错误码。
// 文件坏要包成 INVALID_STORE，补丁违反不变式要包成 REFUSED，在这儿定码只会逼调用方再翻译一次。
//
// 为什么不上 zod：zod 只用于补丁**信封**（patch.ts）。地图文件是**人手也在改**的，
// 需要逐字段说清楚「哪儿不对」；zod 的 issue 列表在这里只会更绕。
//
// 为什么字段表（*_FIELDS）住这里：文件解析与补丁片段允许的键**必须是同一份**，否则
// 「文件只认 A、补丁只认 B」会在两条入口之间开出一条静默丢字段的缝。

import { mapIdError, mapRankError, mapStatusError, type MapStatus } from '../domain/types.js';

/** 这一层的返回：失败是一句「哪儿不对」的原因文案，不是一个异常。 */
export type Read<T> = { ok: true; value: T } | { ok: false; message: string };
export const readOk = <T>(value: T): Read<T> => ({ ok: true, value });
export const readErr = (message: string): Read<never> => ({ ok: false, message });

/** 短标签（label/name/title/kind）的长度上限（契约 §2.6）。 */
export const LABEL_MAX = 120;
/** 自由文本（detail/evidence/summary/next）的长度上限（契约 §2.6）。 */
export const BODY_MAX = 2000;
/** context.updated 的上限：它是个时间串，不是自由文本。 */
export const UPDATED_MAX = 64;
/** 一次 applyPatch 的操作数上限（契约 §4.1）。 */
export const OPS_MAX = 100;

/**
 * 控制字符判据。
 *
 * ⚠️ 故意**放行** \t(09) 与 \n(0a)，却拒绝 \r(0d)：证据/明细本来就是多行文本，一刀切会把
 * 手写的换行也打回去；而 \r 只会在 CRLF 混进来时出现——放它进来会让「同一份逻辑内容」
 * 在 Windows 与 Linux 上算出**不同的 sha256**，于是 expectedRevision 莫名其妙地冲突
 * （revision 是规范化 JSON 的哈希，规范化就要求字节确定）。
 */
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;

export function hasControlChars(text: string): boolean {
  return CONTROL_CHARS.test(text);
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 失败文案里怎么称呼一个值——只说「类型不对」等于没说清哪儿不对。 */
export function describeValue(v: unknown): string {
  if (v === undefined) return '未给';
  if (v === null) return 'null';
  if (Array.isArray(v)) return '数组';
  return typeof v === 'object' ? '对象' : typeof v;
}

/** 文本判据：类型对、不超长、无控制字符。三件事一起说，调用方一次就能改对。 */
export function textError(value: unknown, where: string, max: number): string | undefined {
  if (typeof value !== 'string') return where + ' 必须是字符串（现在是 ' + describeValue(value) + '）';
  if (value.length > max) return where + ' 超长：上限 ' + String(max) + ' 字，现在 ' + String(value.length) + ' 字';
  if (hasControlChars(value)) return where + ' 含控制字符（制表符与换行以外一律拒绝：控制字符会毁掉 markdown 表格与终端输出）';
  return undefined;
}

/**
 * 未知字段判据（契约 §2.7）。
 * 永远是拒绝，不是丢弃：地图会被写回，静默丢掉一个手改的字段 = 毁掉手改的文件。
 */
export function unknownKeysError(
  rec: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
): string | undefined {
  const unknown = Object.keys(rec).filter((k) => !allowed.includes(k));
  if (unknown.length === 0) return undefined;
  return (
    where + ' 出现未知字段 ' + unknown.map((k) => '"' + k + '"').join('、') +
    '（允许的键：' + allowed.join('、') + '）—— 未知字段一律拒绝而不是丢弃：写回时丢掉它等于毁掉手改的文件'
  );
}

/**
 * 列表字段：absent 与 present-but-wrong-type 必须分开（把对象当空数组读会毁文件）。
 * 重载只说一件事：required 读出来一定不是 undefined——省掉调用点上一堆不可能的兜底分支，
 * 而"不可能的兜底"正是下一次有人把 \`?? []\` 当成真逻辑的开端。
 */
export function readArray(
  rec: Record<string, unknown>,
  key: string,
  where: string,
  presence: 'required',
): Read<unknown[]>;
export function readArray(
  rec: Record<string, unknown>,
  key: string,
  where: string,
  presence: 'optional',
): Read<unknown[] | undefined>;
export function readArray(
  rec: Record<string, unknown>,
  key: string,
  where: string,
  presence: 'required' | 'optional',
): Read<unknown[] | undefined> {
  const v = rec[key];
  if (Array.isArray(v)) return readOk(v);
  if (v === undefined) {
    return presence === 'optional' ? readOk(undefined) : readErr(where + '.' + key + ' 缺失：空列表要显式写 []，不写 = 结构不明');
  }
  return readErr(where + '.' + key + ' 必须是数组（现在是 ' + describeValue(v) + '）');
}

/** 对象数组字段：每个元素必须是一个对象（数组套数组是形状错，不是「没有内容」）。 */
export function readEntryArray(
  rec: Record<string, unknown>,
  key: string,
  where: string,
): Read<Array<Record<string, unknown>> | undefined> {
  const list = readArray(rec, key, where, 'optional');
  if (!list.ok) return list;
  if (list.value === undefined) return readOk(undefined);
  const out: Array<Record<string, unknown>> = [];
  for (const [i, item] of list.value.entries()) {
    if (!isRecord(item)) {
      return readErr(where + '.' + key + '[' + String(i) + '] 必须是对象（现在是 ' + describeValue(item) + '）');
    }
    out.push(item as Record<string, unknown>);
  }
  return readOk(out);
}

/** 必填文本字段（null 与缺失同样拒绝——必填就该有值）。 */
export function requireText(
  rec: Record<string, unknown>,
  key: string,
  where: string,
  max: number,
): Read<string> {
  const e = textError(rec[key], where + '.' + key, max);
  return e === undefined ? readOk(rec[key] as string) : readErr(e);
}

/**
 * 可选文本字段。
 * @param allowNull - 补丁里 null 表示「清掉这个字段」（契约 §4.1）；**文件里不允许**：
 *   文件是数据不是指令，null 留在文件里只说明它被写坏了。
 */
export function optionalText(
  rec: Record<string, unknown>,
  key: string,
  where: string,
  max: number,
  allowNull = false,
): Read<string | undefined> {
  const v = rec[key];
  if (v === undefined) return readOk(undefined);
  if (v === null) {
    return allowNull ? readOk(undefined) : readErr(where + '.' + key + ' 不能是 null（要清掉就删掉这个键）');
  }
  const e = textError(v, where + '.' + key, max);
  return e === undefined ? readOk(v as string) : readErr(e);
}

/** 必填 id：字符串 + 语法（语法判据住在 domain/types.ts，这里只负责从对象里取出来）。 */
export function requireId(rec: Record<string, unknown>, key: string, where: string): Read<string> {
  const raw = rec[key];
  const e = mapIdError(raw, where + '.' + key);
  return e === undefined ? readOk(raw as string) : readErr(e);
}

/** 可选 id（可选引用字段，如 node.group）。 */
export function optionalId(
  rec: Record<string, unknown>,
  key: string,
  where: string,
  allowNull = false,
): Read<string | undefined> {
  const v = rec[key];
  if (v === undefined) return readOk(undefined);
  if (v === null) {
    return allowNull ? readOk(undefined) : readErr(where + '.' + key + ' 不能是 null（要清掉就删掉这个键）');
  }
  const e = mapIdError(v, where + '.' + key);
  return e === undefined ? readOk(v as string) : readErr(e);
}

/** 必填 rank：数字 + 整数 + 0..99。 */
export function requireRank(rec: Record<string, unknown>, key: string, where: string): Read<number> {
  const raw = rec[key];
  const e = mapRankError(raw);
  if (e !== undefined) return readErr(where + '.' + key + '：' + e);
  return readOk(raw as number);
}

/** 可选 status：闭合词表，省略由调用方兜默认（declare 默认 todo）。 */
export function optionalStatus(
  rec: Record<string, unknown>,
  key: string,
  where: string,
): Read<MapStatus | undefined> {
  const v = rec[key];
  if (v === undefined) return readOk(undefined);
  const e = mapStatusError(v);
  return e === undefined ? readOk(v as MapStatus) : readErr(where + '.' + key + '：' + e);
}

// ── 允许的键：文件解析与补丁片段共用同一份（见模块头「为什么」） ──

/** 页文件根对象的键（契约 §2 的 JSON 示例）。 */
export const PAGE_FIELDS = ['version', 'title', 'kind', 'layers', 'groups', 'lanes', 'nodes', 'edges', 'context'] as const;
/** 补丁片段（declare/update 的 data）的键（契约 §4.1）。 */
export const FRAGMENT_FIELDS = ['title', 'kind', 'context', 'layers', 'groups', 'lanes', 'nodes', 'edges', 'laneOrder'] as const;
/** remove 的 data 只收身份选择器（契约 §4.1）。 */
export const REMOVE_FIELDS = ['nodes', 'groups', 'lanes', 'layers', 'edges'] as const;
export const LAYER_FIELDS = ['id', 'name', 'rank'] as const;
export const GROUP_FIELDS = ['id', 'label', 'layer'] as const;
export const LANE_FIELDS = ['id', 'label'] as const;
export const NODE_FIELDS = ['id', 'label', 'layer', 'status', 'evidence', 'detail', 'group', 'lane', 'sources'] as const;
export const EDGE_FIELDS = ['from', 'to', 'label'] as const;
/** 边补丁多两个改端点的键（契约 §4.1：边身份 = from+to，没有独立 edge id）。 */
export const EDGE_PATCH_FIELDS = ['from', 'to', 'label', 'newFrom', 'newTo'] as const;
export const CONTEXT_FIELDS = ['summary', 'next', 'updated'] as const;
export const SOURCE_FIELDS = ['path', 'sha256'] as const;
/** remove 里 nodes/groups/lanes/layers 选择器只认 id。 */
export const IDENTITY_FIELDS = ['id'] as const;
/** remove 里 edges 选择器只认 from+to。 */
export const EDGE_IDENTITY_FIELDS = ['from', 'to'] as const;
