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
// 语义档 · 模型档案（防"静默产出垃圾向量"）
//
// 病历（1017 夜调研）：dtype/pooling/维度原先全写死（q8 / cls / 512）。
// 换一个 pooling 不同的模型（如 Qwen3-Embedding 要 last_token）会**装载成功、检索有结果、分数看着正常**
// —— 但向量是垃圾。是"看起来在工作"的一号故障模式，所以判据是：认不出就拒绝，不猜。
import { describe, it, expect } from 'vitest';
import { profileOf, MODEL_PROFILES, DEFAULT_MODEL, BGE_ZH_QUERY_PREFIX } from '../../src/search-svc/semantic.js';

describe('语义档 · 模型档案', () => {
  it('默认模型必须有档案（它是唯一被实测过的档）', () => {
    expect(MODEL_PROFILES[DEFAULT_MODEL]).toEqual({ pooling: 'cls', dim: 512, dtype: 'q8', queryPrefix: BGE_ZH_QUERY_PREFIX });
    expect(profileOf(DEFAULT_MODEL)?.pooling).toBe('cls');
    // [1017 夜] BGE 中文是**非对称**模型：查询侧必须带指令前缀，否则查询与文档不在同一子空间。
    // 实测：不加前缀时语义臂 hit@1 1.7%，加了 2.3%（n=300）—— 幅度小但方向一致，且是官方用法。
    expect(profileOf(DEFAULT_MODEL)?.queryPrefix, 'BGE 中文系列的查询前缀不能丢').toBe(BGE_ZH_QUERY_PREFIX);
  });

  it('bge 中文系列按 cls，维度按档位（small 512 / base 768 / large 1024）', () => {
    expect(profileOf('Xenova/bge-base-zh-v1.5')?.dim).toBe(768);
    expect(profileOf('BAAI/bge-large-zh-v1.5')?.dim).toBe(1024);
    expect(profileOf('BAAI/bge-m3')?.pooling).toBe('cls');
  });

  it('Qwen3-Embedding 必须走 last_token —— 推成 cls 就是垃圾向量', () => {
    expect(profileOf('onnx-community/Qwen3-Embedding-0.6B')?.pooling).toBe('last_token');
  });

  it('不认识的模型返回 null（装载前就拒绝，不按默认 cls 蒙一把）', () => {
    expect(profileOf('text-embedding-3-large')).toBeNull();
    expect(profileOf('随便一个没登记的模型')).toBeNull();
  });

  it('真的去装未知模型 → 报错里说清"该怎么办"，而不是静默降级', async () => {
    const { createTransformersEmbedder } = await import('../../src/search-svc/semantic.js');
    await expect(createTransformersEmbedder('没登记/model')).rejects.toThrow(/未知模型档案/);
    await expect(createTransformersEmbedder('没登记/model')).rejects.toThrow(/MODEL_PROFILES/);
  });
});
