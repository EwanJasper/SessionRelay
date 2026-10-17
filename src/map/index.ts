// 地图层对外出口（T2 CLI / T3 桥接只从这里 import）。
//
// 为什么逐个具名 re-export 而不是 \`export *\`：星号导出遇到重名会**静默丢掉**其中一个，
// 而"某个函数不在出口上"这种故障在调用点才炸，报错还指不到这里。

// ── 类型与统一返回 ──
export type {
  MapContext,
  MapEdge,
  MapError,
  MapErrorCode,
  MapGroup,
  MapLane,
  MapLayer,
  MapNode,
  MapPage,
  MapStatus,
  Res,
  SourceRef,
} from './domain/types.js';
export {
  MAP_ID_RULE,
  MAP_ID_RULE_TEXT,
  MAP_RANK_MAX,
  MAP_RANK_MIN,
  MAP_STATUSES,
  SOURCE_HASH_RULE,
  emptyPage,
  err,
  errorLine,
  isMapStatus,
  mapIdError,
  mapRankError,
  mapStatusError,
  ok,
  refused,
} from './domain/types.js';

// ── 形状判据（T2 校验自己的 CLI 参数时可以复用同一份规则） ──
export type { Read } from './semantics/validate.js';
export {
  BODY_MAX,
  LABEL_MAX,
  OPS_MAX,
  UPDATED_MAX,
  describeValue,
  hasControlChars,
  isRecord,
  readArray,
  readEntryArray,
  textError,
  unknownKeysError,
} from './semantics/validate.js';

// ── 页元数据与证据源 ──
export {
  SOURCES_MAX,
  SOURCE_PATH_MAX,
  contextError,
  readContext,
  readSources,
  sourcePathError,
  sourcesError,
} from './domain/context.js';

// ── 纯操作 ──
export type { MapOpInput, MapOpName } from './domain/ops.js';
export { applyMapOp, declareFragment, pageInvariantError, removeFragment, updateFragment, validatePage } from './domain/ops.js';

// ── 状态 → 看板字形（唯一一份，§5） ──
export {
  BOARD_STATUS_PREFIXES,
  MAP_MODULE,
  STATUS_GLYPHS,
  STATUS_LABELS,
  detailNote,
  isBoardStatusCell,
  kanbanCells,
  kanbanStatusCell,
} from './semantics/vocabulary.js';

// ── 格式（确定性序列化 + 严格解析） ──
export {
  MAP_FILE_VERSION,
  canonicalPage,
  parsePage,
  parsePageText,
  revisionOf,
  serializePage,
  stripBom,
} from './store/format.js';

// ── 原子写与锁 ──
export { RENAME_BACKOFF_STEP_MS, RENAME_MAX_ATTEMPTS, errnoOf, writeFileAtomic } from './store/atomic.js';
export { MAP_LOCK_STALE_MS, lockPathOf, withMapLock } from './store/lock.js';

// ── 页 ──
export type { PageRead } from './store/page.js';
export { DEFAULT_PAGE, MAP_DIR_NAME, initMap, listPages, mapDirOf, pageIdOf, pagePathOf, readPage, readPageIfExists } from './store/page.js';

// ── 主写入口 ──
export type { MapPatch } from './store/apply.js';
export { applyPatch } from './store/apply.js';

// ── patch 信封 ──
export { mapOpSchema, mapPatchSchema, parseMapPatch, parsePatchText } from './patch.js';
