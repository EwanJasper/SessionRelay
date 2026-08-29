// srelay archive（隐私与数据生命周期设计 / 归档方案 v0.2）
// 归档 = 删除正文保留骨架 | 硬删 = 彻底删除 | --history = 查看审计
import readline from 'node:readline/promises';
import { loadConfig } from '../shared/config.js';
import { dbFile } from '../shared/paths.js';
import { openExisting } from '../store/db.js';
import { runArchive, getArchiveHistory, type ArchiveOptions } from '../capture/archive.js';
import { requireRoot, openRelayDb, pc, fmtDate } from './ui.js';

export interface ArchiveFlags {
  days?: string;
  before?: string;
  size?: string;
  source?: string;
  sessions?: string;
  hard?: boolean;
  dryRun?: boolean;
  history?: boolean;
  verbose?: boolean;
  session?: string;
  includeProtected?: boolean;
  json?: boolean;
}

export async function cmdArchive(f: ArchiveFlags): Promise<void> {
  const root = requireRoot();
  const db = openRelayDb(root);
  try {
    // ── 归档历史模式 ──
    if (f.history || f.session) {
      const rows = getArchiveHistory(db, { verbose: f.verbose, sessionId: f.session });
      if (f.json) { console.log(JSON.stringify(rows, null, 2)); return; }
      if (Array.isArray(rows) && rows.length === 0) {
        console.log(pc.dim('（暂无归档记录）'));
        return;
      }
      for (const row of rows as Array<Record<string, unknown>>) {
        const isDetail = 'session_id' in row;
        if (isDetail) {
          console.log(`  会话 ${row.session_id} 「${(row.title as string ?? '').slice(0, 28)}」 · ${row.message_count}msg · 决策 ${row.decision_count} 条`);
        } else {
          console.log(`${fmtDate(row.created_at as string)}  ${row.triggered_by === 'manual' ? '手动' : row.triggered_by} · ${row.mode} · ${row.sessions_affected} 个会话 · 释放 ${(Number(row.bytes_freed) / 1024 / 1024).toFixed(1)}MB`);
          if (f.verbose && Array.isArray(row.details)) {
            for (const d of row.details as Array<Record<string, unknown>>) {
              console.log(`    · ${d.session_id} 「${(d.title as string ?? '').slice(0, 28)}」 · ${d.message_count}msg → 0msg（决策 ${d.decision_count} 条保留）`);
            }
          }
        }
      }
      return;
    }

    // ── 归档执行模式 ──
    if (!f.days && !f.before && !f.size && !f.sessions) {
      console.log(pc.red('用法：srelay archive --days N | --before <date> | --size Nmb | --sessions <ids> | --history'));
      process.exit(2);
    }

    const opts: ArchiveOptions = {
      days: f.days ? Number(f.days) : undefined,
      before: f.before,
      sizeMb: f.size ? parseFloat(f.size.replace(/mb$/i, '')) : undefined,
      source: f.source,
      sessionIds: f.sessions?.split(',').map(s => s.trim()).filter(Boolean),
      hard: f.hard,
      dryRun: f.dryRun,
      includeProtected: f.includeProtected,
    };

    const result = runArchive(db, opts);

    if (f.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    // 预览模式
    if (f.dryRun) {
      console.log(pc.cyan('📊 归档预览'));
      console.log('─'.repeat(50));
      console.log(`将归档 ${result.archived} 个会话，释放约 ${(result.bytesFreed / 1024 / 1024).toFixed(1)} MB`);
      console.log(`跳过 ${result.skipped} 个（保护规则）`);
      if (!f.hard) {
        console.log(pc.dim('  保留：决策 · 话题 · 摘要 · 标题'));
        console.log(pc.dim('  移除：对话正文 · 全文索引'));
      } else {
        console.log(pc.red('  ⚠️ 硬删除模式：所有数据将被彻底删除'));
      }
      console.log(pc.dim('  确认执行请去掉 --dry-run'));
      return;
    }

    // 执行结果
    console.log(pc.green('✓') + ` 归档完成：${result.archived} 个会话 · 释放 ${(result.bytesFreed / 1024 / 1024).toFixed(1)} MB`);
    if (result.skipped > 0) console.log(pc.dim(`  跳过 ${result.skipped} 个（active/imported/note/保留标签）`));
    if (!f.hard) console.log(pc.dim('  可通过 srelay rebuild --force 恢复'));
    if (f.hard) console.log(pc.red('  ⚠️ 硬删除不可恢复（除非源文件还在）'));
  } finally {
    db.close();
  }
}
