// 语义档「运行期状态」的回归测试（1017 夜：把"失败静默"变成"失败有据"）
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSemanticStatus, recordSemantic, describeSemantic, semanticStatusFile } from '../../src/search-svc/semantic-status.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'srelay-sem-'));
  process.env.SRELAY_SEMANTIC_HOME = home;
});
afterEach(() => {
  delete process.env.SRELAY_SEMANTIC_HOME;
  delete process.env.SRELAY_SEMANTIC_FAKE;
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* 清理失败不影响判据 */ }
});

describe('语义档 · 运行期状态', () => {
  it('没写过时是 never，且读侧不抛', () => {
    const s = readSemanticStatus();
    expect(s.state).toBe('never');
    expect(s.failures).toBe(0);
  });

  it('失败会留下**原因**（这就是「不许静默」的落点）', () => {
    recordSemantic({ state: 'failed', model: 'Xenova/bge-small-zh-v1.5', error: 'transformers.js 未安装' });
    const s = readSemanticStatus();
    expect(s.state).toBe('failed');
    expect(s.error).toContain('未安装');
    expect(s.failures).toBe(1);
    expect(s.attemptAt).toBeTruthy();
    expect(describeSemantic(s, true, true)).toContain('装载失败');
    expect(describeSemantic(s, true, true)).toContain('未安装');
  });

  it('装载成功清掉旧错误，并累计次数', () => {
    recordSemantic({ state: 'failed', model: 'm', error: 'boom' });
    recordSemantic({ state: 'ready', model: 'm' });
    const s = readSemanticStatus();
    expect(s.state).toBe('ready');
    expect(s.error).toBeNull();
    expect(s.loads).toBe(1);
    expect(s.failures).toBe(1);   // 历史失败次数不清零（要看得出"这个环境里坏过"）
    expect(s.loadedAt).toBeTruthy();
  });

  it('空闲卸载是一种**正常**状态，不是失败', () => {
    recordSemantic({ state: 'ready', model: 'm' });
    recordSemantic({ state: 'unloaded' });
    const s = readSemanticStatus();
    expect(s.state).toBe('unloaded');
    expect(describeSemantic(s, true, true)).toContain('空闲卸载');
  });

  it('面板（不知道按项目开关）也能拿到一句人话', () => {
    const s = readSemanticStatus();
    const txt = describeSemantic(s, null);
    expect(txt).toContain('按项目');
    expect(describeSemantic({ ...s, state: 'failed', error: 'x' }, null)).toContain('装载失败');
  });

  it('状态文件写在 SRELAY_SEMANTIC_HOME 下（不碰用户家目录）', () => {
    recordSemantic({ state: 'ready', model: 'm' });
    expect(fs.existsSync(semanticStatusFile())).toBe(true);
    expect(semanticStatusFile().startsWith(home)).toBe(true);
  });

  it('文件损坏时读回 never（展示路径不许抛）', () => {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(semanticStatusFile(), '{ 这不是 json');
    expect(readSemanticStatus().state).toBe('never');
  });

  it('零依赖钉子：状态模块不许 import store/db 或任何原生依赖（面板宿主半要 import 它）', () => {
    const src = fs.readFileSync(fileURLToPath(new URL('../../src/search-svc/semantic-status.ts', import.meta.url)), 'utf8');
    const imports = src.split(/\r?\n/).filter((l) => /^\s*import\b/.test(l));
    expect(imports.every((l) => /from 'node:/.test(l)), imports.join(' | ')).toBe(true);
  });
});

describe('语义档 · 真跑一次装载失败', () => {
  it('enabled=true 但环境没装 → 返回 null（降级不变）**且状态文件里记下了原因**', async () => {
    const { getEmbedder, resetSemanticCaches } = await import('../../src/search-svc/semantic.js');
    resetSemanticCaches();
    const cfg = { semantic: { enabled: true, model: 'no-such-model-for-test' } } as never;
    const e = await getEmbedder(cfg);
    expect(e).toBeNull();                                  // 行为不变：调用方照样走纯 FTS
    const s = readSemanticStatus();
    expect(s.state).toBe('failed');                        // 但这次**留下了证据**
    expect(String(s.error).length).toBeGreaterThan(3);
  });

  it('enabled=false 时什么都不写（关着就是关着，不该产生噪音）', async () => {
    const { getEmbedder, resetSemanticCaches } = await import('../../src/search-svc/semantic.js');
    resetSemanticCaches();
    const e = await getEmbedder({ semantic: { enabled: false } } as never);
    expect(e).toBeNull();
    expect(readSemanticStatus().state).toBe('never');
  });
});
