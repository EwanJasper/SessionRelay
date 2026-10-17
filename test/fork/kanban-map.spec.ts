// [T3] 看板桥接 e2e（契约 §5 投影表 / §3 bridge.ts 签名 / §4.3 裁定）。
//
// 真夹具：真临时目录 + 真 progress.md + 真地图文件 + 真源码文件（含真哈希），
// 端到端跑"磁盘 → 看板行 / Mermaid"。mock 掉 fs 就等于把要证明的东西假设掉了。
//
// 双向断言：该投影出来的必须逐项对（状态列/模块列/明细列/行序），
// 且**不许有多余的东西**（假边、auto:map 行重复画、地图被写坏、重复调用结果不一致）。
import { describe, beforeAll, afterAll, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MAP_MODULE, isBoardStatusCell, serializePage, type MapPage } from '../../src/map/index.js';
import { mapKanbanRows, renderMapMermaid } from '../../src/map/bridge.js';

const sha = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

let tmp = '';
let seq = 0;
let root = '';
let mapFile = '';
let boardFile = '';

const NEXT = '把地图层接进守护的 sync 路径';

/** 夹具地图：五态俱全 + 两个对不上账的 source（一个 done、一个 doing）+ 两条真边。 */
function fixturePage(): MapPage {
  return {
    id: 'map',
    title: '看板桥接夹具',
    layers: [
      { id: 'core', name: '内核', rank: 0 },
      { id: 'app', name: '应用', rank: 2 },
    ],
    groups: [],
    lanes: [],
    nodes: [
      { id: 'n-doing-a', label: '正在做的事', layer: 'app', status: 'doing', evidence: 'vitest 3/3' },
      { id: 'n-doing-b', label: '也进行中', layer: 'core', status: 'doing', sources: [{ path: 'src/live.ts', sha256: sha('OLD') }] },
      { id: 'n-blocked', label: '卡住的事', layer: 'app', status: 'blocked' },
      { id: 'n-regress', label: '回归的事', layer: 'app', status: 'regressed' },
      { id: 'n-todo', label: '待办的事', layer: 'core', status: 'todo' },
      { id: 'n-done-ok', label: '完成的带证据', layer: 'core', status: 'done', evidence: 'e2e 通过' },
      { id: 'n-done-bare', label: '完成的没证据', layer: 'core', status: 'done' },
      { id: 'n-done-stale', label: '完成的源码变了', layer: 'core', status: 'done', evidence: '旧的证据', sources: [{ path: 'src/old.ts', sha256: sha('OLD') }] },
    ],
    edges: [
      { from: 'n-doing-a', to: 'n-todo', label: 'uses' },
      { from: 'n-blocked', to: 'n-done-stale' },
    ],
    context: { next: NEXT, updated: '2026-10-18T05:00:00+08:00' },
  };
}

/** progress.md：人写行 1 条 + auto:todos 1 条 + auto:map 1 条（后者用来证明"不重复画"）。 */
const HUMAN_ROW = '| 人写的计划行 | 🔄 进行中 | 正在做的事 | 依赖 正在做的事 这条线（旧规则会在这里连出假边） |';
const TODOS_ROW = '| 来自 ZCode 的待办 | 🔄 进行中 | auto:todos | 该进 AUTO 区 |';
const MAP_ROW = '| 地图上的事 | 🔄 进行中 | auto:map | 层带已经画过它，别再画一遍 |';

function writeBoard(file: string): void {
  fs.writeFileSync(
    file,
    ['# 夹具看板', '', '| 任务 | 状态 | 模块 | 明细 |', '|---|---|---|---|', HUMAN_ROW, TODOS_ROW, MAP_ROW, ''].join('\n'),
    'utf8',
  );
}

