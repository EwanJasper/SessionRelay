// applyPatch：唯一的主写入口（契约 §3 + §4.1）。
//
// 事务语义：1..100 条操作**在草稿上顺序执行** → 校验最终图 → 一次落盘。
// 因此在"第 2 条被拒"时磁盘上一个字节都没动过（拒绝不改文件字节，是这条链的核心承诺）。
//
// 为什么可以在最后才校验整体：§4.1 明确允许"同批内先声明边再声明端点"——
// 逐条全量校验会把这条正当用法打回去。逐条只判它自己需要的身份（改/删找得到目标吗）。
//
// 为什么读不出当前页就拒绝而不是"当空页重写"：坏文件是**数据**，不是要被覆盖的错误。
// 把坏文件当成空页继续写，等于用一次 apply 悄悄删掉别人手改的内容。
//
// 锁的粒度是页不是项目：两个会话各写各的页，永远不该互相 BUSY。

import { readFileSync } from 'node:fs';
import {
  emptyPage,
  err,
  mapIdError,
  ok,
  MAP_ID_RULE_TEXT,
  type MapError,
  type MapPage,
  type Res,
} from '../domain/types.js';
import { OPS_MAX, isRecord, unknownKeysError } from '../semantics/validate.js';
import { applyMapOp, validatePage } from '../domain/ops.js';
import { revisionOf, serializePage } from './format.js';
import { withMapLock } from './lock.js';
import { pageIdOf, pagePathOf, readPageIfExists } from './page.js';
import { writeFileAtomic } from './atomic.js';

/** 一次 apply 的全部输入（CLI 的 --file 就是它）。 */
export interface MapPatch {
  /** 省略 = 默认页。 */
  page?: string;
  /** 'absent' = 文件必须不存在；省略 = 只串行化不校验。 */
  expectedRevision?: string | 'absent';
  /** 1..100 条。 */
  operations: Array<{ op: 'declare' | 'update' | 'remove'; data: unknown }>;
}

const PATCH_FIELDS = ['page', 'expectedRevision', 'operations'] as const;

/**
 * 应用一批操作。
 *
 * @param root - 项目根（页文件在 \`<root>/.sessionrelay/map/\`）。
 * @returns 新的 revision、成功的操作条数、以及落盘后的整页（调用方不必再读一次）。
 */
