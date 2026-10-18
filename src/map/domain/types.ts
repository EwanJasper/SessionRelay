// 地图层第 0 层：类型 + 判据（id / rank / status）+ 统一返回。
//
// 这一层只放**判据**；把判据组合起来的不变式（层存在、边严格向下、节点与分组共用
// 一个命名空间…）在 domain/ops.ts 的 validatePage 里判一次——同一件事判两遍必然漂移。
//
// 为什么不用 brand 类型（mellos 用了）：契约 §3 把接口冻结成裸 string
// （\`MapLayer { id: string }\`），照抄 brand 会让 T2/T3 的每个调用点都得 unwrap 一次，
// 而真正需要把关的是**边界**（文件解析 / 补丁片段），那里用的是这里的 mapIdError 判据。
//
// 为什么不抛异常：预期失败（结构坏了、文件不在、锁被占）都是返回值。看板与守护路径
// 每一轮都会读地图，一次抛就把整轮采集打断——账本的失败绝不许外溢成守护的失败。

/** 状态闭合词表（契约 §2.5）。转换不做裁决：账本记录事实，不当法官。 */
export const MAP_STATUSES = ['todo', 'doing', 'blocked', 'done', 'regressed'] as const;
export type MapStatus = 'todo' | 'doing' | 'blocked' | 'done' | 'regressed';

/** id 语法（页 id、层、组、泳道、节点共用一套）。 */
export const MAP_ID_RULE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const MAP_ID_RULE_TEXT = '小写字母/数字/短横线，首位必须是字母或数字，1-64 位';

/** rank 范围：0 = 最底层（最基础的一层）。 */
export const MAP_RANK_MIN = 0;
export const MAP_RANK_MAX = 99;

/** 证据源指纹只认小写 64 位十六进制：大小写混写会让「同一次哈希」在字符串比较里不相等。 */
export const SOURCE_HASH_RULE = /^[a-f0-9]{64}$/;

export interface MapLayer {
  id: string;
  name: string;
  /** 0..99 的整数，0 在最下；边只能严格向下 ⇒ 图天生无环。 */
  rank: number;
}

export interface MapGroup {
  id: string;
  label: string;
  layer: string;
}

export interface MapLane {
  id: string;
  label: string;
}

/** 便携的证据源引用：路径相对项目根、正斜杠；sha256 缺省 = 还没对过账。 */
export interface SourceRef {
  path: string;
  sha256?: string;
}

export interface MapNode {
  id: string;
  label: string;
  layer: string;
  status: MapStatus;
  /** 完成时的验证证据，或回归时观察到的坏法。 */
  evidence?: string;
  /** 设计说明：职责、契约、关键取舍。 */
  detail?: string;
  group?: string;
  lane?: string;
  sources?: SourceRef[];
}

/** \`from → to\` 表示「from 使用 to」，必须严格指向下层（契约 §2.3）。 */
export interface MapEdge {
  from: string;
  to: string;
  label?: string;
}

export interface MapContext {
  summary?: string;
  next?: string;
  /** 时间串；只做长度/控制字符检查，不强制 ISO 格式（它不是排序键也不是判据）。 */
  updated?: string;
}

export interface MapPage {
  /** 页 id：不是文件里的字段，由文件名给出（默认页 = "map"）。 */
  id: string;
  title: string;
  kind?: string;
  layers: MapLayer[];
  groups: MapGroup[];
  lanes: MapLane[];
  nodes: MapNode[];
  edges: MapEdge[];
  context?: MapContext;
}

export type MapErrorCode =
  | 'NOT_FOUND'
  | 'INVALID_STORE'
  | 'REFUSED'
  | 'CONFLICT'
  | 'BUSY'
  | 'LOCK_UNAVAILABLE'
  | 'INVALID_ARGUMENT'
  | 'SAVE_FAILED';

export interface MapError {
  code: MapErrorCode;
  message: string;
  /** 建议动作：CLI 侧作为 stderr 那行的括号内容（契约 §4）。 */
  hint?: string;
  details?: unknown;
}

export type Res<T> = { ok: true; value: T } | { ok: false; error: MapError };

export const ok = <T>(value: T): { ok: true; value: T } => ({ ok: true, value });

export const err = (
  code: MapErrorCode,
  message: string,
  hint?: string,
  details?: unknown,
): { ok: false; error: MapError } => ({
  ok: false,
  error: {
    code,
    message,
    ...(hint !== undefined ? { hint } : {}),
    ...(details !== undefined ? { details } : {}),
  },
});

/** 结构拒绝的统一出口（契约 §2：不变式违反即拒，码是 REFUSED）。 */
export const refused = (message: string, hint?: string, details?: unknown) =>
  err('REFUSED', message, hint, details);

function typeName(v: unknown): string {
  if (v === undefined) return '未给';
  if (v === null) return 'null';
  if (Array.isArray(v)) return '数组';
  return typeof v === 'object' ? '对象' : typeof v;
}

export function mapIdError(raw: unknown, where = 'id'): string | undefined {
  if (typeof raw !== 'string') return where + ' 必须是字符串（现在是 ' + typeName(raw) + '）';
  return MAP_ID_RULE.test(raw)
    ? undefined
    : where + ' 不符合 id 语法（' + MAP_ID_RULE_TEXT + '）："' + raw + '"';
}

export function mapRankError(raw: unknown): string | undefined {
  if (typeof raw !== 'number') return '必须是数字（现在是 ' + typeName(raw) + '）';
  if (!Number.isInteger(raw)) return '必须是 0..99 的整数（现在是 ' + String(raw) + '）';
  if (raw < MAP_RANK_MIN || raw > MAP_RANK_MAX) {
    return '越界：' + String(raw) + ' 不在 ' + String(MAP_RANK_MIN) + '..' + String(MAP_RANK_MAX) + '（0 = 最底层）';
  }
  return undefined;
}

export function isMapStatus(v: unknown): v is MapStatus {
  return typeof v === 'string' && (MAP_STATUSES as readonly string[]).includes(v);
}

export function mapStatusError(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return '必须是字符串（现在是 ' + typeName(raw) + '）';
  return isMapStatus(raw)
    ? undefined
    : 'status "' + raw + '" 不在闭合词表里（' + MAP_STATUSES.join(' | ') + '）';
}

/** 一行人类可读的错误，供 CLI stderr / 日志（契约 §4：\`错误码：说明（建议动作）\`）。 */
export function errorLine(e: MapError): string {
  return e.code + '：' + e.message + (e.hint !== undefined ? '（' + e.hint + '）' : '');
}

/** 空页：initMap 建的就是它，applyPatch 在文件不存在时也从它起手。 */
export function emptyPage(id: string, title: string): MapPage {
  return { id, title, layers: [], groups: [], lanes: [], nodes: [], edges: [] };
}
