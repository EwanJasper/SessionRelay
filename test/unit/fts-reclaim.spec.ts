import { describe, it, expect } from 'vitest';
import { wasteRatio, shouldReclaim, measureFtsSpace } from '../../src/core/maintain/fts.js';
import { createDb, createNoteSession } from '../../src/store/db.js';
import { dbFile } from '../../src/shared/paths.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MB = 1048576;

describe('空间回收 · 判据（唯一一份：文件 / 内容 的膨胀倍数）', () => {
  it('正常库不动：agent1super 实测 1.74 倍', () => {
    expect(shouldReclaim({ fileBytes: 68.52 * MB, contentBytes: 39.4 * MB, messages: 30983 })).toBe(false);
  });

  it('病态库要回收：E:/work 实测 37 倍（文件 32MB，内容 0.86MB）', () => {
    expect(shouldReclaim({ fileBytes: 32.27 * MB, contentBytes: 0.87 * MB, messages: 902 })).toBe(true);
  });

  it('病态库要回收：小说项目实测 21 倍', () => {
    expect(shouldReclaim({ fileBytes: 14.2 * MB, contentBytes: 0.67 * MB, messages: 310 })).toBe(true);
  });

  it('内容太小的库不参与判断（比值毫无意义，几百字节的新库不该被 VACUUM）', () => {
    expect(shouldReclaim({ fileBytes: 5 * MB, contentBytes: 100, messages: 3 })).toBe(false);
  });

  it('force 无视阈值（给 srelay maintain --fts --force 用）', () => {
    expect(shouldReclaim({ fileBytes: 2 * MB, contentBytes: 1.9 * MB, messages: 500 }, { force: true })).toBe(true);
  });

  it('阈值可调：默认 2.0，调到 5 倍时 1.74 倍仍不动', () => {
    const s = { fileBytes: 68.52 * MB, contentBytes: 39.4 * MB, messages: 30983 };
    expect(wasteRatio(s)).toBeCloseTo(1.74, 1);
    expect(shouldReclaim(s, { ratio: 5 })).toBe(false);
  });
});

describe('空间回收 · 只读测量不写库', () => {
  it('能读出文件与内容体积，且对空库安全（不抛、不返回负值）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'srelay-fts-'));
    try {
      // .sessionrelay 目录不先建出来的话，createDb 会报 unable to open database file
      fs.mkdirSync(path.dirname(dbFile(dir)), { recursive: true });
      const db = createDb(dbFile(dir));
      const st = measureFtsSpace(db as never, dbFile(dir));
      expect(st.fileBytes).toBeGreaterThan(0);          // 空库也有文件（schema + FTS 影子表）
      expect(st.contentBytes).toBe(0);
      expect(st.messages).toBe(0);
      expect(wasteRatio(st)).toBe(0);                    // 内容为 0 时不许除出 Infinity
      expect(shouldReclaim(st)).toBe(false);
      db.close();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  // 回归：修前 contentBytes 恒为 0（列名 sessions.summary 不存在 + length() 数字符不数字节）——
  //   "FTS 空间回收"在真实库上从来没触发过。非空库必须能测出内容体积，且按 UTF-8 字节计。
  it("非空库能测出内容体积（回归：contentBytes 不许恒为 0）", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "srelay-fts2-"));
    try {
      fs.mkdirSync(path.dirname(dbFile(dir)), { recursive: true });
      const db = createDb(dbFile(dir));
      createNoteSession(db, { projectId: "proj-fts", title: "空间回收回归", content: "这是一条中文笔记，用来验证内容体积按 UTF-8 字节统计，而不是恒为 0。" });
      const st = measureFtsSpace(db as never, dbFile(dir));
      expect(st.messages).toBeGreaterThan(0);
      expect(st.contentBytes).toBeGreaterThan(0);
      // 中文字符 1 字 = 3 字节：若仍按字符计，同一句话的体积会显著偏小
      const chars = "这是一条中文笔记，用来验证内容体积按 UTF-8 字节统计，而不是恒为 0。".length;
      expect(st.contentBytes).toBeGreaterThan(chars * 2);
      expect(Number.isFinite(wasteRatio(st))).toBe(true);
      db.close();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
