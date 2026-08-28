// HOP 导入（方针 §10.5 / 技术方案 §5.3）：
// sha256 全量校验（任一不符整体拒绝）· 归化（T21：project_id 重写为当前项目）·
// 合并规则（同身份同 hash 跳过 / 不同 hash 后缀保留双方）· quarantine 隔离导入 + release 放行
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { DB } from '../store/db.js';
import { insertImportedSession, insertImportedMessage, insertTransferLog, getSessionFull } from '../store/db.js';
import type { RelayConfig } from '../shared/config.js';
import { projectIdOf, relayDir, quarantineDir } from '../shared/paths.js';
import { unpackHop, type HopSessionFile } from './hop.js';
import { sha256Hex } from './redact.js';
import type { StatsCounter } from '../core/stats/counter.js';

export interface ImportResult {
  imported: number;
  skipped: number;
  quarantined: number;
  released: number;
  rejected?: string;
}

function fingerprint(s: HopSessionFile): string {
  return sha256Hex(s.messages.map((m) => `${m.seq}|${m.role}|${m.content}`).join('\n'));
}

export function runImport(opts: {
  root: string; cfg: RelayConfig; db: DB; pkgPath: string;
  from?: string; quarantine?: boolean; stats?: StatsCounter;
}): ImportResult {
  const res: ImportResult = { imported: 0, skipped: 0, quarantined: 0, released: 0 };
  const projectId = opts.cfg.identity.project_id ?? projectIdOf(opts.root);
  const tmpDir = path.join(relayDir(opts.root), 'tmp-import');
  fs.rmSync(tmpDir, { recursive: true, force: true });
  // 含 zip-slip 与 sha256 完整性校验——任一失败整体抛出（方针 §10.4）
  const { manifest, files } = unpackHop(opts.pkgPath, tmpDir);

  const sessionFiles = Object.keys(files).filter((k) => k.startsWith('sessions/') && k.endsWith('.json')).sort();

  if (opts.quarantine) {
    // 隔离导入：只入库 元数据+摘要（可检索），正文暂存，release 后可见（方针 §10.4 反注入）
    const stash = path.join(quarantineDir(opts.root), `${path.basename(opts.pkgPath)}-${Date.now().toString(36)}`);
    for (const key of sessionFiles) {
      const s = JSON.parse(files[key]) as HopSessionFile;
      const rel = path.join(stash, key);
      fs.mkdirSync(path.dirname(rel), { recursive: true });
      fs.writeFileSync(rel, files[key]);
      const { skipped } = insertImportedSession(opts.db, {
        source: s.source, sourceSessionId: s.source_session_id, projectId,
        title: s.title, createdAt: s.created_at, lastEventAt: s.last_event_at,
        messageCount: s.messages.length, topics: s.topics, decisions: s.decisions,
        summaryRule: s.summary_rule, author: s.author,
        importedFrom: opts.from ?? manifest.exported_by, originProject: s.project_id,
        contentHash: fingerprint(s),
        sourceFile: rel, // release 定位用
      });
      if (skipped) res.skipped++; else { res.imported++; res.quarantined++; }
    }
  } else {
    for (const key of sessionFiles) {
      const s = JSON.parse(files[key]) as HopSessionFile;
      const { id, skipped } = insertImportedSession(opts.db, {
        source: s.source, sourceSessionId: s.source_session_id, projectId,
        title: s.title, createdAt: s.created_at, lastEventAt: s.last_event_at,
        messageCount: s.messages.length, topics: s.topics, decisions: s.decisions,
        summaryRule: s.summary_rule, author: s.author,
        importedFrom: opts.from ?? manifest.exported_by, originProject: s.project_id,
        contentHash: fingerprint(s), sourceFile: opts.pkgPath,
      });
      if (skipped) { res.skipped++; continue; }
      for (const m of s.messages) insertImportedMessage(opts.db, id, m);
      res.imported++;
    }
  }

  insertTransferLog(opts.db, 'import', opts.pkgPath, manifest.exported_by, opts.from ?? null, sessionFiles.map((k) => k.replace(/^sessions\/|\.json$/g, '')));
  opts.stats?.increment('import_pkg');
  fs.rmSync(tmpDir, { recursive: true, force: true });
  return res;
}

/** release <id 前缀>：把隔离会话的正文放行入库 */
export function runRelease(opts: { root: string; db: DB; idPrefix: string }): { released: number } {
  const rows = opts.db.prepare('SELECT id, source_file FROM sessions WHERE id LIKE ?').all(opts.idPrefix + '%') as Array<{ id: string; source_file: string | null }>;
  let released = 0;
  for (const row of rows) {
    if (!row.source_file || !fs.existsSync(row.source_file)) continue;
    const s = JSON.parse(fs.readFileSync(row.source_file, 'utf8')) as HopSessionFile;
    for (const m of s.messages) insertImportedMessage(opts.db, row.id, m);
    opts.db.prepare('UPDATE sessions SET source_file = ? WHERE id = ?').run('released:' + row.source_file, row.id);
    const dir = path.dirname(row.source_file);
    fs.rmSync(row.source_file, { force: true });
    try { if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir); } catch { /* 忽略 */ }
    released++;
  }
  return { released };
}
