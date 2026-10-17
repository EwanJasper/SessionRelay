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

/** 会话结构不合法（写入**之前**就抛：库里一条不留） */
export class ImportValidationError extends Error {}

interface ParsedSession { key: string; session: HopSessionFile }

/** 单个会话文件的结构校验（返回 null = 合格）。字段白名单以 hop/1.0 为界，不做"多余字段"判断。 */
function validateSession(s: HopSessionFile): string | null {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return '不是对象';
  if (typeof s.source !== 'string' || s.source === '') return '缺 source';
  if (typeof s.source_session_id !== 'string' || s.source_session_id === '') return '缺 source_session_id';
  if (typeof s.created_at !== 'string' || s.created_at === '') return '缺 created_at';
  if (!Array.isArray(s.messages)) return 'messages 不是数组';
  for (let i = 0; i < s.messages.length; i++) {
    const m = s.messages[i] as unknown as Record<string, unknown>;
    if (!m || typeof m !== 'object') return `messages[${i}] 不是对象`;
    if (typeof m.seq !== 'number' || !Number.isFinite(m.seq)) return `messages[${i}].seq 不是数字`;
    if (typeof m.role !== 'string') return `messages[${i}].role 不是字符串`;
    if (typeof m.content !== 'string') return `messages[${i}].content 不是字符串`;
  }
  if (s.decisions !== undefined && !Array.isArray(s.decisions)) return 'decisions 不是数组';
  if (s.questions !== undefined && !Array.isArray(s.questions)) return 'questions 不是数组';
  if (s.topics !== undefined && !Array.isArray(s.topics)) return 'topics 不是数组';
  if (s.files !== undefined && !Array.isArray(s.files)) return 'files 不是数组';
  return null;
}

/**
 * 写入**之前**把所有会话文件验完（[1021 审查 #10]）。
 *
 * 病历：原先边解析边逐条写库，第二条坏（messages: null）时抛异常，第一条**已经提交**——
 * 调用方收到"失败"，库里却多了半包数据，而且没有任何回滚点。
 * 现在：解析 + 结构校验整批先跑；一条不合格就抛出（带文件名），库里一条不写。
 */
function parseSessions(files: Record<string, string>, keys: string[]): ParsedSession[] {
  const out: ParsedSession[] = [];
  const problems: string[] = [];
  for (const key of keys) {
    let s: HopSessionFile;
    try {
      s = JSON.parse(files[key]) as HopSessionFile;
    } catch (e) {
      problems.push(key + '：JSON 解析失败（' + String((e as Error)?.message ?? e).slice(0, 80) + '）');
      continue;
    }
    const bad = validateSession(s);
    if (bad) problems.push(key + '：' + bad);
    else out.push({ key, session: s });
  }
  if (problems.length > 0) {
    throw new ImportValidationError(
      '包内会话结构不合法，**未写入任何数据**：\n  ' + problems.slice(0, 8).join('\n  ')
      + (problems.length > 8 ? `\n  （另有 ${problems.length - 8} 个文件同样不合格）` : ''),
    );
  }
  return out;
}

function fingerprint(s: HopSessionFile): string {
  return sha256Hex(s.messages.map((m) => `${m.seq}|${m.role}|${m.content}`).join('\n'));
}

/** [1021 红队 R13] HOP 包里的 `msgId` 是**导出方库**的 `messages.id`（自增主键），
 *  导进本库后指向不存在的消息。原样照搬的后果：读取端"有 msgId 但查不到" ⇒ 误报
 *  "原文已归档"。所以导入时一律剥掉；`seq` 是包内自带、导入后仍成立，读取端会以
 *  via='seq' 的方式回落（并且**把这个回落计数打出来**，不留痕的回落就是 R13 的半修）。
 *  question 侧同理，虽然当前导入不写 key_questions，先备好不吃亏。 */
