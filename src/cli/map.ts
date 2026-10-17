// srelay map —— 地图层的 CLI 面（契约 §4，T2）。
//
// 为什么九个动作住一个文件：它们共用三张表——退出码映射、游标编解码、参数判据。
// 拆成 map-init.ts / map-read.ts … 就等于把这三张表各抄一份，而抄出来的东西第一次改动就会漂移
// （本仓库的老毛病：同一个状态在三处读成三种样子，所以状态字形也只许有一份）。
//
// 三条纪律（都是踩出来的）：
//   ① 绝不覆盖人写的东西：init 已存在 → CONFLICT；import 目标已存在 → REFUSED；
//      export --to 只覆盖"已经是我们写的快照"；动词表里没有"删页"（删页 = 用户自己删文件）。
//   ② 退出码是给脚本看的：0 成功 / 1 = 把输入改对（NOT_FOUND、INVALID_ARGUMENT、REFUSED、
//      CONFLICT、INVALID_STORE）/ 2 = 值得重跑（BUSY、LOCK_UNAVAILABLE、SAVE_FAILED）。
//   ③ CLI 层不许抛：所有预期失败都是内核的 Res，这里只负责翻译成
//      stderr 一行「错误码：说明（建议动作）」+ --json 的 {ok:false,error:{…}} + 退出码。
//      连"内核某个模块还没就位"也只许是一句能看懂的话，不许是栈回溯。
//
// 为什么 --fields 只作用于 list 类 resource（§4.2）：整页视图（map）与对账（changes）没有
// "投影"的语义；而 list 类里 identity（节点 id / 边的 from+to）永远保留——
// 把 id 投影掉等于把行变成匿名数据，读的人再也指不到具体对象。
//
// 为什么 stale / bridge 直接 import 而不是等 index.ts 转出口：§3 已经冻结这两个模块的签名，
// 静态 import 能让 tsc 在**这里**就把签名漂移抓出来；转出口只是多一次转手，抓不住漂移。

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  BODY_MAX,
  DEFAULT_PAGE,
  LABEL_MAX,
  MAP_ID_RULE_TEXT,
  MAP_STATUSES,
  applyPatch,
  err,
  errorLine,
  errnoOf,
  initMap,
  isRecord,
  kanbanStatusCell,
  listPages,
  mapIdError,
  ok,
  pageIdOf,
  parsePageText,
  parsePatchText,
  readPage,
  readPageIfExists,
  serializePage,
  stripBom,
  type MapError,
  type MapErrorCode,
  type MapPage,
  type MapPatch,
  type MapStatus,
  type Res,
} from '../map/index.js';
// T3 的只读投影：stale（sources 对账）与 bridge（Mermaid 出图）。
// 为什么静态 import 这两个模块而不是等 index.ts 转出口：契约 §3 已冻结它们的签名，
// 静态 import 能让 tsc 在**这里**就把签名对错抓出来（转出口只是转手，抓不住漂移）。
import { checkSources, type ChangesReport } from '../map/stale.js';
import { renderMapMermaid } from '../map/bridge.js';
import { readDepColumn, readKanbanRows } from './kanban.js';
// 依赖列 → 分层 + 真边（纯函数，test/unit/plan-graph.spec.ts 穷举过）。
import { buildPlanLayout, type PlanDep, type PlanEdge, type PlanLayer, type PlanNode } from '../map/plan-graph.js';

/** 九个动作（注册处照这个顺序写 description；也用于拒"未知动作"）。 */
export const MAP_ACTIONS = [
  'init',
  'read',
  'apply',
  'declare',
  'update',
  'remove',
  'check',
  'export',
  'import',
] as const;
export type MapAction = (typeof MAP_ACTIONS)[number];

/** CLI 的全部选项（注册处透传即可）。拼写与 §4 的旗标一一对应。 */
export interface MapCliFlags {
  /** 项目根；省略时用 requireRoot()（与其它命令一致）。 */
  root?: string;
  page?: string;
  resource?: string;
  id?: string;
  ids?: string;
  status?: string;
  limit?: string | number;
  cursor?: string;
  fields?: string;
  /** apply / declare / update / remove 的输入文件；- = stdin。 */
  file?: string;
  title?: string;
  expectedRevision?: string;
  mmd?: boolean;
  md?: boolean;
  d2?: boolean;
  out?: string;
  to?: string;
  from?: string;
  /** check：changed>0 时判失败（退出码 1）。默认只报告。 */
  failOnChanged?: boolean;
  json?: boolean;
}

// ───────────────────────── 退出码（契约 §4.1 的三分法） ─────────────────────────

const EXIT_CODE: Readonly<Record<MapErrorCode, number>> = {
  NOT_FOUND: 1,
  INVALID_ARGUMENT: 1,
  REFUSED: 1,
  CONFLICT: 1,
  INVALID_STORE: 1,
  BUSY: 2,
  LOCK_UNAVAILABLE: 2,
  SAVE_FAILED: 2,
};

const RESOURCES = ['map', 'pages', 'nodes', 'edges', 'layers', 'changes'] as const;
type ListResource = 'pages' | 'nodes' | 'edges' | 'layers';
const LIST_RESOURCES: readonly string[] = ['pages', 'nodes', 'edges', 'layers'];
const LIMIT_DEFAULT = 30;
const LIMIT_MAX = 100;

/** list 类 resource 的 identity：--fields 也投影不掉它们（§4.2）。 */
const IDENTITY_FIELDS: Readonly<Record<ListResource, readonly string[]>> = {
  pages: ['id'],
  nodes: ['id'],
  edges: ['from', 'to'],
  layers: ['id'],
};

/** 每类 resource 能投影的字段（只管"输出这一层"；数据判据在内核）。 */
const FIELD_WHITELIST: Readonly<Record<ListResource, readonly string[]>> = {
  pages: ['id', 'title', 'revision', 'nodes', 'edges'],
  nodes: ['id', 'label', 'layer', 'status', 'evidence', 'detail', 'group', 'lane', 'sources'],
  edges: ['from', 'to', 'label'],
  layers: ['id', 'name', 'rank'],
};

/**
 * 看板状态列 → 地图 status（§4.1 的 import 映射）。
 *
 * ⚠️ 故意不反过来用 STATUS_GLYPHS：⛔ 同时是 blocked 与 regressed 的字形，
 * 反查在语义上不成立（那个表的注释也写明了"同字形是故意的"）。方向永远是 status → 字形。
 */
const IMPORT_STATUS: Readonly<Record<string, MapStatus>> = {
  '✅': 'done',
  '🔄': 'doing',
  '⛔': 'blocked',
  '⬜': 'todo',
};

/**
 * 状态列 → status。用 startsWith 逐个比对，**不取第 1 个字符**：
 * 🔄 是星平面字符（UTF-16 里占两个码元），slice(0, 1) 会把它劈成半个代理对，
 * 于是"进行中"被静默降级成"待办"——这种错只有在真数据上才看得见。
 */
function importStatus(cell: string): MapStatus {
  for (const glyph of Object.keys(IMPORT_STATUS)) {
    if (cell.startsWith(glyph)) return IMPORT_STATUS[glyph] as MapStatus;
  }
  return 'todo';
}

/**
 * 机器派生行（模块列 auto:map / auto:todos）：import 一律跳过（Lead 终审）。
 * 用前缀判而不是逐个列举：以后新增 auto:xxx 同样属于"机器写的"，都不该被当成人的计划搬进地图。
 */
function isMachineRow(module: string): boolean {
  return module.startsWith('auto:');
}

/** import 出来的单层（契约 §4.1 冻结：id / name / rank）。 */
const PLAN_LAYER_ID = 'plan';
const PLAN_LAYER = { id: PLAN_LAYER_ID, name: '计划（自 progress.md 导入）', rank: 0 };

// ───────────────────────── 输入输出 ─────────────────────────

/** CLI 的失败有两种形状：内核的 err(...) 给的是 Res，而 Res.error 是 MapError。 */
type MapFailure = MapError | { ok: false; error: MapError };