/** 与 cli/kanban.ts readKanbanRows 同口径的行读取（不 import 它：那是 Lead 的写区）。 */
function readRows(r: string): string[][] {
  return fs
    .readFileSync(path.join(r, 'progress.md'), 'utf8')
    .split(/\r?\n/)
    .map((l) => l.split('|').map((s) => s.trim()))
    .filter((c) => c.length >= 5 && /^[✅🔄⛔⬜]/u.test(c[2] ?? ''));
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'srelay-kbmap-'));
  root = path.join(tmp, 'proj');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'live.ts'), 'LIVE', 'utf8');
  fs.writeFileSync(path.join(root, 'src', 'old.ts'), 'NEW', 'utf8');
  const dir = path.join(root, '.sessionrelay', 'map');
  fs.mkdirSync(dir, { recursive: true });
  mapFile = path.join(dir, 'map.json');
  fs.writeFileSync(mapFile, serializePage(fixturePage()), 'utf8');
  boardFile = path.join(root, 'progress.md');
  writeBoard(boardFile);
});
afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** 空项目根（没有地图）。 */
function bareRoot(): string {
  seq += 1;
  const r = path.join(tmp, 'bare' + String(seq));
  fs.mkdirSync(r, { recursive: true });
  return r;
}

describe('[T3] §5 投影表逐行', () => {
  it('① 状态列 / 模块列 / 明细列：五态 + 无证据 + 待复验', () => {
    const proj = mapKanbanRows(root);
    expect(proj.rows.length).toBe(9);
    for (const r of proj.rows) {
      expect(r.length).toBe(4);
      expect(r[2]).toBe(MAP_MODULE); // 模块列固定 auto:map
      expect(isBoardStatusCell(r[1])).toBe(true); // 状态列必须能被看板解析器读懂
    }
    const row = (task: string): string[] => {
      const hit = proj.rows.find((r) => r[0] === task);
      expect(hit, '缺行：' + task).toBeDefined();
      return hit ?? [];
    };
    expect(row('待办的事')[1]).toBe('⬜ 待办');
    expect(row('正在做的事')[1]).toBe('🔄 进行中');
    expect(row('正在做的事')[3]).toContain('vitest 3/3'); // doing：evidence 有则附
    expect(row('卡住的事')[1]).toBe('⛔ 阻塞');
    expect(row('回归的事')[1]).toBe('⛔ 回归');
    expect(row('回归的事')[3]).toContain('已做过又坏了');
    expect(row('完成的带证据')[1]).toBe('✅ 完成');
    expect(row('完成的带证据')[3]).toContain('e2e 通过');
    expect(row('完成的带证据')[3]).not.toContain('无证据');
    expect(row('完成的没证据')[1]).toBe('✅ 完成');
    expect(row('完成的没证据')[3]).toContain('无证据'); // done 无 evidence：附「无证据」
    // done + source 对不上账 → 展示层打回，明细带上文件名
    expect(row('完成的源码变了')[1]).toBe('⛔ 待复验');
    expect(row('完成的源码变了')[3]).toContain('⚠ 源码已变：old.ts');
    expect(row('完成的源码变了')[3]).toContain('旧的证据');
  });

  it('② 打回只发生在 done 上：doing 的 source 变了，状态列不动、也不加警告', () => {
    const proj = mapKanbanRows(root);
    const doing = proj.rows.find((r) => r[0] === '也进行中');
    expect(doing?.[1]).toBe('🔄 进行中');
    expect(doing?.[3] ?? '').not.toContain('⚠ 源码已变');
  });

  it('③ 行序：context.next 第一 → (doing, blocked, regressed, todo, done) → 同态按 id', () => {
    const proj = mapKanbanRows(root);
    expect(proj.rows.map((r) => r[0])).toEqual([
      NEXT,
      '正在做的事', // n-doing-a
      '也进行中', // n-doing-b（同态按 id：a < b）
      '卡住的事',
      '回归的事',
      '待办的事',
      '完成的没证据', // done 里 id 升序
      '完成的带证据',
      '完成的源码变了',
    ]);
    // 下一步行的状态列来自内核（🔄），明细说明它出自地图
    expect(proj.rows[0]?.[1]).toBe('🔄 进行中');
    expect(proj.rows[0]?.[2]).toBe(MAP_MODULE);
    expect(proj.rows[0]?.[3]).toContain('context.next');
    expect(proj.note).toContain('8 个节点');
    expect(proj.note).toContain('2 项待复验');
  });

  it('④ maxRows：超出时最后一行是「…还有 N 项」，且总行数不超上限', () => {
    const small = mapKanbanRows(root, { maxRows: 4 });
    expect(small.rows.length).toBe(4);
    expect(small.rows.map((r) => r[0])).toEqual([NEXT, '正在做的事', '也进行中', '…还有 6 项']);
    expect(small.rows[3]?.[1]).toBe('⬜ 待办'); // 收口行也要能被解析器读懂
    expect(small.rows[3]?.[3]).toContain('maxRows=4');
    // 上限非法（<2）→ 兜默认 12：9 行一次放得下
    expect(mapKanbanRows(root, { maxRows: 1 }).rows.length).toBe(9);
    expect(mapKanbanRows(root, { maxRows: 0 }).rows.length).toBe(9);
    expect(mapKanbanRows(root, { maxRows: Number.NaN }).rows.length).toBe(9);
  });
});
describe('[T3] 大图与失败路径（绝不抛、绝不拖挂看板）', () => {
  it('⑤ 20 个节点 + 默认上限 12：11 行内容 + 1 行「…还有 9 项」', () => {
    seq += 1;
    const big = path.join(tmp, 'big' + String(seq));
    const dir = path.join(big, '.sessionrelay', 'map');
    fs.mkdirSync(dir, { recursive: true });
    const nodes = Array.from({ length: 20 }, (_v, i) => ({
      id: 't' + String(i).padStart(2, '0'),
      label: '待办 ' + String(i + 1),
      layer: 'core',
      status: 'todo' as const,
    }));
    const page: MapPage = { id: 'map', title: '大图', layers: [{ id: 'core', name: '内核', rank: 0 }], groups: [], lanes: [], nodes, edges: [] };
    fs.writeFileSync(path.join(dir, 'map.json'), serializePage(page), 'utf8');
    const proj = mapKanbanRows(big);
    expect(proj.rows.length).toBe(12);
    expect(proj.rows[11]?.[0]).toBe('…还有 9 项');
    expect(proj.note).toContain('未列出 9 项');
  });

  it('⑥ 没地图 → 空 rows + note「没有地图」；图坏了 → 空 rows + note 带错误码', () => {
    const bare = bareRoot();
    expect(mapKanbanRows(bare).rows).toEqual([]);
    expect(mapKanbanRows(bare).note).toBe('没有地图');

    const broken = bareRoot();
    const dir = path.join(broken, '.sessionrelay', 'map');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'map.json'), '{"version":1,"title":"x","layers":[],"nodes":[],"edges":[],"bogus":1}', 'utf8');
    const bad = mapKanbanRows(broken);
    expect(bad.rows).toEqual([]);
    expect(bad.note).toContain('INVALID_STORE');

    expect(mapKanbanRows(bare, { page: '../escape' }).rows).toEqual([]);
    expect(mapKanbanRows('').rows).toEqual([]);
  });

  it('⑦ 只读 + 重复调用一致（地图/看板字节不变，只多出哈希缓存）', () => {
    const mapBefore = fs.readFileSync(mapFile);
    const boardBefore = fs.readFileSync(boardFile);
    const a = mapKanbanRows(root);
    const b = mapKanbanRows(root);
    expect(a).toEqual(b);
    const g1 = renderMapMermaid(root, readRows(root));
    const g2 = renderMapMermaid(root, readRows(root));
    expect(g1.ok && g2.ok && g1.value === g2.value).toBe(true);
    expect(fs.readFileSync(mapFile).equals(mapBefore)).toBe(true);
    expect(fs.readFileSync(boardFile).equals(boardBefore)).toBe(true);
    expect(fs.readdirSync(path.join(root, '.sessionrelay', 'map')).sort()).toEqual(['.hash-cache.json', 'map.json']);
  });
});

