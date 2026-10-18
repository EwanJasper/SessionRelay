// sources sha256 对账（契约 §3 `checkSources` + §6 开销预算）。
//
// 干什么：把"节点声称的证据源"与"磁盘上现在的字节"对一次账，逐节点给三态：
//   unchanged = 有基线，且现在还对得上；
//   changed   = 有基线，但现在对不上了（含文件没了——基线在、东西不在，这就是变了）；
//   unknown   = 判不了（没基线 / 项目外路径 / 超过 8MiB / 读不到）。
//
// 为什么 changed 必须要求"有基线"：changed 的语义是「我们手里有指纹，而它不再匹配」。
//   没有 sha256 的 source 从来无法比对——把它算成 changed，等于对一堆**从没验证过**的节点
//   打「⛔ 待复验」；假警报一多，真警报就被忽略（这是本项目最贵的一种失败）。
//   所以：无基线 ⇒ unknown，与文件在不在无关。
//
// 为什么"读不到"是 unknown 而不是 changed：读不到是**观察失败**，不是"内容变了"。
//   两者都不该被当成通过，但混成一个状态就等于在报告里编造观察。
//
// 为什么缓存 key 是「项目相对路径」而不是绝对路径：源码树会搬家、会被克隆，
//   绝对路径进缓存 = 换个目录全量重算，而缓存的全部意义就是**别重算**；
//   相对路径也正好是地图里 sources[].path 的形状（§2：便携、可跨机器比）。
//
// 缓存是**派生物**，与地图文件（人手也在改的真数据）不是一个物种：坏了就当没有，
//   绝不报错、绝不阻断。地图本身**只读**——本模块一个字都不写回页文件。

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  SOURCE_HASH_RULE,
  err,
  mapDirOf,
  ok,
  pageIdOf,
  pagePathOf,
  readPageIfExists,
  type MapNode,
  type MapPage,
  type Res,
  type SourceRef,
} from './index.js';

/** 单文件哈希上限：超过就记 unknown（§6 开销预算）。刚好等于 8MiB 的**照常算**，只拒"超过"。 */
export const HASH_MAX_BYTES = 8 * 1024 * 1024;

/** 缓存文件名。它不以 `<id>.json` 结尾，因此 listPages 的 id 语法过滤天然把它排除在外。 */
export const HASH_CACHE_NAME = '.hash-cache.json';

/** 缓存条目上限：防止项目改名/搬家后条目无限堆积（超出时保留本轮刚用过的）。 */
export const HASH_CACHE_MAX = 1024;

/** 单个 source 的对账结论。 */
export type SourceState = 'unchanged' | 'changed' | 'unknown';

/** 一个节点的对账结论（契约 §3）。 */
export interface ChangesNode {
  id: string;
  label: string;
  state: SourceState;
  /** 有基线但对不上的路径（按地图里的写法给，便于人一眼对上）。 */
  changed: string[];
  /** 判不了的路径，原因见模块头。 */
  unknown: string[];
  /** 受影响消费者：指着这个节点的**入边来源**（from 端）——它们依赖的东西变了。 */
  consumers: string[];
}

export interface ChangesReport {
  page: string;
  nodes: ChangesNode[];
}

/** 一条缓存条目：mtime + size 是"要不要重算"的判据，sha256 是上次算出来的结果。 */
export interface HashCacheEntry {
  mtimeMs: number;
  size: number;
  sha256: string;
}

export type HashCache = Record<string, HashCacheEntry>;

/** 路径判定的结果：项目内才读，项目外一律 unknown。 */
export interface InsideRoot {
  abs: string;
  inside: boolean;
  /** 规范化后的项目相对 POSIX 路径（缓存 key 就是它）。 */
  rel: string;
}

/**
 * 把 source.path 解析成绝对路径，并判定它是否**真的在项目内**。
 *
 * 为什么要单独一个可测的纯函数：地图解析器（§2）已经拒绝 `..`/绝对路径，于是这条分支
 * 在"合法地图"里**走不到**——但"走不到"不等于"不用写"：地图文件是人手也在改的，
 * 而这条分支一旦缺失，一个溜进来的 `../../etc/passwd` 就会被当成项目内文件读掉。
 * 所以它必须是独立可测的判据，而不是某处一个 `startsWith` 的直觉。
 */