/**
 * 统一的失败出口：stderr 一行 + （--json 时）stdout 的结构化错误 + 退出码。
 *
 * 为什么两种形状都收：调用点写 fail(got.error)（已经拆过包）与 fail(err(…))（现造一个）
 * 说的是同一件事，没必要让每个调用点自己判断要不要拆包——而漏拆的解包错是编译期就发现的，
 * 真正的风险是有人为了绕过它写 `(x as any).error`。
 */
function fail(failure: MapFailure, json: boolean): void {
  const e: MapError = 'code' in failure ? failure : failure.error;
  process.exitCode = EXIT_CODE[e.code];
  console.error(errorLine(e)); // 「错误码：说明（建议动作）」——人和脚本都只扫这一行
  if (json) {
    console.log(
      JSON.stringify(
        {
          ok: false,
          error: {
            code: e.code,
            message: e.message,
            ...(e.hint !== undefined ? { hint: e.hint } : {}),
          },
        },
        null,
        2,
      ),
    );
  }
}

function succeed(json: boolean, payload: Record<string, unknown>, human: string): void {
  if (json) console.log(JSON.stringify({ ok: true, ...payload }, null, 2));
  else if (human !== '') console.log(human);
}

const short = (rev: string): string => (rev.length > 8 ? rev.slice(0, 8) : rev);

function oneLine(text: string, max = 80): string {
  const t = text.replace(/\r?\n/g, ' ').trim();
  return t.length > max ? t.slice(0, max) + '…' : t;
}

const str = (v: unknown): string => (v === undefined || v === null ? '' : String(v));

function splitList(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/** 这些旗标里"确实被传了"的那些（用于"这个 resource 不吃这个旗标"的拒绝，绝不静默忽略）。 */
function givenFlags(flags: MapCliFlags, keys: ReadonlyArray<keyof MapCliFlags>): string[] {
  return keys.filter((k) => flags[k] !== undefined).map((k) => '--' + String(k));
}

/** 读一个输入文件（相对路径按项目根解析，与 --to/--out/--from 同一口径）。 */
function readTextFile(abs: string, what: string): Res<string> {
  try {
    return ok(fs.readFileSync(abs, 'utf8'));
  } catch (e) {
    const code = errnoOf(e);
    return err(
      'NOT_FOUND',
      '读不了' + what + '：' + abs + '（' + code + '）',
      '路径相对项目根解析（绝对路径原样用）；确认文件存在且可读',
      { path: abs, errno: code },
    );
  }
}

/** --file / --from 的 - 约定：stdin。读不到（例如 TTY 下没有输入）也要是 INVALID_ARGUMENT。 */
function readInput(raw: string, what: string, root: string): Res<string> {
  if (raw === '-') {
    try {
      return ok(fs.readFileSync(0, 'utf8'));
    } catch (e) {
      return err(
        'INVALID_ARGUMENT',
        '从 stdin 读不到内容：' + errnoOf(e),
        '把 JSON 用管道喂进来：cat patch.json | srelay map apply --file -',
      );
    }
  }
  return readTextFile(path.resolve(root, raw), what);
}

/** fragment / 快照的 JSON 解析：语法错是 INVALID_ARGUMENT（信封与片段的形状由内核判）。 */
function parseJsonValue(text: string, what: string): Res<unknown> {
  try {
    return ok(JSON.parse(stripBom(text)) as unknown);
  } catch (e) {
    return err(
      'INVALID_ARGUMENT',
      what + ' 不是合法 JSON：' + (e instanceof Error ? e.message : String(e)),
      'JSON 不支持注释与尾逗号；用 --file - 从 stdin 读也行',
    );
  }
}

// ───────────────────────── 参数判据 ─────────────────────────

function idsOf(flags: MapCliFlags): Res<string[] | undefined> {
  const one = flags.id === undefined ? [] : splitList(str(flags.id));
  const many = flags.ids === undefined ? [] : splitList(str(flags.ids));
  const all = [...new Set([...one, ...many])];
  if (all.length === 0) return ok(undefined);
  for (const id of all) {
    const e = mapIdError(id, '--id/--ids 里的 id');
    if (e !== undefined) return err('INVALID_ARGUMENT', e, 'id 只认 ' + MAP_ID_RULE_TEXT + '（如 map-store）');
  }
  return ok(all);
}

function statusOfFlag(flags: MapCliFlags): Res<MapStatus | undefined> {
  if (flags.status === undefined || str(flags.status).trim() === '') return ok(undefined);
  const s = str(flags.status).trim();
  if (!(MAP_STATUSES as readonly string[]).includes(s)) {
    return err('INVALID_ARGUMENT', '--status "' + s + '" 不在闭合词表里', '只认 ' + MAP_STATUSES.join(' / '));
  }
  return ok(s as MapStatus);
}

function limitOf(flags: MapCliFlags): Res<number> {
  if (flags.limit === undefined || str(flags.limit).trim() === '') return ok(LIMIT_DEFAULT);
  const raw = str(flags.limit).trim();
  if (!/^\d+$/.test(raw)) {
    return err(
      'INVALID_ARGUMENT',
      '--limit 必须是正整数（现在是 "' + raw + '"）',
      '默认 ' + String(LIMIT_DEFAULT) + '，上限 ' + String(LIMIT_MAX),
    );
  }
  const n = Number(raw);
  if (n < 1) return err('INVALID_ARGUMENT', '--limit 至少是 1', '要读更多就翻页，别用 0');
  if (n > LIMIT_MAX) {
    return err(
      'INVALID_ARGUMENT',
      '--limit 上限是 ' + String(LIMIT_MAX) + '（现在 ' + String(n) + '）',
      '一次读太多等于把整页倒进终端；翻页：把这次输出的 nextCursor 原样传给 --cursor',
    );
  }
  return ok(n);
}

function fieldsOf(flags: MapCliFlags, resource: string): Res<string[] | undefined> {
  if (flags.fields === undefined || str(flags.fields).trim() === '') return ok(undefined);
  if (!LIST_RESOURCES.includes(resource)) {
    return err(
      'INVALID_ARGUMENT',
      '--fields 只作用于 list 类 resource（nodes/edges/layers/pages）',
      '整页看 --resource map，对账看 --resource changes',
    );
  }
  const asked = splitList(str(flags.fields));
  if (asked.length === 0) return err('INVALID_ARGUMENT', '--fields 是空的', '写成 --fields a,b');
  const allowed = FIELD_WHITELIST[resource as ListResource];
  const unknown = asked.filter((f) => !allowed.includes(f));
  if (unknown.length > 0) {
    return err(
      'INVALID_ARGUMENT',
      '--fields 里有 ' + resource + ' 不认识的字段：' + unknown.join('、'),
      resource + ' 的字段：' + allowed.join('、') + '（identity 永远保留）',
    );
  }
  return ok(asked);
}

/** identity + 指定字段（键序沿用原对象，输出才稳定）。 */
function projectRow(
  rec: Record<string, unknown>,
  fields: string[] | undefined,
  identity: readonly string[],
): Record<string, unknown> {
  if (fields === undefined) return rec;
  const keep = new Set<string>([...identity, ...fields]);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec)) if (keep.has(k)) out[k] = v;
  return out;
}

// ───────────────────────── 分页游标（§4.2：不透明） ─────────────────────────
//
// 游标里装的是「offset + 发号那一刻的 revision」：这样"图在两次读之间变了"能被说出来
// （CONFLICT），而不是让第二次读悄悄接在上一次的位置上——静默错位是分页最经典的坑。
// 不透明是为了让调用方原样回传：内部结构一旦被外面依赖，以后想加字段就是破坏性改动。

interface CursorState {
  v: 1;
  res: string;
  page: string;
  off: number;
  rev: string;
}

function encodeCursor(s: CursorState): string {
  return Buffer.from(JSON.stringify(s), 'utf8').toString('base64url');
}

