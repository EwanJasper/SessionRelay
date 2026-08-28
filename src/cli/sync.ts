// srelay sync：一次性增量捕获 + 判定（方针 §8.1）
import { loadConfig } from '../shared/config.js';
import { requireRoot, pc } from './ui.js';
import { runSync } from '../capture/sync.js';
import { runJudge } from '../capture/judge.js';
import { openRelayDb } from './ui.js';

export async function cmdSync(opts: { backfill?: string }): Promise<void> {
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
    console.log(`同步完成：发现 ${s.discovered} · 新会话 ${s.newSessions} · 新消息 ${s.newMessages} · resumed ${s.resumed}${s.blocked ? pc.yellow(` · 拦截 ${s.blocked}`) : ''}`);
    if (j.toPending || j.confirmed) console.log(pc.dim(`判定：${j.toPending} 转 pending · ${j.confirmed} 确认`));
  } finally {
    db.close();
  }
}

function parseDays(v: string): number | undefined {
  if (v === 'all') return undefined;
  const m = /^(\d+)d$/.exec(v);
  return m ? Number(m[1]) : undefined;
}