export function resolveInsideRoot(root: string, rel: string): InsideRoot {
  const rootAbs = path.resolve(typeof root === 'string' ? root : '');
  const raw = typeof rel === 'string' ? rel : '';
  // 绝对路径（POSIX /）与 Windows 盘符（C:\ 或 C:/）、UNC（\\srv）一律当项目外：
  // 它们与 root 的比较没有"相对"可言。
  const absolute = raw.startsWith('/') || raw.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(raw);
  const abs = absolute ? path.resolve(raw) : path.resolve(rootAbs, raw);
  const back = path.relative(rootAbs, abs);
  const inside = !absolute && back !== '' && back !== '..' && !back.startsWith('..' + path.sep) && !path.isAbsolute(back);
  return { abs, inside, rel: back.split(path.sep).join('/') };
}

function errorText(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.replace(/\s+/g, ' ').trim().slice(0, 200);
}

function errnoOf(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : '';
}

export function hashCachePath(root: string): string {
  return path.join(mapDirOf(root), HASH_CACHE_NAME);
}

/**
 * 读缓存。**任何形状不对的条目直接丢掉**——缓存是加速器，不是数据源；
 * 为一条烂缓存报 INVALID_STORE，等于让一个纯优化把整条对账链拖挂。
 */
function loadCache(root: string): HashCache {
  const out: HashCache = {};
  let text: string;
  try {
    text = readFileSync(hashCachePath(root), 'utf8');
  } catch {
    return out;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return out;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
    const e = value as Record<string, unknown>;
    const mtimeMs = e['mtimeMs'];
    const size = e['size'];
    const sha256 = e['sha256'];
    if (typeof mtimeMs !== 'number' || !Number.isFinite(mtimeMs) || mtimeMs < 0) continue;
    if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) continue;
    if (typeof sha256 !== 'string' || !SOURCE_HASH_RULE.test(sha256)) continue;
    out[key] = { mtimeMs, size, sha256 };
  }
  return out;
}

/**
 * 写缓存。三条纪律：
 *   ① 先与磁盘上的现有条目**合并**——两个守护同时跑时，直接覆盖会吃掉对方刚算出来的热条目；
 *   ② 内容没变就**不写**（§6：无变化时 <20ms，"没变化还去写盘"是唯一能破坏这条预算的事）；
 *   ③ 失败一律吞掉：这只是个缓存，写不进去最多是下次多算一遍。
 */
function saveCache(root: string, entries: HashCache, touched: Set<string>): void {
  let merged: HashCache;
  try {
    merged = { ...loadCache(root), ...entries };
  } catch {
    merged = { ...entries };
  }
  let keys = Object.keys(merged);
  if (keys.length > HASH_CACHE_MAX) {
    const keep = keys.filter((k) => touched.has(k));
    const rest = keys.filter((k) => !touched.has(k));
    keys = [...keep, ...rest].slice(0, HASH_CACHE_MAX);
  }
  keys.sort();
  const slim: HashCache = {};
  for (const k of keys) {
    const e = merged[k];
    if (e !== undefined) slim[k] = e;
  }
  const text = JSON.stringify(slim, null, 2) + '\n';
  const file = hashCachePath(root);
  try {
    if (readFileSync(file, 'utf8') === text) return;
  } catch {
    /* 还没有缓存文件，正常 */
  }
  const tmp = file + '.tmp-' + String(process.pid);
  try {
    mkdirSync(mapDirOf(root), { recursive: true });
    writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, file);
  } catch {
    try {
      unlinkSync(tmp);
    } catch {
      /* 临时文件可能压根没建起来 */
    }
  }
}

