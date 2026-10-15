// srelay init（方针 §15.6 啊哈机制 + 源选择 + 回填 + 试搜）
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline/promises';
import { defaultConfig, saveConfig, IGNORE_TEMPLATE, loadConfig } from '../shared/config.js';
import { inferProjectRoot, relayDir, dbFile, ignoreFile, projectIdOf } from '../shared/paths.js';
import { touchRegistry } from '../shared/registry.js';
import { createDb, getSession, countsByState, openExisting } from '../store/db.js';
import { runSync } from '../capture/sync.js';
import { runJudge } from '../capture/judge.js';
import { openStats } from '../core/stats/counter.js';
import { searchSessions } from '../search-svc/engine.js';
import { pc, fmtDate } from './ui.js';
import { installWatchService } from './watch.js';

/** 检测本机已安装的 AI 工具（跨平台路径检测） */
export interface DetectedSource {
  id: string;
  displayName: string;
  installed: boolean;
  path: string;
}

export function detectSources(): DetectedSource[] {
  const home = os.homedir();
  const platform = process.platform;

  // Trae 在不同平台的用户数据目录不同
  const traePaths: Record<string, string[]> = {
    win32: [
      path.join(home, 'AppData', 'Roaming', 'Trae CN'),
      path.join(home, 'AppData', 'Roaming', 'Trae'),
    ],
    darwin: [
      path.join(home, 'Library', 'Application Support', 'Trae CN'),
      path.join(home, 'Library', 'Application Support', 'Trae'),
    ],
    linux: [
      path.join(home, '.config', 'Trae CN'),
      path.join(home, '.config', 'Trae'),
    ],
  };

  // [fork 1015] 环境变量必须优先于内置默认路径。
  // 病历：config.ts 早就承诺「环境变量 > config.json > 默认值」，init 的交互界面也明文让用户
  // 去设 CODEX_DIR 之类，但 detectSources() 里全是硬编码路径 —— 用户按提示设了变量，
  // 探测照样只看默认位置，于是「装了的源显示未安装」（或反过来），init 与 doctor 双双失聪。
  // 这里不接 config.json（init 常常发生在还没有 config.json 的时候），只做 env > 默认。
  const envFirst = (key: string, def: string): string => process.env[key]?.trim() || def;

  const checks: Array<{ id: string; name: string; paths: string[] }> = [
    {
      id: 'claude-code', name: 'Claude Code',
      paths: [envFirst('CLAUDE_PROJECTS_DIR', path.join(home, '.claude', 'projects'))],
    },
    {
      id: 'zcode', name: 'ZCode',
      paths: [envFirst('ZCODE_DB_PATH', path.join(home, '.zcode', 'cli', 'db', 'db.sqlite'))],
    },
    {
      id: 'dsh', name: 'DeepSeek Harness',
      // 会话按工作目录 slug 分组存放；探测目录本身即可判定源可用。
      // 此前漏了这一项：--yes 走「只选已安装的源」，故裸跑 srelay init 建出的库
      // 永远采不到 DSH 会话（适配器 src/adapters/dsh/ 早已存在，只差这个探测项）。
      paths: [envFirst('DSH_SESSIONS_DIR', path.join(home, '.dsh', 'sessions'))],
    },
    {
      id: 'codex', name: 'Codex',
      paths: [envFirst('CODEX_DIR', path.join(home, '.codex'))],
    },
    {
      id: 'qoder', name: 'Qoder',
      paths: [
        envFirst('QODER_DIR', path.join(home, '.qoder-cn')),  // 中国版（env 优先）
        path.join(home, '.qoder'),              // 国际版
        path.join(home, '.qoder-cn', 'cache', 'projects'),  // 会话数据子目录
      ],
    },
    {
      id: 'trae', name: 'Trae（部分支持）',
      // TRAE_DIR 优先；未设时按平台候选逐个探测（Trae 各平台目录名不同，见上表）
      paths: [...(process.env.TRAE_DIR?.trim() ? [process.env.TRAE_DIR.trim()] : []), ...(traePaths[platform] ?? traePaths.linux ?? [])],
    },
  ];

  return checks.map(c => {
    const found = c.paths.find(p => fs.existsSync(p));
    return {
      id: c.id,
      displayName: c.name,
      installed: !!found,
      path: found ?? c.paths[0] ?? '(未知路径)',
    };
  });
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
      if (notInstalled.length > 0) {
        console.log(pc.dim('\n  💡 已安装但未检测到？在 config.json 的 capture.sources 中手动添加，'));
        console.log(pc.dim('     或设置环境变量覆盖路径（如 CODEX_DIR=/自定义路径）。详见 srelay doctor。'));
      }
      console.log(pc.cyan('\n选择要捕获的来源：'));
      console.log(pc.dim('  回车 或 A = 全选已安装的'));
      console.log(pc.dim('  逗号分隔 = 只选指定的（如 zcode,claude-code）'));
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = (await rl.question('> ')).trim().toLowerCase();
      rl.close();
      if (!answer || answer === 'a' || answer === 'all') {
        selectedSources = installed.map(d => d.id);
      } else {
        selectedSources = answer.split(',').map(s => s.trim()).filter(s =>
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

  touchRegistry(root); // 全局注册表（design-serve-resolve §5）：serve 多项目解析的候选来源

  // [1015 夜] 看板自动起草：简报的「计划/下一步」段唯一来源就是项目根的 progress.md，
  // 而全仓库此前只有读、没有写——没人写就是空的（b3 实测该维度只捕获 3.3%，全库最大盲区）。
  // 放在 init 里 = 新项目「开箱即有」；**已存在则绝不覆盖**（那是人手写的文件）。
  // 插件对新工作区的自动接入走的也是 srelay init，所以那条路同样会自动拿到看板。
  try {
    const { writeKanbanDraft } = await import('./kanban.js');
    const kdb = fs.existsSync(dbFile(root)) ? openExisting(dbFile(root)) : null;
    try {
      const k = writeKanbanDraft(root, kdb, projectIdOf(root));
      if (k.created) console.log(pc.green('✓') + ` 已生成看板初稿 ${pc.dim(k.path)}（${k.rows} 行，此后由人维护）`);
    } finally { try { kdb?.close(); } catch { /* 已关 */ } }
  } catch { /* 看板生成失败不影响 init 主流程 */ }


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