function decodeCursor(text: string): Res<CursorState> {
  const bad = (why: string): Res<never> =>
    err(
      'INVALID_ARGUMENT',
      '--cursor 不是本工具发出来的游标（' + why + '）',
      '游标是不透明字符串：把上次输出里的 nextCursor 原样粘过来，不要手改',
    );
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(text, 'base64url').toString('utf8')) as unknown;
  } catch {
    return bad('解不开');
  }
  if (!isRecord(raw)) return bad('结构不对');
  const v = raw['v'];
  const res = raw['res'];
  const page = raw['page'];
  const off = raw['off'];
  const rev = raw['rev'];
  if (v !== 1) return bad('版本不是 1');
  if (typeof res !== 'string' || typeof page !== 'string' || typeof rev !== 'string') return bad('缺字段');
  if (typeof off !== 'number' || !Number.isInteger(off) || off < 0) return bad('offset 不是非负整数');
  return ok({ v: 1, res, page, off, rev });
}

/** pages 没有单一 revision：全部页的 (id, revision) 合起来算一个，逻辑没变就不变。 */
function compositeRevision(pairs: string[]): string {
  return createHash('sha256').update(pairs.join('\n'), 'utf8').digest('hex');
}

function resolveOffset(flags: MapCliFlags, resource: string, page: string, rev: string): Res<number> {
  if (flags.cursor === undefined || str(flags.cursor).trim() === '') return ok(0);
  const dec = decodeCursor(str(flags.cursor).trim());
  if (!dec.ok) return dec;
  const st = dec.value;
  if (st.res !== resource) {
    return err(
      'INVALID_ARGUMENT',
      '这个游标是给 --resource ' + st.res + ' 的，本次读的是 ' + resource,
      '游标不通用：用这次输出的 nextCursor，或省略 --cursor 从头读',
    );
  }
  if (st.page !== page) {
    return err(
      'INVALID_ARGUMENT',
      '这个游标是给页 "' + st.page + '" 的，本次读的是页 "' + page + '"',
      '省略 --cursor 从头读',
    );
  }
  if (st.rev !== rev) {
    return err(
      'CONFLICT',
      '两次读之间地图变了（revision ' + short(st.rev) + ' → ' + short(rev) + '）',
      '省略 --cursor 从头重新读：分页读的是发号那一刻的快照，图变了就不能接着往下接',
      { expected: st.rev, actual: rev },
    );
  }
  return ok(st.off);
}

// ───────────────────────── 人类可读投影 ─────────────────────────

function fieldOf(o: Record<string, unknown>, k: string): string {
  const v = o[k];
  if (v === undefined || v === null) return '';
  if (Array.isArray(v)) return String(v.length);
  return String(v);
}

function humanNodes(items: Array<Record<string, unknown>>): string {
  return items
    .map((o) => {
      const st = typeof o['status'] === 'string' ? kanbanStatusCell(o['status'] as MapStatus) : '·';
      const head =
        '  ' + st + '  ' + fieldOf(o, 'id') + (o['label'] !== undefined ? '  ' + fieldOf(o, 'label') : '');
      const bits: string[] = [];
      if (o['layer'] !== undefined) bits.push('层 ' + fieldOf(o, 'layer'));
      if (o['group'] !== undefined) bits.push('组 ' + fieldOf(o, 'group'));
      if (o['lane'] !== undefined) bits.push('泳道 ' + fieldOf(o, 'lane'));
      if (o['detail'] !== undefined) bits.push('明细：' + oneLine(fieldOf(o, 'detail'), 60));
      if (o['evidence'] !== undefined) bits.push('证据：' + oneLine(fieldOf(o, 'evidence'), 60));
      if (Array.isArray(o['sources'])) bits.push('源 ' + String((o['sources'] as unknown[]).length));
      return head + (bits.length > 0 ? '\n     ' + bits.join(' · ') : '');
    })
    .join('\n');
}

function humanSlice(
  label: string,
  total: number,
  offset: number,
  shown: number,
  nextCursor: string | undefined,
): string {
  const range = shown === 0 ? '空' : String(offset + 1) + '-' + String(offset + shown);
  return (
    label +
    '（共 ' +
    String(total) +
    ' 项，本次 ' +
    range +
    '）' +
    (nextCursor !== undefined ? '\n下一页：--cursor ' + nextCursor : '')
  );
}

// ───────────────────────── 九个动作 ─────────────────────────

async function actInit(root: string, flags: MapCliFlags): Promise<void> {
  const json = flags.json === true;
  const raw = flags.title === undefined ? '' : str(flags.title);
  // §4.1：省略 --title 时取项目根目录名（title 是给人看的第一行字，空标题没有意义）
  const title = raw.trim() === '' ? path.basename(path.resolve(root)) || DEFAULT_PAGE : raw;
  const got = initMap(root, title);
  if (!got.ok) return fail(got.error, json);
  return succeed(json, { page: DEFAULT_PAGE, path: got.value.path, title }, '✅ 已建地图：' + got.value.path + '（标题：' + title + '）');
}

