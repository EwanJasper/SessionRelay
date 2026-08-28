// 适配器注册表（改进方案 改动1 / D24）
// 核心代码只与本注册表交互，永不直接引用具体 adapter——加新 agent = 注册即可

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import type { SessionSourceAdapter, AdapterConfig } from './types.js';
import { claudeProjectsDir, zcodeDbPath, codexDir, traeDir, type RelayConfig } from '../shared/config.js';
import { adapter as claudeAdapter } from './claude-code/index.js';
import { adapter as zcodeAdapter } from './zcode/index.js';
import { adapter as codexAdapter } from './codex/index.js';
import { adapter as traeAdapter } from './trae/index.js';

const require = createRequire(import.meta.url);

const builtins = new Map<string, SessionSourceAdapter>();
const customs = new Map<string, SessionSourceAdapter>();

/** 注册内置适配器 */
export function register(adapter: SessionSourceAdapter): void {
  builtins.set(adapter.id, adapter);
}

/** 注册 custom 适配器（覆盖同名 builtin） */
export function registerCustom(adapter: SessionSourceAdapter): void {
  customs.set(adapter.id, adapter);
}

/** 获取适配器（custom 优先，再查 builtin） */
export function get(sourceId: string): SessionSourceAdapter | undefined {
  return customs.get(sourceId) ?? builtins.get(sourceId);
}

/** 列出所有可用适配器 */
export function list(): SessionSourceAdapter[] {
  const seen = new Set<string>();
  const out: SessionSourceAdapter[] = [];
  for (const a of [...customs.values(), ...builtins.values()]) {
    if (!seen.has(a.id)) { seen.add(a.id); out.push(a); }
  }
  return out;
}

/**
 * 从 .sessionrelay/adapters/ 目录加载自定义适配器
 * 文件名即 source id（如 dsh.js → source='dsh'）
 */
export function loadCustomAdapters(projectRoot: string): { loaded: string[]; errors: string[] } {
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
      registerCustom(adapter);
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
  const capture = cfg.capture as Record<string, unknown>;
  return (capture[`custom_${sourceId}`] as AdapterConfig) ?? {};
}

// ── 内置适配器注册（ESM top-level import，无循环依赖问题） ──
register(claudeAdapter);
register(zcodeAdapter);
register(codexAdapter);
register(traeAdapter);

// 标记已初始化（纯标记，加载 custom 由调用方触发）
let customLoaded = false;
export function ensureRegistered(projectRoot?: string): { loaded: string[]; errors: string[] } {
  if (!customLoaded && projectRoot) {
    customLoaded = true;
    return loadCustomAdapters(projectRoot);
  }
  return { loaded: [], errors: [] };
}
