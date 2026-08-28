// srelay decisions / history / unresolved（方针 §8.2；验收：决策列表含出处 D10）
import { loadConfig } from '../shared/config.js';
import { listDecisions, listUnresolved } from '../store/db.js';
import { searchSessions } from '../search-svc/engine.js';
import { getSession } from '../store/db.js';
import { requireRoot, openRelayDb, pc, fmtDate } from './ui.js';

export async function cmdDecisions(opts: { topic?: string; source?: string; limit?: number; json?: boolean }): Promise<void> {
  const root = requireRoot();
  const cfg = loadConfig(root);
  const db = openRelayDb(root);
  try {
    const rows = listDecisions(db, cfg.identity.project_id ?? root, { topic: opts.topic, source: opts.source })
      .slice(0, opts.limit ?? 20);
    if (opts.json) { console.log(JSON.stringify({ count: rows.length, decisions: rows }, null, 2)); return; }
    if (rows.length === 0) {
      console.log(pc.dim('（暂无已确认决策。会话 confirmed 后自动提取——见 srelay list --state pending）'));
      return;
    }
    console.log(`共 ${rows.length} 条决策（按时间）：\n`);
    for (const r of rows) {
      console.log(`${pc.dim(fmtDate(r.at))} [${r.source}] ${r.text}`);
      console.log(pc.dim(`        出处：「${(r.title ?? '').slice(0, 30)}」 ${r.sessionId} · msg#${r.seq} · srelay show ${r.sessionId} --range ${r.seq}:${r.seq}`));
    }
  } finally {
    db.close();
  }
}

export async function cmdUnresolved(opts: { limit?: number; json?: boolean }): Promise<void> {
  const root = requireRoot();
  const cfg = loadConfig(root);
  const db = openRelayDb(root);
  try {
    const rows = listUnresolved(db, cfg.identity.project_id ?? root, opts.limit ?? 20);
    if (opts.json) { console.log(JSON.stringify({ count: rows.length, unresolved: rows }, null, 2)); return; }
    if (rows.length === 0) { console.log(pc.dim('（暂无未决问题）')); return; }
    for (const r of rows) {
      console.log(`${pc.yellow('◻')} ${r.q}`);
      console.log(pc.dim(`   ${fmtDate(r.at)} [${r.source}] 「${(r.title ?? '').slice(0, 28)}」 ${r.sessionId}`));
    }
  } finally {
    db.close();
  }
}

export async function cmdHistory(filePath: string, opts?: { json?: boolean }): Promise<void> {
  const root = requireRoot();
  const cfg = loadConfig(root);
  const db = openRelayDb(root);
  try {
    // 文件路径在入库时保持标识符单 token，直接作为查询（§6.1）
    const hits = searchSessions(db, { project: cfg.identity.project_id ?? root, query: `"${filePath.replace(/\\/g, '/')}"`, limit: 20 });
    if (hits.length === 0) { console.log(pc.dim(`没有会话提到 ${filePath}`)); return; }
    console.log(`${filePath} 出现在 ${hits.length} 个会话：\n`);
    for (const h of hits) {
      const s = getSession(db, h.sessionId);
      console.log(`${pc.dim(fmtDate(s?.created_at))} [${s?.source}] 「${(s?.title ?? '').slice(0, 32)}」 ${pc.dim(s!.id)}`);
      if (h.snippet) console.log(pc.dim(`   ${h.snippet.slice(0, 90)}`));
    }
  } finally {
    db.close();
  }
}