function readMapPayload(page: MapPage, revision: string): { payload: Record<string, unknown>; human: string } {
  const counts = {
    layers: page.layers.length,
    groups: page.groups.length,
    lanes: page.lanes.length,
    nodes: page.nodes.length,
    edges: page.edges.length,
  };
  const layers = [...page.layers]
    .sort((a, b) => b.rank - a.rank || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((l) => ({ id: l.id, name: l.name, rank: l.rank, nodes: page.nodes.filter((n) => n.layer === l.id).length }));
  const lines: string[] = [
    '地图页 ' + page.id + ' · ' + page.title + (page.kind !== undefined ? '（kind ' + page.kind + '）' : ''),
    'revision ' + short(revision) + '（完整值：map read --resource map --json）',
    '层（rank 高在上）：' + (layers.length === 0 ? '（空）' : ''),
    ...layers.map(
      (l) => '  rank ' + String(l.rank) + '  ' + l.id + '  ' + l.name + '（' + String(l.nodes) + ' 节点）',
    ),
    '分组 ' + String(counts.groups) + ' · 泳道 ' + String(counts.lanes) + ' · 节点 ' + String(counts.nodes) + ' · 边 ' + String(counts.edges),
  ];
  if (page.context?.summary !== undefined) lines.push('摘要：' + oneLine(page.context.summary, 120));
  if (page.context?.next !== undefined) lines.push('下一步：' + oneLine(page.context.next, 120));
  if (page.context?.updated !== undefined) lines.push('更新于：' + page.context.updated);
  return {
    payload: {
      resource: 'map',
      page: page.id,
      revision,
      title: page.title,
      ...(page.kind !== undefined ? { kind: page.kind } : {}),
      ...(page.context !== undefined ? { context: page.context } : {}),
      counts,
      layers,
    },
    human: lines.join('\n'),
  };
}

function changesPayload(report: ChangesReport): { payload: Record<string, unknown>; human: string } {
  const nodes = report.nodes;
  let changed = 0;
  let unknown = 0;
  for (const n of nodes) {
    if (n.state === 'changed') changed++;
    else if (n.state === 'unknown') unknown++;
  }
  const summary = { total: nodes.length, changed, unknown, unchanged: nodes.length - changed - unknown };
  const drifted = nodes.filter((n) => n.state !== 'unchanged');
  const lines: string[] = [];
  if (drifted.length === 0) {
    lines.push('✅ sources 对账：' + String(nodes.length) + ' 个带证据源的节点全部未变');
  } else {
    lines.push(
      '⚠ sources 对账：' + String(drifted.length) + ' 个节点对不上（changed ' + String(changed) + ' / unknown ' + String(unknown) + '）',
    );
    for (const n of drifted) {
      const files = [...n.changed, ...n.unknown];
      lines.push(
        '  ' +
          (n.state === 'changed' ? '⛔' : '❔') +
          ' ' +
          n.id +
          '  ' +
          oneLine(n.label, 40) +
          (files.length > 0 ? '  ← ' + files.slice(0, 3).join('、') : ''),
      );
      if (n.consumers.length > 0) lines.push('     受影响消费者：' + n.consumers.slice(0, 5).join('、'));
    }
  }
  return { payload: { page: report.page, summary, nodes }, human: lines.join('\n') };
}

async function actRead(root: string, flags: MapCliFlags): Promise<void> {
  const json = flags.json === true;
  const resource =
    flags.resource === undefined || str(flags.resource).trim() === '' ? 'map' : str(flags.resource).trim();
  if (!(RESOURCES as readonly string[]).includes(resource)) {
    return fail(
      err('INVALID_ARGUMENT', '未知 --resource "' + resource + '"', '只认 ' + RESOURCES.join(' / ') + '（默认 map）'),
      json,
    );
  }
  const pageId = pageIdOf(flags.page);
  const ids = idsOf(flags);
  if (!ids.ok) return fail(ids.error, json);
  const status = statusOfFlag(flags);
  if (!status.ok) return fail(status.error, json);
  const limit = limitOf(flags);
  if (!limit.ok) return fail(limit.error, json);
  const fields = fieldsOf(flags, resource);
  if (!fields.ok) return fail(fields.error, json);

  if (resource === 'map') {
    const extra = givenFlags(flags, ['id', 'ids', 'status', 'limit', 'cursor', 'fields']);
    if (extra.length > 0) {
      return fail(
        err('INVALID_ARGUMENT', '--resource map 是整页视图，不吃 ' + extra.join('、'), '要按条件筛选用 --resource nodes/edges/layers/pages'),
        json,
      );
    }
    const got = readPage(root, pageId);
    if (!got.ok) return fail(got.error, json);
    const p = readMapPayload(got.value.page, got.value.revision);
    return succeed(json, p.payload, p.human);
  }

  if (resource === 'changes') {
    const extra = givenFlags(flags, ['status', 'limit', 'cursor', 'fields']);
    if (extra.length > 0) {
      return fail(
        err('INVALID_ARGUMENT', '--resource changes 不吃 ' + extra.join('、'), 'sources 对账按页整体给出；只支持 --ids 收窄到指定节点'),
        json,
      );
    }
    const got = checkSources(root, pageId, ids.value);
    if (!got.ok) return fail(got.error, json);
    const p = changesPayload(got.value);
    return succeed(json, { resource: 'changes', ...p.payload }, p.human);
  }

  if (resource === 'pages' && flags.page !== undefined) {
    return fail(err('INVALID_ARGUMENT', '--resource pages 是全部页，不能用 --page 过滤', '要看某一页用 --resource map --page <id>'), json);
  }
  if (status.value !== undefined && resource !== 'nodes') {
    return fail(err('INVALID_ARGUMENT', '--status 只作用于 --resource nodes', '别的列表没有状态列'), json);
  }

  // ── list 类：pages / nodes / edges / layers 走同一条「取全量 → 过滤 → 分页 → 投影」的路 ──
  let rev: string;
  let items: Array<Record<string, unknown>>;

  if (resource === 'pages') {
    const listed = listPages(root);
    if (!listed.ok) return fail(listed.error, json);
    rev = compositeRevision(listed.value.map((p) => p.id + ':' + p.revision));
    items = listed.value as unknown as Array<Record<string, unknown>>;
  } else {
    const got = readPage(root, pageId);
    if (!got.ok) return fail(got.error, json);
    rev = got.value.revision;
    const page = got.value.page;
    if (resource === 'nodes') items = page.nodes as unknown as Array<Record<string, unknown>>;
    else if (resource === 'edges') items = page.edges as unknown as Array<Record<string, unknown>>;
    else {
      items = [...page.layers]
        .sort((a, b) => b.rank - a.rank || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .map((l) => ({ id: l.id, name: l.name, rank: l.rank, nodes: page.nodes.filter((n) => n.layer === l.id).length }));
    }
  }

  const wanted = ids.value;
  if (wanted !== undefined) {
    const before = items.length;
    items = items.filter((it) =>
      resource === 'edges'
        ? wanted.includes(str(it['from'])) || wanted.includes(str(it['to']))
        : wanted.includes(str(it['id'])),
    );
    if (items.length === 0 && before > 0) {
      return fail(
        err('NOT_FOUND', '没有这些 ' + resource + '：' + wanted.join('、'), '用 --resource ' + resource + ' 看全部（不带 --id/--ids）'),
        json,
      );
    }
  }
  if (resource === 'nodes' && status.value !== undefined) {
    const s = status.value;
    items = items.filter((it) => it['status'] === s);
  }

  const total = items.length;
  const off = resolveOffset(flags, resource, resource === 'pages' ? '' : pageId, rev);
  if (!off.ok) return fail(off.error, json);
  const sliced = items.slice(off.value, off.value + limit.value);
  const nextOffset = off.value + sliced.length < total ? off.value + sliced.length : undefined;
  const nextCursor =
    nextOffset === undefined
      ? undefined
      : encodeCursor({ v: 1, res: resource, page: resource === 'pages' ? '' : pageId, off: nextOffset, rev });

  const identity = IDENTITY_FIELDS[resource as ListResource];
  const shown = sliced.map((it) => projectRow(it, fields.value, identity));
  const label =
    resource === 'pages'
      ? '页列表'
      : resource === 'nodes'
        ? '节点'
        : resource === 'edges'
          ? '依赖边（from → to = from 使用 to）'
          : '层（rank 高在上）';

  let human: string;
  if (resource === 'pages') {
    human =
      humanSlice(label, total, off.value, shown.length, nextCursor) +
      (shown.length === 0
        ? ''
        : '\n' +
          shown
            .map(
              (o) =>
                '  ' +
                fieldOf(o, 'id').padEnd(10) +
                ' ' +
                oneLine(fieldOf(o, 'title'), 28) +
                '  ' +
                short(fieldOf(o, 'revision')) +
                '  节点 ' +
                fieldOf(o, 'nodes') +
                ' 边 ' +
                fieldOf(o, 'edges'),
            )
            .join('\n'));
  } else if (resource === 'nodes') {
    human = humanSlice(label, total, off.value, shown.length, nextCursor) + (shown.length === 0 ? '' : '\n' + humanNodes(shown));
  } else if (resource === 'edges') {
    human =
      humanSlice(label, total, off.value, shown.length, nextCursor) +
      (shown.length === 0
        ? ''
        : '\n' +
          shown
            .map(
              (o) =>
                '  ' +
                fieldOf(o, 'from') +
                ' → ' +
                fieldOf(o, 'to') +
                (o['label'] !== undefined ? '  ' + oneLine(fieldOf(o, 'label'), 40) : ''),
            )
            .join('\n'));
  } else {
    human =
      humanSlice(label, total, off.value, shown.length, nextCursor) +
      (shown.length === 0
        ? ''
        : '\n' +
          shown
            .map(
              (o) =>
                '  rank ' +
                fieldOf(o, 'rank') +
                '  ' +
                fieldOf(o, 'id') +
                '  ' +
                oneLine(fieldOf(o, 'name'), 30) +
                '（' +
                fieldOf(o, 'nodes') +
                ' 节点）',
            )
            .join('\n'));
  }

  return succeed(
    json,
    {
      resource,
      ...(resource === 'pages' ? {} : { page: pageId }),
      revision: rev,
      total,
      offset: off.value,
      limit: limit.value,
      count: shown.length,
      ...(nextCursor !== undefined ? { nextCursor } : {}),
      items: shown,
    },
    human,
  );
}

async function actApply(root: string, flags: MapCliFlags, op: MapAction): Promise<void> {
  const json = flags.json === true;
  const file = flags.file === undefined ? '' : str(flags.file).trim();
  if (file === '') {
    return fail(
      err(
        'INVALID_ARGUMENT',
        '缺少 --file',
        op === 'apply'
          ? 'map apply --file patch.json（或 --file - 从 stdin 读）'
          : 'map ' + op + ' --file fragment.json（单操作糖装的是页面片段本身；或 --file - 从 stdin 读）',
      ),
      json,
    );
  }
  const text = readInput(file, ' --file', root);
  if (!text.ok) return fail(text.error, json);

  let patch: MapPatch;
  if (op === 'apply') {
    // 信封的键集合严格：多余键/缺键都由内核判 INVALID_ARGUMENT（patch.ts 的 strictObject）
    const parsed = parsePatchText(text.value);
    if (!parsed.ok) return fail(parsed.error, json);
    patch = parsed.value;
  } else {
    const raw = parseJsonValue(text.value, '--file');
    if (!raw.ok) return fail(raw.error, json);
    if (isRecord(raw.value) && Object.keys(raw.value).length === 2 && 'op' in raw.value && 'data' in raw.value) {
      // 最容易犯的错：把 patch 信封喂给单操作糖。与其让内核报"未知字段 op、data"，不如直说（§4.2）。
      return fail(
        err(
          'INVALID_ARGUMENT',
          'map ' + op + ' 的 --file 装的是页面片段本身（等价于 operations[0].data），不是 {op,data} 信封',
          '去掉外面那层：{"title":"…","layers":[…],"nodes":[…]}；要一次多条操作请用 map apply',
        ),
        json,
      );
    }
    patch = {
      ...(flags.page !== undefined ? { page: str(flags.page) } : {}),
      ...(flags.expectedRevision !== undefined ? { expectedRevision: str(flags.expectedRevision) } : {}),
      operations: [{ op: op as 'declare' | 'update' | 'remove', data: raw.value }],
    };
  }

  const got = applyPatch(root, patch);
  if (!got.ok) return fail(got.error, json);
  const page = got.value.page;
  return succeed(
    json,
    {
      page: page.id,
      revision: got.value.revision,
      applied: got.value.applied,
      counts: { nodes: page.nodes.length, edges: page.edges.length },
    },
    '✅ ' +
      op +
      ' 完成：' +
      String(got.value.applied) +
      ' 条操作 → 页 ' +
      page.id +
      '（revision ' +
      short(got.value.revision) +
      '，节点 ' +
      String(page.nodes.length) +
      ' 边 ' +
      String(page.edges.length) +
      '）',
  );
}

async function actCheck(root: string, flags: MapCliFlags): Promise<void> {
  const json = flags.json === true;
  const extra = givenFlags(flags, ['resource', 'status', 'limit', 'cursor', 'fields']);
  if (extra.length > 0) {
    return fail(
      err('INVALID_ARGUMENT', 'map check 不吃 ' + extra.join('、'), 'check 只认 --page / --ids / --fail-on-changed / --json'),
      json,
    );
  }
  const ids = idsOf(flags);
  if (!ids.ok) return fail(ids.error, json);
  const got = checkSources(root, pageIdOf(flags.page), ids.value);
  if (!got.ok) return fail(got.error, json);
  const p = changesPayload(got.value);
  const summary = p.payload['summary'] as { changed: number };
  if (summary.changed > 0 && flags.failOnChanged === true) {
    // 门禁语义：报告本身成功了，但"有源码漂移"这件事要能被 CI 看见 → 退出码 1（与 doctor 的 errs>0 同惯例）
    process.exitCode = 1;
    console.error(
      '发现 ' +
        String(summary.changed) +
        ' 个节点的源码已变（--fail-on-changed 判失败）——按 §5 这些节点在看板上会显示成「⛔ 待复验」',
    );
  }
  // check 与 read --resource changes 同源同结构（§4.2）：check 额外负责退出码与人类摘要
  return succeed(json, p.payload, p.human);
}

// ── export：三种文本格式 + JSON 快照 ──
//
// 为什么 --md / --d2 的渲染写在 CLI 而不在 bridge：bridge 的产物是看板行（progress.md 用），
// 而这两个是"粘进文档 / 喂给 d2 二进制"的导出格式，没有第二个消费者；
// 状态字形仍然走 vocabulary（唯一一份），不另造表。

function mdCell(text: string, max = 60): string {
  const one = text.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
  return one.length > max ? one.slice(0, max) + '…' : one;
}

function renderMapMd(page: MapPage, revision: string): string {
  const L: string[] = [];
  L.push('# ' + page.title + '（页 ' + page.id + '）', '');
  L.push('> 由 srelay map export --md 生成（revision ' + short(revision) + '）；手改会被覆盖——要改内容用 srelay map apply。', '');
  if (page.context?.next !== undefined) L.push('**下一步**：' + mdCell(page.context.next, 400), '');
  if (page.context?.summary !== undefined) L.push('**摘要**：' + mdCell(page.context.summary, 400), '');
  const layers = [...page.layers].sort((a, b) => b.rank - a.rank || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const l of layers) {
    const nodes = page.nodes.filter((n) => n.layer === l.id);
    L.push('## ' + l.name + '（' + l.id + ' · rank ' + String(l.rank) + '，' + String(nodes.length) + ' 个节点）', '');
    L.push('| 状态 | 节点 | 分组 | 证据 | 明细 |', '|---|---|---|---|---|');
    for (const n of nodes) {
      L.push(
        '| ' +
          kanbanStatusCell(n.status) +
          ' | ' +
          n.id +
          ' ' +
          mdCell(n.label) +
          ' | ' +
          (n.group ?? '-') +
          ' | ' +
          mdCell(n.evidence ?? '-', 40) +
          ' | ' +
          mdCell(n.detail ?? '-', 80) +
          ' |',
      );
    }
    L.push('');
  }
  if (page.edges.length > 0) {
    L.push('## 依赖边（from → to = from 使用 to）', '');
    const edges = [...page.edges].sort((a, b) =>
      a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : a.to > b.to ? 1 : 0,
    );
    for (const e of edges) {
      L.push('- ' + e.from + ' → ' + e.to + (e.label !== undefined ? '：' + mdCell(e.label, 40) : ''));
    }
    L.push('');
  }
  return L.join('\n');
}

const D2_CLASS: Readonly<Record<MapStatus, string>> = {
  todo: 'todo',
  doing: 'doing',
  blocked: 'blocked',
  done: 'done',
  regressed: 'blocked', // 与看板投影同口径：回归就是"卡住了"，区别在文案
};

function d2Esc(t: string): string {
  return t.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n');
}

function renderMapD2(page: MapPage): string {
  const L: string[] = [
    '# generated by srelay map export --d2（导出示例：d2 --theme 200 in.d2 out.svg）',
    '# 页 ' + page.id + ' · ' + page.title,
    'classes: {',
    '  done:    { style.fill: "#2e7d32"; style.font-color: "#ffffff" }',
    '  doing:   { style.fill: "#f9a825"; style.font-color: "#000000" }',
    '  blocked: { style.fill: "#c62828"; style.font-color: "#ffffff" }',
    '  todo:    { style.fill: "#607d8b"; style.font-color: "#ffffff" }',
    '}',
  ];
  const layers = [...page.layers].sort((a, b) => b.rank - a.rank || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const l of layers) {
    L.push('"' + l.id + '": "' + d2Esc(l.name) + '" {');
    for (const n of page.nodes.filter((x) => x.layer === l.id)) {
      L.push(
        '  "' + n.id + '": "' + d2Esc(n.label + '\n' + kanbanStatusCell(n.status)) + '" { class: ' + D2_CLASS[n.status] + ' }',
      );
    }
    L.push('}');
  }
  for (const e of page.edges) {
    L.push('"' + e.from + '" -> "' + e.to + '"' + (e.label !== undefined ? ': "' + d2Esc(e.label) + '"' : ''));
  }
  return L.join('\n') + '\n';
}

async function actExport(root: string, flags: MapCliFlags): Promise<void> {
  const json = flags.json === true;
  const formats: string[] = [];
  if (flags.mmd === true) formats.push('mmd');
  if (flags.md === true) formats.push('md');
  if (flags.d2 === true) formats.push('d2');
  if (formats.length > 1) {
    return fail(
      err(
        'INVALID_ARGUMENT',
        '--mmd/--md/--d2 只能给一个（现在给了 ' + formats.map((f) => '--' + f).join('、') + '）',
        '三种是同一份数据的不同格式，要多个就分两次跑',
      ),
      json,
    );
  }
  const format = formats[0];
  const to = flags.to === undefined ? undefined : str(flags.to).trim();

  if (to !== undefined && to !== '') {
    // §4.2：--to 必须与 --json 同用（它的用途只有一个——把 JSON 快照写进仓库）
    if (!json) {
      return fail(
        err('INVALID_ARGUMENT', '--to 只在 --json 下使用', '--to 的用途是把 JSON 快照写进仓库：map export --json --to docs/map.json'),
        json,
      );
    }
    if (format !== undefined) {
      return fail(
        err('INVALID_ARGUMENT', '--to（写 JSON 快照）与 --' + format + ' 不能同时用', '要写快照就 --json --to <路径>；要看图就 --mmd/--md/--d2'),
        json,
      );
    }
    if (flags.out !== undefined) {
      return fail(err('INVALID_ARGUMENT', '--to 与 --out 不能同时用', '--to 写快照、--out 写渲染结果，一次做一件事'), json);
    }
    return exportSnapshot(root, flags, to, json);
  }

  const fmt = format ?? 'mmd';
  const pageId = pageIdOf(flags.page);
  let text: string;
  if (fmt === 'mmd') {
    // 人写行 = 模块列不是 auto:* 的行：auto 区由看板合成，别在这里混进来（§5）
    const humanRows = readKanbanRows(root).filter((r) => !/^auto:/.test(str(r[3]).trim()));
    const got = renderMapMermaid(root, humanRows, { page: pageId });
    if (!got.ok) return fail(got.error, json);
    text = got.value;
  } else {
    const got = readPage(root, pageId);
    if (!got.ok) return fail(got.error, json);
    text = fmt === 'md' ? renderMapMd(got.value.page, got.value.revision) : renderMapD2(got.value.page);
  }

  const out = flags.out === undefined ? undefined : str(flags.out);
  if (out === undefined || out === '-') {
    if (json) return succeed(true, { format: fmt, page: pageId, text }, '');
    process.stdout.write(text.endsWith('\n') ? text : text + '\n');
    return;
  }
  const abs = path.resolve(root, out);
  try {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text, 'utf8');
  } catch (e) {
    return fail(err('SAVE_FAILED', '写不了 ' + abs + '：' + errnoOf(e), '检查目录权限与路径长度；路径相对项目根解析'), json);
  }
  const rel = path.relative(root, abs).split(path.sep).join('/');
  return succeed(json, { format: fmt, page: pageId, path: rel, bytes: Buffer.byteLength(text, 'utf8') }, '✅ 已写出 ' + rel + '（' + fmt + '）');
}

async function exportSnapshot(root: string, flags: MapCliFlags, to: string, json: boolean): Promise<void> {
  if (path.isAbsolute(to)) {
    return fail(err('INVALID_ARGUMENT', '--to 必须是仓库内的相对路径（现在给的是绝对路径）', '例如 --to docs/map.json'), json);
  }
  const rootAbs = path.resolve(root);
  const abs = path.resolve(rootAbs, to);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) {
    return fail(err('INVALID_ARGUMENT', '--to 跑到项目根外面去了：' + to, '快照是要提交进仓库的，所以只允许项目根内的相对路径'), json);
  }
  const got = readPage(root, pageIdOf(flags.page));
  if (!got.ok) return fail(got.error, json);
  const text = serializePage(got.value.page);
  let overwritten = false;
  if (fs.existsSync(abs)) {
    // 「绝不覆盖人写文件」的同一把尺子：只有目标本身已经是**我们这种快照**时才覆盖。
    const prev = readTextFile(abs, ' --to 目标');
    if (!prev.ok) return fail(prev.error, json);
    const parsed = parsePageText(prev.value, abs, pageIdOf(flags.page));
    if (!parsed.ok) {
      return fail(
        err('REFUSED', '目标已存在且不是地图快照：' + abs, '换一个路径；这个文件不是本工具写的，绝不覆盖（真要覆盖请自己先改名或删掉）'),
        json,
      );
    }
    overwritten = true;
  }
  try {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text, 'utf8');
  } catch (e) {
    return fail(err('SAVE_FAILED', '写不了快照 ' + abs + '：' + errnoOf(e), '检查目录权限与路径长度'), json);
  }
  const rel = path.relative(rootAbs, abs).split(path.sep).join('/');
  return succeed(
    json,
    { to: rel, path: abs, page: got.value.page.id, revision: got.value.revision, bytes: Buffer.byteLength(text, 'utf8'), overwritten },
    '✅ 快照已写入 ' + rel + '（页 ' + got.value.page.id + ' · revision ' + short(got.value.revision) + '）',
  );
}

