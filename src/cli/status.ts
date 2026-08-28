// srelay status：透明度面板（方针 §6.2 / §8.4）+ --json（T14）
import fs from 'node:fs';
import { loadConfig } from '../shared/config.js';
import { dbFile } from '../shared/paths.js';
import { isDaemonAlive } from '../shared/lock.js';
import { openStats } from '../core/stats/counter.js';
import { countsByState, countsBySource, listSessions } from '../store/db.js';
import { requireRoot, openRelayDb, pc, fmtDate, stateBadge } from './ui.js';
import { watchServiceStatus } from './watch.js';

export async function cmdStatus(opts?: { json?: boolean }): Promise<void> {
  const root = requireRoot();
  const cfg = loadConfig(root);
  const db = openRelayDb(root);
  try {
    const pid = cfg.identity.project_id ?? root;
    const st = countsByState(db, pid);
    const bySource = countsBySource(db, pid);
    const recent = listSessions(db, { projectId: pid, limit: 3 });
    const stats = openStats(root);
    const size = fs.existsSync(dbFile(root)) ? fs.statSync(dbFile(root)).size : 0;
    const alive = isDaemonAlive(root);
    const service = await watchServiceStatus(root);
    const blocked = stats.snapshot()['blocked_by_ignore'] ?? 0;

    if (opts?.json) {
      console.log(JSON.stringify({
        project: pid,
        mode: cfg.capture.mode,
        daemon: { alive: alive.alive, pid: alive.pid ?? null, service },
        sessions: { total: Object.values(st).reduce((a, b) => a + b, 0), ...st },
        bySource,
        ignoredByRules: blocked,
        dbSizeMB: Number((size / 1024 / 1024).toFixed(2)),
        recent: recent.map((s) => ({ id: s.id, title: s.title, source: s.source, state: s.state, lastEventAt: s.last_event_at })),
      }, null, 2));
      return;
    }

    const modeColor = cfg.capture.mode === 'off' ? pc.red(cfg.capture.mode) : cfg.capture.mode === 'meta' ? pc.yellow(cfg.capture.mode) : pc.green(cfg.capture.mode);
    console.log(`会话接力 · ${root.replace(/\\/g, '/').split('/').pop()}   模式: ${modeColor}`);
    console.log('─'.repeat(58));
    if (alive.alive) {
      console.log(`守护    ${pc.green('● running')} (pid ${alive.pid}) · 服务: ${service}`);
    } else {
      console.log(`守护    ${pc.red('🔴 auto-capture 未运行，最近会话可能未捕获')}`);
      console.log(pc.yellow(`        → srelay watch --install-service（推荐）或 srelay sync 兜底`));
    }
    console.log(`会话    active ${st.active ?? 0} · pending ${st.pending_end ?? 0} · confirmed ${st.confirmed ?? 0}`);
    console.log(`来源    ${Object.entries(bySource).map(([k, v]) => `${k} ${v}`).join(' · ') || pc.dim('（空）')}`);
    console.log(`拦截    ignore 规则累计拦截 ${blocked} 次${cfg.capture.mode !== 'full' ? pc.yellow(` · 当前模式 ${cfg.capture.mode}（不落正文）`) : ''}`);
    console.log(`体积    relay.sqlite ${(size / 1024 / 1024).toFixed(1)} MB`);
    if (recent.length > 0) {
      console.log('最近');
      for (const s of recent) {
        console.log(`   ${fmtDate(s.last_event_at ?? s.created_at)} ${s.source.padEnd(11)} 「${(s.title ?? '').slice(0, 24)}」 ${stateBadge(s.state)} ${pc.dim(s.id)}`);
      }
    }
    console.log('─'.repeat(58));
    console.log(pc.dim('下一步  srelay search <关键词> · srelay list --source zcode'));
  } finally {
    db.close();
  }
}