/** 一个 source 的对账（含缓存的读与回填）。reason 只进内存，不进报告。 */
function classifySource(root: string, src: SourceRef, cache: HashCache, touched: Set<string>): SourceState {
  const place = resolveInsideRoot(root, typeof src?.path === 'string' ? src.path : '');
  if (!place.inside) return 'unknown'; // 项目外：不读，也不算"变了"
  const baseline = src?.sha256;
  if (typeof baseline !== 'string' || !SOURCE_HASH_RULE.test(baseline)) return 'unknown'; // 无基线
  let size = 0;
  let mtimeMs = 0;
  try {
    const st = statSync(place.abs);
    if (!st.isFile()) return 'unknown'; // 目录/FIFO/设备：读不出"内容"，不是 changed
    size = st.size;
    mtimeMs = st.mtimeMs;
  } catch (e) {
    // 文件没了 = 东西变了（基线还在，它却不在了）；其余 stat 失败是观察失败。
    return errnoOf(e) === 'ENOENT' ? 'changed' : 'unknown';
  }
  if (size > HASH_MAX_BYTES) return 'unknown'; // 超过 8MiB：宁可说不知道，也不每轮读 8MiB
  const hit = cache[place.rel];
  let got: string | undefined;
  if (hit !== undefined && hit.size === size && hit.mtimeMs === mtimeMs) got = hit.sha256;
  if (got === undefined) {
    try {
      got = createHash('sha256').update(readFileSync(place.abs)).digest('hex');
    } catch {
      return 'unknown'; // 读不到：观察失败
    }
    cache[place.rel] = { mtimeMs, size, sha256: got };
    touched.add(place.rel);
  }
  return got === baseline ? 'unchanged' : 'changed';
}

/** 入边来源：谁指着这个节点（§3 consumers）。边的方向是 from → to（from 使用 to）。 */
function consumersOf(page: MapPage): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const e of page.edges) {
    if (typeof e?.from !== 'string' || typeof e?.to !== 'string') continue;
    const list = out.get(e.to) ?? [];
    if (!list.includes(e.from)) list.push(e.from);
    out.set(e.to, list);
  }
  return out;
}

function sourcesOf(node: MapNode): SourceRef[] {
  return Array.isArray(node?.sources) ? node.sources : [];
}

/**
 * 逐节点核对 sources[].sha256（契约 §3）。
 *
 * `ids` 给定时只报这些节点（`[]` 视为"没给过滤"，与 CLI 的 `--id` 缺省同义）。
 * **没有 sources 的节点算 unchanged**：它没有做出任何证据声明，也就无从"对不上账"；
 * 把它算 unknown 会让一张刚从 progress.md 导入的地图满屏"未知"，把真问题淹掉。
 *
 * 只读：除了 .hash-cache.json（纯派生物）之外，不写任何东西，更不改地图文件。
 * 不抛：预期失败是返回值，意外异常也被兜成 INVALID_STORE——看板与守护都调这条链，
 * 一次抛就会打断整轮采集。
 */
export function checkSources(root: string, page?: string, ids?: string[]): Res<ChangesReport> {
  try {
    if (typeof root !== 'string' || root === '') {
      return err('INVALID_ARGUMENT', 'checkSources 需要一个项目根目录（现在是 ' + String(root) + '）');
    }
    const got = readPageIfExists(root, page);
    if (!got.ok) return { ok: false, error: got.error };
    if (got.value === undefined) {
      return err(
        'NOT_FOUND',
        '还没有这个地图页：' + pagePathOf(root, pageIdOf(page)),
        '先跑 srelay map init（或 map apply 建页）；check 只对账，不建图',
      );
    }
    const pg = got.value.page;
    const wanted = Array.isArray(ids) && ids.length > 0 ? new Set(ids.filter((i) => typeof i === 'string')) : undefined;
    const nodes = pg.nodes.filter((n) => wanted === undefined || wanted.has(n.id));
    const consumers = consumersOf(pg);
    const cache = loadCache(root);
    const touched = new Set<string>();
    const report: ChangesNode[] = [];
    for (const n of nodes) {
      const changed: string[] = [];
      const unknown: string[] = [];
      for (const s of sourcesOf(n)) {
        const state = classifySource(root, s, cache, touched);
        const shown = typeof s?.path === 'string' ? s.path : String(s?.path);
        if (state === 'changed' && !changed.includes(shown)) changed.push(shown);
        if (state === 'unknown' && !unknown.includes(shown)) unknown.push(shown);
      }
      report.push({
        id: n.id,
        label: n.label,
        state: changed.length > 0 ? 'changed' : unknown.length > 0 ? 'unknown' : 'unchanged',
        changed,
        unknown,
        consumers: consumers.get(n.id) ?? [],
      });
    }
    if (touched.size > 0) saveCache(root, cache, touched);
    return ok({ page: pg.id, nodes: report });
  } catch (e) {
    return err(
      'INVALID_STORE',
      'sources 对账出了意外（已兜住，不向外抛）：' + errorText(e),
      '把这条消息连同 .sessionrelay/map/ 下的文件一起报给维护者',
    );
  }
}
