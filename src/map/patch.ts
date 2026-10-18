// patch 信封的 zod schema（契约 §3 的 MapPatch / §4.1 的操作形状）。
//
// 为什么只在这里用 zod（片段内部不用）：片段里每个字段的判据必须与**文件解析**共用同一份
// （semantics/validate.ts 的字段表 + domain/ops.ts 的不变式）。在这里用 zod 再实现一遍形状，
// 两处判据就会漂移，而漂移的表现是"补丁能过、文件读不回来"或反过来。
// zod 在这里只回答三件事：必须是对象、键恰好这三个、operations 是 1..100 条 {op,data}。
//
// 为什么一律 strictObject：zod 的 object 默认会把未知键**丢掉**。在这个仓库里丢字段等于毁数据
// （写回时未知键就没了），所以未知键必须是错误。
//
// 为什么还是返回值：applyPatch 的调用方（CLI/守护）不该为了一个坏 JSON 去 try/catch。

import { z } from 'zod';
import { MAP_ID_RULE, MAP_ID_RULE_TEXT, err, ok, type Res } from './domain/types.js';
import { OPS_MAX } from './semantics/validate.js';
import type { MapPatch } from './store/apply.js';

export const mapOpSchema = z.strictObject({
  op: z.enum(['declare', 'update', 'remove']),
  data: z.record(z.string(), z.unknown()),
});

export const mapPatchSchema = z.strictObject({
  page: z.string().regex(MAP_ID_RULE, '页 id 只认 ' + MAP_ID_RULE_TEXT).optional(),
  expectedRevision: z.string().min(1, 'expectedRevision 不能是空串（要表达"文件不存在"请写 "absent"）').optional(),
  operations: z
    .array(mapOpSchema)
    .min(1, '一次 apply 至少一条操作（空事务没有意义）')
    .max(OPS_MAX, '一次 apply 最多 ' + String(OPS_MAX) + ' 条操作'),
});

/** 解析并校验一个 patch（任意 JSON 值）→ 类型化的 MapPatch，或 INVALID_ARGUMENT。 */
export function parseMapPatch(raw: unknown): Res<MapPatch> {
  const got = mapPatchSchema.safeParse(raw);
  if (got.success) return ok(got.data as MapPatch);
  const issues = got.error.issues.map((i) => ({
    where: i.path.map((p) => String(p)).join('.'),
    message: i.message,
  }));
  const first = issues[0];
  const detail = first === undefined ? '未知问题' : (first.where === '' ? '' : first.where + '：') + first.message;
  return err(
    'INVALID_ARGUMENT',
    'patch 信封不合法：' + detail,
    '写法见 §4.1：{"page"?:…,"expectedRevision"?:…,"operations":[{"op":"declare|update|remove","data":{…}}]}（1..' +
      String(OPS_MAX) + ' 条）',
    { issues },
  );
}

/** 解析 patch 文本（CLI 的 --file）：JSON 语法错也是 INVALID_ARGUMENT，绝不抛。 */
export function parsePatchText(text: string): Res<MapPatch> {
  let raw: unknown;
  try {
    raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (e) {
    return err(
      'INVALID_ARGUMENT',
      '--file 给的不是合法 JSON：' + (e instanceof Error ? e.message : String(e)),
      '用 --file - 从 stdin 读，或检查文件里是否有注释/尾逗号',
    );
  }
  return parseMapPatch(raw);
}