async function actImport(root: string, flags: MapCliFlags): Promise<void> {
  const json = flags.json === true;
  const from = flags.from === undefined ? '' : str(flags.from).trim();
  if (from === '') {
    return fail(
      err('INVALID_ARGUMENT', '缺少 --from', 'map import --from progress.md（看板行 → 单层初稿）或 --from <快照.json>'),
      json,
    );
  }
  const extra = givenFlags(flags, [
    'resource',
    'id',
    'ids',
    'status',
    'limit',
    'cursor',
    'fields',
    'file',
    'title',
    'expectedRevision',
    'mmd',
    'md',
    'd2',
    'out',
    'to',
  ]);
  if (extra.length > 0) {
    return fail(err('INVALID_ARGUMENT', 'map import 不吃 ' + extra.join('、'), 'import 只认 --from 与 --page'), json);
  }
  const pageId = pageIdOf(flags.page);
  const idErr = mapIdError(pageId, '页 id');
  if (idErr !== undefined) {
    return fail(err('INVALID_ARGUMENT', idErr, '页 id 只认 ' + MAP_ID_RULE_TEXT + '（如 map / core）'), json);
  }

  // 先区分"还没有地图"与"地图坏了"：坏文件是数据，不是"没建"（readPageIfExists 就是为了这件事）
  const existing = readPageIfExists(root, pageId);
  if (!existing.ok) return fail(existing.error, json);
  if (existing.value !== undefined) {
    return fail(
      err('REFUSED', '地图页 "' + pageId + '" 已存在：' + existing.value.path, 'import 是一次性迁移入口，绝不覆盖已有地图；要改内容用 map apply'),
      json,
    );
  }

  const fromAbs = path.resolve(root, from);
  const progressAbs = path.join(path.resolve(root), 'progress.md');
  if (fromAbs.toLowerCase() === progressAbs.toLowerCase()) return importFromKanban(root, pageId, json);

  if (path.extname(fromAbs).toLowerCase() === '.md') {
    return fail(
      err(
        'INVALID_ARGUMENT',
        '只支持 <项目根>/progress.md 这种看板来源（现在给的是 ' + from + '）',
        '看板行的解析器只有一份（cli/kanban.ts 的 readKanbanRows，读项目根的 progress.md）；要导入别的文件，把那些行搬进 progress.md 或改用 JSON 快照',
      ),
      json,
    );
  }
  return importFromSnapshot(root, pageId, json, fromAbs);
}

