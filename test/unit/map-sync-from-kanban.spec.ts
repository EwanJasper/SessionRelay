import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hatchMapFromKanban, syncMapFromKanban } from '../../src/cli/map.js';
import { readPageIfExists } from '../../src/map/index.js';

/**
 * 看板 → 地图增量同步（2026-10-18）。
 *
 * 病根：地图建好之后**没有任何路径能让它变** —— hatch 只管「还没有地图」，
 *   upgrade 只管「单层孵化图」，两者对「已有地图 + 看板新增了行」都返回不动。
 *   于是 progress.md 里新写的事永远进不了图，用户看到的就是「标签和节点一直那样」。
 */
const kanban = (rows) => {
  const lines = ['| 任务 | 状态 | 模块 | 明细 |', '|---|---|---|---|'];
  for (const pair of rows) lines.push('| ' + pair[0] + ' | ' + pair[1] + ' | core | - |');
  return lines.join('\n');
};
const mk = (rows) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'srelay-sync-'));
  fs.writeFileSync(path.join(dir, 'progress.md'), kanban(rows));
  return dir;
};
const pageOf = (dir) => {
  const r = readPageIfExists(dir);
  return r.ok ? r.value : undefined;
};

describe('看板 → 地图增量同步', () => {
  it('没有地图时什么也不做（首次建图归孵化器）', () => {
    const d = mk([['甲', '✅']]);
    const r = syncMapFromKanban(d);
    expect(r.ok).toBe(false);
    expect(r.note).toContain('孵化');
  });

  it('★ 看板新增一行 ⇒ 图里多一个节点（这就是「刷新」）', () => {
    const d = mk([['甲', '✅']]);
    hatchMapFromKanban(d);
    const before = pageOf(d).page.nodes.length;
    fs.writeFileSync(path.join(d, 'progress.md'), kanban([['甲', '✅'], ['新事', '🔄']]));
    const r = syncMapFromKanban(d);
    expect(r.ok).toBe(true);
    expect(r.added).toBe(1);
    expect(pageOf(d).page.nodes.length).toBe(before + 1);
  });
  it('★ 新节点落进收件箱层，且不改动已有层的 rank', () => {
    const d = mk([['甲', '✅']]);
    hatchMapFromKanban(d);
    const ranksBefore = pageOf(d).page.layers.map((l) => l.id + '@' + l.rank).join(',');
    fs.writeFileSync(path.join(d, 'progress.md'), kanban([['甲', '✅'], ['新事', '🔄']]));
    syncMapFromKanban(d);
    const page = pageOf(d).page;
    const added = page.nodes.find((n) => n.label === '新事');
    expect(added.layer).toBe('inbox');
    expect(page.layers.some((l) => l.id === 'inbox')).toBe(true);
    const kept = page.layers.filter((l) => l.id !== 'inbox').map((l) => l.id + '@' + l.rank).join(',');
    expect(kept).toBe(ranksBefore);
  });

  it('★ 看板状态变了 ⇒ 地图节点状态**不跟着变**（地图是结构真值，投影不能反过来定义它）', () => {
    const d = mk([['甲', '🔄 进行中']]);
    hatchMapFromKanban(d);
    const beforeStatus = pageOf(d).page.nodes.find((n) => n.label === '甲').status;
    fs.writeFileSync(path.join(d, 'progress.md'), kanban([['甲', '✅ 完成']]));
    const r = syncMapFromKanban(d);
    // 红队实测打回的设计冲突：docs/map-cli.md 明写「投影不改地图里的 status」，
    //   而原实现每轮拿看板状态覆盖地图 ⇒ 用户按文档改的地图状态下一轮被静默改回。
    expect(r.statusFixed).toBe(0);
    expect(pageOf(d).page.nodes.find((n) => n.label === '甲').status).toBe(beforeStatus);
  });

  it('★ 看板行消失 ⇒ 不删节点（删是人的决定）', () => {
    const d = mk([['甲', '✅'], ['乙', '✅']]);
    hatchMapFromKanban(d);
    fs.writeFileSync(path.join(d, 'progress.md'), kanban([['甲', '✅']]));
    syncMapFromKanban(d);
    expect(pageOf(d).page.nodes.map((n) => n.label)).toContain('乙');
  });

  it('与看板一致时返回「与看板一致」且不写盘（revision 不变）', () => {
    const d = mk([['甲', '✅']]);
    hatchMapFromKanban(d);
    const revBefore = pageOf(d).revision;
    const r = syncMapFromKanban(d);
    expect(r.ok).toBe(true);
    expect(r.added).toBe(0);
    expect(r.statusFixed).toBe(0);
    expect(pageOf(d).revision).toBe(revBefore);
  });

  it('★ 匹配率过低（人写的结构图）⇒ 只同步状态、不新增节点', async () => {
    const d = mk([['任务甲', '✅']]);
    hatchMapFromKanban(d);
    // 手工把这张图改成「人写的结构图」：节点名与看板行完全无关
    const { applyPatch } = await import('../../src/map/store/apply.js');
    const before = pageOf(d);
    applyPatch(d, {
      expectedRevision: before.revision,
      operations: [{ op: 'declare', data: { nodes: [{ id: 'arch1', label: '架构模块甲', layer: 'plan', status: 'done' }] } }],
    });
    // 看板加两行（与图完全对不上）
    fs.writeFileSync(path.join(d, 'progress.md'), kanban([['乙事', '✅'], ['丙事', '✅'], ['丁事', '✅']]));
    const r = syncMapFromKanban(d);
    expect(r.ok).toBe(true);
    expect(r.added).toBe(0);
    expect(r.note).toContain('结构图');
    expect(pageOf(d).page.nodes.map((n) => n.label)).not.toContain('丁事');
  });


  it('★ 两波新增：id 不会撞（原病：kb1 撞名拼成 kb1_x，非法 id 整批被拒，此后永久停摆）', () => {
    const d = mk([['甲', '✅']]);
    hatchMapFromKanban(d);
    fs.writeFileSync(path.join(d, 'progress.md'), kanban([['甲', '✅'], ['第一波', '✅']]));
    expect(syncMapFromKanban(d).added).toBe(1);
    fs.writeFileSync(path.join(d, 'progress.md'), kanban([['甲', '✅'], ['第一波', '✅'], ['第二波', '✅']]));
    const r = syncMapFromKanban(d);
    expect(r.ok, '第二波必须成功 —— 原病是 REFUSED 后永久停摆').toBe(true);
    expect(r.added).toBe(1);
    const ids = pageOf(d).page.nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((x) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(x)), 'id 必须符合 MAP_ID_RULE').toBe(true);
  });


  it('★ 匹配极少但新增极多 ⇒ 拒绝新增（红队 P2-5：1 个偶然同名不能击穿护栏）', () => {
    const rows = [['发布', '✅']];
    for (let i = 0; i < 24; i++) rows.push(['新任务' + i, '✅']);
    const d = mk(rows);
    hatchMapFromKanban(d);
    // 现在图里 25 个节点都与看板同名 —— 这反而是正常孵化图，再加 25 条全新的
    const more = rows.concat(Array.from({ length: 25 }, (_, i) => ['后加' + i, '✅']));
    fs.writeFileSync(path.join(d, 'progress.md'), kanban(more));
    const r = syncMapFromKanban(d);
    // 25 个匹配、25 个新增 ⇒ allowAdd = max(3, 125) = 125 ⇒ 放行；单轮上限 20 生效
    expect(r.added).toBe(20);
    // 下一轮继续把剩下的收进来（这才是「多的下轮继续」第一次真的成立）
    const r2 = syncMapFromKanban(d);
    expect(r2.added).toBe(5);
  });


  it('★ 重复行不能凑 matched（原病：5 份「甲」+20 新行 ⇒ matched=5 ⇒ 塞 20 个噪音）', () => {
    const rows = [];
    for (let i = 0; i < 5; i++) rows.push(['甲', '✅']);   // 5 份同名（粘贴事故）
    const d = mk(rows);
    hatchMapFromKanban(d);
    const more = rows.concat(Array.from({ length: 20 }, (_, i) => ['新任务' + i, '✅']));
    fs.writeFileSync(path.join(d, 'progress.md'), kanban(more));
    const r = syncMapFromKanban(d);
    // 1 个去重 label ⇒ allowAdd = max(3, 5) = 5 < 20 ⇒ 拒绝新增
    expect(r.added).toBe(0);
  });

  it('★ 地图自己的投影对不上自己时，不许判成「人写结构图」而永久冻结', () => {
    // 原病：byLabel 用地图原 label，而投影会拍平/截断 ⇒ 只剩自身投影 + 1 条新行也 added=0。
    const d = mk([['甲  双空格', '✅'], ['乙|竖线', '✅']]);
    hatchMapFromKanban(d);
    fs.writeFileSync(path.join(d, 'progress.md'), kanban([['甲  双空格', '✅'], ['乙|竖线', '✅'], ['新人写行', '✅']]));
    const r = syncMapFromKanban(d);
    expect(r.ok).toBe(true);
    expect(r.added, '两条存量都对得上 ⇒ 应当放行新增，不该判成人写结构图').toBe(1);
  });
});
