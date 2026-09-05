// srelay search / show / list（方针 §8.2；出处块强制 D10；B 档 scope 契约对 CLI 同样生效）
import { loadConfig, type CaptureMode } from '../shared/config.js';
import { assembleScope } from '../core/scope/assemble.js';
import { searchSessions } from '../search-svc/engine.js';
import { findSessionByPrefix, getSession, listSessions, getMessageRange } from '../store/db.js';
import { openStats } from '../core/stats/counter.js';
import { requireRoot, openRelayDb, pc, fmtDate, stateBadge } from './ui.js';

export interface SearchFlags {
  topic?: string; tag?: string; file?: string; source?: string; since?: string; until?: string;
  limit?: number; json?: boolean;
}

export async function cmdSearch(query: string, flags: SearchFlags): Promise<void> {
  const root = requireRoot();
  const cfg = loadConfig(root);
  const db = openRelayDb(root);
  const stats = openStats(root);
  stats.increment('cli_search');
  try {
    const pred = {
      topics: flags.topic ? [flags.topic] : undefined,
      tags: flags.tag ? [flags.tag] : undefined,
      files: flags.file ? [flags.file] : undefined,
      sources: flags.source ? [flags.source] : undefined,
      since: flags.since,
      until: flags.until,
    };
    // B 档 scope 契约对 CLI 生效（交集只能收窄；CLI 不吃 A 档 auto-scope——人自己管时间窗）
    const asm = assembleScope({ root, cfg, callPred: pred, includeAuto: false });
    // 语义补充命中（未启用 → null → 与纯 FTS 行为等价）
    const { semanticSearch } = await import('../search-svc/semantic.js');
    const semHits = await semanticSearch(db, cfg, query, { project: cfg.identity.project_id ?? root, extraWhere: asm.where });
    const hits = searchSessions(db, {
      project: cfg.identity.project_id ?? root,
      query,
      limit: flags.limit ?? 10,
      extraWhere: asm.where,
      semanticHits: semHits,
    });
    if (flags.json) {
      const rows = hits.map((h) => {
        const s = getSession(db, h.sessionId);
        return {
          sessionId: h.sessionId, title: s?.title ?? null, source: s?.source ?? null,
          createdAt: s?.created_at ?? null, state: s?.state ?? null,
          score: Number(h.score.toFixed(3)), coverage: h.coverage, viaMeta: h.viaMeta,
          viaSemantic: h.viaSemantic ?? false,
          snippet: h.snippet, provenance: { sessionId: h.sessionId },
        };
      });
      console.log(JSON.stringify({ query, count: rows.length, hits: rows }, null, 2));
      return;
    }
    if (hits.length === 0) {
      const scopedNote = asm.scopeFile && asm.scopeFile.mode !== 'full' ? pc.dim('（scope 契约生效中：srelay scope show 查看 / scope reset 放宽）') : '';
      console.log(pc.yellow('未找到。') + scopedNote);
      return;
    }
    const snap = stats.snapshot();
    if (snap['first_hit'] === undefined) stats.increment('first_hit');
    hits.forEach((h, i) => {
      const s = getSession(db, h.sessionId);
      const no = pc.cyan(`${i + 1}.`);
      console.log(`${no} ${(s?.title ?? h.sessionId).slice(0, 44)}  ${pc.dim(`${s?.source ?? ''} · ${fmtDate(s?.created_at)} · `)}${stateBadge(s?.state ?? '')}`);
      if (h.snippet) console.log(pc.dim(`   ${h.snippet.slice(0, 100)}`));
      if (!h.viaMeta) console.log(pc.dim(`   srelay show ${h.sessionId} · 命中覆盖 ${Math.round(h.coverage * 100)}%`));
    });
    console.log(pc.dim(`\n${hits.length} 条命中。--json 看机器格式。`));
  } finally {
    db.close();
  }
}