function withoutForeignMsgIds<T>(arr: T[] | undefined): T[] {
  return (arr ?? []).map((item) => {
    const copy = { ...(item as unknown as Record<string, unknown>) };
    delete copy.msgId;
    return copy as unknown as T;
  });
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
  // ① 结构校验**整批先跑**：任何一条不合格 → 抛 ImportValidationError，库里一条不写（#10）
  const parsed = parseSessions(files, sessionFiles);

  // ② 隔离包先暂存到 quarantine 目录（stash 写失败也要清干净，别留半包文件）
  const stash = opts.quarantine
    ? path.join(quarantineDir(opts.root), `${path.basename(opts.pkgPath)}-${Date.now().toString(36)}`)
    : null;
  let stashWritten = false;
  try {
    if (stash) {
      for (const p of parsed) {
        const rel = path.join(stash, p.key);
        fs.mkdirSync(path.dirname(rel), { recursive: true });
        fs.writeFileSync(rel, files[p.key]);
      }
      stashWritten = true;
    }

    // ③ 全部写库动作放进**一个事务**：要么整包落地，要么一条不留（#10）
    const writeAll = opts.db.transaction(() => {
      for (const p of parsed) {
        const s = p.session;
        const { id, skipped } = insertImportedSession(opts.db, {
          source: s.source, sourceSessionId: s.source_session_id, projectId,
          title: s.title, createdAt: s.created_at, lastEventAt: s.last_event_at ?? null,
          messageCount: s.messages.length, topics: s.topics ?? [], decisions: withoutForeignMsgIds(s.decisions),
          summaryRule: s.summary_rule ?? null, author: s.author ?? null,
          importedFrom: opts.from ?? manifest.exported_by, originProject: s.project_id,
          contentHash: fingerprint(s),
          // 隔离：#12 —— 让会话以 state='quarantine' 落库，决策/未决视图据此排除；
          //       release 时再改回 confirmed（见 runRelease）。
          quarantined: opts.quarantine === true,
          sourceFile: stash ? path.join(stash, p.key) : opts.pkgPath, // release 定位用
        });
        if (skipped) { res.skipped++; continue; }
        if (opts.quarantine) { res.imported++; res.quarantined++; continue; } // 正文留在暂存目录，release 才入库
        for (const m of s.messages) insertImportedMessage(opts.db, id, m);
        res.imported++;
      }
      insertTransferLog(opts.db, 'import', opts.pkgPath, manifest.exported_by, opts.from ?? null, sessionFiles.map((k) => k.replace(/^sessions\/|\.json$/g, '')));
    });
    writeAll();
  } catch (e) {
    // 失败清理：暂存目录、临时解包目录都要抹掉（容错不许静默：清理失败也要说出来）
    if (stash && stashWritten) {
      try { fs.rmSync(stash, { recursive: true, force: true }); }
      catch (ce) { console.warn('[import] 暂存目录清理失败（可手工删）：' + stash + ' —— ' + String((ce as Error)?.message ?? ce).slice(0, 100)); }
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw e;
  }

  opts.stats?.increment('import_pkg');
  fs.rmSync(tmpDir, { recursive: true, force: true });
  return res;
}

/**
 * release <id 前缀>：把隔离会话放行入库（[1021 审查 #12] 配套）。
 *
 * 两件事必须一起做，否则"放行"是假的：
 *   ① 正文入库（原行为）；
 *   ② **state 改回 'confirmed' + 写 confirmed_at** —— 隔离态现在是 state='quarantine'，
 *      而 listDecisions/listUnresolved 按它排除；只改 source_file 的话，放行后决策**永远不可见**
 *      （lead 实测发现，报告没提到这一条）。
 */
export function runRelease(opts: { root: string; db: DB; idPrefix: string }): { released: number; skipped: Array<{ id: string; why: string }> } {
  // 只放行**隔离态**的会话：以前按 id 前缀无条件扫，normal 会话（source_file 指向包文件）也会被"放行"一次
  const rows = opts.db.prepare("SELECT id, source_file FROM sessions WHERE id LIKE ? AND state = 'quarantine'")
    .all(opts.idPrefix + '%') as Array<{ id: string; source_file: string | null }>;
  let released = 0;
  const skipped: Array<{ id: string; why: string }> = [];
  const tx = opts.db.transaction(() => {
    for (const row of rows) {
      if (!row.source_file || !fs.existsSync(row.source_file)) { skipped.push({ id: row.id, why: '暂存文件不存在（可能已放行或被清理）' }); continue; }
      let s: HopSessionFile;
      try {
        s = JSON.parse(fs.readFileSync(row.source_file, 'utf8')) as HopSessionFile;
      } catch (e) {
        skipped.push({ id: row.id, why: '暂存文件解析失败：' + String((e as Error)?.message ?? e).slice(0, 80) });
        continue;
      }
      const bad = validateSession(s);
      if (bad) { skipped.push({ id: row.id, why: '暂存会话结构不合法：' + bad }); continue; }
      for (const m of s.messages) insertImportedMessage(opts.db, row.id, m);
      opts.db.prepare("UPDATE sessions SET source_file = ?, state = 'confirmed', confirmed_at = ? WHERE id = ?")
        .run('released:' + row.source_file, new Date().toISOString(), row.id);
      released++;
    }
  });
  tx();
  // 文件清理放在事务之后：先保证"库里已放行"，再删暂存副本（删失败也不影响数据正确性）
  for (const row of rows) {
    if (!row.source_file || !fs.existsSync(row.source_file)) continue;
    if (skipped.some((s) => s.id === row.id)) continue; // 没放行的别删，留给人工排查
    const dir = path.dirname(row.source_file);
    try { fs.rmSync(row.source_file, { force: true }); } catch (e) {
      console.warn('[release] 暂存文件删除失败（库已放行，可手工删）：' + row.source_file + ' —— ' + String((e as Error)?.message ?? e).slice(0, 80));
    }
    try { if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir); } catch { /* 非空 = 还有别的会话在隔离，正常 */ }
  }
  return { released, skipped };
}
