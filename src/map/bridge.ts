// 地图 → 看板行 / Mermaid（契约 §5 投影表 + §3 签名）。
//
// 两条铁律（不是"最好这样"，是"必须"）：
//   ① **绝不抛**：这条链挂在守护的 sync 路径上（capture/sync.ts → syncKanbanAuto）。
//      地图坏了、页 id 非法、磁盘抽风——任何情况都只返回空 rows + note（或 Res 的 err）。
//      账本的失败绝不许外溢成守护的失败（§5 最后一行）。
//   ② **绝不改地图**：投影是"读账本、画出来"。地图里的 status 一个字都不动，
//      source 对不上账时只把**展示层**打回成「⛔ 待复验」——账本不是法官，打回不写回。
//
// 为什么状态→字形在这一个字都不写：那张表（kanbanCells / MAP_MODULE / STATUS_*）
//   是**唯一一份**（内核 semantics/vocabulary.ts，§5）。bridge 只负责把 cells.note 与节点的
//   evidence/detail **拼起来**；在这里再写一张表，就是下一个漂移的起点。
//
// 为什么 maxRows 连"下一步行"和"…还有 N 项"一起算：上限的意义是"这一屏放得下"，
//   若只卡内容行，行数会随 context.next 的有无而多一行——上限就成了看情况的东西。

import {
  MAP_MODULE,
  err,
  errorLine,
  isBoardStatusCell,
  kanbanCells,
  ok,
  pageIdOf,
  pagePathOf,
  readPageIfExists,
  type MapLayer,
  type MapNode,
  type MapPage,
  type Res,
} from './index.js';
import { checkSources } from './stale.js';

/** 一行看板 = 4 格数组 [任务, 状态, 模块, 明细]（契约 §3）。 */
export interface KanbanProjection {
  rows: string[][];
  /** 一句人话的投影说明（守护日志/CLI 都能直接用）；出错时它就是唯一线索。 */
  note: string;
}

/** 行数上限默认 12（可配 map.rows_max，由调用方传进来）。 */
export const MAP_ROWS_DEFAULT = 12;
/** 上限硬顶：再大就不是"看板一屏"了（防一个坏配置把 progress.md 撑成墙）。 */
export const MAP_ROWS_MAX = 500;
/** 最小有意义的上限：至少放得下「1 行内容 + 1 行省略」。 */
const MAP_ROWS_MIN = 2;

/** 任务列上限。看板是给人扫的：一行 120 字的 label 会把表格挤到没法读。 */
const TASK_CELL_MAX = 60;
/** 明细列上限（evidence 契约上限 2000，这里只做"一行摘要"）。 */
const DETAIL_CELL_MAX = 200;

const NO_MAP_NOTE = '没有地图';
const NOTE_SEP = ' · ';
const HUMAN_AREA_LABEL = '人写的计划（progress.md）';
const AUTO_AREA_LABEL = '自动待办（ZCode todo 同步）';
/** auto:todos 的模块标记（与 cli/kanban.ts 的 AUTO_MODULE 同值：那边写、这边读）。 */
const AUTO_TODOS_MODULE = 'auto:todos';

/**
 * §5 的行序权重：doing → blocked → regressed → todo → done（id 升序做稳定序）。
 * 这是**行序**不是字形表——字形一律走内核的 kanbanCells。
 */
const STATUS_ORDER: Readonly<Record<string, number>> = { doing: 0, blocked: 1, regressed: 2, todo: 3, done: 4 };

function errorText(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.replace(/\s+/g, ' ').trim().slice(0, 200);
}

/** 表格单元格不接受换行/制表符（明细与 evidence 按设计就是多行的）。 */
function flatText(v: unknown): string {
  return typeof v === 'string' ? v.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim() : '';
}