/**
 * 从看板行构造地图内容（**唯一实现**）。`map import` 与守护的自动孵化共用它 ——
 * 两处各写一份的话，改一处漏一处，孵出来的图和手导出来的图会长得不一样。
 *
 * 产出**层 + 节点 + 边**三件套，不再是单层。原因（2026-10-18）：地图不变式要求边
 *   **严格跨层向下**，单层图上一条边都加不了 ⇒ 「建边」的前提是先分层，而层只能从
 *   依赖关系里推（无依赖的沉底，依赖别人的往上抬）。没有依赖列 / 解析不出边时，
 *   退化成原来的单层 0 边，行为不变。
 */
type BuiltNodes =
  | {
      ok: true;
      value: {
        layers: PlanLayer[]; nodes: PlanNode[]; edges: PlanEdge[];
        skipped: number; truncated: number; unresolved: string[]; ambiguous: string[];
      };
    }
  | { ok: false; code: 'REFUSED'; msg: string; hint: string };

function buildImportNodes(rows: string[][], file: string): BuiltNodes {
  const depCol = readDepColumn(path.dirname(file)); // 表头说哪格是依赖；没有依赖列返回 null
  const deps: PlanDep[] = [];
  const meta = new Map<string, { status: string; detail?: string }>();
  let truncated = 0;
  let skipped = 0;
  for (const c of rows) {
    if (isMachineRow(str(c[3]).trim())) { skipped++; continue; }
    const labelRaw = str(c[1]).trim();
    const detailRaw = str(c[4]).trim();
    let cut = false;
    let label = labelRaw;
    let detail = detailRaw;
    if (label.length > LABEL_MAX) { label = label.slice(0, LABEL_MAX); cut = true; }
    if (detail.length > BODY_MAX) { detail = detail.slice(0, BODY_MAX); cut = true; }
    if (cut) truncated++;
    const id = 'n' + String(deps.length + 1);
    deps.push({ id, label, dep: depCol === null ? '' : str(c[depCol] ?? '').trim() });
    meta.set(id, { status: importStatus(str(c[2]).trim()), ...(detail !== '' ? { detail } : {}) });
  }
  if (deps.length === 0) {
    return {
      ok: false, code: 'REFUSED',
      msg: 'progress.md 里只有机器行（auto:map / auto:todos），没有可导入的人写行：' + file,
      hint: '迁移要的是人写过的计划；机器行由看板自己维护，不属于地图（把真正的计划写成模块列非 auto:* 的行）',
    };
  }
  const built = buildPlanLayout(deps, meta);
  if (!built.ok) {
    return {
      ok: false, code: 'REFUSED', msg: built.msg,
      hint: '地图不变式要求边严格跨层向下，依赖成环就永远排不出层；去掉一条依赖或改指向后重试',
    };
  }
  const { layers, nodes, edges, unresolved, ambiguous } = built.layout;
  return { ok: true, value: { layers, nodes, edges, skipped, truncated, unresolved, ambiguous } };
}

