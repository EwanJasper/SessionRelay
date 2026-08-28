// srelay mode / confirm / purge / stats（方针 §8.1；破坏性操作需确认——友好度红线）
import readline from 'node:readline/promises';
import { setCaptureMode, loadConfig, type CaptureMode } from '../shared/config.js';
import { confirmSession, purgePending, findSessionByPrefix } from '../store/db.js';
import { openStats } from '../core/stats/counter.js';
import { requireRoot, openRelayDb, pc } from './ui.js';

export async function cmdMode(mode: CaptureMode): Promise<void> {
  const root = requireRoot();
  if (!['full', 'meta', 'off'].includes(mode)) {
    console.log(pc.red('✗ 模式必须是 full | meta | off'));
    process.exit(2);
  }
  setCaptureMode(root, mode);
  const hints: Record<CaptureMode, string> = {
    full: '全量捕获（默认）：正文入索引，隐私靠 .sessionrelayignore 硬边界。',
    meta: '只存元数据与统计，不存消息正文（敏感项目推荐）。',
    off: '关闭自动捕获，仅手动 save 入库（最严格）。',
  };
  console.log(pc.green('✓') + ` 捕获模式 → ${mode}\n  ${hints[mode]}`);
  if (mode !== 'off') console.log(pc.dim('  立即生效：srelay sync'));
}

export async function cmdConfirm(idPrefix: string): Promise<void> {
  const root = requireRoot();
  const cfg = loadConfig(root);
  const db = openRelayDb(root);
  try {
    const s = findSessionByPrefix(db, idPrefix, cfg.identity.project_id ?? root);
    if (!s) { console.log(pc.red('✗ 未找到会话：') + idPrefix); return; }
    confirmSession(db, s.id, new Date().toISOString()); // 与 judge 同路：提取元数据 + summary_rule
    const after = findSessionByPrefix(db, s.id, cfg.identity.project_id ?? root);
    console.log(pc.green('✓') + ` 已确认并提取：${s.id} 「${s.title ?? ''}」`);
    if (after?.summary_rule) console.log(pc.dim('  摘要：' + after.summary_rule.split('\n').slice(0, 3).join(' | ')));
  } finally {
    db.close();
  }
}

export async function cmdPurge(opts: { pending?: boolean; yes?: boolean }): Promise<void> {
  if (!opts.pending) {
    console.log(pc.red('✗ 请指定范围：srelay purge --pending（当前仅支持清除未固化会话）'));
    process.exit(2);
  }
  const root = requireRoot();
  const cfg = loadConfig(root);
  const db = openRelayDb(root);
  try {
    const n = purgePending(db, cfg.identity.project_id ?? root);
    if (n === 0) { console.log(pc.dim('没有 pending 会话可清除。')); return; }
    if (!opts.yes && process.stdin.isTTY) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const a = await rl.question(pc.yellow(`将删除 ${n} 个 pending 会话（含消息），确认？(y/N) `));
      rl.close();
      if (a.toLowerCase() !== 'y') { console.log('已取消。'); return; }
    } else if (!opts.yes) {
      console.log(pc.red('非交互环境需加 --yes')); process.exit(2);
    }
    purgePending(db, cfg.identity.project_id ?? root);
    console.log(pc.green('✓') + ` 已清除 ${n} 个 pending 会话。`);
  } finally {
    db.close();
  }
}

export async function cmdStats(opts: { report?: boolean; reset?: boolean; json?: boolean }): Promise<void> {
  const root = requireRoot();
  const stats = openStats(root);
  if (opts.reset) { stats.reset(); console.log(pc.green('✓') + ' 计数器已清零。'); return; }
  if (opts.report) { console.log(stats.reportText()); return; }
  const snap = stats.snapshot();
  if (opts.json) { console.log(JSON.stringify(snap, null, 2)); return; }
  const keys = Object.keys(snap).sort();
  if (keys.length === 0) { console.log(pc.dim('（暂无计数）')); return; }
  console.log('本地匿名计数器（零外呼，可 srelay stats --reset 清零）：');
  for (const k of keys) console.log(`  ${k.padEnd(18)} ${snap[k]}`);
}
