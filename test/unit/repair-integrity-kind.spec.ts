import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { integrityOf, isBusyMessage } from '../../src/core/lifecycle/repair.js';

/**
 * 2026-10-18 事故回归：库被别的进程锁着时，integrityOf 必须报 kind='busy'，
 * 绝不能因为"读不到"就说它坏了 —— 旧代码只有一个布尔位，于是两个完好的库
 * （agent1super 57MB / dsh插件记忆 2.3MB）被改名成 .damaged-* 并另建了空库。
 */
describe('库体检 · 「读不了」不许当成「坏了」', () => {
  it('锁冲突的各种措辞都要认出来', () => {
    for (const m of [
      'database is locked',
      'SQLITE_BUSY: database is locked',
      'SQLITE_LOCKED',
      'EBUSY: resource busy or locked',
      'database table is locked',
    ]) expect(isBusyMessage(m), m).toBe(true);
  });

  it('真正损坏的措辞不许被误认成锁冲突', () => {
    for (const m of [
      "database disk image is malformed",
      'file is not a database',
      'SQLITE_CORRUPT',
      'no such table: sessions',
    ]) expect(isBusyMessage(m), m).toBe(false);
  });

  it('库不存在 → kind=missing（该建库，不该"隔离"）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'srelay-int-'));
    try {
      const v = integrityOf(path.join(dir, 'nope.sqlite'));
      expect(v.ok).toBe(false);
      expect(v.kind).toBe('missing');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
