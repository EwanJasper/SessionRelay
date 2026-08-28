// srelay export / import / team（方针 §8.4/§8.5）
import { loadConfig } from '../shared/config.js';
import { runExport } from '../relay/export.js';
import { runImport, runRelease } from '../relay/import.js';
import { listTransferLog, teamStatus } from '../store/db.js';
import { ZipSlipError, IntegrityError } from '../relay/hop.js';
import { openStats } from '../core/stats/counter.js';
import { requireRoot, openRelayDb, pc, fmtDate } from './ui.js';
import type { ScopePredicate } from '../core/scope/evaluator.js';

export interface ExportFlags {
  output?: string; all?: boolean; noRedact?: boolean; decisionsOnly?: boolean;
  topic?: string; tag?: string; source?: string; since?: string; until?: string; excludeTag?: string;
}

export async function cmdExport(f: ExportFlags): Promise<void> {
  const root = requireRoot();
  const cfg = loadConfig(root);
  const db = openRelayDb(root);
  try {
    const filters: ScopePredicate = {};
    if (f.topic) filters.topics = [f.topic];
    if (f.tag) filters.tags = [f.tag];
    if (f.source) filters.sources = [f.source];
    if (f.since) filters.since = f.since;
    if (f.until) filters.until = f.until;
    const r = runExport({
      root, cfg, db,
      output: f.output, all: f.all, noRedact: f.noRedact, decisionsOnly: f.decisionsOnly,
      filters: Object.keys(filters).length ? filters : undefined,
      excludeTags: f.excludeTag ? [f.excludeTag] : undefined,
      stats: openStats(root),
    });
    console.log(pc.green('✓') + ` 已导出 ${r.sessionCount} 会话 · ${r.messageCount} 消息 → ${r.file}`);
    if (r.redactionHits > 0) console.log(pc.yellow(`  脱敏：命中 ${r.redactionHits} 处（报告在包内 summary/redaction-report.txt）`));
    console.log(pc.dim('  交接：把 .hop 文件发给同事，对方运行 srelay import <file>'));
  } finally {
    db.close();
  }
}

export async function cmdImport(pkg: string, f: { from?: string; quarantine?: boolean; release?: string }): Promise<void> {
  const root = requireRoot();
  const cfg = loadConfig(root);
  const db = openRelayDb(root);
  try {
    if (f.release) {
      const r = runRelease({ root, db, idPrefix: f.release });
      console.log(pc.green('✓') + ` 已放行 ${r.released} 个隔离会话（正文入库）。`);
      return;
    }
    const r = runImport({ root, cfg, db, pkgPath: pkg, from: f.from, quarantine: f.quarantine, stats: openStats(root) });
    const parts = [`导入 ${r.imported}`];
    if (r.skipped) parts.push(`跳过(已存在) ${r.skipped}`);
    if (r.quarantined) parts.push(`隔离待放行 ${r.quarantined}（srelay import <pkg> --release <id前缀>）`);
    console.log(pc.green('✓') + ' ' + parts.join(' · '));
    console.log(pc.dim('  导入会话已归化到当前项目，search/decisions 立即可用。'));
  } catch (e) {
    if (e instanceof ZipSlipError || e instanceof IntegrityError) {
      console.log(pc.red('✗ 拒绝导入：') + e.message + pc.dim('（完整性/安全校验失败，包可能被篡改）'));
      process.exit(1);
    }
    throw e;
  } finally {
    db.close();
  }
}

export async function cmdTeam(sub: string): Promise<void> {
  const root = requireRoot();
  const cfg = loadConfig(root);
  const db = openRelayDb(root);
  try {
    const pid = cfg.identity.project_id ?? root;
    if (sub === 'status') {
      const t = teamStatus(db, pid);
      console.log(`会话 ${t.native + t.imported}（本地捕获 ${t.native} · 导入 ${t.imported}）· 导入包 ${t.packages} 个`);
      console.log('贡献者：' + (Object.entries(t.byAuthor).map(([k, v]) => `${k} ${v}`).join(' · ') || '（空）'));
      console.log('来源：' + (Object.entries(t.byImporter).map(([k, v]) => `${k} ${v}`).join(' · ') || '（空）'));
    } else if (sub === 'log') {
      const rows = listTransferLog(db, 20);
      if (rows.length === 0) { console.log(pc.dim('（暂无导出/导入记录）')); return; }
      for (const r of rows) {
        const n = (() => { try { return (JSON.parse(r.session_ids) as string[]).length; } catch { return 0; } })();
        console.log(`${fmtDate(r.created_at)} ${r.type === 'export' ? pc.green('导出') : pc.cyan('导入')} ${n} 会话 · ${r.from_user ?? '-'} → ${r.to_user ?? '-'} · ${r.file_path.split(/[\\/]/).pop()}`);
      }
    } else {
      console.log(pc.red('用法：srelay team status | log'));
      process.exit(2);
    }
  } finally {
    db.close();
  }
}
