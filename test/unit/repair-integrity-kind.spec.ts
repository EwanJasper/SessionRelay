import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { integrityOf, isBusyMessage, isCorruptMessage } from '../../src/core/lifecycle/repair.js';
import { createDb, openReadonly } from '../../src/store/db.js';

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

  // ── [红队 R1] 真损坏最常见的两种形态在 createDb 阶段就抛，以前落进 error ⇒ 永远不修 ──
  it('真损坏的措辞必须识别为 corrupt（否则维修永远不动手）', () => {
    for (const m of [
      'SQLITE_NOTADB: file is not a database',
      'file is not a database',
      'database disk image is malformed',
      'SQLITE_CORRUPT: malformed database schema',
    ]) {
      expect(isCorruptMessage(m), m).toBe(true);
      expect(isBusyMessage(m), m).toBe(false);      // 不许和锁冲突混淆
    }
  });

  it('锁冲突不许被误判成损坏（那是 10-18 事故的反向）', () => {
    for (const m of ['database is locked', 'SQLITE_BUSY', 'database schema is locked']) {
      expect(isBusyMessage(m), m).toBe(true);
      expect(isCorruptMessage(m), m).toBe(false);
    }
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

describe('体检必须用只读连接（2026-10-18 红队 🟡）', () => {
  const mkDb = (dir: string): string => {
    const f = path.join(dir, 'relay.sqlite');
    const db = createDb(f);
    db.close();
    return f;
  };

  it('openReadonly 打开的库真的写不进去', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'srelay-ro-'));
    const f = mkDb(dir);
    const db = openReadonly(f);
    let wrote = false;
    try { db.exec('CREATE TABLE should_not_exist(a)'); wrote = true; } catch { /* 应该抛 */ }
    db.close();
    expect(wrote, '只读连接竟然写成功了 —— 那不是只读').toBe(false);
  });

  it('openReadonly 不创建、不迁移：库文件的 mtime 一个字都不该变', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'srelay-ro2-'));
    const f = mkDb(dir);
    const before = fs.statSync(f).mtimeMs;
    const db = openReadonly(f);
    db.prepare('PRAGMA integrity_check').get();
    db.close();
    expect(fs.statSync(f).mtimeMs, '体检改了库文件的 mtime —— 说明它不是在读，是在写').toBe(before);
  });

  it('integrityOf 对健康库不改 mtime（真体检，不是真写入）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'srelay-ro3-'));
    const f = mkDb(dir);
    const before = fs.statSync(f).mtimeMs;
    const v = integrityOf(f);
    expect(v.ok).toBe(true);
    expect(v.kind).toBe('ok');
    expect(fs.statSync(f).mtimeMs).toBe(before);
  });
});
