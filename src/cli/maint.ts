// srelay rebuild + scope pick（欠账补齐）
import readline from 'node:readline/promises';
import { loadConfig } from '../shared/config.js';
import { dbFile } from '../shared/paths.js';
import { openExisting } from '../store/db.js';
import { runRebuild } from '../capture/rebuild.js';
import { saveScopeFile, makeScopeFile, loadScopeFile } from '../core/scope/scopeFile.js';
import { insertScopeLog, listSessions } from '../store/db.js';
import { checkbox } from '@inquirer/prompts';
import { requireRoot, openRelayDb, pc } from './ui.js';

export async function cmdRebuild(opts: { force?: boolean }): Promise<void> {
  const root = requireRoot();
  const cfg = loadConfig(root);
  if (!opts.force && process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const a = await rl.question(pc.yellow('将删除并从源文件全量重建索引（imported 会话保留，旧库存为 .bak）。确认？(y/N) '));
    rl.close();
    if (a.toLowerCase() !== 'y') { console.log('已取消。'); return; }
  } else if (!opts.force) {
    console.log(pc.red('非交互环境需 --force')); process.exit(2);
  }
  try {
    const r = await runRebuild({ root, cfg, force: opts.force });
    console.log(pc.green('✓') + ` 重建完成：从源重摄 ${r.autoSessions} 会话 · 保留 imported ${r.importedPreserved} 个`);
    console.log(pc.dim(`  旧库备份：${r.bakFile}（确认无误后可删）`));
  } catch (e) {
    console.log(pc.red('✗ 重建失败：') + (e as Error).message);
    process.exit(1);
  }
}

/** C 档 TUI（方针 §6.4：仅 fallback，绝不自动弹出）——勾选候选会话生成 sessionIds 谓词 */
export async function cmdScopePick(): Promise<void> {
  const root = requireRoot();
  if (!process.stdin.isTTY) {
    console.log(pc.red('scope pick 需要交互终端。') + pc.dim('非交互场景用：srelay scope set --sessions <ids>'));
    process.exit(2);
  }
  const cfg = loadConfig(root);
  const db = openRelayDb(root);
  try {
    const rows = listSessions(db, { projectId: cfg.identity.project_id ?? root, limit: 25 });
    if (rows.length === 0) { console.log(pc.dim('（暂无候选会话）')); return; }
    const selected = await checkbox({
      message: `勾选本次检索可见的会话（空格选择，回车确认；当前：${loadScopeFile(root)?.mode === 'full' ? 'full' : '谓词'}）`,
      choices: rows.map((r) => ({
        value: r.id,
        name: `${r.created_at.slice(5, 10)} [${r.source}] 「${(r.title ?? r.id).slice(0, 32)}」 ${r.state}`,
        checked: false,
      })),
    });
    if (selected.length === 0) { console.log(pc.dim('未选择，保持现状。')); return; }
    const sf = makeScopeFile({ sessionIds: selected }, { by: 'cli:pick' });
    saveScopeFile(root, sf);
    insertScopeLog(db, 'set', sf.filters, 'cli:pick');
    console.log(pc.green('✓') + ` scope pick：已挂载 ${selected.length} 个会话（srelay scope reset 恢复）`);
  } finally {
    db.close();
  }
}
