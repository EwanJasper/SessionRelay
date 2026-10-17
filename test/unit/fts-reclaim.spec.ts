import { describe, it, expect } from 'vitest';
import { wasteRatio, shouldReclaim, measureFtsSpace } from '../../src/core/maintain/fts.js';
import { createDb } from '../../src/store/db.js';
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
});