describe('[T3] renderMapMermaid', () => {
  it('⑧ 层带 subgraph（rank 高在上）+ 只画地图里的真边', () => {
    const got = renderMapMermaid(root, readRows(root));
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    const mmd = got.value;
    expect(mmd.startsWith('flowchart TB')).toBe(true);
    // 层带：app(rank 2) 在 core(rank 0) 上方
    const iApp = mmd.indexOf('subgraph L_app[');
    const iCore = mmd.indexOf('subgraph L_core[');
    expect(iApp).toBeGreaterThan(-1);
    expect(iCore).toBeGreaterThan(iApp);
    expect(mmd).toContain('应用（rank 2）');
    expect(mmd).toContain('内核（rank 0）');
    // 真边：直接来自地图 edges
    expect(mmd).toContain('m_n_doing_a -->|uses| m_n_todo');
    expect(mmd).toContain('m_n_blocked --> m_n_done_stale');
    const edgeLines = mmd.split('\n').filter((l) => l.includes('-->'));
    expect(edgeLines.length).toBe(2); // 多一根就是假边
    // 无假边：人写行不产生任何边（旧实现靠文本包含关系连边，踩过假边）
    expect(edgeLines.every((l) => /^ {4}m_[A-Za-z0-9_]+ -->/.test(l))).toBe(true);
    // 无同层边：每根线的两端必须分属不同层（不变式 §2.3）
    const layerOf: Record<string, string> = {
      m_n_doing_a: 'app',
      m_n_doing_b: 'core',
      m_n_blocked: 'app',
      m_n_regress: 'app',
      m_n_todo: 'core',
      m_n_done_ok: 'core',
      m_n_done_bare: 'core',
      m_n_done_stale: 'core',
    };
    for (const line of edgeLines) {
      const ids = line.match(/m_[A-Za-z0-9_]+/g) ?? [];
      expect(ids.length).toBe(2);
      expect(layerOf[ids[0] ?? '']).not.toBe(layerOf[ids[1] ?? '']);
    }
    // 打回状态也带进图里（同一份字形来源）
    expect(mmd).toContain('待复验');
  });

  it('⑨ 人写行进 HUMAN、auto:todos 进 AUTO、auto:map 行不再重复画', () => {
    const got = renderMapMermaid(root, readRows(root));
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    const mmd = got.value;
    expect(mmd).toContain('subgraph HUMAN');
    expect(mmd).toContain('人写的计划行');
    expect(mmd).toContain('subgraph AUTO');
    expect(mmd).toContain('来自 ZCode 的待办');
    expect(mmd).not.toContain('地图上的事'); // auto:map 行 = 层带本身
    const humanAt = mmd.indexOf('subgraph HUMAN');
    const autoAt = mmd.indexOf('subgraph AUTO');
    const layerAt = mmd.indexOf('subgraph L_app[');
    expect(humanAt).toBeLessThan(autoAt);
    expect(autoAt).toBeLessThan(layerAt);
    // 两种行形状都认：bridge 自己的 4 格数组（0=任务）喂进去也一样
    const fromProjection = renderMapMermaid(root, mapKanbanRows(root).rows);
    expect(fromProjection.ok).toBe(true);
    if (fromProjection.ok) {
      expect(fromProjection.value).toContain('subgraph L_app[');
      expect(fromProjection.value).not.toContain('地图上的事');
    }
  });

  it('⑩ 地图不存在 / 0 节点 → ok:false（让 kanban 回落纯行渲染）', () => {
    const bare = bareRoot();
    const missing = renderMapMermaid(bare, readRows(root));
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe('NOT_FOUND');

    const empty = bareRoot();
    const dir = path.join(empty, '.sessionrelay', 'map');
    fs.mkdirSync(dir, { recursive: true });
    const page: MapPage = { id: 'map', title: '空图', layers: [], groups: [], lanes: [], nodes: [], edges: [] };
    fs.writeFileSync(path.join(dir, 'map.json'), serializePage(page), 'utf8');
    const noNodes = renderMapMermaid(empty, []);
    expect(noNodes.ok).toBe(false);

    const broken = bareRoot();
    const dir2 = path.join(broken, '.sessionrelay', 'map');
    fs.mkdirSync(dir2, { recursive: true });
    fs.writeFileSync(path.join(dir2, 'map.json'), '{ 这不是 JSON', 'utf8');
    const bad = renderMapMermaid(broken, []);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe('INVALID_STORE');
  });

  it('⑪ 绝不抛：humanRows 是垃圾也照样返回', () => {
    const junk = renderMapMermaid(root, null as unknown as string[][]);
    expect(junk.ok).toBe(true);
    const junk2 = renderMapMermaid(root, [null, 42, [], ['x']] as unknown as string[][]);
    expect(junk2.ok).toBe(true);
    expect(() => mapKanbanRows(root, { maxRows: 'x' as unknown as number })).not.toThrow();
    expect(() => renderMapMermaid(root, [], { page: '../escape' })).not.toThrow();
    expect(mapKanbanRows(root, { maxRows: 'x' as unknown as number }).rows.length).toBe(9);
  });
});
