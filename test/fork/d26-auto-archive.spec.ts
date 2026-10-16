// [fork 1011] D26 自动归档回归锁：双通道窗口（workflow 7d 先行、普通 60d）、
// 保护规则沿用 runArchive、auto_vacuum 一次性启用 + 增量回收。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDb, upsertCapturedSession, insertMessage, confirmSession, countMessages } from '../../src/store/db.js';
import { autoArchiveProject, autoArchivePolicyOf, strengthGateOf, type AutoArchivePolicy } from '../../src/capture/archive.js';
import { EXTRACT_VERSION } from '../../src/core/extract/version.js';

let tmp = '';
let db: ReturnType<typeof createDb>;
const POLICY: AutoArchivePolicy = { hotDays: 60, workflowDays: 7, checkEveryMin: 60 };

const DAY = 86_400_000;
const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY).toISOString();

let seqCounter = 100;
function seed(uuid: string, title: string, opts: {
  origin?: string; state?: string; depth?: number; daysAgo: number; msgs?: number;
}): string {
  const up = upsertCapturedSession(db, {
    source: 'dsh', sourceSessionId: uuid, projectId: 'proj-d26', title,
    createdAt: iso(opts.daysAgo), lastEventAt: iso(opts.daysAgo),
    origin: opts.origin ?? 'auto', state: opts.state ?? 'confirmed',
  });
  const id = up.id;
  db.prepare("UPDATE sessions SET last_event_at = ?, confirmed_at = CASE WHEN ?='confirmed' THEN ? ELSE confirmed_at END WHERE id = ?")
    .run(iso(opts.daysAgo), opts.state ?? 'confirmed', iso(opts.daysAgo), id);
  const n = opts.msgs ?? 3;
  for (let i = 0; i < n; i++) {
    insertMessage(db, { sessionId: id, role: i % 2 ? 'assistant' : 'user', content: `消息 ${i} of ${title}`, seqNum: ++seqCounter, createdAt: iso(opts.daysAgo) });
  }
  db.prepare('UPDATE sessions SET message_count = ? WHERE id = ?').run(n, id);
  // [1017 合并] 自动归档改走 planAging，多了**抽取版本门**：只有"已按当前规则抽取过"的会话
  // 才允许归档正文（否则等于结论还没提炼就先删了原文）。夹具必须显式满足这个前提，
  // 否则测的就不是归档逻辑，而是"版本旧所以全都不动"。
  db.prepare('UPDATE sessions SET extracted_version = ? WHERE id = ?').run(EXTRACT_VERSION, id);
  if ((opts.state ?? 'confirmed') === 'confirmed') confirmSession(db, id, iso(1));
  return id;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'd26-'));
  fs.mkdirSync(path.join(tmp, '.sessionrelay'), { recursive: true });
  process.chdir(tmp);
  db = createDb(path.join(tmp, '.sessionrelay', 'relay.sqlite'));
});
afterEach(() => {
  process.chdir(os.tmpdir());
  try { db.close(); } catch { /* 已关 */ }
  for (let i = 0; i < 3; i++) { try { fs.rmSync(tmp, { recursive: true, force: true }); break; } catch { /* 句柄延迟重试 */ } }
});

