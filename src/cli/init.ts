// srelay init（方针 §15.6 啊哈机制 + 源选择 + 回填 + 试搜）
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline/promises';
import { defaultConfig, saveConfig, IGNORE_TEMPLATE, loadConfig } from '../shared/config.js';
import { inferProjectRoot, relayDir, dbFile, ignoreFile, projectIdOf } from '../shared/paths.js';
import { createDb, getSession, countsByState, openExisting } from '../store/db.js';
import { runSync } from '../capture/sync.js';
import { runJudge } from '../capture/judge.js';
import { openStats } from '../core/stats/counter.js';
import { searchSessions } from '../search-svc/engine.js';
import { pc, fmtDate } from './ui.js';
import { installWatchService } from './watch.js';

/** 检测本机已安装的 AI 工具 */
interface DetectedSource {
  id: string;
  displayName: string;
  installed: boolean;
  path: string;
}

function detectSources(): DetectedSource[] {
  const home = os.homedir();
  const checks: Array<{ id: string; name: string; paths: string[] }> = [
    { id: 'claude-code', name: 'Claude Code', paths: [path.join(home, '.claude', 'projects')] },
    { id: 'zcode', name: 'ZCode', paths: [path.join(home, '.zcode', 'cli', 'db', 'db.sqlite')] },
    { id: 'codex', name: 'Codex', paths: [path.join(home, '.codex')] },
    { id: 'qoder', name: 'Qoder', paths: [path.join(home, '.qoder-cn')] },
    { id: 'trae', name: 'Trae（部分支持）', paths: [path.join(home, 'AppData', 'Roaming', 'Trae CN')] },
  ];
  return checks.map(c => ({
    id: c.id,
    displayName: c.name,
    installed: c.paths.some(p => fs.existsSync(p)),
    path: c.paths[0],
  }));
}

export async function cmdInit(opts: { backfill?: string; yes?: boolean; installService?: boolean; sources?: string }): Promise<void> {
  const root = inferProjectRoot(process.cwd());
  const stats = openStats(root);

  if (fs.existsSync(relayDir(root))) {
    console.log(pc.yellow('本项目已初始化，执行增量同步。'));
  } else {
    fs.mkdirSync(relayDir(root), { recursive: true });

    // ── 源选择 ──
    const detected = detectSources();
    const installed = detected.filter(d => d.installed);
    const notInstalled = detected.filter(d => !d.installed);
    let selectedSources: string[];

    if (opts.sources) {
      // 命令行指定：逗号分隔
      selectedSources = opts.sources.split(',').map(s => s.trim()).filter(Boolean);
      console.log(pc.dim(`指定来源：${selectedSources.join(', ')}`));
    } else if (opts.yes || !process.stdout.isTTY) {
      // 非交互或 --yes：自动选择所有已安装的
      selectedSources = installed.map(d => d.id);
    } else {
      // 交互选择
      console.log(pc.cyan('\n🔍 检测到以下 AI 编程工具：\n'));
      for (const d of installed) {
        console.log(`  ✅ ${d.displayName.padEnd(20)} ${pc.dim(d.path)}`);
      }
      for (const d of notInstalled) {
        console.log(`  ⬜ ${d.displayName.padEnd(20)} ${pc.dim('未检测到')}`);
      }
      console.log(pc.cyan('\n选择要捕获的来源（逗号分隔，回车=全选已安装的）：'));
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = (await rl.question('> ')).trim();
      rl.close();
      if (!answer) {
        selectedSources = installed.map(d => d.id);
      } else {
        selectedSources = answer.split(',').map(s => s.trim().toLowerCase()).filter(s =>
          detected.some(d => d.id === s)
        );
        if (selectedSources.length === 0) {
          selectedSources = installed.map(d => d.id);
          console.log(pc.yellow('输入无效，默认选择所有已安装的。'));
        }
      }
    }

    if (selectedSources.length === 0) {
      console.log(pc.yellow('⚠️ 未选择任何来源，将不会自动捕获会话。'));
      console.log(pc.dim('  之后可在 .sessionrelay/config.json 的 capture.sources 中手动添加。'));
      selectedSources = [];
    }

    const cfg = defaultConfig();
    cfg.identity.project_id = projectIdOf(root);
    cfg.capture.sources = selectedSources;
    saveConfig(root, cfg);
    if (!fs.existsSync(ignoreFile(root))) fs.writeFileSync(ignoreFile(root), IGNORE_TEMPLATE, 'utf8');
    createDb(dbFile(root)).close();
    stats.increment('install');

    console.log(pc.green('✓') + ` 已初始化 ${pc.dim(relayDir(root))}`);
    const sourcesList = selectedSources.length > 0 ? selectedSources.join(', ') : '(无, 手动 save 可用)';
    console.log(pc.dim(`  来源: ${sourcesList}`));
    console.log(pc.dim('  模式: full (可用 srelay mode 调整)'));
  }

  const cfg = loadConfig(root);
  const backfill = parseBackfill(opts.backfill ?? '30d');
  if (backfill === 0) {
    console.log('跳过回填（--backfill none）。');
  } else {
    const s = await runSync({ projectRoot: root, config: cfg, backfillDays: backfill });
    const db = openExisting(dbFile(root));
    runJudge(db, { projectId: cfg.identity.project_id!, now: new Date(), idleMin: cfg.capture.idle_threshold_min, cooldownH: cfg.capture.cooldown_hours });
    stats.increment('backfill_done');
    console.log(pc.green('✓') + ` 回填最近 ${backfill} 天：发现 ${s.discovered} 会话 · 新入库 ${s.newSessions} · 消息 ${s.newMessages}${s.blocked ? pc.yellow(` · ignore 拦截 ${s.blocked}`) : ''}`);
    const counts = countsByState(db, cfg.identity.project_id!);
    db.close();
    console.log(pc.dim(`  会话状态：active ${counts.active ?? 0} · pending ${counts.pending_end ?? 0} · confirmed ${counts.confirmed ?? 0}`));
  }

  // 啊哈收尾：邀请试搜（方针 §15.6）
  if (process.stdout.isTTY && !opts.yes && backfill !== 0) {
    try {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const kw = (await rl.question(pc.cyan('\n输入一个你还记得的关键词，试试搜历史会话（回车跳过）：'))).trim();
      rl.close();
      if (kw) {
        const db = openExisting(dbFile(root));
        const hits = searchSessions(db, { project: cfg.identity.project_id!, query: kw, limit: 3 });
        if (hits.length > 0) {
          stats.increment('first_hit');
          console.log(pc.green(`  命中 ${hits.length} 条：`));
          for (const h of hits) {
            const s = getSession(db, h.sessionId);
            console.log(`   · ${(s?.title ?? h.sessionId).slice(0, 40)}  ${pc.dim(fmtDate(s?.created_at))} ${pc.dim(h.sessionId)}`);
          }
        } else {
          console.log(pc.dim('  未命中（正常，回填窗口外的内容或换个词）'));
        }
        db.close();
      }
    } catch { /* 非交互环境跳过 */ }
  }

  if (opts.installService) {
    await installWatchService(root);
  } else {
    console.log(pc.dim('\n下一步：'));
    console.log(pc.dim('  srelay search <关键词>          搜索历史会话'));
    console.log(pc.dim('  srelay watch --install-service  注册守护（推荐）'));
  }
  stats.increment('init_done');
}

function parseBackfill(v: string): number {
  if (v === 'none') return 0;
  const m = /^(\d+)d$/.exec(v);
  if (!m) return 30;
  return Number(m[1]);
}