function clip(text: string, max: number): string {
  if (max <= 1) return '';
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

function byId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function normRows(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return MAP_ROWS_DEFAULT;
  const n = Math.floor(raw);
  if (n < MAP_ROWS_MIN) return MAP_ROWS_DEFAULT; // 上限小于"1 行 + 1 行省略"没有意义：兜默认
  return Math.min(n, MAP_ROWS_MAX);
}

/** §5 行序：context.next 之后，节点按 (doing, blocked, regressed, todo, done) 再按 id。 */
function orderNodes(nodes: MapNode[]): MapNode[] {
  return [...nodes].sort((a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) || byId(a.id, b.id));
}

function joinParts(parts: Array<string | undefined>): string {
  return parts.map(flatText).filter((p) => p !== '').join(NOTE_SEP);
}
/**
 * 拿"哪些节点的证据源已经对不上"（nodeId → 第一条变了/没了的路径）。
 *
 * 只对**真有 sources 的页**跑对账：一张刚从 progress.md 导入的地图一条 source 都没有，
 * 为了它每轮 sync 去 stat 一堆不存在的文件，纯属白烧预算（§6：无变化时 <20ms）。
 * 对账失败**不改结论也不上报**：投影层没有地方说"我没能对账"，那就当"没有发现变化"，
 * 但绝不当成"有问题"——假警报比沉默更贵。
 */
function stalePathsOf(root: string, pg: MapPage): Map<string, string> {
  const out = new Map<string, string>();
  try {
    if (!pg.nodes.some((n) => Array.isArray(n.sources) && n.sources.length > 0)) return out;
    const rep = checkSources(root, pg.id);
    if (!rep.ok) return out;
    for (const n of rep.value.nodes) {
      const first = n.changed[0];
      if (first !== undefined) out.set(n.id, first);
    }
  } catch {
    /* 投影绝不因为对账失败而挂掉 */
  }
  return out;
}

/** 一个节点 → 一行看板。status 打回只发生在 done 上（§5 最后一行）。 */
function nodeRow(node: MapNode, sourceChangedAt: string | undefined): string[] {
  const evidence = flatText(node.evidence);
  const hasEvidence = evidence !== ''; // §4.3.6：trim 后为空 = 没有证据
  const stale = node.status === 'done' && sourceChangedAt !== undefined;
  const cells =
    sourceChangedAt !== undefined
      ? kanbanCells(node.status, { stale, stalePath: sourceChangedAt, hasEvidence })
      : kanbanCells(node.status, { stale, hasEvidence });
  return [
    clip(flatText(node.label), TASK_CELL_MAX),
    cells.status,
    MAP_MODULE,
    clip(joinParts([cells.note, evidence, node.detail]), DETAIL_CELL_MAX),
  ];
}

/**
 * context.next → 一行看板。
 * 状态列取内核 kanbanCells('doing') 的字形（**单一来源**），不是在这里写死 emoji：
 * "下一步"是**正在推进的意图**，也因此会被简报的看板段读到（那段只读 🔄/⛔）——
 * 这正是地图层存在的意义：把「计划/下一步」从 3.3% 的捕获率里捞出来。
 */
function nextRow(next: string, pageId: string): string[] {
  return [
    clip(next, TASK_CELL_MAX),
    kanbanCells('doing').status,
    MAP_MODULE,
    '地图下一步（' + pageId + '.json context.next）',
  ];
}

/** 超出上限的收口行。状态列给 ⬜ 而不是空串：空状态的行会被看板解析器整个跳过（静默消失）。 */
function overflowRow(hidden: number, maxRows: number): string[] {
  return [
    '…还有 ' + String(hidden) + ' 项',
    kanbanCells('todo').status,
    MAP_MODULE,
    '（本页 maxRows=' + String(maxRows) + '；地图里还有 ' + String(hidden) + ' 个节点未列出）',
  ];
}

function noteOf(pg: MapPage, total: number, hidden: number, staleCount: number): string {
  const bits = ['地图「' + clip(flatText(pg.title), 40) + '」：' + String(total) + ' 个节点'];
  if (hidden > 0) bits.push('未列出 ' + String(hidden) + ' 项');
  if (staleCount > 0) bits.push(String(staleCount) + ' 项待复验');
  if (total === 0) bits.push('空图');
  return bits.join(NOTE_SEP);
}

/**
 * 地图 → 看板行（契约 §3 / §5）。**绝不抛、绝不改地图**。
 *
 * 失败分两种，note 里说得很清楚（这是调用方唯一的线索）：
 *   还没建图（readPageIfExists → ok(undefined)）→ 空 rows + note「没有地图」；
 *   图坏了（INVALID_STORE / 页 id 非法）→ 空 rows + note「地图读不了：<错误码：说明>」。
 * 两者都不许拖挂 syncKanbanAuto：调用方照旧刷它的 auto:todos 区。
 */
export function mapKanbanRows(root: string, opts: { page?: string; maxRows?: number } = {}): KanbanProjection {
  try {
    if (typeof root !== 'string' || root === '') {
      return { rows: [], note: '地图投影跳过：没给项目根目录' };
    }
    const read = readPageIfExists(root, opts.page);
    if (!read.ok) return { rows: [], note: '地图读不了：' + errorLine(read.error) };
    if (read.value === undefined) return { rows: [], note: NO_MAP_NOTE };
    const pg = read.value.page;
    const maxRows = normRows(opts.maxRows);
    const stale = stalePathsOf(root, pg);

    const rows: string[][] = [];
    const next = flatText(pg.context?.next);
    if (next !== '') rows.push(nextRow(next, pg.id));

    const ordered = orderNodes(Array.isArray(pg.nodes) ? pg.nodes : []);
    const room = maxRows - rows.length;
    let listed = ordered;
    let hidden = 0;
    if (ordered.length > room) {
      listed = ordered.slice(0, Math.max(0, room - 1)); // 留一格给「…还有 N 项」
      hidden = ordered.length - listed.length;
    }
    for (const n of listed) rows.push(nodeRow(n, stale.get(n.id)));
    if (hidden > 0) rows.push(overflowRow(hidden, maxRows));

    return { rows, note: noteOf(pg, ordered.length, hidden, stale.size) };
  } catch (e) {
    // 走到这里说明是**预料之外**的故障（不是地图坏）。照样不抛：看板路径没有"炸"这个选项。
    return { rows: [], note: '地图投影失败（已兜住，不向外抛）：' + errorText(e) };
  }
}
// ─────────────────────────── Mermaid ───────────────────────────

/**
 * 从一行看板单元格里认出 [任务/状态/模块/明细]。
 *
 * 为什么要"认"而不是按下标取：看板行的两种形状都真实存在——
 *   bridge 自己产的 4 格数组（0=任务），与 cli/kanban.ts readKanbanRows 的切分结果
 *   （行首的竖线切出一个空串，于是 1=任务、2=状态）。按下标硬取，一定有一边是错的，
 *   而错的那边不会报错，只会把状态列和任务列**错位**显示——最难看出来的那种坏。
 * 判据用内核的 isBoardStatusCell：状态列的字形只有那一份定义（§5）。
 */
function rowFields(row: unknown): { name: string; status: string; module: string; detail: string } {
  const cells = Array.isArray(row) ? row.map((c) => (typeof c === 'string' ? c.trim() : '')) : [];
  let at = -1;
  for (let i = 1; i < cells.length; i++) {
    if (isBoardStatusCell(cells[i] ?? '')) {
      at = i;
      break;
    }
  }
  if (at < 0) return { name: '', status: '', module: '', detail: '' };
  return {
    name: flatText(cells[at - 1]),
    status: flatText(cells[at]),
    module: flatText(cells[at + 1]),
    detail: flatText(cells[at + 2]),
  };
}

/** 状态列字形 → Mermaid class（沿用 architecture.mmd / kanban.ts 的 classDef 命名）。 */
function glyphClass(status: string): 'done' | 'doing' | 'blocked' | 'todo' {
  if (status.includes('✅')) return 'done';
  if (status.includes('🔄')) return 'doing';
  if (status.includes('⛔')) return 'blocked';
  return 'todo';
}

/** 形状随状态：完成=体育场、阻塞=六边、进行中=方框、待办=平行四边形（与旧图观感一致）。 */
function shapeOf(cls: string, label: string): string {
  if (cls === 'done') return '(["' + label + '"])';
  if (cls === 'blocked') return '{{"' + label + '"}}';
  if (cls === 'doing') return '["' + label + '"]';
  return '[/"' + label + '"]';
}

/**
 * Mermaid 标签里的危险字符一律剥掉：引号会截断双引号标签、方括号/花括号会撞形状语法、
 * 竖线会撞边标签、尖括号会让人名里塞进的 HTML 生效、反引号在部分渲染器里有语义。
 * 剥掉而不是转义——Mermaid 的转义规则随版本变，而这里的目标只是"别把图弄坏"。
 * ⚠️ 反引号写成 \x60：本文件是纯文本，直接写字符本身会让代码块/模板字符串提前收尾。
 */
function escapeLabel(raw: string): string {
  return flatText(raw).replace(/["\\{}\[\]|<>\x60*]/g, '').trim();
}

function nodeLabel(name: string, status: string, max = 22): string {
  const shown = name.length > max ? name.slice(0, max) + '…' : name;
  const short = status.replace(/[✅🔄⛔⬜]\s*/g, '').trim().slice(0, 12);
  return shown + (short === '' ? '' : '<br/><small>' + short + '</small>');
}

/** 看板行 → 图节点 id（与旧 renderMermaid 同一套：行序 + 去标点短名）。 */
function humanNodeId(name: string, i: number): string {
  const slug = name.replace(/[^0-9A-Za-z\u4e00-\u9fa5]+/g, '').slice(0, 10);
  return 'N' + String(i) + '_' + (slug || 'x');
}

/**
 * 地图节点 → 图节点 id。
 * 为什么加前缀并去掉短横线：Mermaid 的 id 语法对短横线与首位数字并不友好（旧解析器会把
 * a-b 当成边），而地图 id（§2）允许短横线、也允许以数字开头。前缀 + 下划线既保证不撞
 * 看板行的 N 号节点，也保证任何合法地图 id 都能画出来（id 只影响图，label 才是人看的）。
 */
function mapNodeId(id: string): string {
  return 'm_' + id.replace(/-/g, '_');
}

function layerGraphId(id: string): string {
  return 'L_' + id.replace(/-/g, '_');
}

interface LayerBlock {
  id: string;
  label: string;
  rank: number;
  nodes: MapNode[];
}

/** 层带：rank 高的在上方（§5）。空层不画（一个空 subgraph 只是噪音）。 */
function layerBlocks(pg: MapPage): LayerBlock[] {
  const byLayer = new Map<string, MapNode[]>();
  for (const n of pg.nodes) {
    const arr = byLayer.get(n.layer) ?? [];
    arr.push(n);
    byLayer.set(n.layer, arr);
  }
  const layers: MapLayer[] = Array.isArray(pg.layers) ? pg.layers : [];
  const blocks: LayerBlock[] = [];
  for (const lay of [...layers].sort((a, b) => b.rank - a.rank || byId(a.id, b.id))) {
    const nodes = (byLayer.get(lay.id) ?? []).slice().sort((a, b) => byId(a.id, b.id));
    if (nodes.length > 0) blocks.push({ id: lay.id, label: lay.name, rank: lay.rank, nodes });
  }
  // 兜底：不变式（§2.2）保证节点必属于一个已存在的层；真出现孤儿节点，宁可多画一块
  // 「未分层」也不要让节点在图里凭空消失（消失的节点看起来就像"这事不存在"）。
  const declared = new Set(layers.map((l) => l.id));
  const orphans = (Array.isArray(pg.nodes) ? pg.nodes : []).filter((n) => !declared.has(n.layer));
  if (orphans.length > 0) blocks.push({ id: 'orphan', label: '未分层（数据异常）', rank: -1, nodes: orphans });
  return blocks;
}
/**
 * 有地图时出图：层带 subgraph（rank 高在上）+ **直接取 edges 的真边**（§5）。
 *
 * 与前身（cli/kanban.ts renderMermaid）的关键差别：**边不再从人写的文本里猜**。
 * 旧实现靠"依赖列文本包含另一行前 6 字"连边，实测踩过假边（一次把
 * sessionrelay-src/SessionRelay（真源码 fork…）连到了前缀相同的另一行）。
 * 地图里的 edges 是**声明过结构**的（from 使用 to，且严格向下、无同层），
 * 所以这里的每一根线都对应账本里的一条真边；人写行进 HUMAN 区但**不产生边**。
 *
 * 地图不存在、图坏了、或**一个节点都没有** → ok:false：调用方应当回落到"纯行渲染"的
 * 老路径（renderMermaid(humanRows)）。绝不输出一个只有壳的空 flowchart——那会把
 * board.mmd 变成一张空白页，比没有图更糟（看起来就像"看板没了"）。
 */
export function renderMapMermaid(root: string, humanRows: string[][], opts: { page?: string } = {}): Res<string> {
  try {
    if (typeof root !== 'string' || root === '') {
      return err('INVALID_ARGUMENT', 'renderMapMermaid 需要一个项目根目录（现在是 ' + String(root) + '）');
    }
    const read = readPageIfExists(root, opts.page);
    if (!read.ok) return { ok: false, error: read.error };
    const file = pagePathOf(root, pageIdOf(opts.page));
    if (read.value === undefined) {
      return err('NOT_FOUND', NO_MAP_NOTE + '：' + file, '调用方回落到 renderMermaid(humanRows) 只画看板行');
    }
    const pg = read.value.page;
    const nodes = Array.isArray(pg.nodes) ? pg.nodes : [];
    if (nodes.length === 0) {
      return err('NOT_FOUND', '地图里一个节点都没有：' + file, '空图会把 board.mmd 变成空白页；调用方回落到 renderMermaid(humanRows)');
    }
    const stale = stalePathsOf(root, pg);
    const rows = Array.isArray(humanRows) ? humanRows : [];

    const lines: string[] = ['flowchart TB'];
    const human: string[] = [];
    const auto: string[] = [];
    const classes: Array<{ id: string; cls: string }> = [];

    rows.forEach((row, i) => {
      const f = rowFields(row);
      if (f.name === '') return;
      // auto:map 行就是下面那些层带本身；再画一遍等于同一件事在图里出现两次。
      if (f.module === MAP_MODULE) return;
      const id = humanNodeId(escapeLabel(f.name), i);
      const cls = glyphClass(f.status);
      const line = '        ' + id + shapeOf(cls, nodeLabel(escapeLabel(f.name), f.status));
      if (f.module === AUTO_TODOS_MODULE) auto.push(line);
      else human.push(line);
      classes.push({ id, cls });
    });

    if (human.length > 0) {
      lines.push('    subgraph HUMAN["' + HUMAN_AREA_LABEL + '"]', '        direction TB', ...human, '    end');
    }
    if (auto.length > 0) {
      lines.push('    subgraph AUTO["' + AUTO_AREA_LABEL + '"]', '        direction TB', ...auto, '    end');
    }

    for (const block of layerBlocks(pg)) {
      const head = block.rank >= 0 ? block.label + '（rank ' + String(block.rank) + '）' : block.label;
      lines.push('    subgraph ' + layerGraphId(block.id) + '["' + escapeLabel(head) + '"]', '        direction TB');
      for (const n of block.nodes) {
        const changedAt = stale.get(n.id);
        const evidence = flatText(n.evidence);
        const staleNode = n.status === 'done' && changedAt !== undefined;
        const cells =
          changedAt !== undefined
            ? kanbanCells(n.status, { stale: staleNode, stalePath: changedAt, hasEvidence: evidence !== '' })
            : kanbanCells(n.status, { stale: staleNode, hasEvidence: evidence !== '' });
        const id = mapNodeId(n.id);
        const cls = glyphClass(cells.status);
        lines.push('        ' + id + shapeOf(cls, nodeLabel(escapeLabel(n.label), cells.status)));
        classes.push({ id, cls });
      }
      lines.push('    end');
    }

    const layerOf = new Map<string, string>(nodes.map((n) => [n.id, n.layer] as [string, string]));
    const graphId = new Map<string, string>(nodes.map((n) => [n.id, mapNodeId(n.id)] as [string, string]));
    for (const e of Array.isArray(pg.edges) ? pg.edges : []) {
      if (typeof e?.from !== 'string' || typeof e?.to !== 'string') continue;
      const from = graphId.get(e.from);
      const to = graphId.get(e.to);
      if (from === undefined || to === undefined) continue; // 端点不在图里：宁可少画一根，也不画假边
      if (layerOf.get(e.from) === layerOf.get(e.to)) continue; // 同层边（不变式 §2.3 禁止）再兜一层
      const label = e.label !== undefined ? escapeLabel(String(e.label)).slice(0, 40) : '';
      lines.push('    ' + from + (label !== '' ? ' -->|' + label + '| ' : ' --> ') + to);
    }

    lines.push('    classDef done fill:#2e7d32,color:#fff');
    lines.push('    classDef doing fill:#f9a825,color:#000');
    lines.push('    classDef blocked fill:#c62828,color:#fff');
    lines.push('    classDef todo fill:#607d8b,color:#fff');
    for (const cls of ['done', 'doing', 'blocked', 'todo']) {
      const ids = classes.filter((c) => c.cls === cls).map((c) => c.id);
      if (ids.length > 0) lines.push('    class ' + ids.join(',') + ' ' + cls);
    }
    return ok(lines.join('\n') + '\n');
  } catch (e) {
    return err('INVALID_STORE', '地图制图失败（已兜住，不向外抛）：' + errorText(e), '调用方回落到 renderMermaid(humanRows)');
  }
}


