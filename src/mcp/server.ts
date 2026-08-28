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
         insertScopeLog, addSessionLink, getLinkedSessions, createNoteSession,
         getSessionFull, metaTextOf, type DB } from '../store/db.js';
import { searchSessions } from '../search-svc/engine.js';
import { runExport, runExportMarkdown } from '../relay/export.js';
import { runImport, runRelease } from '../relay/import.js';
import { ZipSlipError, IntegrityError } from '../relay/hop.js';
import path from 'node:path';
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
    description: '取某会话的消息（可按角色过滤、限制单条长度）。session_id 支持前缀。role=user 只取用户提问（轻量）；缺省返回全部',
    inputSchema: {
      session_id: z.string(),
      start_msg: z.number().optional().describe('起始消息序号（含）'),
      end_msg: z.number().optional().describe('结束消息序号（含）'),
      role: z.enum(['user', 'assistant']).optional().describe('只取该角色的消息（解决"AI 回复太长，只要用户提问"的场景）'),
      max_chars: z.number().optional().describe('单条消息截断长度（默认 4000；设大值取全文）'),
    },
  }, async (args) => {
    const s = findSessionByPrefix(db, args.session_id, project) ?? getSession(db, args.session_id);
    if (!s) return toolOut({ found: false, reason: '未找到会话' });
    const from = args.start_msg ?? 1;
    const to = args.end_msg ?? Math.max(s.message_count, 1);
    const cap = args.max_chars ?? 4000;
    let msgs = getMessageRange(db, s.id, from, to);
    if (args.role) {
      msgs = msgs.filter((m) => m.role === args.role);
    }
    const result = msgs.map((m) => ({
      seq: m.seq_num, role: m.role,
      content: m.content.length > cap ? m.content.slice(0, cap) + `…(截断，全文 ${m.content.length} 字，加大 max_chars 取更多)` : m.content,
      createdAt: m.created_at,
    }));
    return toolOut({
      found: true,
      session: sessionBrief(db, s.id),
      summary_rule: s.summary_rule,
      range: [from, to],
      roleFilter: args.role ?? 'all',
      totalInDb: s.message_count,
      returned: result.length,
      messages: result,
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

  // ══════════ 写域工具（D21：内容不可变的旁路写入；状态迁移仍归 watch/CLI） ══════════

  server.registerTool('annotate_session', {
    title: '注释会话（标签/摘要）',
    description: '为会话添加/移除标签、设置人工摘要（进入检索索引）。这是元数据编辑，不改写对话内容',
    inputSchema: {
      session_id: z.string().describe('会话 ID（支持前缀）'),
      add_tags: z.array(z.string()).optional(),
      remove_tags: z.array(z.string()).optional(),
      summary: z.string().optional().describe('人工摘要（覆盖旧值；会成为权威摘要层）'),
    },
  }, async (args) => {
    const s = findSessionByPrefix(db, args.session_id, project) ?? getSession(db, args.session_id);
    if (!s) return toolOut({ ok: false, reason: '未找到会话' });
    const full = getSessionFull(db, s.id);
    if (!full) return toolOut({ ok: false, reason: '会话数据缺失' });
    const remove = new Set(args.remove_tags ?? []);
    const tags = [...new Set([...full.userTags, ...(args.add_tags ?? [])])].filter((t) => !remove.has(t));
    db.prepare('UPDATE sessions SET user_tags = ?, user_summary = COALESCE(?, user_summary), meta_text = ? WHERE id = ?')
      .run(JSON.stringify(tags), args.summary ?? null,
        metaTextOf(full.title, [...full.topics, ...tags, ...(args.summary ? [args.summary] : [])]), s.id);
    return toolOut({ ok: true, sessionId: s.id, userTags: tags, ...(args.summary ? { userSummary: args.summary } : {}), note: '标签与摘要已进入检索索引' });
  });

  server.registerTool('save_note', {
    title: '写入结论笔记',
    description: '把结论/备忘写入项目记忆（source=note，origin=manual，立即确认并提取）。笔记中的决策句式会直接进入决策库',
    inputSchema: {
      title: z.string().min(2),
      content: z.string().min(4),
      tags: z.array(z.string()).optional(),
    },
  }, async (args) => {
    const id = createNoteSession(db, { projectId: project, title: args.title, content: args.content, tags: args.tags });
    insertScopeLog(db, 'note', { id, title: args.title }, 'mcp:save_note');
    return toolOut({ ok: true, sessionId: id, source: 'note', state: 'confirmed', note: '笔记已可被 search / get_decisions / export 检索' });
  });

  server.registerTool('export_handoff', {
    title: '导出交接包',
    description: '生成 .hop 交接包（sha256 完整性 + 默认脱敏）或 HANDOFF.md。默认尊重当前 scope',
    inputSchema: {
      output: z.string().optional().describe('输出绝对路径（缺省在项目根）'),
      all: z.boolean().optional().describe('忽略 scope 导出全库'),
      decisions_only: z.boolean().optional(),
      format: z.enum(['hop', 'markdown']).optional().default('hop'),
    },
  }, async (args) => {
    try {
      const opts = {
        root, cfg, db,
        output: args.output ?? path.join(root, `${path.basename(root)}-handoff.${args.format === 'markdown' ? 'md' : 'hop'}`),
        all: args.all, decisionsOnly: args.decisions_only,
      };
      const r = args.format === 'markdown'
        ? (() => { const m = runExportMarkdown(opts); return { file: m.file, sessionCount: m.sessionCount, messageCount: 0, redactionHits: 0 }; })()
        : runExport(opts);
      return toolOut({ ok: true, ...r, format: args.format ?? 'hop', note: '把文件发给同事：srelay import <file>' });
    } catch (e) {
      return toolOut({ ok: false, reason: (e as Error).message });
    }
  });

  server.registerTool('import_handoff', {
    title: '导入交接包（默认隔离）',
    description: '导入 .hop 交接包：sha256 全量校验 + 归化到当前项目。经 AI 发起的导入默认走隔离模式（只入元数据与摘要，正文待 release）',
    inputSchema: {
      path: z.string().describe('包文件绝对路径'),
      from: z.string().optional().describe('来源人'),
      quarantine: z.boolean().optional().default(true).describe('默认 true（隔离导入）；显式 false 需用户明确要求'),
    },
  }, async (args) => {
    try {
      const r = runImport({ root, cfg, db, pkgPath: args.path, from: args.from, quarantine: args.quarantine ?? true });
      return toolOut({ ok: true, ...r, note: r.quarantined > 0 ? '隔离会话可用 release_quarantine 放行' : '归化完成，search 立即可用' });
    } catch (e) {
      if (e instanceof ZipSlipError || e instanceof IntegrityError) {
        return toolOut({ ok: false, rejected: e.message, reason: '完整性/安全校验失败，已整体拒绝' });
      }
      return toolOut({ ok: false, reason: (e as Error).message });
    }
  });

  server.registerTool('release_quarantine', {
    title: '放行隔离会话',
    description: '把隔离导入的会话正文放行入库（用户确认后使用）',
    inputSchema: { session_id_prefix: z.string() },
  }, async (args) => {
    const r = runRelease({ root, db, idPrefix: args.session_id_prefix });
    return toolOut({ ok: true, released: r.released });
  });

  server.registerTool('link_sessions', {
    title: '建立会话关联',
    description: '把两个会话建立关联（continues=延续 / related=相关 / pinned=挂载），供 get_linked_sessions 与跨会话追溯',
    inputSchema: {
      session_id: z.string().describe('会话 ID（支持前缀）'),
      linked_ids: z.array(z.string()).min(1),
      kind: z.enum(['continues', 'related', 'pinned']).optional().default('related'),
    },
  }, async (args) => {
    const a = findSessionByPrefix(db, args.session_id, project) ?? getSession(db, args.session_id);
    if (!a) return toolOut({ ok: false, reason: '未找到主会话' });
    const resolved: string[] = []; const missed: string[] = [];
    for (const p of args.linked_ids) {
      const b = findSessionByPrefix(db, p, project) ?? getSession(db, p);
      if (b) { addSessionLink(db, a.id, b.id, args.kind ?? 'related'); resolved.push(b.id); } else missed.push(p);
    }
    return toolOut({ ok: missed.length === 0, sessionId: a.id, linked: resolved, missed, kind: args.kind ?? 'related' });
  });

  server.registerTool('get_linked_sessions', {
    title: '查询会话关联',
    description: '某会话的全部关联（双向：它指向的 / 指向它的），带 kind 与方向',
    inputSchema: { session_id: z.string() },
  }, async (args) => {
    const s = findSessionByPrefix(db, args.session_id, project) ?? getSession(db, args.session_id);
    if (!s) return toolOut({ ok: false, reason: '未找到会话' });
    const links = getLinkedSessions(db, s.id);
    return toolOut({ ok: true, sessionId: s.id, count: links.length, links });
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
