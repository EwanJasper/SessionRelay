// srelay doctor（技术方案 T12 / §8.7）：自检 + 修复建议
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { segment } from '../core/tokenize/tokenizer.js';
import { loadConfig, claudeProjectsDir, zcodeDbPath } from '../shared/config.js';
import { dbFile, findRelayRoot, ignoreFile } from '../shared/paths.js';
import { isDaemonAlive } from '../shared/lock.js';
import { watchServiceStatus } from './watch.js';
import { pc } from './ui.js';

type Level = 'ok' | 'warn' | 'err';
interface Check { name: string; level: Level; detail: string; fix?: string }

export async function cmdDoctor(): Promise<void> {
  const checks: Check[] = [];

  // 1 Node 版本（engines 要求 >=22；better-sqlite3/jieba 预编译按新 ABI 分发）
  const [maj] = process.versions.node.split('.').map(Number);
  checks.push(maj >= 22 ? c('Node 运行时', 'ok', `v${process.versions.node}`) : c('Node 运行时', 'err', `v${process.versions.node} < 22（engines 要求）`, '升级 Node 至 22+'));

  // 2 FTS5
  try {
    const t = new Database(':memory:');
    t.exec('CREATE VIRTUAL TABLE _f USING fts5(x)');
    t.close();
    checks.push(c('SQLite FTS5', 'ok', '可用'));
  } catch (e) {
    checks.push(c('SQLite FTS5', 'err', (e as Error).message, '反馈 issue；或 config.search.tokenizer 改 bigram'));
  }

  // 3 jieba
  try {
    const toks = segment('数据库索引');
    checks.push(toks.length > 0 ? c('中文分词 (jieba)', 'ok', `正常，示例 → ${toks.slice(0, 4).join(' ')}`) : c('中文分词', 'err', '返回空'));
  } catch (e) {
    checks.push(c('中文分词 (jieba)', 'err', (e as Error).message, '重装 @node-rs/jieba'));
  }

  // 4/5 数据源
  const root = findRelayRoot(process.cwd());
  const cfg = root ? loadConfig(root) : null;
  const claudeDir = cfg ? claudeProjectsDir(cfg) : path.join(os.homedir(), '.claude', 'projects');
  checks.push(fs.existsSync(claudeDir)
    ? c('Claude Code 源目录', 'ok', claudeDir)
    : c('Claude Code 源目录', 'warn', `不存在（${claudeDir}）`, '未安装/未使用 Claude Code 可忽略'));
  const zdb = cfg ? zcodeDbPath(cfg) : path.join(os.homedir(), '.zcode', 'cli', 'db', 'db.sqlite');
  if (fs.existsSync(zdb)) {
    try {
      const z = new Database(zdb, { readonly: true });
      z.prepare('SELECT COUNT(*) FROM session').get();
      z.close();
      checks.push(c('ZCode 库（只读探测）', 'ok', zdb));
    } catch (e) {
      checks.push(c('ZCode 库（只读探测）', 'warn', (e as Error).message, 'ZCode 正在写时偶发，重试即可'));
    }
  } else {
    checks.push(c('ZCode 库', 'warn', `不存在（${zdb}）`, '未安装 ZCode 可忽略'));
  }

  // 6 项目初始化与库
  if (!root) {
    checks.push(c('项目初始化', 'warn', '当前目录未初始化', 'srelay init'));
  } else {
    try {
      loadConfig(root);
      checks.push(c('config.json', 'ok', '可解析'));
    } catch (e) {
      checks.push(c('config.json', 'err', (e as Error).message, '删除后 srelay init 重建'));
    }
    if (fs.existsSync(dbFile(root))) {
      try {
        const db = new Database(dbFile(root), { readonly: true });
        const v = db.pragma('integrity_check', { simple: true });
        db.close();
        checks.push(c('relay.sqlite 完整性', v === 'ok' ? 'ok' : 'err', String(v), v === 'ok' ? undefined : 'srelay rebuild（Phase 2 交付）'));
      } catch (e) {
        checks.push(c('relay.sqlite', 'err', (e as Error).message));
      }
    } else {
      checks.push(c('relay.sqlite', 'warn', '不存在', 'srelay init'));
    }
    checks.push(fs.existsSync(ignoreFile(root))
      ? c('.sessionrelayignore', 'ok', '存在')
      : c('.sessionrelayignore', 'warn', '不存在（无排除规则）'));
    const alive = isDaemonAlive(root);
    if (!alive.alive) {
      checks.push(c('守护进程', 'warn', '未运行', 'srelay watch --install-service 或 srelay sync 兜底'));
    } else {
      checks.push(c('守护进程', 'ok', `运行中 (pid ${alive.pid}) · 服务：${await watchServiceStatus(root)}`));
    }

    // ── 新增检查：Codex / Qoder / Trae / 归档表 / custom 适配器 ──

    // Codex
    const codexDir = path.join(os.homedir(), '.codex');
    checks.push(fs.existsSync(codexDir)
      ? c('Codex 源', 'ok', codexDir)
      : c('Codex 源', 'warn', '未检测到（未安装可忽略）'));

    // Qoder
    const qoderDir = path.join(os.homedir(), '.qoder-cn');
    checks.push(fs.existsSync(qoderDir)
      ? c('Qoder 源', 'ok', qoderDir)
      : c('Qoder 源', 'warn', '未检测到（未安装可忽略）'));

    // Trae（部分支持，AI 回复加密）
    const traeDir = path.join(os.homedir(), 'AppData', 'Roaming', 'Trae CN');
    if (fs.existsSync(traeDir)) {
      checks.push(c('Trae 源', 'warn', `${traeDir}（部分支持：仅用户提问，AI 回复加密）`));
    } else {
      checks.push(c('Trae 源', 'warn', '未检测到（未安装可忽略）'));
    }

    // 归档表（M2 迁移）
    if (fs.existsSync(dbFile(root))) {
      try {
        const db = new Database(dbFile(root), { readonly: true });
        const hasCleanupLog = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cleanup_log'").get();
        const hasCleanupAt = (db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>).some(col => col.name === 'cleanup_at');
        db.close();
        checks.push(hasCleanupLog && hasCleanupAt
          ? c('归档表（M2）', 'ok', 'cleanup_log + cleanup_at 就绪')
          : c('归档表（M2）', 'warn', '缺少表或列', '重新打开库自动迁移'));
      } catch {
        checks.push(c('归档表（M2）', 'warn', '无法检测'));
      }
    }

    // custom 适配器
    const customDir = path.join(root, '.sessionrelay', 'adapters');
    if (fs.existsSync(customDir)) {
      const jsFiles = fs.readdirSync(customDir).filter(f => f.endsWith('.js'));
      checks.push(jsFiles.length > 0
        ? c('Custom 适配器', 'ok', `${jsFiles.length} 个已加载：${jsFiles.map(f => f.replace('.js', '')).join(', ')}`)
        : c('Custom 适配器', 'ok', '目录存在，无自定义适配器'));
    } else {
      checks.push(c('Custom 适配器', 'ok', '无（可在 .sessionrelay/adapters/ 添加）'));
    }
  }

  // 语义检索（R7 条件项：未启用=可选提示；启用后查依赖，回填进度在 srelay semantic status）
  if (root) {
    const cfg = loadConfig(root);
    if (cfg.semantic?.enabled === true) {
      const { resolveTransformersEntry, semanticModelOf } = await import('../search-svc/semantic.js');
      const entry = resolveTransformersEntry();
      checks.push(entry
        ? c('语义检索', 'ok', `已启用（${semanticModelOf(cfg)}）`)
        : c('语义检索', 'err', '已启用但 transformers.js 缺失（检索已自动降级纯字面）', 'npm i --prefix ~/.sessionrelay/semantic @huggingface/transformers@3'));
    } else {
      checks.push(c('语义检索', 'warn', '未启用（可选增强：换词查询也能命中，srelay semantic enable）'));
    }
  }

  for (const k of checks) {
    const icon = k.level === 'ok' ? pc.green('✅') : k.level === 'warn' ? pc.yellow('⚠️ ') : pc.red('❌');
    console.log(`${icon} ${k.name.padEnd(18)} ${k.detail}${k.fix ? pc.dim(`  → ${k.fix}`) : ''}`);
  }
  const errs = checks.filter((k) => k.level === 'err').length;
  const warns = checks.filter((k) => k.level === 'warn').length;
  console.log(pc.dim(`\n${checks.length} 项检查：${checks.length - errs - warns} 通过 · ${warns} 提示 · ${errs} 失败`));
  if (errs > 0) process.exit(1);

  function c(name: string, level: Level, detail: string, fix?: string): Check { return { name, level, detail, fix }; }
}
