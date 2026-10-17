// 页级元数据与「证据源」的判据：sources（源码指纹）与 context（summary/next/updated）。
//
// sources.path 为什么必须是相对项目根、正斜杠、不许穿越（..）：
//   ① 指纹的意义是「换机器、进仓库之后还能比」——绝对路径一比就全变成 changed，对账立刻失去意义；
//   ② path 是给人看的（看板明细列会写「⚠ 源码已变：<文件名>」），带盘符/反斜杠的路径在
//      markdown 表格里会被当成转义吃掉。
//
// context.updated 只做长度/控制字符检查，**不强制 ISO 格式**：它既不是排序键也不是判据，
// 强制格式只会把手改文件里一个无害的时间串打回去。
//
// 这一层的失败同样是返回值：读文件、读补丁都要能带着「哪儿不对」回去。

import {
  BODY_MAX,
  UPDATED_MAX,
  describeValue,
  isRecord,
  optionalText,
  readErr,
  readOk,
  textError,
  unknownKeysError,
  CONTEXT_FIELDS,
  SOURCE_FIELDS,
  type Read,
} from '../semantics/validate.js';
import { SOURCE_HASH_RULE, type MapContext, type SourceRef } from './types.js';

/** sources 条数上限：一条 source 一次 stat/hash，上百条已远超「一页该有的证据量」。 */
export const SOURCES_MAX = 100;
export const SOURCE_PATH_MAX = 1024;

const PATH_PATH_FORBIDDEN = /[\u0000-\u001f\u007f-\u009f\\:]/;

/** 单条 source.path 的判据；返回原因或 undefined。 */
export function sourcePathError(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return '必须是字符串（现在是 ' + describeValue(raw) + '）';
  if (raw.length === 0) return '不能为空';
  if (raw.length > SOURCE_PATH_MAX) return '超长：上限 ' + String(SOURCE_PATH_MAX) + ' 字';
  if (PATH_PATH_FORBIDDEN.test(raw)) {
    return '不能含控制字符、反斜杠或冒号（要相对项目根的 POSIX 路径，如 src/map/store/atomic.ts）';
  }
  if (raw.startsWith('/')) return '必须是相对路径（不能以 / 开头）';
  if (raw.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) {
    return '不能有空的、"." 或 ".." 路径段（不许穿越到项目外）';
  }
  return undefined;
}

/** sources 数组的判据（契约 §2 的 SourceRef）。 */
export function sourcesError(raw: unknown, where = 'sources'): string | undefined {
  if (!Array.isArray(raw)) return where + ' 必须是数组（现在是 ' + describeValue(raw) + '）';
  if (raw.length > SOURCES_MAX) return where + ' 最多 ' + String(SOURCES_MAX) + ' 条（现在 ' + String(raw.length) + ' 条）';
  for (const [i, item] of raw.entries()) {
    const at = where + '[' + String(i) + ']';
    if (!isRecord(item)) return at + ' 必须是对象（现在是 ' + describeValue(item) + '）';
    const unk = unknownKeysError(item, SOURCE_FIELDS, at);
    if (unk !== undefined) return unk;
    const pe = sourcePathError(item['path']);
    if (pe !== undefined) return at + '.path ' + pe;
    const hash = item['sha256'];
    if (hash !== undefined && (typeof hash !== 'string' || !SOURCE_HASH_RULE.test(hash))) {
      return at + '.sha256 必须是小写 64 位十六进制（现在是 ' + describeValue(hash) + '）';
    }
  }
  return undefined;
}

/** context 的判据（契约 §3 的 MapContext）。 */
export function contextError(raw: unknown, where = 'context'): string | undefined {
  if (!isRecord(raw)) return where + ' 必须是对象（现在是 ' + describeValue(raw) + '）';
  const unk = unknownKeysError(raw, CONTEXT_FIELDS, where);
  if (unk !== undefined) return unk;
  for (const key of ['summary', 'next'] as const) {
    if (raw[key] === undefined) continue;
    const e = textError(raw[key], where + '.' + key, BODY_MAX);
    if (e !== undefined) return e;
  }
  if (raw['updated'] !== undefined) {
    const e = textError(raw['updated'], where + '.updated', UPDATED_MAX);
    if (e !== undefined) return e;
  }
  return undefined;
}

/**
 * 从对象里读 sources。
 * @param allowNull - 补丁里 null = 清掉证据源（§4.1）；文件里 null 是写坏了。
 */
export function readSources(
  rec: Record<string, unknown>,
  key: string,
  where: string,
  allowNull = false,
): Read<SourceRef[] | undefined> {
  const raw = rec[key];
  if (raw === undefined) return readOk(undefined);
  if (raw === null) {
    return allowNull
      ? readOk(undefined)
      : readErr(where + '.' + key + ' 不能是 null（要清掉就删掉这个键）');
  }
  const e = sourcesError(raw, where + '.' + key);
  return e === undefined ? readOk(raw as SourceRef[]) : readErr(e);
}

/** 从对象里读 context（null 由 allowNull 决定是「清掉」还是「写坏了」）。 */
export function readContext(
  rec: Record<string, unknown>,
  key: string,
  where: string,
  allowNull = false,
): Read<MapContext | undefined> {
  const raw = rec[key];
  if (raw === undefined) return readOk(undefined);
  if (raw === null) {
    return allowNull
      ? readOk(undefined)
      : readErr(where + '.' + key + ' 不能是 null（要清掉就删掉这个键）');
  }
  const e = contextError(raw, where + '.' + key);
  return e === undefined ? readOk(raw as MapContext) : readErr(e);
}

/** 供 ops 复用：可选短文本（与 optionalText 同义，起个地图内的名字避免读者跨模块找）。 */
export { optionalText };