export function applyPatch(
  root: string,
  patch: MapPatch,
): Res<{ revision: string; applied: number; page: MapPage }> {
  if (!isRecord(patch)) {
    return err('INVALID_ARGUMENT', 'patch 必须是一个对象', '形如 {"operations":[{"op":"declare","data":{…}}]}');
  }
  const unk = unknownKeysError(patch as Record<string, unknown>, PATCH_FIELDS, 'patch');
  if (unk !== undefined) return err('INVALID_ARGUMENT', unk, 'patch 的键只有 page / expectedRevision / operations');

  const ops = (patch as { operations?: unknown }).operations;
  if (!Array.isArray(ops)) {
    return err('INVALID_ARGUMENT', 'patch.operations 必须是数组', '一次 apply 就是一次事务：1..' + String(OPS_MAX) + ' 条操作');
  }
  if (ops.length === 0) {
    return err('INVALID_ARGUMENT', 'patch.operations 是空数组', '空事务没有意义：要读图用 map read');
  }
  if (ops.length > OPS_MAX) {
    return err(
      'INVALID_ARGUMENT',
      'patch.operations 有 ' + String(ops.length) + ' 条，超过上限 ' + String(OPS_MAX),
      '拆成几次 apply：一次事务越大，冲突时的重做成本越高',
    );
  }

  const pageArg = (patch as { page?: unknown }).page;
  if (pageArg !== undefined && typeof pageArg !== 'string') {
    return err('INVALID_ARGUMENT', 'patch.page 必须是字符串', '页 id 只认 ' + MAP_ID_RULE_TEXT);
  }
  const id = pageIdOf(pageArg as string | undefined);
  const idErr = mapIdError(id, '页 id');
  if (idErr !== undefined) {
    return err('INVALID_ARGUMENT', idErr, '页 id 只认 ' + MAP_ID_RULE_TEXT + '（如 map / core / map-store）');
  }

  const exp = (patch as { expectedRevision?: unknown }).expectedRevision;
  if (exp !== undefined && typeof exp !== 'string') {
    return err('INVALID_ARGUMENT', 'patch.expectedRevision 必须是字符串或 "absent"', '想表达"文件必须不存在"就写 "absent"');
  }
  if (exp === '') {
    return err('INVALID_ARGUMENT', 'patch.expectedRevision 是空串', '要么省略（只串行化不校验），要么给 map read 拿到的 revision');
  }

  const file = pagePathOf(root, id);
  return withMapLock(file, () => {
    const current = readPageIfExists(root, id);
    if (!current.ok) return { ok: false, error: current.error };
    const existing = current.value;

    if (exp === 'absent' && existing !== undefined) {
      return err(
        'CONFLICT',
        '页 "' + id + '" 已存在（expectedRevision 是 "absent"，要求文件不存在）：' + file,
        '先 map read 拿当前 revision，再决定是改内容还是换个页 id',
      );
    }
    if (typeof exp === 'string' && exp !== 'absent') {
      if (existing === undefined) {
        return err('CONFLICT', '页 "' + id + '" 还不存在，但 expectedRevision 给了一个 revision：' + file, '要新建就把 expectedRevision 写成 "absent"（或省略）');
      }
      if (existing.revision !== exp) {
        return err(
          'CONFLICT',
          '页 "' + id + '" 的 revision 已经变了：期望 ' + exp + '，实际 ' + existing.revision,
          '重新 map read 拿最新 revision 再改——用旧 revision 硬写会覆盖别人的改动，所以这里拒绝',
          { expected: exp, actual: existing.revision },
        );
      }
    }

    // 文件不存在时从空页起手：title 缺省 = 页 id（一条 declare 片段就能建页，§4.1）
    let draft: MapPage = existing !== undefined ? existing.page : emptyPage(id, id);
    // 页还不存在就来 update/remove → NOT_FOUND（§4.3）。为什么要在循环外单判一次：
    // 一条空片段（data:{})在空页上是"无操作"，会**凭空建出一个空页**——"我没有要建页"
    // 却多出一个文件，正是本仓库最嫌恶的静默副作用。declare 落地之后，同一批里的 update 照常放行。
    let created = existing !== undefined;
    for (const [i, op] of ops.entries()) {
      const opName = isRecord(op) && typeof op.op === 'string' ? op.op : undefined;
      if (!created && (opName === 'update' || opName === 'remove')) {
        return err(
          'NOT_FOUND',
          '页 "' + id + '" 还不存在，第 ' + String(i + 1) + ' 条操作却要 ' + opName + '：' + file,
          '要建页就先写一条 declare（或 map init）：update/remove 只能作用于已存在的对象',
        );
      }
      const got = applyMapOp(draft, op);
      if (!got.ok) {
        const e: MapError = got.error;
        return err(
          e.code,
          '第 ' + String(i + 1) + ' 条操作被拒：' + e.message,
          e.hint,
          { opIndex: i, ...(isRecord(e.details) ? e.details : e.details !== undefined ? { cause: e.details } : {}) },
        );
      }
      draft = got.value;
      if (opName === 'declare') created = true;
    }

    const checked = validatePage(draft);
    if (!checked.ok) {
      return err('REFUSED', '操作全部执行后最终图不合法：' + checked.error.message, checked.error.hint);
    }

    const text = serializePage(draft);
    if (existing !== undefined) {
      try {
        if (readFileSync(file, 'utf8') === text) {
          // 内容一字未变：不写。省掉一次 rename，也让"跑两次无变化"在文件时间戳上真的没变化
          return ok({ revision: existing.revision, applied: ops.length, page: draft });
        }
      } catch {
        // 读不回来就直接写：写不会比读更危险（写是原子的）
      }
    }
    const written = writeFileAtomic(file, text);
    if (!written.ok) return { ok: false, error: written.error };
    return ok({ revision: revisionOf(draft), applied: ops.length, page: draft });
  });
}
