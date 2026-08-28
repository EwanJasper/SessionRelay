// MCP Server（方针 §九 / 技术方案 §3.5/§5.4）
// 契约：检索类工具逐条携带出处块（D10）；全部受 Scope 交集语义约束（D5）；
//       scope.json 每次调用 stat 热更新（T28）；命中不足返回放宽 hint。
// 本服务永不触发会话状态迁移（§1.2 约束 2）；set_scope 仅写 scope.json + scope_log。
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'node:fs';
import { loadConfig, type RelayConfig } from '../shared/config.js';
import { dbFile, findRelayRoot } from '../shared/paths.js';
import { openExisting, listSessions, listDecisions, listUnresolved,
         getMessageRange, findSessionByPrefix, getSession, countsByState, countsBySource,
         insertScopeLog, type DB } from '../store/db.js';
import { searchSessions } from '../search-svc/engine.js';
import type { ScopePredicate } from '../core/scope/evaluator.js';
import { compilePredicate } from '../core/scope/evaluator.js';
import { assembleScope } from '../core/scope/assemble.js';
import { loadScopeFile, saveScopeFile, makeScopeFile } from '../core/scope/scopeFile.js';

function toolOut(obj: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(obj, null, 2) }] };
}

const zPred = {
  topic: z.string().optional().describe('按话题过滤（精确）'),
  tag: z.string().optional().describe('按用户标签过滤'),
  file: z.string().optional().describe('按涉及文件前缀过滤'),
  source: z.string().optional().describe('按来源 agent 过滤：claude-code | zcode | …'),
  since: z.string().optional().describe('ISO 日期下界'),
  until: z.string().optional().describe('ISO 日期上界'),
};

function predFrom(args: { topic?: string; tag?: string; file?: string; source?: string; since?: string; until?: string }): ScopePredicate {
  const p: ScopePredicate = {};
  if (args.topic) p.topics = [args.topic];
  if (args.tag) p.tags = [args.tag];
  if (args.file) p.files = [args.file];
  if (args.source) p.sources = [args.source];
  if (args.since) p.since = args.since;
  if (args.until) p.until = args.until;
  return p;
}

function sessionBrief(db: DB, sessionId: string) {
  const s = getSession(db, sessionId);
  return s
    ? { sessionId: s.id, title: s.title, source: s.source, createdAt: s.created_at, state: s.state }
    : { sessionId };
}

