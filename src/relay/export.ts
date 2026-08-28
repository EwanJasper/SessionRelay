// HOP 导出（方针 §10 / 技术方案 §5.3）：
// 选集默认尊重当前 scope（--all 覆盖）· 默认脱敏（--no-redact 关）· HANDOFF.md 页脚署名（T19）
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { DB } from '../store/db.js';
import { listSessions, getSessionFull, insertTransferLog } from '../store/db.js';
import type { RelayConfig } from '../shared/config.js';
import type { ScopePredicate } from '../core/scope/evaluator.js';
import { assembleScope } from '../core/scope/assemble.js';
import { redactText, type RedactHit } from './redact.js';
import { buildManifest, packHop, type HopSessionFile } from './hop.js';
import { buildHandoff, buildTimeline } from './handoff-md.js';
import type { StatsCounter } from '../core/stats/counter.js';

export const FOOTER = '由会话接力 SessionRelay 生成 · github.com/sessionrelay/sessionrelay · 让 AI 的记忆属于项目';

export interface ExportOptions {
  root: string;
  cfg: RelayConfig;
  db: DB;
  output?: string;
  all?: boolean;
  noRedact?: boolean;
  decisionsOnly?: boolean;
  filters?: ScopePredicate;
  excludeTags?: string[];
  stats?: StatsCounter;
}

export interface ExportResult {
  file: string;
  sessionCount: number;
  messageCount: number;
  redactionHits: number;
}

export function runExport(opts: ExportOptions): ExportResult {
  const projectId = opts.cfg.identity.project_id ?? opts.root;
  const where = opts.all ? null : assembleScope({ root: opts.root, cfg: opts.cfg, callPred: opts.filters, includeAuto: false }).where;
  const rows = listSessions(opts.db, { projectId, where, limit: 10000 });

  const doRedact = !opts.noRedact;
  const sessions: HopSessionFile[] = [];
  const allRedactionHits: Array<{ session: string; field: string; seq?: number; hits: RedactHit[] }> = [];
  let messageCount = 0;

  for (const row of rows) {
    const full = getSessionFull(opts.db, row.id);
    if (!full) continue;
    if (opts.excludeTags?.length && full.userTags.some((t) => opts.excludeTags!.includes(t))) continue;

    const rd = (text: string | null, field: string, seq?: number): string | null => {
      if (!doRedact || !text) return text;
      const r = redactText(text);
      if (r.hits.length > 0) allRedactionHits.push({ session: full.id, field, seq, hits: r.hits });
      return r.text;
    };

    const messages = opts.decisionsOnly ? [] : getSessionMessagesForExport(opts.db, full.id);
    sessions.push({
      id: full.id,
      source: full.source,
      source_session_id: full.sourceSessionId,
      project_id: full.projectId,
      title: rd(full.title, 'title'),
      created_at: full.createdAt,
      last_event_at: full.lastEventAt,
      state: full.state,
      origin: full.origin,
      author: full.author,
      summary_rule: rd(full.summaryRule, 'summary'),
      topics: full.topics,
      files: full.files,
      decisions: full.decisions.map((d) => ({ ...d, text: rd(d.text, 'decision', d.seq) ?? d.text })),
      questions: full.questions.map((q) => ({ ...q, q: rd(q.q, 'question', q.seq) ?? q.q })),
      messages: messages.map((m) => ({ seq: m.seq, role: m.role, content: rd(m.content, 'message', m.seq) ?? m.content, createdAt: m.createdAt ?? null })),
    });
    messageCount += messages.length;
  }

  sessions.sort((a, b) => a.created_at.localeCompare(b.created_at));
  const dates = sessions.map((s) => s.created_at).sort();

  const files: Record<string, string> = {};
  for (const s of sessions) files[`sessions/${s.id}.json`] = JSON.stringify(s, null, 2) + '\n';

  // metadata 汇总
  const decisions = sessions.flatMap((s) => s.decisions.map((d) => ({ at: d.at ?? s.created_at, source: s.source, sessionId: s.id, title: s.title, text: d.text, seq: d.seq })));
  const topicMap: Record<string, string[]> = {};
  for (const s of sessions) for (const t of s.topics) (topicMap[t] ??= []).push(s.id);
  const fileMap: Record<string, number> = {};
  for (const s of sessions) for (const f of s.files) fileMap[f] = (fileMap[f] ?? 0) + 1;
  files['metadata/decisions.json'] = JSON.stringify(decisions, null, 2) + '\n';
  files['metadata/topics.json'] = JSON.stringify(topicMap, null, 2) + '\n';
  files['metadata/files.json'] = JSON.stringify(fileMap, null, 2) + '\n';

  // 交接文档（零 LLM，由 summary_rule 组装）+ 时间线
  files['summary/HANDOFF.md'] = buildHandoff(path.basename(opts.root), sessions, decisions, FOOTER);
  files['summary/timeline.md'] = buildTimeline(sessions);
  if (allRedactionHits.length > 0) {
    files['summary/redaction-report.txt'] = allRedactionHits
      .map((h) => `${h.session} ${h.field}${h.seq != null ? `#${h.seq}` : ''}: ${h.hits.map((x) => `${x.pattern}×${x.count}`).join(', ')}`)
      .join('\n') + '\n';
  }

  const manifest = buildManifest({
    created_at: new Date().toISOString(),
    exported_by: opts.cfg.identity.author ?? os.userInfo().username,
    project_id: projectId,
    session_count: sessions.length,
    sources: [...new Set(sessions.map((s) => s.source))],
    date_range: { start: dates[0] ?? null, end: dates[dates.length - 1] ?? null },
    includes: { messages: !opts.decisionsOnly, decisions: true, topics: true, file_history: true },
    redaction: { applied: doRedact, report: allRedactionHits.length > 0 ? 'summary/redaction-report.txt' : null },
  });

  const out = opts.output ?? path.join(process.cwd(), `${path.basename(opts.root)}-handoff.hop`);
  fs.writeFileSync(out, packHop(manifest, files));
  insertTransferLog(opts.db, 'export', out, manifest.exported_by, null, sessions.map((s) => s.id));
  opts.stats?.increment('export_pkg');
  return { file: out, sessionCount: sessions.length, messageCount, redactionHits: allRedactionHits.length };
}

function getSessionMessagesForExport(db: DB, sessionId: string): Array<{ seq: number; role: string; content: string; createdAt: string | null }> {
  return (db.prepare('SELECT seq_num, role, content, created_at FROM messages WHERE session_id = ? ORDER BY seq_num')
    .all(sessionId) as Array<{ seq_num: number; role: string; content: string; created_at: string | null }>)
    .map((m) => ({ seq: m.seq_num, role: m.role, content: m.content, createdAt: m.created_at }));
}
