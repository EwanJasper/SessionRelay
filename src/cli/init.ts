// srelay init（方针 §15.6 啊哈机制 + §12 Phase 1）
import fs from 'node:fs';
import readline from 'node:readline/promises';
import { defaultConfig, saveConfig, IGNORE_TEMPLATE, loadConfig } from '../shared/config.js';
import { inferProjectRoot, relayDir, dbFile, ignoreFile, projectIdOf } from '../shared/paths.js';
import { createDb, getSession, countsByState } from '../store/db.js';
import { runSync } from '../capture/sync.js';
import { runJudge } from '../capture/judge.js';
import { openStats } from '../core/stats/counter.js';
import { searchSessions } from '../search-svc/engine.js';
import { pc, fmtDate } from './ui.js';
import { installWatchService } from './watch.js';

export async function cmdInit(opts: { backfill?: string; yes?: boolean; installService?: boolean }): Promise<void> {
  const root = inferProjectRoot(process.cwd());
  const stats = openStats(root);

  if (fs.existsSync(relayDir(root))) {
    console.log(pc.yellow('本项目已初始化，执行增量同步。'));
  } else {
    fs.mkdirSync(relayDir(root), { recursive: true });
    const cfg = defaultConfig();
    cfg.identity.project_id = projectIdOf(root);
    saveConfig(root, cfg);
    if (!fs.existsSync(ignoreFile(root))) fs.writeFileSync(ignoreFile(root), IGNORE_TEMPLATE, 'utf8');
    createDb(dbFile(root)).close();
    stats.increment('install');
    console.log(pc.green('✓') + ` 已初始化 ${pc.dim(relayDir(root))}（默认模式 full，可用 srelay mode 调整）`);
  }

  const cfg = loadConfig(root);
  const backfill = parseBackfill(opts.backfill ?? '30d');
  if (backfill === 0) {
    console.log('跳过回填（--backfill none）。');
  } else {
    const s = await runSync({ projectRoot: root, config: cfg, backfillDays: backfill });
    runJudge(await_open(root), { projectId: cfg.identity.project_id!, now: new Date(), idleMin: cfg.capture.idle_threshold_min, cooldownH: cfg.capture.cooldown_hours });
    stats.increment('backfill_done');
    console.log(pc.green('✓') + ` 回填最近 ${backfill} 天：发现 ${s.discovered} 会话 · 新入库 ${s.newSessions} · 消息 ${s.newMessages}${s.blocked ? pc.yellow(` · ignore 拦截 ${s.blocked}`) : ''}`);
    const counts = countsByState(await_open(root), cfg.identity.project_id!);
    console.log(pc.dim(`  会话状态：active ${counts.active ?? 0} · pending ${counts.pending_end ?? 0} · confirmed ${counts.confirmed ?? 0}`));
  }

  // 啊哈收尾：邀请试搜（方针 §15.6）
  if (process.stdout.isTTY && !opts.yes && backfill !== 0) {
    try {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const kw = (await rl.question(pc.cyan('\n输入一个你还记得的关键词，试试搜历史会话（回车跳过）：'))).trim();
      rl.close();
      if (kw) {
        const db = await_open(root);
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
    console.log(pc.dim('  srelay watch --install-service  注册守护（推荐，自动捕获不再依赖手动）'));
  }
  stats.increment('init_done');
}

import { openExisting } from '../store/db.js';
function await_open(root: string) { return openExisting(dbFile(root)); }

function parseBackfill(v: string): number {
  if (v === 'none') return 0;
  const m = /^(\d+)d$/.exec(v);
  if (!m) return 30;
  return Number(m[1]);
}
