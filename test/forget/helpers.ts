// forget 测试公用（test-forget v3 §I 构造规格）
// 关键纪律：功能/检索断言可直插 DB；复活对抗（resurrection.spec）必须造真实源文件。
import fs from 'node:fs';
import path from 'node:path';
import { vi } from 'vitest';
import { defaultConfig, saveConfig, type RelayConfig } from '../../src/shared/config.js';
import { projectIdOf } from '../../src/shared/paths.js';
import type { RelayConfig as Cfg } from '../../src/shared/config.js';

export class CliExit extends Error {
  constructor(public code: number) { super(`process.exit(${code})`); }
}

export interface CliCapture { out: string[]; err: string[] }

/** 捕获 CLI 输出与退出（die/用法错误走 process.exit——必须拦截防杀测试进程） */
export async function runCli(fn: () => Promise<void>): Promise<{ exitCode: number | null; cap: CliCapture }> {
  const cap: CliCapture = { out: [], err: [] };
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { cap.out.push(a.map(String).join(' ')); });
  const errSpy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { cap.err.push(a.map(String).join(' ')); });
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new CliExit(code ?? 0); }) as never);
  try {
    await fn();
    return { exitCode: null, cap };
  } catch (e) {
    if (e instanceof CliExit) return { exitCode: e.code, cap };
    throw e;
  } finally {
    logSpy.mockRestore(); errSpy.mockRestore(); exitSpy.mockRestore();
  }
}

export function makeProject(dir: string, over: Partial<Cfg['capture']> = {}): { root: string; pid: string; cfg: RelayConfig } {
  fs.mkdirSync(path.join(dir, '.sessionrelay'), { recursive: true });
  const cfg = defaultConfig();
  const pid = projectIdOf(dir);
  cfg.identity.project_id = pid;
  cfg.capture.sources = ['claude-code'];
  Object.assign(cfg.capture, over);
  saveConfig(dir, cfg);
  return { root: dir, pid, cfg };
}

/** 伪造运行中的守护（D5：心跳新鲜 + pid 存活——用测试进程自身 pid） */
export function fakeDaemon(root: string): void {
  fs.writeFileSync(path.join(root, '.sessionrelay', 'lock'),
    JSON.stringify({ pid: process.pid, heartbeat: Date.now(), at: new Date().toISOString() }));
}
