// #16 回归：多个项目的自定义适配器不得串味（1021 适配器组）
//
// 病历（docs/1021-红队审计-RT.md #16）：`customLoaded` 是**进程级单个布尔**、custom 适配器是**一张全局表**。
//   第一个项目加载完 `.sessionrelay/adapters/` 之后，后续项目**再也不读自己的目录**，且拿到的是
//   上一个项目的适配器（实测：A、B 各定义同名 zzprobe，B 初始化后 get('zzprobe') 仍是 A 的标记）。
//
// 修前会红：把 registry 回退成全局 `customLoaded` + 全局 `customs`（或回退 60c5de0）
//   ⇒ 第二次 get('zzprobe') 仍是 'A-marker'（断言 'B-marker' 失败）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ensureRegistered, get, list } from '../../src/adapters/registry.js';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'srelay-r1021-reg-'));
});
afterEach(() => {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 清理失败不影响判据 */ }
});

/** 在临时项目里造一个自定义适配器（文件名即 source id；.cjs 显式走 CommonJS require） */
function makeProject(name: string, marker: string): string {
  const projectRoot = path.join(root, name);
  const dir = path.join(projectRoot, '.sessionrelay', 'adapters');
  fs.mkdirSync(dir, { recursive: true });
  const src = [
    'module.exports = {',
    '  id: "zzprobe",',
    '  displayName: ' + JSON.stringify(marker) + ',',
    '  discover: function () { return []; },',
    '  readNew: async function () { return { messages: [], badLines: 0, cursor: {} }; },',
    '};',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'zzprobe.cjs'), src);
  return projectRoot;
}

describe('#16 · 注册上下文按项目根隔离', () => {
  it('A、B 各自定义同名适配器：依次初始化后各拿各的（含显式上下文 get）', () => {
    const projA = makeProject('projA', 'A-marker');
    const projB = makeProject('projB', 'B-marker');

    ensureRegistered(projA);
    // [B2] 读适配器必须显式带项目根（进程级 activeKey 已删除）
    expect(get('zzprobe', projA)?.displayName, 'A 初始化后应拿到 A 的适配器').toBe('A-marker');

    ensureRegistered(projB);
    // 修前（#16）：这里恒为 'A-marker'（进程级布尔把 B 的加载整个跳过了）
    expect(get('zzprobe', projB)?.displayName, 'B 初始化后必须拿到 B 的适配器').toBe('B-marker');

    // 两次初始化后 A 仍必须是 A 的——旧 activeKey 实现下"最近一次"会把 A 抢走
    expect(get('zzprobe', projA)?.displayName).toBe('A-marker');

    // list 也必须按上下文给（sync 用它报「未知源可用列表」）
    expect(list(projB).find((a) => a.id === 'zzprobe')?.displayName).toBe('B-marker');
    expect(list(projA).find((a) => a.id === 'zzprobe')?.displayName).toBe('A-marker');
  });

  it('没有适配器目录的项目不会被上一个项目的注册污染', () => {
    const projA = makeProject('projA2', 'A-marker');
    const projEmpty = path.join(root, 'projEmpty');
    fs.mkdirSync(projEmpty, { recursive: true });
    ensureRegistered(projA);
    expect(get('zzprobe', projA)?.displayName).toBe('A-marker');
    ensureRegistered(projEmpty);
    // 空项目：拿不到 zzprobe（回落到 builtin 表，那里没有这个 id）
    expect(get('zzprobe', projEmpty)).toBeUndefined();
  });

  it('[B2] 漏传项目根 = 立刻抛错（歧义路径已删除，不许静默猜上下文）', () => {
    const projA = makeProject('projA3', 'A-marker');
    ensureRegistered(projA);
    // @ts-expect-error 故意漏传 root：TypeScript 层也拦（这里验证运行时同样不放过）
    expect(() => get('zzprobe')).toThrow(/必须显式传 projectRoot/);
    // @ts-expect-error 同上
    expect(() => list()).toThrow(/必须显式传 projectRoot/);
  });
});