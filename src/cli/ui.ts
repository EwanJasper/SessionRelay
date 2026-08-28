// CLI 呈现助手（技术方案 §8）
import pc from 'picocolors';
import { openExisting } from '../store/db.js';
import type { DB } from '../store/db.js';
import { findRelayRoot, dbFile } from '../shared/paths.js';

export { pc };

export function die(msg: string, hint?: string): never {
  console.error(pc.red('✗ ') + msg);
  if (hint) console.error(pc.dim('  下一步：' + hint));
  process.exit(1);
}

export function requireRoot(): string {
  const root = findRelayRoot(process.cwd());
  if (!root) die('未找到 .sessionrelay（本项目尚未初始化）', '在项目根目录运行 srelay init');
  return root;
}

export function openRelayDb(root: string): DB {
  return openExisting(dbFile(root));
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function stateBadge(s: string): string {
  if (s === 'confirmed') return pc.green('confirmed');
  if (s === 'pending_end') return pc.yellow('pending');
  return pc.cyan('active');
}
