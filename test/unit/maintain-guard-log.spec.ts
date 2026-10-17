import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseGuardSamples, analyzeGuardGaps, analyzeGuardLog, analyzeProjectGuard,
  countBackfillMessages, formatGapAlert, formatStamp, guardLogFile,
} from '../../src/core/maintain/guard-log.js';
import { createDb, createNoteSession } from '../../src/store/db.js';
import { dbFile } from '../../src/shared/paths.js';

const DAY = 86_400_000;
let dir = '';

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'srelay-guardlog-'));
  fs.mkdirSync(path.dirname(dbFile(dir)), { recursive: true });
});
afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不影响判据 */ } });

const LOG = [
  '2026-10-18 01:00  instances=1/1  fork=OK (0.5.1-fork.1)',
  '2026-10-18 01:00  dashboards=3/3',
  '2026-10-18 02:00  instances=0/1  fork=OK (0.5.1-fork.1)',
  '2026-10-18 02:00  instances=0/1  fork=OK (0.5.1-fork.1)',
  '2026-10-18 02:30  instances=0/1  fork=OK (0.5.1-fork.1)',
  '2026-10-18 03:00  instances=1/1  fork=OK (0.5.1-fork.1)',
  '2026-10-18 03:10  instances=0/1  fork=OK (0.5.1-fork.1)',
].join('\n');

describe('守护断线核算 · 解析与区间合成', () => {
  it('只认 instances= 行（dashboards 等行忽略），并按时间排序', () => {
    const s = parseGuardSamples(LOG);
    expect(s.length).toBe(6);
    expect(s[0].instances).toBe(1);
    expect(s.every((x) => /instances=/.test(x.raw))).toBe(true);
  });

  it('连续 0 合成一个区间；恢复点取第一个 >0 样本；末尾未恢复按 now 算', () => {
    const samples = parseGuardSamples(LOG);
    const now = new Date(2026, 9, 18, 3, 40).getTime();   // 2026-10-18 03:40 本地
    const a = analyzeGuardGaps(samples, { alarmMinutes: 5, nowMs: now });
    expect(a.gaps.length).toBe(2);
    expect(a.gaps[0].closed).toBe(true);
    expect(a.gaps[0].minutes).toBe(60);                  // 02:00 → 03:00
    expect(a.gaps[1].closed).toBe(false);
    expect(a.gaps[1].minutes).toBe(30);                  // 03:10 → 03:40
    expect(a.alarming.length).toBe(2);                   // 阈值 5 分钟
  });

  it('阈值可调：90 分钟时 60/30 都不算报警', () => {
    const samples = parseGuardSamples(LOG);
    const now = new Date(2026, 9, 18, 3, 40).getTime();
    const a = analyzeGuardGaps(samples, { alarmMinutes: 90, nowMs: now });
    expect(a.gaps.length).toBe(2);
    expect(a.alarming.length).toBe(0);
  });

  it('没有断线记录 → 空区间集（不报假警）', () => {
    const a = analyzeGuardLog(dir, { nowMs: Date.now() });
    expect(a.exists).toBe(false);
    expect(a.analysis.gaps.length).toBe(0);
  });

  it('报警行文案包含 起始→结束 / 时长 / 补采 三段', () => {
    const samples = parseGuardSamples(LOG);
    const now = new Date(2026, 9, 18, 3, 40).getTime();
    const gap = analyzeGuardGaps(samples, { alarmMinutes: 5, nowMs: now }).gaps[0];
    const line = formatGapAlert(gap, null, now);
    expect(line).toContain('[lifecycle] gap=2026-10-18 02:00→2026-10-18 03:00');
    expect(line).toMatch(/1\.0h|60min/);   // 60 分钟按小时展示（1.0h），文案只要求能看出时长
    expect(line).toContain('补采=未知');
    expect(formatGapAlert(gap, 0, now)).toContain('补采=未见');
    expect(formatGapAlert(gap, 7, now)).toContain('补采=是：窗口内 7 条消息已入库');
  });
});

describe('守护断线核算 · 补采判定 + 回写 guard.log', () => {
  function makeDbWithMessageInside(fromMs: number, toMs: number): void {
    const db = createDb(dbFile(dir));
    try {
      const sid = createNoteSession(db, { projectId: 'proj-guard', title: '断线期间的一条', content: '这是一条消息。' });
      db.prepare('UPDATE messages SET created_at = ? WHERE session_id = ?')
        .run(new Date((fromMs + toMs) / 2).toISOString(), sid);
    } finally { db.close(); }
  }

  it('窗口内消息条数：命中 / 不命中 / 主库坏掉=null（不许猜）', () => {
    const from = Date.now() - 2 * 3600_000;
    const to = Date.now() - 1 * 3600_000;
    makeDbWithMessageInside(from, to);
    expect(countBackfillMessages(dir, from, to)).toBe(1);
    expect(countBackfillMessages(dir, to, to + 3600_000)).toBe(0);
    fs.rmSync(dbFile(dir), { force: true });
    fs.writeFileSync(dbFile(dir), 'garbage');
    expect(countBackfillMessages(dir, from, to)).toBeNull();
  });

  it('analyzeProjectGuard --append：超阈值区间写进 guard.log，重复调用不重复写', () => {
    const now = Date.now();
    const start = now - 3 * 3600_000;
    const end = now - 2 * 3600_000;
    const logPath = guardLogFile(dir);
    fs.writeFileSync(logPath, [
      formatStamp(start) + '  instances=0/1  fork=OK (x)',
      formatStamp(end) + '  instances=1/1  fork=OK (x)',
    ].join('\n') + '\n', 'utf8');
    makeDbWithMessageInside(start, end);

    const r1 = analyzeProjectGuard(dir, { alarmMinutes: 5, nowMs: now, append: true });
    expect(r1.analysis.gaps.length).toBe(1);
    expect(r1.appended.length).toBe(1);
    expect(r1.backfill[0].messages).toBe(1);
    expect(fs.readFileSync(logPath, 'utf8')).toContain('[lifecycle] gap=');
    expect(fs.readFileSync(logPath, 'utf8')).toContain('补采=是：窗口内 1 条消息已入库');

    const r2 = analyzeProjectGuard(dir, { alarmMinutes: 5, nowMs: now, append: true });
    expect(r2.appended.length).toBe(0);                                  // 去重：不重复刷日志
  });

  it('未超阈值不写任何东西（报警阈值生效）', () => {
    const now = Date.now();
    const start = now - 3 * 60_000;
    const end = now - 1 * 60_000;
    const logPath = guardLogFile(dir);
    fs.writeFileSync(logPath, [
      formatStamp(start) + '  instances=0/1  fork=OK (x)',
      formatStamp(end) + '  instances=1/1  fork=OK (x)',
    ].join('\n') + '\n', 'utf8');
    const r = analyzeProjectGuard(dir, { alarmMinutes: 10, nowMs: now, append: true });
    expect(r.analysis.gaps.length).toBe(1);
    expect(r.appended.length).toBe(0);
    expect(fs.readFileSync(logPath, 'utf8')).not.toContain('[lifecycle]');
  });
});
