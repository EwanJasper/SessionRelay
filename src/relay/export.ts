// HOP 导出（方针 §10 / 技术方案 §5.3）：
// 选集默认尊重当前 scope（--all 覆盖）· 默认脱敏（--no-redact 关）· HANDOFF.md 页脚署名（T19）
// 支持 hop（zip 包）与 markdown/summary（HANDOFF 直出）两种交付形态。
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
import { projectIdOf } from '../shared/paths.js';
import { loadIgnoreRules, isSessionBlocked } from '../capture/ignore.js';
import type { StatsCounter } from '../core/stats/counter.js';

export const FOOTER = '由会话接力 SessionRelay 生成 · github.com/EwanJasper/SessionRelay · 让 AI 的记忆属于项目';

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
  /**
   * 导出边界是否**重新应用当前排除规则**（默认 true，[1021 审查 #07]）。
   *
   * 病历：导出只按 scope 选集，完全不看 .sessionrelayignore —— 会话**入库之后**才加的排除规则
   * 对导出毫无约束（复现：入库一条「机密会话X」，之后加 title:机密 规则，导出包里仍有它）。
   * 于是「排除了」只对采集生效，分享/交接边界照样漏。
   *
   * 语义定死（对"新增规则对已存内容怎么处理"的回答）：
   *   · 排除规则是**边界规则**，不是删除命令 —— 新增规则**不动库里已有内容**（要抹掉得显式 forget）；
   *   · 但**所有对外出口**（hop 包 / markdown / summary）一律按**当前**规则过滤，且把过滤条数报出来。
   */
  reapplyIgnore?: boolean;
}

export interface ExportResult {
  file: string;
  sessionCount: number;
  messageCount: number;
  redactionHits: number;
  /** 导出边界被**当前排除规则**挡掉的会话数（>0 说明库里有内容"规则说别带走"） */
  ignoredByRules: number;
}

interface ExportData {
  sessions: HopSessionFile[];
  decisions: Array<{ at: string; source: string; sessionId: string; title: string | null; text: string; seq: number; pinned?: boolean; kind?: 'decision' | 'negative'; msgId?: string | number }>;
  topicMap: Record<string, string[]>;
  fileMap: Record<string, number>;
  messageCount: number;
  redactionHits: number;
  redactionLines: string[];
  ignoredByRules: number;
}

function buildExportData(opts: ExportOptions): ExportData {
  // ⚠️ 回退值必须是 projectIdOf(root)，不能用 opts.root —— 全库其它入口（capture/import/listDecisions）
  // 都用 projectIdOf；这里写 root 时，identity.project_id 未配置的库会**静默导出 0 条**
  // （复现：手写 config 不含 identity → 导出 session_count=0）。判据只许有一份。
  const projectId = opts.cfg.identity.project_id ?? projectIdOf(opts.root);
  // 排除规则只在导出边界读一次（不逐会话读配置）
  const ignoreRules = opts.reapplyIgnore === false ? [] : loadIgnoreRules(opts.root);
  let ignoredByRules = 0;
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
    // [1021 审查 #07] 导出边界重新过一遍**当前**排除规则（与采集侧同一份判据 isSessionBlocked）
    if (ignoreRules.length > 0 && isSessionBlocked(ignoreRules, {
      source: full.source,
      sourceSessionId: full.sourceSessionId,
      title: full.title,
      sourceFile: full.sourceFile ?? '',
    })) { ignoredByRules++; continue; }

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
  // [fork 1015] 这个投影**曾经是白名单**，把 pinned 与 kind 悄悄吃了：导出的 decisions 汇总里
  // 置顶状态与"否掉一条路"的标记全丢，导入后用户置顶的东西从简报里消失、negative 退化成普通决策。
  // 现在把用户态字段一并带上（仍是可选字段，老包读不到就是 undefined，语义同缺省）。
  const decisions = sessions.flatMap((s) => s.decisions.map((d) => ({
    at: d.at ?? s.created_at, source: s.source, sessionId: s.id, title: s.title, text: d.text, seq: d.seq,
    ...(d.pinned !== undefined ? { pinned: d.pinned } : {}),
    ...(d.kind !== undefined ? { kind: d.kind } : {}),
    // [1021 红队 R13] msgId 一起带走（元数据里才是接收方唯一能稳定回查的键）；
    // 但导入方必须剥掉它 —— 那是**导出方库**的自增主键，见 relay/import.ts。
    ...(d.msgId !== undefined ? { msgId: d.msgId } : {}),
  })));
  const topicMap: Record<string, string[]> = {};
  for (const s of sessions) for (const t of s.topics) (topicMap[t] ??= []).push(s.id);
  const fileMap: Record<string, number> = {};
  for (const s of sessions) for (const f of s.files) fileMap[f] = (fileMap[f] ?? 0) + 1;

  const redactionLines = allRedactionHits.map((h) => {
    const where = h.seq != null ? `#${h.seq}` : '';
    const pats = h.hits.map((x) => `${x.pattern}×${x.count}`).join(', ');
    return `${h.session} ${h.field}${where}: ${pats}`;
  });
  return { sessions, decisions, topicMap, fileMap, messageCount, redactionHits: allRedactionHits.length, redactionLines, ignoredByRules };
}

