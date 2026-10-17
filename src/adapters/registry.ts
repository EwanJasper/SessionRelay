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
// 修法：以**项目根**为键管理注册上下文。
//   · `get(id, root)` / `list(root)` 可显式携带上下文（新代码请这样调）；
//   · 老调用点（sync.ts / watch.ts 的 `get(source)`）不传 root —— 它们都在
//     `ensureRegistered(root)` **之后**才 get，所以走"最近一次 ensureRegistered 设定的活动上下文"，
//     拿到的正是自己项目的上下文。这条规则写在 ensureRegistered 上，别在别处另立一套。
interface RegContext {
  loaded: boolean;
  customs: Map<string, SessionSourceAdapter>;
}

/** 不带项目根的 registerCustom 落到这里（= 旧行为：对所有项目可见，优先级低于项目自己的） */
const globalContext: RegContext = { loaded: true, customs: new Map() };
const contexts = new Map<string, RegContext>();
/** 最近一次 ensureRegistered(root) 设定的活动上下文（老调用点靠它） */
let activeKey: string | null = null;

const keyOf = (projectRoot: string): string => path.resolve(projectRoot).toLowerCase();

function ctxFor(projectRoot: string): RegContext {
  const k = keyOf(projectRoot);
  let c = contexts.get(k);
  if (!c) { c = { loaded: false, customs: new Map() }; contexts.set(k, c); }
  return c;
}

/** 取上下文：给 root 就取那个项目的；没给就取活动上下文；都没有才退回全局（只有 builtins + 显式注册） */
function contextOf(projectRoot?: string): RegContext {
  if (projectRoot) return ctxFor(projectRoot);
  if (activeKey) {
    const c = contexts.get(activeKey);
    if (c) return c;
  }
  return globalContext;
}

/** 注册内置适配器 */
export function register(adapter: SessionSourceAdapter): void {
  builtins.set(adapter.id, adapter);
}

/** 注册 custom 适配器（覆盖同名 builtin）。给了 projectRoot 就只对该项目生效。 */
export function registerCustom(adapter: SessionSourceAdapter, projectRoot?: string): void {
  (projectRoot ? ctxFor(projectRoot) : globalContext).customs.set(adapter.id, adapter);
}

/** 获取适配器：项目上下文 custom 优先 → 全局 custom → builtin。 */
export function get(sourceId: string, projectRoot?: string): SessionSourceAdapter | undefined {
  const ctx = contextOf(projectRoot);
  return ctx.customs.get(sourceId) ?? globalContext.customs.get(sourceId) ?? builtins.get(sourceId);
}

/** 列出所有可用适配器（同一 id 只出现一次，先到先得 = 项目 custom 优先） */
export function list(projectRoot?: string): SessionSourceAdapter[] {
  const ctx = contextOf(projectRoot);
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
 * 同时这里会把该项目的上下文设为**活动上下文**，供不传 root 的老调用点（`get(source)`）使用。
 */
export function ensureRegistered(projectRoot?: string): { loaded: string[]; errors: string[] } {
  if (!projectRoot) return { loaded: [], errors: [] };   // 没有项目根 = 无从加载（与原行为一致）
  const key = keyOf(projectRoot);
  activeKey = key;
  const ctx = ctxFor(projectRoot);
  if (ctx.loaded) return { loaded: [], errors: [] };
  return loadCustomAdapters(projectRoot);
}
