// srelay scope set/add/reset/show · attach/detach（方针 §6.4/§6.5，D6）
// 说明（P3-A 登记偏差）：attach 的 session_links 一等关联依赖会话身份（Phase 4 branch/PID），
// MVP 落位为 scope.json 的 sessionIds 谓词（最高优先级）+ scope_log 留痕——语义与 D6 的 MVP 部分一致。
import { loadConfig } from '../shared/config.js';
import { resetScopeFile, saveScopeFile, makeScopeFile, loadScopeFile, mergeFilters } from '../core/scope/scopeFile.js';
import type { ScopePredicate } from '../core/scope/evaluator.js';
import { insertScopeLog } from '../store/db.js';
import { requireRoot, openRelayDb, pc } from './ui.js';

export interface ScopeFlags {
  topic?: string; tag?: string; file?: string; source?: string;
  since?: string; until?: string; sessions?: string; full?: boolean;
}

function flagsToPred(f: ScopeFlags): ScopePredicate {
  const p: ScopePredicate = {};
  if (f.topic) p.topics = f.topic.split(',').map((s) => s.trim());
  if (f.tag) p.tags = f.tag.split(',').map((s) => s.trim());
  if (f.file) p.files = f.file.split(',').map((s) => s.trim());
  if (f.source) p.sources = f.source.split(',').map((s) => s.trim());
  if (f.sessions) p.sessionIds = f.sessions.split(',').map((s) => s.trim());
  if (f.since) p.since = f.since;
  if (f.until) p.until = f.until;
  return p;
}

function withLog(root: string, action: string, pred: unknown): void {
  const db = openRelayDb(root);
  try { insertScopeLog(db, action, pred, 'cli'); } finally { db.close(); }
}

export async function cmdScopeSet(f: ScopeFlags): Promise<void> {
  const root = requireRoot();
  const sf = makeScopeFile(flagsToPred(f), { full: f.full, by: 'cli' });
  saveScopeFile(root, sf);
  withLog(root, 'set', sf.filters);
  printScope(root, sf);
}

export async function cmdScopeAdd(f: ScopeFlags): Promise<void> {
  const root = requireRoot();
  const cur = loadScopeFile(root);
  if (!cur || cur.mode === 'full') {
    return cmdScopeSet(f); // 无既有契约或处于 full → 等价 set
  }
  const sf = makeScopeFile(mergeFilters(cur.filters, flagsToPred(f)), { by: 'cli' });
  saveScopeFile(root, sf);
  withLog(root, 'add', sf.filters);
  printScope(root, sf);
}

export async function cmdScopeReset(): Promise<void> {
  const root = requireRoot();
  resetScopeFile(root);
  withLog(root, 'reset', null);
  console.log(pc.green('✓') + ' scope 已重置（全库可见，auto-scope 仍按入口规则生效）。');
}

export async function cmdScopeShow(): Promise<void> {
  const root = requireRoot();
  const sf = loadScopeFile(root);
  if (!sf) { console.log(pc.dim('（无 scope 契约——全库可见）')); }
  else printScope(root, sf);
  const db = openRelayDb(root);
  try {
    const logs = db.prepare('SELECT action, predicate, created_at FROM scope_log ORDER BY id DESC LIMIT 5').all() as Array<{ action: string; predicate: string; created_at: string }>;
    if (logs.length) {
      console.log(pc.dim('最近变更：'));
      for (const l of logs) console.log(pc.dim(`  ${l.created_at.slice(5, 16)} ${l.action} ${l.predicate.slice(0, 60)}`));
    }
  } finally { db.close(); }
}

function printScope(root: string, sf: { mode: string; filters: ScopePredicate }): void {
  const f = sf.filters;
  const parts: string[] = [];
  if (f.topics?.length) parts.push(`topic=${f.topics.join(',')}`);
  if (f.tags?.length) parts.push(`tag=${f.tags.join(',')}`);
  if (f.files?.length) parts.push(`file=${f.files.join(',')}`);
  if (f.sources?.length) parts.push(`source=${f.sources.join(',')}`);
  if (f.sessionIds?.length) parts.push(`sessions=${f.sessionIds.join(',')}`);
  if (f.since) parts.push(`since=${f.since}`);
  if (f.until) parts.push(`until=${f.until}`);
  console.log(pc.green('✓') + ` scope：${sf.mode === 'full' ? pc.yellow('full（逃生口，解除 A/B/C 裁剪）') : parts.join(' · ') || '（空谓词）'}`);
  console.log(pc.dim('  CLI 与 MCP 查询共用此契约；srelay scope reset 恢复全库。'));
}

export async function cmdAttach(ids: string[]): Promise<void> {
  const root = requireRoot();
  if (ids.length === 0) { console.log(pc.red('✗ 用法：srelay attach <sessionId前缀>…')); process.exit(2); }
  const db = openRelayDb(root);
  try {
    const cfg = loadConfig(root);
    const resolved: string[] = [];
    for (const p of ids) {
      const s = db.prepare('SELECT id FROM sessions WHERE project_id = ? AND id LIKE ? LIMIT 1').get(cfg.identity.project_id ?? root, p + '%') as { id: string } | undefined;
      if (!s) { console.log(pc.red(`✗ 未找到会话：${p}`)); process.exit(1); }
      resolved.push(s.id);
    }
    const sf = makeScopeFile({ sessionIds: resolved }, { by: 'cli:attach' });
    saveScopeFile(root, sf);
    insertScopeLog(db, 'attach', sf.filters, 'cli');
    console.log(pc.green('✓') + ` 已挂载 ${resolved.length} 个会话（最高优先级谓词）`);
    for (const id of resolved) {
      const t = db.prepare('SELECT title FROM sessions WHERE id = ?').get(id) as { title: string | null };
      console.log(`   ${id} 「${(t.title ?? '').slice(0, 30)}」`);
    }
  } finally { db.close(); }
}

export async function cmdDetach(): Promise<void> {
  const root = requireRoot();
  const sf = loadScopeFile(root);
  if (sf?.filters.sessionIds?.length) {
    delete sf.filters.sessionIds;
    const next = makeScopeFile(sf.filters, { by: 'cli:detach' });
    saveScopeFile(root, next);
    withLog(root, 'detach', next.filters);
    console.log(pc.green('✓') + ' 已解除挂载（其余过滤条件保留）。');
  } else {
    resetScopeFile(root);
    withLog(root, 'detach', null);
    console.log(pc.green('✓') + ' 已解除挂载（scope 重置）。');
  }
}
