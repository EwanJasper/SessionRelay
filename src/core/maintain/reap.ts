// 孤儿备份 / 临时文件清理（空间自愈 · 规则层）
//
// ── 病历（实测，2026-10-18）────────────────────────────────────────────
//   39 MB  E:/music player/.sessionrelay/relay.sqlite.damaged-2026-10-16T1737
//   13 MB  E:/music player/.sessionrelay/relay.sqlite.damaged-2026-10-16T1737-wal
//   36 MB  E:/work/.sessionrelay/relay.sqlite.damaged-2026-10-16T1834
//   主库早就重建好了，这三份灾难备份躺了 2 天、占 88 MB，没有任何机制会清它们。
//   但用户明确说过「备份先留着」⇒ 我们不删任何现有文件，只提供**规则**：
//     · 默认 enabled=false，开关没显式打开时连一个字节都不动；
//     · 只有 *.damaged-* / *.bak-* / *.tmp* 且超过 N 天（默认 30）才进入候选；
//     · **删除前必须确认主库健康**（能打开 + PRAGMA integrity_check=ok + messages>0），
//       否则一份健康的库配着坏掉的"主库"被删掉 = 真丢数据；
//     · 每删一个文件必须写一行审计日志（reap.log）——不许静默删。
//
// 判据只有一份：shouldReapTmpFile()。CLI（srelay maintain --reap）与生命周期都调它。
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { dbFile } from '../../shared/paths.js';

export interface ReapOptions {
  /** 总开关。**默认 false**（用户说过备份先留着）；只有显式打开才可能删 */
  enabled?: boolean;
  /** 多老才清（天）。默认 30 天 */
  minAgeDays?: number;
  /** 只算不删（CLI 干跑 / 生命周期在 enabled=false 时） */
  dryRun?: boolean;
  /** 注入时钟（测试用）；缺省 Date.now() */
  now?: number;
}

export interface ReapCandidate {
  name: string;
  file: string;
  bytes: number;
  ageDays: number;
  /** 命中的命名规则（damaged / bak / tmp）——报告里要能看出"为什么算候选" */
  rule: string;
}

export interface MainDbHealth { ok: boolean; detail: string }

export interface ReapProjectResult {
  root: string;
  enabled: boolean;
  dryRun: boolean;
  health: MainDbHealth;
  /** 扫描的顶层文件数（只在 .sessionrelay 顶层扫，不递归——不碰用户嵌套目录） */
  scanned: number;
  candidates: ReapCandidate[];
  deleted: ReapCandidate[];
  /** 没删的原因（一条都不许无声）：enabled=false / 主库不健康 / 太新 / 删除失败 */
  skipped: Array<{ file: string; reason: string }>;
  /** 审计日志路径（没删任何东西时为空串） */
  journalFile: string;
}

export const REAP_DEFAULT_AGE_DAYS = 30;

/** 命中的命名规则；不命中返回 null。宁可漏清，不许误删。 */
function matchReapRule(name: string): string | null {
  if (/\.damaged-/.test(name)) return 'damaged';
  if (/\.bak-/.test(name)) return 'bak';
  if (/\.tmp(\.|$|-)/.test(name)) return 'tmp';   // foo.tmp / foo.tmp-123 / x.tmp.1 都算（sqlite 临时文件常见）
  return null;
}

/**
 * 判据（唯一一份）：这个名字/时间的文件该不该清。
 *  - enabled 必须显式为 true（默认不删）；
 *  - 时间必须是有限数（时间不可信 → 不动，宁可漏清）；
 *  - 年龄 ≥ minAgeDays（默认 30 天 —— 用户明说备份先留着）；
 *  - 名字命中三种灾难备份/临时形态之一。
 */
export function shouldReapTmpFile(name: string, mtimeMs: number, nowMs: number, opts: ReapOptions = {}): boolean {
  if (opts.enabled !== true) return false;
  if (!Number.isFinite(mtimeMs) || !Number.isFinite(nowMs)) return false;
  const minAge = Number.isFinite(Number(opts.minAgeDays)) ? Number(opts.minAgeDays) : REAP_DEFAULT_AGE_DAYS;
  if (minAge < 0) return false;
  if ((nowMs - mtimeMs) / 86_400_000 < minAge) return false;
  return matchReapRule(name) !== null;
}

/** 主库健康门禁：能打开 + integrity_check 通过 + 消息数 > 0。失败必须给出原因，不许静默放行。 */
export function checkMainDbHealth(root: string): MainDbHealth {
  const f = dbFile(root);
  if (!fs.existsSync(f)) return { ok: false, detail: '主库不存在：' + f };
  let db: InstanceType<typeof Database> | null = null;
  try {
    db = new Database(f, { readonly: true, fileMustExist: true });
    db.pragma('busy_timeout = 3000');
    const ic = String(db.pragma('integrity_check', { simple: true }));
    if (ic !== 'ok') return { ok: false, detail: 'PRAGMA integrity_check=' + ic };
    const n = Number((db.prepare('SELECT count(*) AS c FROM messages').get() as { c?: number } | undefined)?.c ?? 0);
    if (n <= 0) return { ok: false, detail: '主库 messages=0（疑似空库/重建中，不清备份）' };
    return { ok: true, detail: 'integrity_check=ok · messages=' + n };
  } catch (e) {
    return { ok: false, detail: '主库打不开/检查失败：' + String((e as Error)?.message ?? e).slice(0, 160) };
  } finally {
    try { db?.close(); } catch { /* 关不上不影响判定 */ }
  }
}