/**
 * 孵化/升级共用的一句话总结（**文案只有一份**）：把「几个节点 / 几层 / 几条边」说清楚，
 * 再把解析不上的依赖原样报出来 —— 静默丢掉未解析的片段，等于让人以为依赖都建好了。
 */
function hatchNote(nodes: number, layers: number, edges: number, unresolved: string[], ambiguous: string[]): string {
  const parts = [
    '已自动孵化 ' + String(nodes) + ' 个节点 / ' + String(layers) + ' 层 / ' + String(edges) + ' 条边',
    edges === 0 ? '（依赖列解析不出可用的边，保持单层 0 边）' : '（边取自依赖列，方向：用者 → 被用者）',
  ];
  if (unresolved.length > 0) parts.push('；' + String(unresolved.length) + ' 个依赖片段指不到任何任务，未建边：' + unresolved.slice(0, 3).join('、'));
  if (ambiguous.length > 0) parts.push('；' + String(ambiguous.length) + ' 个依赖片段命中多个任务，未建边：' + ambiguous.slice(0, 3).join('、'));
  return parts.join('');
}

/**
 * 【第 1 档 · 补齐】已孵化的单层图 → 补上分层与依赖边。
 *
 * 为什么需要它：早期孵出来的图是单层的（那时还没有依赖列解析），而边只能从层带里长出来。
 *   不补的话，那批项目的图永远停在「N 节点 / 0 边」。
 *
 * 六道前置（全部通过才动，任何一条不满足就原样留着）—— 这条路的危险在于「覆盖」，
 *   所以判据必须证明「这张图就是孵化器刚生成的那张、并且和看板一字不差」，
 *   证明不了就当它是人写的，一个字都不碰：
 *   ① 没有任何边（有边说明已经补过或人写过）；
 *   ② 只有一层、且是 PLAN_LAYER_ID；
 *   ③ 没有分组/泳道；
 *   ④ 所有节点 id 形如 n1..nN 且都在这层（孵化器的写法）；
 *   ⑤ 节点数与看板可导入行数相同；
 *   ⑥ 每个节点的 id 与 label 都和重新解析出来的一致。
 */
function upgradeHatchedMap(root: string, existing: { page: MapPage; revision: string }): { ok: boolean; imported: number; skipped: number; note: string } {
  const keep = (why: string) => ({ ok: false, imported: 0, skipped: 0, note: why });
  const page = existing.page;
  if (page.edges.length > 0) return keep('已有地图（带边），不动');
  if (page.layers.length !== 1 || page.layers[0]?.id !== PLAN_LAYER_ID) return keep('已有地图（不是单层孵化图），不动（孵化只在空白项目上发生）');
  if ((page.groups?.length ?? 0) > 0 || (page.lanes?.length ?? 0) > 0) return keep('已有地图（带分组/泳道），不动');
  if (!page.nodes.every((n) => /^n\d+$/.test(n.id) && n.layer === PLAN_LAYER_ID)) return keep('已有地图（节点不像孵化产物），不动');
  const rows = readKanbanRows(root);
  if (rows.length === 0) return keep('progress.md 里没有可解析的看板行');
  const built = buildImportNodes(rows, path.join(root, 'progress.md'));
  if (!built.ok) return keep(built.msg);
  const { layers, nodes, edges, unresolved, ambiguous } = built.value;
  if (nodes.length !== page.nodes.length) return keep('图（' + String(page.nodes.length) + ' 节点）与看板（' + String(nodes.length) + ' 行）不一致，像是手改过，不动');
  const fresh = new Map(nodes.map((n) => [n.id, n.label]));
  for (const n of page.nodes) {
    if (fresh.get(n.id) !== n.label) return keep('图上的 "' + n.label + '" 与看板对不上，像是手改过，不动');
  }
  if (edges.length === 0) return keep('依赖列解析不出任何边，保持单层（没有可补的东西）');
  // 重建，而不是逐节点改层：一次性 remove + declare，中途任何一条被拒 → 整页不落盘（文件一个字节都不动）
  const operations = [
    // remove 的 data 是「片段」而不是单个 id：{nodes:[{id}]} / {layers:[{id}]}（实测踩到过）
    { op: 'remove' as const, data: { nodes: page.nodes.map((n) => ({ id: n.id })) } },
    { op: 'remove' as const, data: { layers: [{ id: PLAN_LAYER_ID }] } },
    { op: 'declare' as const, data: { layers, nodes, edges } },
  ];
  const applied = applyPatch(root, { expectedRevision: existing.revision, operations });
  if (!applied.ok) return keep('补齐时落盘失败（地图原样保留）：' + errorLine(applied.error));
  return { ok: true, imported: nodes.length, skipped: built.value.skipped, note: '已补齐分层与依赖边：' + hatchNote(nodes.length, layers.length, edges.length, unresolved, ambiguous).replace('已自动孵化 ', '') };
}

/**
 * 【第 1 档 · 自动孵化】项目有 progress.md 但**还没有地图** ⇒ 自动落一张单层骨架。
 *
 * 为什么要有它（用户 2026-10-18）：skill 和 AGENTS.md 都是"说明书"，靠 AI 记得读；
 *   真正该做到的是——**没人开口、没人敲命令，新项目一接进来自己就有图**。
 *   所以这一步挂在守护的 runSync 上，不挂在任何手动命令上。
 *
 * 三条安全边界（都是硬约束）：
 *   ① `expectedRevision: 'absent'` —— 文件已存在就**不重建**（升级走下面的 upgradeHatchedMap，
 *      那条路带 revision 校验、且只在能证明「图和看板一致」时才动，手改过的图一个字都不碰）；
 *   ② 只搬人写行（机器行由看板自己维护，搬进来会"自己吃自己"）；
 *   ③ 边只从**依赖列**推，匹配不上/认不准一律不建（硬猜的假边比没有边更糟）。
 */