describe('fork · D26 自动归档', () => {
  it('双通道分窗：workflow 10d 归档、普通 10d 不动、普通 70d 归档、active 保护', () => {
    const wf = seed('wf-old', 'workflow 十天前', { origin: 'workflow', depth: 1, daysAgo: 10 });
    const hot = seed('hot-recent', '普通十天前', { daysAgo: 10 });
    const old = seed('old-seventy', '普通七十天前', { daysAgo: 70 });
    const act = seed('act-old', '活跃七十天前', { state: 'active', daysAgo: 70 });

    const r = autoArchiveProject(db, POLICY);
    expect(r.workflowArchived).toBe(1);
    expect(r.hotArchived).toBe(1);
    // workflow 10d 已被第一通道归档；普通 10d 留在热层
    const rows = db.prepare("SELECT id, cleanup_at, message_count FROM sessions WHERE source='dsh'").all() as Array<{ id: string; cleanup_at: string | null; message_count: number }>;
    const byId = new Map(rows.map(x => [x.id, x]));
    expect(byId.get(wf)!.cleanup_at).not.toBeNull();
    expect(byId.get(wf)!.message_count).toBe(0);
    expect(byId.get(hot)!.cleanup_at).toBeNull();
    expect(byId.get(old)!.cleanup_at).not.toBeNull();
    expect(byId.get(act)!.cleanup_at).toBeNull();
  });

  it('[1017 合并] 抽取版本门：还没按当前规则抽取过的老会话**不许**归档正文', () => {
    // 这条门是合并新增的（原 autoArchiveProject 只看时间窗）——没有它，一次规则升级后
    // 老会话的正文会先被删，而它们的新结论还没抽出来。
    const stale = seed('stale-version', '七十天前但版本旧', { daysAgo: 70 });
    db.prepare('UPDATE sessions SET extracted_version = ? WHERE id = ?').run(EXTRACT_VERSION - 1, stale);
    const r = autoArchiveProject(db, POLICY);
    expect(r.hotArchived).toBe(0);
    const row = db.prepare('SELECT cleanup_at FROM sessions WHERE id = ?').get(stale) as { cleanup_at: string | null };
    expect(row.cleanup_at).toBeNull();
  });

  it('[1017 合并] 强度门与窗口推导一致（strengthGateOf）', () => {
    // strength = 1 − ageDays/90 ⇒ 窗 30d 对应阈 0.667、窗 90d 对应阈 0（越老越严，两门边界重合）
    expect(strengthGateOf(30)).toBeCloseTo(0.667, 3);
    expect(strengthGateOf(90)).toBe(0);
    // 超过 90 天窗口在数学上会算出负数 → 夹到 0（只有 ≥90d 的会话能过），不许变成"全放行"
    expect(strengthGateOf(120)).toBe(0);
    expect(strengthGateOf(-5)).toBe(1);
  });

  it('审计：cleanup_log triggered_by=auto 且明细逐会话', () => {
    seed('wf-audit', 'workflow 待归档', { origin: 'workflow', depth: 1, daysAgo: 9 });
    autoArchiveProject(db, POLICY);
    const log = db.prepare('SELECT triggered_by, mode, sessions_affected FROM cleanup_log ORDER BY id DESC LIMIT 1').get() as { triggered_by: string; mode: string; sessions_affected: number };
    expect(log.triggered_by).toBe('auto');
    expect(log.mode).toBe('archive');
    expect(log.sessions_affected).toBeGreaterThanOrEqual(1);
  });

  it('auto_vacuum 首跑启用（NONE→INCREMENTAL）且空页回收', () => {
    seed('vac', '填出空页', { daysAgo: 70, msgs: 50 });
    const before = db.pragma('auto_vacuum', { simple: true }) as number;
    expect(before).toBe(0); // 新库默认 NONE
    const r = autoArchiveProject(db, POLICY);
    expect(r.vacuumEnabled).toBe(true);
    expect(db.pragma('auto_vacuum', { simple: true })).toBe(2); // INCREMENTAL 持久生效
    // 二跑不再重复启用
    const r2 = autoArchiveProject(db, POLICY);
    expect(r2.vacuumEnabled).toBe(false);
  });

  it('policy 关闭（enabled:false）→ autoArchivePolicyOf 返回 null；缺省补 60/7/60', () => {
    const cfg = { archive: { enabled: false } } as unknown as Parameters<typeof autoArchivePolicyOf>[0];
    expect(autoArchivePolicyOf(cfg)).toBeNull();
    const cfg2 = {} as unknown as Parameters<typeof autoArchivePolicyOf>[0];
    const pol = autoArchivePolicyOf(cfg2)!;
    expect(pol.hotDays).toBe(60);
    expect(pol.workflowDays).toBe(7);
    expect(pol.checkEveryMin).toBe(60);
  });
});