export function buildServer(root: string, db: DB, cfg: RelayConfig): McpServer {
  const project = cfg.identity.project_id ?? root;
  const server = new McpServer({ name: 'sessionrelay', version: '0.1.0' });

  /** 命中不足提示（方针 §6.4）：返回 scope 外还有多少可用 */
  const buildHint = (callPred: ScopePredicate, hitCount: number): string | null => {
    if (hitCount >= cfg.search.min_hits_hint) return null;
    const w = compilePredicate(callPred);
    const row = db.prepare(
      `SELECT COUNT(*) AS n FROM sessions s WHERE s.project_id = ?${w ? ` AND ${w.sql}` : ''}`,
    ).get(project, ...(w?.params ?? [])) as { n: number };
    if (row.n > hitCount) {
      return `当前 scope 命中 ${hitCount} 条，满足条件的有 ${row.n} 条在 scope 之外，可调用 set_scope({mode:'full'}) 放宽（隐私 ignore 不受影响）`;
    }
    return null;
  };

  server.registerTool('search_sessions', {
    title: '搜索历史会话',
    description: '跨 agent 中文全文搜索本项目历史会话（自动应用 scope 与来源出处）',
    inputSchema: { query: z.string().describe('搜索词，支持 "短语" 精确匹配'), limit: z.number().optional(), ...zPred },
  }, async (args) => {
    const callPred = predFrom(args);
    // T28：每次调用重新装配（scope.json 热更新）
    const asm = assembleScope({ root, cfg, callPred, includeAuto: true });
    const hits = searchSessions(db, { project, query: args.query, limit: args.limit ?? 10, extraWhere: asm.where });
    const out = hits.map((h) => ({
      ...sessionBrief(db, h.sessionId),
      score: Number(h.score.toFixed(3)),
      coverage: h.coverage,
      viaMeta: h.viaMeta,
      snippet: h.snippet,
      provenance: { ...sessionBrief(db, h.sessionId), msg: h.seq, note: `get_session_detail 可取全文` },
    }));
    const hint = buildHint(callPred, hits.length);
    return toolOut({ query: args.query, scoped: !!asm.where, escaped: asm.escaped, count: out.length, hits: out, ...(hint ? { hint } : {}) });
  });

  server.registerTool('get_session_detail', {
    title: '会话详情',
    description: '取某会话的完整消息（或片段）。session_id 支持前缀',
    inputSchema: {
      session_id: z.string(),
      start_msg: z.number().optional().describe('起始消息序号（含）'),
      end_msg: z.number().optional().describe('结束消息序号（含）'),
    },
  }, async (args) => {
    const s = findSessionByPrefix(db, args.session_id, project) ?? getSession(db, args.session_id);
    if (!s) return toolOut({ found: false, reason: '未找到会话' });
    const from = args.start_msg ?? 1;
    const to = args.end_msg ?? Math.max(s.message_count, 1);
    const msgs = getMessageRange(db, s.id, from, to).map((m) => ({
      seq: m.seq_num, role: m.role, content: m.content.length > 4000 ? m.content.slice(0, 4000) + '…(截断)' : m.content, createdAt: m.created_at,
    }));
    return toolOut({
      found: true,
      session: sessionBrief(db, s.id),
      summary_rule: s.summary_rule,
      range: [from, to],
      messages: msgs,
      provenance: { sessionId: s.id, source: s.source, createdAt: s.created_at, state: s.state },
    });
  });

  server.registerTool('list_sessions', {
    title: '列出会话',
    description: '按过滤条件列出本项目会话（scope 生效）',
    inputSchema: { limit: z.number().optional(), state: z.string().optional().describe('active|pending_end|confirmed'), ...zPred },
  }, async (args) => {
    const callPred = predFrom(args);
    const asm = assembleScope({ root, cfg, callPred, includeAuto: true });
    const rows = listSessions(db, { projectId: project, state: args.state, limit: args.limit ?? 20, where: asm.where });
    return toolOut({ count: rows.length, sessions: rows.map((s) => ({ ...sessionBrief(db, s.id), messageCount: s.message_count, summary: s.summary_rule?.split('\n')[0] ?? null })) });
  });

  server.registerTool('get_decisions', {
    title: '决策列表',
    description: '本项目全部已确认技术决策（带出处，可回跳）',
    inputSchema: { topic: z.string().optional(), source: z.string().optional() },
  }, async (args) => {
    const rows = listDecisions(db, project, { topic: args.topic, source: args.source });
    return toolOut({
      count: rows.length,
      decisions: rows.map((r) => ({
        at: r.at, text: r.text,
        provenance: { sessionId: r.sessionId, source: r.source, title: r.title, msg: r.seq },
      })),
    });
  });

  server.registerTool('get_file_history', {
    title: '文件讨论史',
    description: '某文件路径被哪些会话讨论过（跨 agent）',
    inputSchema: { file_path: z.string() },
  }, async (args) => {
    const asm = assembleScope({ root, cfg, includeAuto: true });
    const hits = searchSessions(db, { project, query: `"${args.file_path.replace(/\\/g, '/')}"`, limit: 20, extraWhere: asm.where });
    return toolOut({
      file: args.file_path,
      count: hits.length,
      sessions: hits.map((h) => ({ ...sessionBrief(db, h.sessionId), snippet: h.snippet, provenance: { ...sessionBrief(db, h.sessionId), msg: h.seq } })),
    });
  });

  server.registerTool('get_unresolved', {
    title: '未决问题',
    description: '会话中提出但（启发式判定）未解决的问题',
    inputSchema: { limit: z.number().optional() },
  }, async (args) => {
    const rows = listUnresolved(db, project, args.limit ?? 20);
    return toolOut({ count: rows.length, unresolved: rows.map((r) => ({ q: r.q, at: r.at, provenance: sessionBrief(db, r.sessionId) })) });
  });

  server.registerTool('get_stats', {
    title: '索引统计',
    description: '本项目记忆库统计（会话数/状态/来源/体积/当前 scope）',
    inputSchema: {},
  }, async () => {
    const byState = countsByState(db, project);
    const bySource = countsBySource(db, project);
    const sf = loadScopeFile(root);
    return toolOut({
      project,
      mode: cfg.capture.mode,
      sessions: { total: Object.values(byState).reduce((a, b) => a + b, 0), ...byState },
      bySource,
      dbSizeMB: Number((fs.existsSync(dbFile(root)) ? fs.statSync(dbFile(root)).size / 1024 / 1024 : 0).toFixed(2)),
      scope: sf ? { mode: sf.mode, filters: sf.filters, issued_at: sf.issued_at } : null,
    });
  });

  server.registerTool('set_scope', {
    title: '调整检索边界（逃生口）',
    description: '收得太紧时的放宽通道：mode:"full" 解除裁剪（隐私 ignore 永不受影响）；或设置新过滤条件',
    inputSchema: {
      mode: z.enum(['predicate', 'full']).optional(),
      filters: z.object({
        topics: z.array(z.string()).optional(), tags: z.array(z.string()).optional(),
        files: z.array(z.string()).optional(), sources: z.array(z.string()).optional(),
        since: z.string().optional(), until: z.string().optional(),
      }).optional(),
    },
  }, async (args) => {
    const sf = makeScopeFile(args.filters ?? {}, { full: args.mode === 'full', by: 'mcp:set_scope' });
    saveScopeFile(root, sf);
    insertScopeLog(db, 'set', sf.filters, 'mcp:set_scope');
    return toolOut({ ok: true, scope: { mode: sf.mode, filters: sf.filters }, note: 'full 只解除 A/B/C 裁剪；隐私 ignore 是捕获层硬边界，不受影响' });
  });

  return server;
}

export async function runServe(): Promise<void> {
  const root = process.env.SRELAY_PROJECT_ROOT
    ? findRelayRoot(process.env.SRELAY_PROJECT_ROOT) ?? process.env.SRELAY_PROJECT_ROOT
    : findRelayRoot(process.cwd());
  if (!root) {
    process.stderr.write('srelay serve: 未找到 .sessionrelay（先在项目内 srelay init）\n');
    process.exit(1);
  }
  const cfg = loadConfig(root);
  const db = openExisting(dbFile(root));
  const server = buildServer(root, db, cfg);
  await server.connect(new StdioServerTransport());
  process.stderr.write(`[srelay-serve] 项目 ${root} · 8 tools 就绪（stdio）\n`);
  await new Promise(() => {}); // 常驻
}
