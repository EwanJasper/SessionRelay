// 适配器注册表（改进方案 改动1 / D24）
// 核心代码只与本注册表交互，永不直接引用具体 adapter——加新 agent = 注册即可

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import type { SessionSourceAdapter, AdapterConfig } from './types.js';
import { claudeProjectsDir, zcodeDbPath, codexDir, traeDir, qoderDir, dshSessionsDir, type RelayConfig } from '../shared/config.js';
import { adapter as claudeAdapter } from './claude-code/index.js';
import { adapter as zcodeAdapter } from './zcode/index.js';
import { adapter as codexAdapter } from './codex/index.js';
import { adapter as traeAdapter } from './trae/index.js';
import { adapter as qoderAdapter } from './qoder/index.js';
import { adapter as dshAdapter } from './dsh/index.js';

const require = createRequire(import.meta.url);

const builtins = new Map<string, SessionSourceAdapter>();

// ── 注册上下文（[1021 #16]）──
//
// 病历：原来 `customLoaded` 是**进程级单个布尔**、custom 适配器是**一张全局表**。于是第一个项目
// 加载完 `.sessionrelay/adapters/` 之后，后续项目**再也不读自己的目录**，而且拿到的是上一个项目的
// 适配器（实测：A、B 各定义一个 zzprobe.js，依次初始化后 B 拿到的是 A 的标记）。
//
// 修法：以**项目根**为键管理注册上下文。**读路径一律显式传根**。
//
// [B2 二次收口] 上一版还给老调用点留了个兜底：模块级 `let activeKey` = "最近一次 ensureRegistered
//   设定的活动上下文"。那是一条**歧义路径**：全局守护并发跑多项目，两次 await 之间别的项目可能
//   把 activeKey 改写 ⇒ A 项目的周期拿到 B 项目的同名 custom adapter（红队已复现）。
//   现在 activeKey **彻底删除**：`get(id, root)` / `list(root)` 的 root 必填，
//   调用方漏传就**立刻抛错**（requireRoot），不再有"猜一个上下文"的余地。
interface RegContext {
  loaded: boolean;
  customs: Map<string, SessionSourceAdapter>;
}

/** 不带项目根的 registerCustom 落到这里（只做**写**：对所有项目可见、优先级低于项目自己的）。
 *  读路径不允许再隐式取它 —— 见下面 requireRoot 的注释。 */
const globalContext: RegContext = { loaded: true, customs: new Map() };
const contexts = new Map<string, RegContext>();

const keyOf = (projectRoot: string): string => path.resolve(projectRoot).toLowerCase();

/** [B2] 读路径的唯一入口校验：**必须**显式给项目根。
 *  病历：原实现有模块级 `let activeKey`（最近一次 ensureRegistered 的项目），老调用点
 *  `get(source)` 不传根就落到它上面。全局守护是**并发**跑多项目的：两次 await 之间别的项目
 *  可能把 activeKey 改写，于是 A 项目的周期拿到 B 项目的同名 custom adapter（串项目）。
 *  这条歧义路径已**彻底删除**（activeKey 不存在了）；再漏传根 = 立刻抛错，不许静默猜测。 */
function requireRoot(api: string, projectRoot?: string): string {
  if (typeof projectRoot !== 'string' || projectRoot.trim() === '') {
    throw new Error(api + '() 必须显式传 projectRoot：进程级 activeKey 已删除（多项目并发会串项目，见 1021 #16 / B2）');
  }
  return projectRoot;
}

function ctxFor(projectRoot: string): RegContext {
  const k = keyOf(projectRoot);
  let c = contexts.get(k);
  if (!c) { c = { loaded: false, customs: new Map() }; contexts.set(k, c); }
  return c;
}

/** 取上下文：**只认显式传入的项目根**（缺失即抛错，见 requireRoot）。 */
function contextOf(api: string, projectRoot?: string): RegContext {
  return ctxFor(requireRoot(api, projectRoot));
}

/** 注册内置适配器 */
export function register(adapter: SessionSourceAdapter): void {
  builtins.set(adapter.id, adapter);
}

/** 注册 custom 适配器（覆盖同名 builtin）。给了 projectRoot 就只对该项目生效。 */
export function registerCustom(adapter: SessionSourceAdapter, projectRoot?: string): void {
  (projectRoot ? ctxFor(projectRoot) : globalContext).customs.set(adapter.id, adapter);
}