export async function cmdShow(idPrefix: string, opts: { range?: string; json?: boolean }): Promise<void> {
  const root = requireRoot();
  const cfg = loadConfig(root);
  const db = openRelayDb(root);
  const stats = openStats(root);
  stats.increment('cli_show');
  try {
    const s = findSessionByPrefix(db, idPrefix, cfg.identity.project_id ?? root);
    if (!s) { console.log(pc.red('✗ 未找到会话：') + idPrefix); return; }
    const [from, to] = parseRange(opts.range, s.message_count);
    if (opts.json) {
      const msgs = getMessageRange(db, s.id, from, to);
      console.log(JSON.stringify({ session: s, range: [from, to], messages: msgs }, null, 2));
      return;
    }
    console.log(pc.bold(`「${s.title ?? s.id}」`));
    console.log(pc.dim(`${s.source} · ${fmtDate(s.created_at)} · ${s.state} · ${s.message_count} 消息 · 显示 #${from}-#${to}`));
    console.log('─'.repeat(58));
    const msgs = getMessageRange(db, s.id, from, to);
    // 总预算保护（20KB）：超出时停止输出并提示分段查看
    const BUDGET = 20 * 1024;
    let used = 0;
    let stopped = false;
    for (const m of msgs) {
      const body = m.content.length > 600 ? m.content.slice(0, 600) + ` …(截断，共 ${m.content.length} 字)` : m.content;
      used += Buffer.byteLength(body, 'utf8');
      if (used > BUDGET) {
        stopped = true;
        const shown = msgs.indexOf(m);
        console.log(pc.yellow(`\n⚠️ 输出已达 20KB 预算，已显示 #${from}–#${from + shown - 1}（共 ${msgs.length} 条中）。`));
        console.log(pc.dim(`  分段查看：--range ${from + shown}:${to}；只看提问：MCP get_session_detail(role: 'user')`));
        break;
      }
      const who = m.role === 'user' ? pc.cyan('用户') : pc.green('AI  ');
      console.log(`${pc.dim(`#${m.seq_num}`)} ${who} ${body.replace(/\n+/g, '\n   ')}`);
    }
    if (!stopped) {
      console.log(pc.dim(`\n💡 省上下文技巧：MCP get_session_detail 支持 role:'user' 只看提问、max_chars 控制单条长度`));
    }
  } finally {
    db.close();
  }
}

export async function cmdList(opts: { source?: string; state?: string; limit?: number; json?: boolean }): Promise<void> {
  const root = requireRoot();
  const cfg = loadConfig(root);
  const db = openRelayDb(root);
  try {
    const asm = assembleScope({ root, cfg, includeAuto: false });
    const rows = listSessions(db, { projectId: cfg.identity.project_id ?? root, source: opts.source, state: opts.state, limit: opts.limit ?? 20, where: asm.where });
    if (opts.json) {
      console.log(JSON.stringify({ count: rows.length, sessions: rows }, null, 2));
      return;
    }
    if (rows.length === 0) { console.log(pc.dim('（空）先 srelay sync 或等待守护捕获。')); return; }
    // 笔记单独分组展示（note 是 AI 结论记录，不是对话会话）
    const sessions = rows.filter(s => s.source !== 'note');
    const notes = rows.filter(s => s.source === 'note');
    for (const s of sessions) {
      console.log(`${pc.dim(fmtDate(s.last_event_at ?? s.created_at))}  ${s.source.padEnd(11)} ${stateBadge(s.state).padEnd(10)} 「${(s.title ?? '').slice(0, 36)}」 ${pc.dim(`${s.id} · ${s.message_count}msg`)}`);
    }
    if (notes.length > 0) {
      console.log(pc.dim(`\n── AI 笔记（${notes.length} 条，srelay list --source note 查看）──`));
      for (const s of notes) {
        console.log(`${pc.dim(fmtDate(s.created_at))}  📝 「${(s.title ?? '').slice(0, 40)}」 ${pc.dim(s.id)}`);
      }
    }
  } finally {
    db.close();
  }
}

function parseRange(r: string | undefined, total: number): [number, number] {
  if (!r) return [1, Math.max(total, 1)];
  const m = /^(\d*):(\d*)$/.exec(r);
  if (!m) return [1, Math.max(total, 1)];
  return [Number(m[1] || 1), Number(m[2] || Math.max(total, 1))];
}
