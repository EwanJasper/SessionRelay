import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { shouldReapTmpFile, reapProjectTmpFiles, REAP_DEFAULT_AGE_DAYS } from '../../src/core/maintain/reap.js';
import { createDb, createNoteSession } from '../../src/store/db.js';
import { dbFile } from '../../src/shared/paths.js';

const DAY = 86_400_000;
let dir = '';

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'srelay-reap-'));
  fs.mkdirSync(path.dirname(dbFile(dir)), { recursive: true });
});
afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不影响判据 */ } });

/** 造一个 mtime 在 N 天前的文件（内容无所谓，只看名字/时间/大小）。 */
function makeOldFile(name: string, ageDays: number, bytes = 1024): string {
  const p = path.join(dir, '.sessionrelay', name);
  fs.writeFileSync(p, Buffer.alloc(bytes, 7));
  const t = new Date(Date.now() - ageDays * DAY);
  fs.utimesSync(p, t, t);
  return p;
}

/** 建一个"健康主库"：有 1 条笔记消息（messages>0 是健康门禁的一部分）。 */
function makeHealthyDb(): void {
  const db = createDb(dbFile(dir));
  try { createNoteSession(db, { projectId: 'proj-reap', title: '健康库里的一条笔记', content: '决定保留这条笔记。' }); }
  finally { db.close(); }
}

describe('孤儿备份清理 · 判据 shouldReapTmpFile（唯一一份）', () => {
  it('默认关闭：再老、再像灾难备份也一律不动（用户说「备份先留着」）', () => {
    expect(shouldReapTmpFile('relay.sqlite.damaged-2026-10-16T1737', Date.now() - 100 * DAY, Date.now())).toBe(false);
    expect(shouldReapTmpFile('relay.sqlite.bak-abc', Date.now() - 100 * DAY, Date.now(), { enabled: false })).toBe(false);
  });

  it('显式打开 + 超过默认 30 天，才清三种灾难/临时形态', () => {
    const now = Date.now();
    expect(REAP_DEFAULT_AGE_DAYS).toBe(30);
    expect(shouldReapTmpFile('relay.sqlite.damaged-2026-10-16T1737', now - 40 * DAY, now, { enabled: true })).toBe(true);
    expect(shouldReapTmpFile('relay.sqlite.damaged-2026-10-16T1737-wal', now - 40 * DAY, now, { enabled: true })).toBe(true);
    expect(shouldReapTmpFile('relay.sqlite.bak-abc', now - 40 * DAY, now, { enabled: true })).toBe(true);
    expect(shouldReapTmpFile('foo.tmp', now - 40 * DAY, now, { enabled: true })).toBe(true);
    expect(shouldReapTmpFile('foo.sqlite.tmp-123', now - 40 * DAY, now, { enabled: true })).toBe(true);
    expect(shouldReapTmpFile('relay.sqlite.damaged-x', now - 2 * DAY, now, { enabled: true })).toBe(false);
  });

  it('主库/配置/普通文件一律不动（宁可漏清，不许误删）', () => {
    const now = Date.now();
    const old = now - 100 * DAY;
    for (const name of ['relay.sqlite', 'relay.sqlite-wal', 'relay.sqlite-shm', 'config.json', 'stats.json', 'guard.log', 'notes.md']) {
      expect(shouldReapTmpFile(name, old, now, { enabled: true }), name).toBe(false);
    }
  });

  it('minAgeDays 可调；时间不可信（NaN）一律不动', () => {
    const now = Date.now();
    expect(shouldReapTmpFile('a.tmp', now - 10 * DAY, now, { enabled: true, minAgeDays: 7 })).toBe(true);
    expect(shouldReapTmpFile('a.tmp', now - 3 * DAY, now, { enabled: true, minAgeDays: 7 })).toBe(false);
    expect(shouldReapTmpFile('a.tmp', Number.NaN, now, { enabled: true })).toBe(false);
    expect(shouldReapTmpFile('a.tmp', now - 100 * DAY, Number.NaN, { enabled: true })).toBe(false);
  });
});

describe('孤儿备份清理 · 主库健康门禁 + 审计日志', () => {
  it('默认 enabled=false：只列候选、一个都不删，并说明原因', () => {
    makeHealthyDb();
    const p = makeOldFile('relay.sqlite.damaged-20261016', 40);
    const r = reapProjectTmpFiles(dir, { minAgeDays: 30 });
    expect(r.enabled).toBe(false);
    expect(r.candidates.map((c) => c.name)).toContain('relay.sqlite.damaged-20261016');
    expect(r.deleted.length).toBe(0);
    expect(fs.existsSync(p)).toBe(true);
    expect(r.skipped.some((s) => s.reason.includes('enabled=false'))).toBe(true);
  });

  it('主库健康 + 超过阈值 → 真删，且每个被删文件在 reap.log 里各有一行', () => {
    makeHealthyDb();
    const p1 = makeOldFile('relay.sqlite.damaged-20261016T1737', 40, 2048);
    const p2 = makeOldFile('relay.sqlite.damaged-20261016T1737-wal', 40, 512);
    const r = reapProjectTmpFiles(dir, { enabled: true, minAgeDays: 30 });
    expect(r.health.ok).toBe(true);
    expect(r.deleted.length).toBe(2);
    expect(fs.existsSync(p1)).toBe(false);
    expect(fs.existsSync(p2)).toBe(false);
    const journal = fs.readFileSync(r.journalFile, 'utf8');
    expect(journal).toContain('DELETED');
    expect(journal).toContain('relay.sqlite.damaged-20261016T1737');
    expect(journal.split(/\r?\n/).filter((l) => l.includes('DELETED')).length).toBe(2);
  });

  it('主库坏掉（文件是垃圾）→ 拒绝清理，一个都不删，原因写进 skipped', () => {
    const bad = dbFile(dir);
    fs.writeFileSync(bad, 'this is not a sqlite database');
    const p = makeOldFile('relay.sqlite.damaged-20261016', 40);
    const r = reapProjectTmpFiles(dir, { enabled: true, minAgeDays: 30 });
    expect(r.health.ok).toBe(false);
    expect(r.deleted.length).toBe(0);
    expect(fs.existsSync(p)).toBe(true);
    expect(r.skipped.some((s) => s.reason.includes('主库健康检查未过'))).toBe(true);
  });

  it('主库为空（messages=0）→ 也拒绝清理（重建中的库不许删备份）', () => {
    const db = createDb(dbFile(dir)); db.close();
    const p = makeOldFile('relay.sqlite.damaged-x', 40);
    const r = reapProjectTmpFiles(dir, { enabled: true, minAgeDays: 30 });
    expect(r.health.ok).toBe(false);
    expect(r.deleted.length).toBe(0);
    expect(fs.existsSync(p)).toBe(true);
  });

  it('文件太新不进入候选（默认 30 天）', () => {
    makeHealthyDb();
    const p = makeOldFile('relay.sqlite.damaged-recent', 2);
    const r = reapProjectTmpFiles(dir, { enabled: true, minAgeDays: 30 });
    expect(r.candidates.length).toBe(0);
    expect(r.deleted.length).toBe(0);
    expect(fs.existsSync(p)).toBe(true);
  });
});
