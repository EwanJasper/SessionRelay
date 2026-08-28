// srelay save（方针 §8.1 / D2 并存范式：手动存储与自动捕获并存；off 模式下唯一入口）
// ignore 硬边界仍生效；手动保存的会话立即 confirm（触发提取+摘要，D7）
import { checkbox } from '@inquirer/prompts';
import { loadConfig } from '../shared/config.js';
import { dbFile } from '../shared/paths.js';
import { openExisting, listSessions, confirmSession, getSessionFull, metaTextOf } from '../store/db.js';
import { captureSessions, discoverAll } from '../capture/sync.js';
import { openStats } from '../core/stats/counter.js';
import { requireRoot, pc, fmtDate } from './ui.js';
import type { DiscoveredSession } from '../adapters/types.js';

export interface SaveFlags {
  id?: string; recent?: string; interactive?: boolean;
  tag?: string; summary?: string; source?: string; json?: boolean;
}

export async function cmdSave(f: SaveFlags): Promise<void> {
  const root = requireRoot();
  const cfg = loadConfig(root);
  const db = openExisting(dbFile(root));
  const stats = openStats(root);
  try {
    let pool = discoverAll(root, cfg);
    if (f.source) pool = pool.filter((d) => d.source === f.source);
    if (pool.length === 0) {
      console.log(pc.yellow('未发现任何会话源。') + pc.dim('检查 srelay doctor，或用 --source 指定。'));
      return;
    }

    let picked: DiscoveredSession[] = [];
    if (f.id) {
      picked = pool.filter((d) => d.sourceSessionId.startsWith(f.id!) || d.sourceSessionId.includes(f.id!));
    } else if (f.recent) {
      const m = /^(\d+)d$/.exec(f.recent);
      const days = m ? Number(m[1]) : 7;
      const cutoff = Date.now() - days * 86400_000;
      picked = pool.filter((d) => d.mtimeMs >= cutoff);
    } else if (f.interactive && process.stdin.isTTY) {
      const selected = await checkbox({
        message: `选择要存储的会话（${pool.length} 个候选，按最近排序）`,
        choices: [...pool]
          .sort((a, b) => b.mtimeMs - a.mtimeMs)
          .slice(0, 30)
          .map((d) => ({
            value: `${d.source}\u0000${d.sourceSessionId}`,
            name: `${fmtDate(new Date(d.mtimeMs).toISOString())} [${d.source}] ${d.title ?? d.sourceSessionId}`,
          })),
      });
      const want = new Set(selected);
      picked = pool.filter((d) => want.has(`${d.source}\u0000${d.sourceSessionId}`));
    } else {
      console.log(pc.red('用法：srelay save <会话ID前缀> | --recent 7d | --interactive'));
      process.exit(2);
    }
    if (picked.length === 0) {
      console.log(pc.yellow('没有匹配的会话。'));
      return;
    }

    const s = await captureSessions({ projectRoot: root, config: cfg, db, sessions: picked, stats });
    if (s.blocked > 0 && s.newSessions === 0 && s.newMessages === 0) {
      // 全部被 ignore 拦截：仍产出结构化结果（--json 契约），非 JSON 才走提示
      if (f.json) {
        console.log(JSON.stringify({ saved: 0, newMessages: 0, resumed: 0, blocked: s.blocked, sessionIds: [], tags: [], summary: null }, null, 2));
      } else {
        console.log(pc.red(`✗ ${s.blocked} 个会话被 .sessionrelayignore 硬边界拦截（隐私边界对手动操作同样生效）。`));
      }
      return;
    }

    // 手动保存 → 立即 confirm（提取 + summary_rule，D7 免费摘要）
    const savedIds: string[] = [];
    for (const d of picked) {
      const row = db.prepare('SELECT id FROM sessions WHERE source = ? AND source_session_id = ?').get(d.source, d.sourceSessionId) as { id: string } | undefined;
      if (!row) continue;
      confirmSession(db, row.id, new Date().toISOString());
      savedIds.push(row.id);
    }

    // --tag / --summary：用户权威标注（D7 第二层）
    if (f.tag || f.summary) {
      const tags = f.tag ? f.tag.split(',').map((t) => t.trim()).filter(Boolean) : [];
      for (const id of savedIds) {
        const full = getSessionFull(db, id);
        if (!full) continue;
        const merged = [...new Set([...full.userTags, ...tags])];
        const metaText = metaTextOf(full.title, [...full.topics, ...merged, ...(f.summary ? [f.summary] : [])]);
        db.prepare('UPDATE sessions SET user_tags = ?, user_summary = COALESCE(?, user_summary), meta_text = ? WHERE id = ?')
          .run(JSON.stringify(merged), f.summary ?? null, metaText, id);
      }
    }

    const result = {
      saved: savedIds.length,
      newMessages: s.newMessages,
      resumed: s.resumed,
      blocked: s.blocked,
      sessionIds: savedIds,
      tags: f.tag ? f.tag.split(',').map((t) => t.trim()).filter(Boolean) : [],
      summary: f.summary ?? null,
    };
    stats.increment('manual_save');
    if (f.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(pc.green('✓') + ` 已手动保存 ${result.saved} 个会话（origin=manual，已确认并提取）`);
    if (result.tags.length) console.log(pc.dim(`  标签：${result.tags.join(', ')}`));
    if (result.summary) console.log(pc.dim(`  摘要：${result.summary}`));
    const rows = listSessions(db, { projectId: cfg.identity.project_id ?? root, limit: savedIds.length });
    for (const r of rows.filter((x) => savedIds.includes(x.id)).slice(0, 5)) {
      console.log(`   ${r.id} 「${(r.title ?? '').slice(0, 30)}」 ${pc.dim(r.source)}`);
    }
  } finally {
    db.close();
  }
}