export function runExport(opts: ExportOptions): ExportResult {
  const data = buildExportData(opts);
  const files: Record<string, string> = {};
  for (const s of data.sessions) files[`sessions/${s.id}.json`] = JSON.stringify(s, null, 2) + '\n';
  files['metadata/decisions.json'] = JSON.stringify(data.decisions, null, 2) + '\n';
  files['metadata/topics.json'] = JSON.stringify(data.topicMap, null, 2) + '\n';
  files['metadata/files.json'] = JSON.stringify(data.fileMap, null, 2) + '\n';
  files['summary/HANDOFF.md'] = buildHandoff(path.basename(opts.root), data.sessions, data.decisions, FOOTER);
  files['summary/timeline.md'] = buildTimeline(data.sessions);
  if (data.redactionHits > 0) {
    files['summary/redaction-report.txt'] = data.redactionLines.join('\n') + '\n';
  }

  const dates = data.sessions.map((s) => s.created_at).sort();
  const manifest = buildManifest({
    created_at: new Date().toISOString(),
    exported_by: opts.cfg.identity.author ?? os.userInfo().username,
    project_id: opts.cfg.identity.project_id ?? opts.root,
    session_count: data.sessions.length,
    sources: [...new Set(data.sessions.map((s) => s.source))],
    date_range: { start: dates[0] ?? null, end: dates[dates.length - 1] ?? null },
    includes: { messages: !opts.decisionsOnly, decisions: true, topics: true, file_history: true },
    redaction: { applied: !opts.noRedact, report: data.redactionHits > 0 ? 'summary/redaction-report.txt' : null },
  });

  const out = opts.output ?? path.join(process.cwd(), `${path.basename(opts.root)}-handoff.hop`);
  fs.writeFileSync(out, packHop(manifest, files));
  insertTransferLog(opts.db, 'export', out, manifest.exported_by, null, data.sessions.map((s) => s.id));
  opts.stats?.increment('export_pkg');
  return {
    file: out, sessionCount: data.sessions.length, messageCount: data.messageCount,
    redactionHits: data.redactionHits, ignoredByRules: data.ignoredByRules,
  };
}

/** markdown / summary 直出（方针 §8.4 --format）：summary 为免会话细节的精简版 */
export function runExportMarkdown(opts: ExportOptions & { summaryOnly?: boolean }): { file: string; sessionCount: number; ignoredByRules: number } {
  const data = buildExportData(opts);
  const md = buildHandoff(path.basename(opts.root), data.sessions, data.decisions, FOOTER, { summaryOnly: opts.summaryOnly });
  const out = opts.output ?? path.join(process.cwd(), opts.summaryOnly ? 'SUMMARY.md' : 'HANDOFF.md');
  fs.writeFileSync(out, md, 'utf8');
  insertTransferLog(opts.db, 'export', out, null, null, data.sessions.map((s) => s.id));
  opts.stats?.increment('export_pkg');
  return { file: out, sessionCount: data.sessions.length, ignoredByRules: data.ignoredByRules };
}

function getSessionMessagesForExport(db: DB, sessionId: string): Array<{ seq: number; role: string; content: string; createdAt: string | null }> {
  return (db.prepare('SELECT seq_num, role, content, created_at FROM messages WHERE session_id = ? ORDER BY seq_num')
    .all(sessionId) as Array<{ seq_num: number; role: string; content: string; created_at: string | null }>)
    .map((m) => ({ seq: m.seq_num, role: m.role, content: m.content, createdAt: m.created_at }));
}