export function hatchMapFromKanban(root: string): { ok: boolean; imported: number; skipped: number; note: string } {
  try {
    const file = path.join(root, 'progress.md');
    if (!fs.existsSync(file)) return { ok: false, imported: 0, skipped: 0, note: '没有 progress.md，无需孵化' };
    const existing = readPageIfExists(root);
    if (!existing.ok) return { ok: false, imported: 0, skipped: 0, note: '地图读不了：' + errorLine(existing.error) };
    if (existing.value !== undefined) return upgradeHatchedMap(root, existing.value);
    const rows = readKanbanRows(root);
    if (rows.length === 0) return { ok: false, imported: 0, skipped: 0, note: 'progress.md 里没有可解析的看板行' };
    const built = buildImportNodes(rows, file);
    if (!built.ok) return { ok: false, imported: 0, skipped: 0, note: built.msg };
    const { layers, nodes, edges } = built.value;
    const applied = applyPatch(root, {
      expectedRevision: 'absent',
      operations: [{ op: 'declare', data: { layers, nodes, ...(edges.length > 0 ? { edges } : {}) } }],
    });
    if (!applied.ok) return { ok: false, imported: 0, skipped: 0, note: '落盘失败：' + errorLine(applied.error) };
    return { ok: true, imported: nodes.length, skipped: built.value.skipped, note: hatchNote(nodes.length, layers.length, edges.length, built.value.unresolved, built.value.ambiguous) };
  } catch (e) { return { ok: false, imported: 0, skipped: 0, note: '孵化失败（已兜住）：' + String((e as Error).message).slice(0, 60) }; }
}

async function importFromKanban(root: string, pageId: string, json: boolean): Promise<void> {
  const file = path.join(root, 'progress.md');
  if (!fs.existsSync(file)) {
    return fail(
      err('NOT_FOUND', '没有 ' + file, '先跑 srelay kanban init 起草看板，或手写一份（| 任务 | 状态 | 模块 | 明细 |）'),
      json,
    );
  }
  const rows = readKanbanRows(root); // 复用唯一那份解析器，别在这里造第二套
  if (rows.length === 0) {
    return fail(
      err('REFUSED', 'progress.md 里没有可解析的看板行：' + file, '状态列要以 ✅🔄⛔⬜ 开头，列序为 | 任务 | 状态 | 模块 | 明细 |'),
      json,
    );
  }
  const built = buildImportNodes(rows, file);
  if (!built.ok) return fail(err(built.code, built.msg, built.hint), json);
  const { layers, nodes, edges, skipped, truncated, unresolved, ambiguous } = built.value;

  const patch: MapPatch = {
    page: pageId,
    expectedRevision: 'absent',
    // 层从依赖列推（无依赖的沉底）；边只从依赖列建，匹配不上/认不准一律不建（§4.1）
    operations: [{ op: 'declare', data: { layers, nodes, ...(edges.length > 0 ? { edges } : {}) } }],
  };
  const applied = applyPatch(root, patch);
  if (!applied.ok) return fail(applied.error, json);
  return succeed(
    json,
    { page: pageId, revision: applied.value.revision, imported: nodes.length, skipped, truncated, from: 'progress.md', layers: layers.length, edges: edges.length, ...(unresolved.length > 0 ? { unresolved } : {}), ...(ambiguous.length > 0 ? { ambiguous } : {}) },
    '✅ 已从 progress.md 导入 ' +
      String(nodes.length) +
      ' 行 → 页 ' +
      pageId +
      '（单层 ' +
      PLAN_LAYER_ID +
      ' · 无自动边 · revision ' +
      short(applied.value.revision) +
      '）' +
      (skipped > 0 ? '；跳过 ' + String(skipped) + ' 行机器行（auto:map / auto:todos 由看板自己维护）' : '') +
      (truncated > 0
        ? '；' + String(truncated) + ' 行超长已截断（label ≤' + String(LABEL_MAX) + ' / detail ≤' + String(BODY_MAX) + '）'
        : ''),
  );
}

async function importFromSnapshot(root: string, pageId: string, json: boolean, abs: string): Promise<void> {
  const text = readTextFile(abs, ' --from 快照');
  if (!text.ok) return fail(text.error, json);
  const parsed = parsePageText(text.value, abs, pageId); // 严格读：形状不对即拒，绝不静默丢字段
  if (!parsed.ok) return fail(parsed.error, json);
  const p = parsed.value;
  const data: Record<string, unknown> = {
    title: p.title,
    ...(p.kind !== undefined ? { kind: p.kind } : {}),
    ...(p.context !== undefined ? { context: p.context } : {}),
    layers: p.layers,
    ...(p.groups.length > 0 ? { groups: p.groups } : {}),
    ...(p.lanes.length > 0 ? { lanes: p.lanes } : {}),
    nodes: p.nodes,
    edges: p.edges,
  };
  const applied = applyPatch(root, { page: pageId, expectedRevision: 'absent', operations: [{ op: 'declare', data }] });
  if (!applied.ok) return fail(applied.error, json);
  const rel = path.relative(path.resolve(root), abs).split(path.sep).join('/');
  return succeed(
    json,
    {
      page: pageId,
      revision: applied.value.revision,
      from: rel,
      imported: { layers: p.layers.length, nodes: p.nodes.length, edges: p.edges.length },
    },
    '✅ 已从快照恢复 ' +
      rel +
      ' → 页 ' +
      pageId +
      '（层 ' +
      String(p.layers.length) +
      ' · 节点 ' +
      String(p.nodes.length) +
      ' · 边 ' +
      String(p.edges.length) +
      ' · revision ' +
      short(applied.value.revision) +
      '）',
  );
}

// ───────────────────────── 入口 ─────────────────────────

/**
 * srelay map <action> 的全部实现。注册处（src/bin/srelay.ts）只要把 commander 的 opts 原样传进来。
 *
 * @param action - MAP_ACTIONS 之一。
 * @param flags - §4 的旗标（拼写见 MapCliFlags）。
 */
export async function cmdMap(action: string, flags: MapCliFlags = {}): Promise<void> {
  const opts: MapCliFlags = flags ?? {};
  const json = opts.json === true;
  try {
    if (!(MAP_ACTIONS as readonly string[]).includes(action)) {
      return fail(err('INVALID_ARGUMENT', '未知动作 "' + action + '"', '支持：' + MAP_ACTIONS.join(' / ')), json);
    }
    const { requireRoot } = await import('./ui.js');
    const rootRaw = opts.root === undefined ? '' : str(opts.root).trim();
    const root = rootRaw === '' ? requireRoot() : path.resolve(rootRaw);

    switch (action as MapAction) {
      case 'init':
        return await actInit(root, opts);
      case 'read':
        return await actRead(root, opts);
      case 'apply':
      case 'declare':
      case 'update':
      case 'remove':
        return await actApply(root, opts, action as MapAction);
      case 'check':
        return await actCheck(root, opts);
      case 'export':
        return await actExport(root, opts);
      case 'import':
        return await actImport(root, opts);
      default:
        return fail(err('INVALID_ARGUMENT', '未知动作 "' + action + '"', '支持：' + MAP_ACTIONS.join(' / ')), json);
    }
  } catch (e) {
    // 走到这里就是我们的缺陷（预期失败全是 Res）。也**不许抛**：给一句能看懂的话 + 退出码 1。
    return fail(
      err(
        'INVALID_STORE',
        '内部错误（地图 CLI 缺陷）：' + (e instanceof Error ? e.message : String(e)),
        '把你的命令与这条信息一起报给维护者；数据没有被改动（写盘都是原子的）',
      ),
      json,
    );
  }
}

export { EXIT_CODE as MAP_EXIT_CODE };
