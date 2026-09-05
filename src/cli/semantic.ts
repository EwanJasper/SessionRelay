// srelay semantic（design-semantic v4）：可选语义检索——显式 opt-in，未启用零行为变化
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, saveConfig } from '../shared/config.js';
import { dbFile } from '../shared/paths.js';
import { openExisting, countSemanticBacklog, vectorSignature } from '../store/db.js';
import {
  semanticCacheDir, resolveTransformersEntry, getEmbedder, semanticSearch, digestSemantic,
  DEFAULT_MODEL, DEFAULT_THRESHOLD, resetSemanticCaches,
} from '../search-svc/semantic.js';
import { searchSessions } from '../search-svc/engine.js';
import { findRelayRoot } from '../shared/paths.js';
import { die, pc } from './ui.js';

export interface SemanticFlags {
  enable?: boolean;
  disable?: boolean;
  status?: boolean;
  test?: string;
  threshold?: string;
}

// enable 时安装依赖：npm --prefix 用户缓存目录（不进主包；Windows .cmd 必须 shell——R10）
function installTransformers(): boolean {
  const dir = semanticCacheDir();
  fs.mkdirSync(dir, { recursive: true });
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  console.log(pc.dim(`  安装 @huggingface/transformers 到 ${dir.replace(/\\/g, '/')} ...`));
  const r = spawnSync(npm, ['install', '--no-fund', '--no-audit', '--loglevel=error', '@huggingface/transformers@^3'], {
    shell: process.platform === 'win32', encoding: 'utf-8', cwd: dir, stdio: 'pipe',
  });
  return r.status === 0 && !!resolveTransformersEntry();
}

export async function cmdSemantic(f: SemanticFlags): Promise<void> {
  const root = findRelayRoot(process.cwd());
  if (!root) die('未找到 .sessionrelay（本项目尚未初始化）', '在项目根目录运行 srelay init');
  const cfg = loadConfig(root);

  // ── enable ──
  if (f.enable) {
    if (cfg.semantic?.enabled === true) { console.log(pc.dim('语义检索已启用（无需重复 enable）')); return; }
    console.log(pc.cyan('⚡ 启用语义检索（本地推理，完全可选）'));
    // ① 依赖：已装跳过；未装自动安装；失败给指引退出（不留半开状态）
    if (!resolveTransformersEntry()) {
      const ok = installTransformers();
      if (!ok) {
        die(
          'transformers.js 安装失败（网络或权限）',
          `手动安装：npm i --prefix ~/.sessionrelay/semantic @huggingface/transformers@3 后重试；国内模型下载可设 HF_ENDPOINT=https://hf-mirror.com`,
        );
      }
    } else {
      console.log(pc.dim('  transformers.js 已就绪'));
    }
    // ② 写配置（模型就绪与否不阻塞开关——检索路径自带 R3 降级）
    const semantic = { ...(cfg.semantic ?? {}), enabled: true, model: cfg.semantic?.model ?? DEFAULT_MODEL, threshold: cfg.semantic?.threshold ?? DEFAULT_THRESHOLD };
    saveConfig(root, { ...cfg, semantic });
    resetSemanticCaches();
    // ③ 模型就绪检查 + 存量回填（Fake 环境跳过模型；真模型首次会触发下载）
    const embedder = await getEmbedder(loadConfig(root));
    if (!embedder) {
      console.log(pc.yellow('  ⚠️ 模型暂不可用（首次运行需下载，或离线）——开关已保存，检索暂走纯 FTS，模型就绪后自动生效'));
      console.log(pc.dim('  提示：HF_ENDPOINT=https://hf-mirror.com srelay sync 触发下载（国内镜像）'));
      return;
    }
    console.log(pc.dim(`  模型 ${embedder.model} 就绪，开始回填存量 confirmed 会话...`));
    const db = openExisting(dbFile(root));
    try {
      let total = 0;
      for (;;) {
        const n = await digestSemantic(db, loadConfig(root), { projectId: cfg.identity.project_id, limit: 50 });
        total += n;
        if (n === 0) break;
        process.stdout.write(`\r  已嵌入 ${total} 个会话`);
      }
      console.log('');
      const backlog = countSemanticBacklog(db, embedder.model);
      console.log(pc.green('✓') + ` 语义检索已启用：${total} 向量 · 待嵌 ${backlog}`);
      console.log(pc.dim('  验证：srelay semantic test "换一种说法的查询"'));
    } finally { db.close(); }
    return;
  }

  // ── disable ──
  if (f.disable) {
    if (cfg.semantic?.enabled !== true) { console.log(pc.dim('语义检索本就未启用')); return; }
    saveConfig(root, { ...cfg, semantic: { ...cfg.semantic, enabled: false } });
    resetSemanticCaches();
    console.log(pc.green('✓') + ' 已停用（向量数据保留；重新 enable 无需重新回填）');
    return;
  }

  // ── test：FTS vs 语义 vs 融合 对比（透明度与调参工具） ──
  if (f.test !== undefined) {
    const db = openExisting(dbFile(root));
    try {
      const project = cfg.identity.project_id ?? root;
      const ftsOnly = searchSessions(db, { project, query: f.test, limit: 10 });
      const sem = await semanticSearch(db, cfg, f.test, { project });
      const merged = searchSessions(db, { project, query: f.test, limit: 10, semanticHits: sem });
      const line = (h: typeof ftsOnly[number]) =>
        `  ${h.sessionId}  「${(h.snippet || '').slice(0, 30)}」 ${h.viaSemantic ? pc.cyan('[语义]') : h.viaMeta ? pc.dim('[meta]') : '[FTS]'}`;
      console.log(pc.cyan(`查询：「${f.test}」`));
      console.log(`FTS-only：${ftsOnly.length} 命中`);
      ftsOnly.forEach(line);
      console.log(`融合（FTS + 语义${sem === null ? '，语义未启用/不可用' : ''}）：${merged.length} 命中`);
      merged.forEach(line);
      if (sem !== null && sem.length > 0) console.log(pc.dim(`  语义 top 分数：${sem.map((s) => s.score.toFixed(3)).join(', ')}（阈值 ${cfg.semantic?.threshold ?? DEFAULT_THRESHOLD}，config.semantic.threshold 可调）`));
    } finally { db.close(); }
    return;
  }

  // ── status（默认） ──
  const db = fs.existsSync(dbFile(root)) ? openExisting(dbFile(root)) : null;
  try {
    const enabled = cfg.semantic?.enabled === true;
    const model = cfg.semantic?.model ?? DEFAULT_MODEL;
    console.log(`语义检索    ${enabled ? pc.green('已启用') : pc.dim('未启用（可选增强，srelay semantic enable）')}`);
    if (enabled) {
      console.log(`  模型      ${model}`);
      console.log(`  依赖      ${resolveTransformersEntry() ? pc.green('transformers.js 可用') : pc.yellow('缺失（检索自动降级纯 FTS；重装见 srelay semantic enable）')}`);
      if (db) {
        const sig = vectorSignature(db, model);
        const backlog = countSemanticBacklog(db, model);
        console.log(`  向量      ${sig.split(':')[0]} 个 · 待嵌 ${backlog}${backlog > 0 ? pc.dim('（守护/sync 周期自动补嵌）') : ''}`);
      }
      console.log(`  阈值      ${cfg.semantic?.threshold ?? DEFAULT_THRESHOLD}（config.semantic.threshold）`);
    }
    console.log(pc.dim(`  缓存目录  ${semanticCacheDir().replace(/\\/g, '/')}（依赖与模型，可整目录删除）`));
  } finally { db?.close(); }
}