function formatBytes(n: number): string {
  if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
}

/** 把一次删除/跳过写进 .sessionrelay/reap.log（append-only，一条不落）。 */
function appendJournal(journalFile: string, line: string): void {
  try {
    fs.mkdirSync(path.dirname(journalFile), { recursive: true });
    fs.appendFileSync(journalFile, line + '\n', 'utf8');
  } catch {
    // 日志写不进去是严重问题：上层会把这个文件列进 skipped（不许"删了但没记账"）
    throw new Error('审计日志写不进去：' + journalFile);
  }
}

/** 扫描 + 判定 + （仅在 enabled 且主库健康时）删除。 */
export function reapProjectTmpFiles(root: string, opts: ReapOptions = {}): ReapProjectResult {
  const now = Number.isFinite(opts.now) ? Number(opts.now) : Date.now();
  const enabled = opts.enabled === true;
  const dryRun = opts.dryRun === true || !enabled;
  const dir = path.dirname(dbFile(root));
  const res: ReapProjectResult = {
    root, enabled, dryRun,
    health: { ok: false, detail: '未检查' },
    scanned: 0, candidates: [], deleted: [], skipped: [], journalFile: '',
  };
  if (!fs.existsSync(dir)) return res;
  let names: string[] = [];
  try { names = fs.readdirSync(dir); } catch (e) { res.skipped.push({ file: dir, reason: '目录读不了：' + String((e as Error)?.message ?? e) }); return res; }
  const files: Array<{ name: string; file: string; mtimeMs: number; bytes: number }> = [];
  for (const name of names) {
    const file = path.join(dir, name);
    let st: fs.Stats;
    try { st = fs.statSync(file); } catch { continue; }
    if (!st.isFile()) continue;                 // 只处理普通文件，目录一律不碰
    res.scanned++;
    files.push({ name, file, mtimeMs: st.mtimeMs, bytes: st.size });
  }
  const minAge = Number.isFinite(Number(opts.minAgeDays)) ? Number(opts.minAgeDays) : REAP_DEFAULT_AGE_DAYS;
  for (const f of files) {
    if (!matchReapRule(f.name)) continue;
    if (!shouldReapTmpFile(f.name, f.mtimeMs, now, { ...opts, enabled: true, minAgeDays: minAge })) {
      res.skipped.push({ file: f.file, reason: '太新：' + ((now - f.mtimeMs) / 86_400_000).toFixed(1) + ' 天 < 阈值 ' + minAge + ' 天' });
      continue;
    }
    res.candidates.push({ name: f.name, file: f.file, bytes: f.bytes, ageDays: Math.round(((now - f.mtimeMs) / 86_400_000) * 10) / 10, rule: matchReapRule(f.name) as string });
  }
  if (res.candidates.length === 0) return res;

  // 主库健康门禁：**无论 enabled 与否都检查**（干跑要给用户看"真删的话安不安全"）
  res.health = checkMainDbHealth(root);
  if (!enabled) {
    for (const c of res.candidates) res.skipped.push({ file: c.file, reason: 'enabled=false（默认不删；要清请显式打开）' });
    return res;
  }
  if (!res.health.ok) {
    for (const c of res.candidates) res.skipped.push({ file: c.file, reason: '主库健康检查未过，拒绝清理：' + res.health.detail });
    return res;
  }
  if (opts.dryRun === true) {
    for (const c of res.candidates) res.skipped.push({ file: c.file, reason: 'dry-run：只报告，不删除' });
    return res;
  }

  const journalFile = path.join(dir, 'reap.log');
  res.journalFile = journalFile;
  const stamp = new Date(now).toISOString();
  for (const c of res.candidates) {
    try {
      fs.rmSync(c.file, { force: true });
      res.deleted.push(c);
      appendJournal(journalFile,
        stamp + '  DELETED  ' + c.file + '  ' + formatBytes(c.bytes) + '  age=' + c.ageDays + 'd  rule=' + c.rule
        + '  health=[' + res.health.detail + ']');
    } catch (e) {
      const reason = '删除失败：' + String((e as Error)?.message ?? e);
      res.skipped.push({ file: c.file, reason });
      try {
        appendJournal(journalFile, stamp + '  SKIP  ' + c.file + '  ' + reason + '  health=[' + res.health.detail + ']');
      } catch { /* 日志也写不进去时只能留在 skipped 里，调用方必须打印 */ }
    }
  }
  return res;
}

/** 批量版本（生命周期/CLI 用）：逐项目跑，失败项目也带出来，不吞。 */
export function reapAllProjects(roots: string[], opts: ReapOptions = {}): ReapProjectResult[] {
  return roots.map((r) => {
    try { return reapProjectTmpFiles(r, opts); }
    catch (e) {
      return {
        root: r, enabled: opts.enabled === true, dryRun: opts.dryRun === true || opts.enabled !== true,
        health: { ok: false, detail: '未检查' }, scanned: 0, candidates: [], deleted: [],
        skipped: [{ file: r, reason: '清理过程抛错：' + String((e as Error)?.message ?? e) }], journalFile: '',
      };
    }
  });
}