/** 获取适配器：项目上下文 custom 优先 → 全局 custom → builtin。
 *  [B2] projectRoot **必填**；不传直接抛错（不再回落到进程级 activeKey）。 */
export function get(sourceId: string, projectRoot: string): SessionSourceAdapter | undefined {
  const ctx = contextOf('get', projectRoot);
  return ctx.customs.get(sourceId) ?? globalContext.customs.get(sourceId) ?? builtins.get(sourceId);
}

/** 列出所有可用适配器（同一 id 只出现一次，先到先得 = 项目 custom 优先）。
 *  [B2] projectRoot **必填**；不传直接抛错（不再回落到进程级 activeKey）。 */
export function list(projectRoot: string): SessionSourceAdapter[] {
  const ctx = contextOf('list', projectRoot);
  const seen = new Set<string>();
  const out: SessionSourceAdapter[] = [];
  for (const a of [...ctx.customs.values(), ...globalContext.customs.values(), ...builtins.values()]) {
    if (!seen.has(a.id)) { seen.add(a.id); out.push(a); }
  }
  return out;
}

/**
 * 从 .sessionrelay/adapters/ 目录加载自定义适配器
 * 文件名即 source id（如 dsh.js → source='dsh'）
 */
export function loadCustomAdapters(projectRoot: string): { loaded: string[]; errors: string[] } {
  const ctx = ctxFor(projectRoot);
  // 标记要在**读目录之前**：这个函数只为某一个项目跑一次（谁把代码变真谁负责），
  // 目录不存在也算"读过"——否则每个周期都要 stat 一次，而旧行为同样只尝试一次。
  ctx.loaded = true;
  const dir = path.join(projectRoot, '.sessionrelay', 'adapters');
  if (!fs.existsSync(dir)) return { loaded: [], errors: [] };

  const loaded: string[] = [];
  const errors: string[] = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.js') && !f.endsWith('.cjs')) continue;
    const sourceId = f.replace(/\.(js|cjs)$/, '');
    try {
      const mod = require(path.join(dir, f));
      const adapter = (mod.default ?? mod) as SessionSourceAdapter;
      if (!adapter.id || !adapter.discover || !adapter.readNew) {
        errors.push(`${f}: 缺少 id/discover/readNew`);
        continue;
      }
      registerCustom(adapter, projectRoot);   // 只注册进这个项目的上下文
      loaded.push(sourceId);
    } catch (e) {
      errors.push(`${f}: ${(e as Error).message}`);
    }
  }
  return { loaded, errors };
}

/** 从 RelayConfig 提取指定 adapter 的配置 */
export function adapterConfig(cfg: RelayConfig, sourceId: string): AdapterConfig {
  if (sourceId === 'claude-code') {
    return { projectsDir: claudeProjectsDir(cfg) };
  }
  if (sourceId === 'zcode') {
    return { dbPath: zcodeDbPath(cfg) };
  }
  if (sourceId === 'codex') {
    return { codexDir: codexDir(cfg) };
  }
  if (sourceId === 'trae') {
    return { traeDir: traeDir(cfg) };
  }
  if (sourceId === 'qoder') {
    return { qoderDir: qoderDir(cfg) };
  }
  if (sourceId === 'dsh') {
    return { sessionsDir: dshSessionsDir(cfg) };
  }
  const capture = cfg.capture as Record<string, unknown>;
  return (capture[`custom_${sourceId}`] as AdapterConfig) ?? {};
}

// ── 内置适配器注册（ESM top-level import，无循环依赖问题） ──
register(claudeAdapter);
register(zcodeAdapter);
register(codexAdapter);
register(traeAdapter);
register(qoderAdapter);
register(dshAdapter);

/**
 * 初始化某个项目的注册上下文（加载它的 .sessionrelay/adapters/ 一次）。
 *
 * [1021 #16] 关键是**每个项目各一次**：原实现是进程级单个 `customLoaded` 布尔，
 * 第一个项目加载后，后续项目直接返回空结果（连自己的目录都不读）。
 * [B2] 这里**不再**顺手设置什么"活动上下文"（activeKey 已删）：读适配器一律显式传根，
 *       并发项目之间没有任何共享可变状态可以串。
 */
export function ensureRegistered(projectRoot: string): { loaded: string[]; errors: string[] } {
  const ctx = ctxFor(projectRoot);
  if (ctx.loaded) return { loaded: [], errors: [] };
  return loadCustomAdapters(projectRoot);
}
