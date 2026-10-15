// srelay sync：一次性增量捕获 + 判定（方针 §8.1）
import { loadConfig } from '../shared/config.js';
import { requireRoot, pc } from './ui.js';
import { runSync } from '../capture/sync.js';
import { runJudge } from '../capture/judge.js';
import { openRelayDb } from './ui.js';

export async function cmdSync(opts: { backfill?: string; json?: boolean }): Promise<void> {
  const root = requireRoot();
  const cfg = loadConfig(root);
  const db = openRelayDb(root);
  try {
    if (cfg.capture.mode === 'off') {
      console.log(pc.yellow('当前捕获模式为 off（零自动写入）。如需恢复：srelay mode full'));
      return;
    }
    const backfillDays = opts.backfill ? parseDays(opts.backfill) : undefined;
    const s = await runSync({ projectRoot: root, config: cfg, db, backfillDays });
    const j = runJudge(db, {
      projectId: cfg.identity.project_id ?? root,
      now: new Date(),
      idleMin: cfg.capture.idle_threshold_min,
      cooldownH: cfg.capture.cooldown_hours,
    });
    if (opts.json) { console.log(JSON.stringify({ ...s, judge: j }, null, 2)); return; }
    console.log(`同步完成：发现 ${s.discovered} · 新会话 ${s.newSessions} · 新消息 ${s.newMessages} · resumed ${s.resumed}${s.blocked ? pc.yellow(` · 拦截 ${s.blocked}`) : ''}`);
    if (j.toPending || j.confirmed) console.log(pc.dim(`判定：${j.toPending} 转 pending · ${j.confirmed} 确认`));
    // 语义 digest（守护不在时的补嵌路径；未启用时零开销短路）
    const { digestSemantic } = await import('../search-svc/semantic.js');
    const { embedded } = await digestSemantic(db, cfg, { projectId: cfg.identity.project_id, limit: 100 });
    if (embedded > 0) console.log(pc.dim(`语义：补嵌 ${embedded} 个会话`));
    // [1015 夜 · B1] 自动刷新看板的「自动区」（只动模块列 = auto:todos 的行，人写的行不碰）。
    // 放在 sync 末尾 = 每次增量捕获后跟着刷新，守护跑 sync 时同样生效 ⇒ 全程无人工步骤。
    // 绝不抛：看板刷不新不该影响捕获。
    try {
      const { syncKanbanAuto } = await import('./kanban.js');
      const k = syncKanbanAuto(root, cfg);
      if (k.ok && /刷新/.test(k.reason) && !opts.json) console.log(pc.dim(`看板：${k.reason}`));
    } catch { /* 看板刷新失败不连坐捕获 */ }
  } finally {
    db.close();
  }
}

function parseDays(v: string): number | undefined {
  if (v === 'all') return undefined;
  const m = /^(\d+)d$/.exec(v);
  return m ? Number(m[1]) : undefined;
}
