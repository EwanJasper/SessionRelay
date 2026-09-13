// v5 迁移：清 zcode 游标（游标竞态修复后的历史数据自愈）
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createDb, openExisting } from '../../src/store/db.js';

describe('schema v5 迁移 · zcode 游标重置', () => {
  it('M1 v4 库打开时清空 zcode source_files 游标，其他源保留', () => {
    const f = path.resolve('test/.tmp/mig-v5/relay.sqlite');
    fs.rmSync(path.dirname(f), { recursive: true, force: true });
    fs.mkdirSync(path.dirname(f), { recursive: true });
    // 造 v4 库：zcode + claude-code 两条游标
    const db = createDb(f);
    db.pragma('user_version = 4'); // 模拟 0.4.4 库
    db.prepare("INSERT INTO source_files (source, file_path, cursor, last_seen) VALUES ('zcode', 'zcode:sess_x', '{\"rowid\":36822}', ?)")
      .run(new Date().toISOString());
    db.prepare("INSERT INTO source_files (source, file_path, cursor, last_seen) VALUES ('claude-code', 'D:/x/a.jsonl', '{\"offset\":100}', ?)")
      .run(new Date().toISOString());
    db.close();
    // 打开：迁移自动跑
    const db2 = openExisting(f);
    expect(db2.pragma('user_version', { simple: true })).toBe(5);
    expect((db2.prepare("SELECT COUNT(*) n FROM source_files WHERE source = 'zcode'").get() as { n: number }).n).toBe(0);
    expect((db2.prepare("SELECT COUNT(*) n FROM source_files WHERE source = 'claude-code'").get() as { n: number }).n).toBe(1);
    db2.close();
    fs.rmSync(path.dirname(f), { recursive: true, force: true });
  });
});
