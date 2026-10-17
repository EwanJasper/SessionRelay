// 状态 → 看板字形（**唯一一份**，契约 §5）。
//
// 为什么必须唯一：同一个状态在 progress.md、board.mmd、终端里读成三种样子，等于在撒谎说
// "这是三个东西"。mellos 的那张表曾经散在三个文件里，并且**真的漂移过**——所以这里只此一份，
// 谁要投影就 import 这里。
//
// 投影**不改地图里的 status**（账本不是法官）：source 对不上账时，地图里仍然写着 done，
// 只是**展示层**打回成「⛔ 待复验」。打回是给人看的，不是替人改账。
//
// 这一层没有 I/O、没有颜色、没有 node:* —— 字形与文案是共享字母表，终端与网页各自决定怎么画。

import type { MapStatus } from '../domain/types.js';

/** 看板模块列上的归属标记（§5：模块列固定 auto:map）——看板合成靠它认出"这些行是我们写的"。 */
export const MAP_MODULE = 'auto:map';

/** 状态 → 字形。regressed 与 blocked 同字形是**故意**的：都是"卡住了"，区别在文案。 */
export const STATUS_GLYPHS: Readonly<Record<MapStatus, string>> = {
  todo: '⬜',
  doing: '🔄',
  blocked: '⛔',
  done: '✅',
  regressed: '⛔',
};

export const STATUS_LABELS: Readonly<Record<MapStatus, string>> = {
  todo: '待办',
  doing: '进行中',
  blocked: '阻塞',
  done: '完成',
  regressed: '回归',
};

/** 状态列字形（"⬜ 待办"这种；插件解析器只认这四种 emoji 开头的状态列）。 */
export function kanbanStatusCell(status: MapStatus): string {
  return STATUS_GLYPHS[status] + ' ' + STATUS_LABELS[status];
}

/** 源文件对账失败时的展示层打回（§5 最后一行）：地图里还是 done，看板上是「⛔ 待复验」。 */
export const STALE_CELL = '⛔ 待复验';
/** done 但没写 evidence：字形照旧（这就是 done），明细列说清楚"没证据"。 */
export const NO_EVIDENCE_NOTE = '无证据';
/** regressed 的定义，写进明细列：不然"⛔ 回归"要靠人猜是回归到什么。 */
export const REGRESSED_NOTE = '已做过又坏了';

const UNKNOWN_STALE_PATH_NOTE = '⚠ 源码已变';

/** 路径只取文件名：明细列是给人扫的，全路径会把表格挤爆。 */
function baseName(p: string): string {
  const cut = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return cut >= 0 ? p.slice(cut + 1) : p;
}

export interface KanbanCellsOptions {
  /** 该节点的任一 source 指纹对不上 → 展示层打回成待复验。 */
  stale?: boolean;
  /** 变了的那条路径（有就给文件名，没有就只说"源码已变"）。 */
  stalePath?: string;
  /** 是否写了 evidence（done 没证据要说出来）。 */
  hasEvidence?: boolean;
}

/** 明细列的补充文案（不含节点自己的 evidence/detail，那是数据，由 bridge 拼在后面）。 */
export function detailNote(status: MapStatus, opts: KanbanCellsOptions = {}): string {
  if (opts.stale === true) {
    return opts.stalePath !== undefined ? UNKNOWN_STALE_PATH_NOTE + '：' + baseName(opts.stalePath) : UNKNOWN_STALE_PATH_NOTE;
  }
  if (status === 'regressed') return REGRESSED_NOTE;
  if (status === 'done' && opts.hasEvidence !== true) return NO_EVIDENCE_NOTE;
  return '';
}

/** 一次给出状态列与明细列补充（bridge 只负责把 note 与 evidence/detail 拼起来）。 */
export function kanbanCells(status: MapStatus, opts: KanbanCellsOptions = {}): { status: string; note: string } {
  return {
    status: opts.stale === true ? STALE_CELL : kanbanStatusCell(status),
    note: detailNote(status, opts),
  };
}

/** 看板解析器认的状态列开头字符（与 cli/kanban.ts 的历史判据同一份）。 */
export const BOARD_STATUS_PREFIXES = ['✅', '🔄', '⛔', '⬜'] as const;

/** 这一格是不是我们自己能读懂的状态列。 */
export function isBoardStatusCell(cell: string): boolean {
  return (BOARD_STATUS_PREFIXES as readonly string[]).some((p) => cell.startsWith(p));
}
