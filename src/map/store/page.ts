// 页的读写、列表与初始化：\`<root>/.sessionrelay/map/<page>.json\`（默认页就是 map.json）。
//
// 页 id 从**文件名**来，不是文件里的字段（契约 §2）：这样"一个努力 = 一个文件"，
// 两个会话各写各的页时永远不会互相覆盖——每次保存都是整文件 rename，读者只看到旧或新。
//
// revision 为什么是"规范化 JSON 的 sha256"而不是文件字节的 sha256：
//   ① 手改过格式（换缩进、挪键序）但逻辑没变时 revision 不该变，否则 expectedRevision 会假冲突；
//   ② 规范化之后，读到的 revision 与下一次写出去的 revision 必然一致，冲突检测才有意义。
//
// 坏页**大声失败**，不静默跳过：listPages 少报一个页会让人以为"地图没了"，
// 而本仓库的纪律是"绝不静默什么都不做"。看板/守护那条链另有兜底（§5：任何地图错误都返回空 rows）。

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import {
  MAP_ID_RULE,
  MAP_ID_RULE_TEXT,
  emptyPage,
  err,
  mapIdError,
  ok,
  type MapPage,
  type Res,
} from '../domain/types.js';
import { LABEL_MAX, textError } from '../semantics/validate.js';
import { errnoOf, writeFileAtomic } from './atomic.js';
import { parsePageText, revisionOf, serializePage } from './format.js';
import { withMapLock } from './lock.js';

/** 地图目录名：\`<root>/.sessionrelay/map\`。 */
export const MAP_DIR_NAME = 'map';
/** 默认页 id（就是 map.json）。 */
export const DEFAULT_PAGE = 'map';

export function mapDirOf(root: string): string {
  return path.join(root, '.sessionrelay', MAP_DIR_NAME);
}

export function pageIdOf(page?: string): string {
  return page === undefined || page === '' ? DEFAULT_PAGE : page;
}

/**
 * 页文件的路径。
 * ⚠️ 调用方**必须先过 mapIdError**：页 id 是路径的一部分，未校验的 id 能靠 \`..\` 走到地图目录外。
 * 本模块所有入口（readPage/readPageIfExists/listPages/initMap）以及 applyPatch 都做了这件事。
 */
export function pagePathOf(root: string, page?: string): string {
  return path.join(mapDirOf(root), pageIdOf(page) + '.json');
}

export interface PageRead {
  page: MapPage;
  /** 规范化 JSON 的 sha256。 */
  revision: string;
  path: string;
}

/**
 * 读一个页；**文件不存在不是错误**（返回 undefined）。
 *
 * 为什么要把这个语义单独给出来：看板投影（§5）与 applyPatch 都要区分"还没有地图"
 * 和"地图坏了"——前者是正常状态（项目还没建图），后者要大声报出来。
 */
export function readPageIfExists(root: string, page?: string): Res<PageRead | undefined> {
  const id = pageIdOf(page);
  const idErr = mapIdError(id, '页 id');
  if (idErr !== undefined) {
    return err('INVALID_ARGUMENT', idErr, '页 id 只认 ' + MAP_ID_RULE_TEXT + '（如 map / core / map-store）');
  }
  const file = pagePathOf(root, id);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    const code = errnoOf(e);
    if (code === 'ENOENT') return ok(undefined);
    return err('INVALID_STORE', '读不了页文件 ' + file + '：' + code, '检查文件权限；它可能是个目录，或被别的进程独占', {
      path: file,
      errno: code,
    });
  }
  const parsed = parsePageText(text, file, id);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  return ok({ page: parsed.value, revision: revisionOf(parsed.value), path: file });
}

/** 读一个页；不存在 → NOT_FOUND（带"先 init"的建议动作）。 */
export function readPage(root: string, page?: string): Res<PageRead> {
  const got = readPageIfExists(root, page);
  if (!got.ok) return { ok: false, error: got.error };
  if (got.value === undefined) {
    return err('NOT_FOUND', '还没有这个地图页：' + pagePathOf(root, pageIdOf(page)), '先跑 srelay map init；或直接 map apply 建页');
  }
  return ok(got.value);
}

/**
 * 列出所有页。默认页排最前，其余按 id 字典序。
 * 为什么默认页在最前：它就是"那张图"，列在最后会让人以为没有地图。
 */
export function listPages(
  root: string,
): Res<Array<{ id: string; title: string; revision: string; nodes: number; edges: number }>> {
  const dir = mapDirOf(root);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (e) {
    const code = errnoOf(e);
    if (code === 'ENOENT') return ok([]); // 目录还没建：没有页，不是坏
    return err('INVALID_STORE', '读不了地图目录 ' + dir + '：' + code, '检查目录权限', { path: dir, errno: code });
  }
  // 只认 <id>.json：.hash-cache.json、map.json.lock、map.json.bak 都不匹配 id 语法，因此天然被排除
  const ids = entries
    .filter((name) => name.endsWith('.json') && MAP_ID_RULE.test(name.slice(0, -'.json'.length)))
    .map((name) => name.slice(0, -'.json'.length));
  ids.sort((a, b) => (a === DEFAULT_PAGE ? -1 : b === DEFAULT_PAGE ? 1 : a < b ? -1 : a > b ? 1 : 0));
  const out: Array<{ id: string; title: string; revision: string; nodes: number; edges: number }> = [];
  for (const id of ids) {
    const got = readPage(root, id);
    // 一个坏页不能变成一声不响的"没这个页"（那正是本仓库最嫌恶的静默失效）
    if (!got.ok) return { ok: false, error: got.error };
    out.push({
      id,
      title: got.value.page.title,
      revision: got.value.revision,
      nodes: got.value.page.nodes.length,
      edges: got.value.page.edges.length,
    });
  }
  return ok(out);
}

/**
 * 建空地图（默认页）。**已存在 → CONFLICT，绝不覆盖**：那是人手也在改的文件。
 * 标题必填（CLI 省略 --title 时取项目目录名，兜默认是 CLI 的事，不是库的）。
 */
export function initMap(root: string, title: string): Res<{ path: string }> {
  const titleErr = textError(title, 'title', LABEL_MAX);
  if (titleErr !== undefined) {
    return err('INVALID_ARGUMENT', titleErr, '标题是给人看的第一行字：1-120 字、不含控制字符');
  }
  const file = pagePathOf(root, DEFAULT_PAGE);
  return withMapLock(file, () => {
    if (existsSync(file)) {
      return err('CONFLICT', '地图已存在：' + file, '绝不覆盖人手改过的地图；要改内容请用 map apply');
    }
    const written = writeFileAtomic(file, serializePage(emptyPage(DEFAULT_PAGE, title)));
    if (!written.ok) return { ok: false, error: written.error };
    return ok({ path: file });
  });
}
