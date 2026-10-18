// [1015 债务1 回归] HOP 必须保住决策的用户态字段：pinned（置顶）与 kind（ADR-001 否定性决策）。
//
// 病历：`export.ts` 生成 metadata/decisions.json 时用的是**白名单投影**，把这两个字段悄悄吃掉；
// 同时 hop.ts / db.ts 的类型声明里也没有它们（运行时靠 `...d` 展开侥幸活着）。于是导出→导入后：
//   · 用户 `srelay pin` 过的决策丢掉置顶 → 不再豁免 48h 窗、不再排在简报第一位
//   · negative 退化成普通 decision → 简报里"改用 Y"与"采用 Y"重新变得不可分辨（ADR-001 白做）
//
// 这条测试是**双向**的：既要断言"有值就带过去"，也要断言"没有就不凭空造字段"（向后兼容老包）。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import { createDb, insertSession, insertMessage, confirmSession, getSessionFull } from '../../src/store/db.js';
import { defaultConfig, saveConfig } from '../../src/shared/config.js';
import { dbFile, projectIdOf } from '../../src/shared/paths.js';
import { runExport } from '../../src/relay/export.js';
import { runImport } from '../../src/relay/import.js';

const TMP = path.resolve('test/.tmp/hop-pinned');
const PROJ = path.join(TMP, 'p');
const PID = projectIdOf(PROJ);
const PKG = path.join(TMP, 'x.hop');
const SID = 'pin100000000000001';

beforeAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(path.join(PROJ, '.sessionrelay'), { recursive: true });
  saveConfig(PROJ, { ...defaultConfig(), identity: { project_id: PID, author: '张三' } });
  const db = createDb(dbFile(PROJ));
  insertSession(db, { id: SID, source: 'zcode', sourceSessionId: 's1', projectId: PID, createdAt: '2026-10-01T00:00:00Z', title: '存储选型' });
  insertMessage(db, { sessionId: SID, role: 'user', content: '存储怎么选？', seqNum: 1, createdAt: '2026-10-01T00:00:00Z' });
  insertMessage(db, { sessionId: SID, role: 'assistant', content: '决定改用 node:sqlite 直查 SQL', seqNum: 2, createdAt: '2026-10-01T00:05:00Z' });
  confirmSession(db, SID, '2026-10-01T01:00:00Z');
  // 直接写用户的置顶与负标记（等价于 srelay pin 与 ADR-001 的抽取结果）
  db.prepare('UPDATE sessions SET decisions = ? WHERE id = ?').run(JSON.stringify([
    { at: '2026-10-01T00:05:00Z', text: '决定改用 node:sqlite 直查 SQL', seq: 2, pinned: true },
    { at: '2026-10-01T00:06:00Z', text: '弃用位置 OFFSET 游标', seq: 3, kind: 'negative' },
    { at: '2026-10-01T00:07:00Z', text: '统一走 extractForWrite', seq: 4 },
  ]), SID);
  db.close();
});
afterAll(() => { fs.rmSync(TMP, { recursive: true, force: true }); });

describe('[债务1] HOP 保住 pinned 与 kind', () => {
  it('导出包内 sessions/<id>.json 与 metadata/decisions.json 都带 pinned / kind', () => {
    const db = createDb(dbFile(PROJ));
    runExport({ root: PROJ, cfg: { ...defaultConfig(), identity: { project_id: PID, author: '张三' } }, db, all: true, noRedact: true, output: PKG });
    db.close();
    const raw = unzipSync(new Uint8Array(fs.readFileSync(PKG)));
    const sess = JSON.parse(strFromU8(raw['sessions/' + SID + '.json']));
    const meta = JSON.parse(strFromU8(raw['metadata/decisions.json']));

    const sw = sess.decisions.find((d: any) => d.text.includes('node:sqlite'));
    expect(sw.pinned).toBe(true);
    const neg = sess.decisions.find((d: any) => d.text.includes('OFFSET'));
    expect(neg.kind).toBe('negative');
    // 没标的决策不许凭空长出字段（向后兼容）
    const plain = sess.decisions.find((d: any) => d.text.includes('extractForWrite'));
    expect(plain).not.toHaveProperty('pinned');
    expect(plain).not.toHaveProperty('kind');

    // 汇总投影：以前就是这里把两个字段吃掉的
    const mSw = meta.find((d: any) => d.text.includes('node:sqlite'));
    expect(mSw.pinned).toBe(true);
    const mNeg = meta.find((d: any) => d.text.includes('OFFSET'));
    expect(mNeg.kind).toBe('negative');
    const mPlain = meta.find((d: any) => d.text.includes('extractForWrite'));
    expect(mPlain).not.toHaveProperty('pinned');
  });

  it('导入到另一个项目后，decisions 列里 pinned / kind 原样保留', () => {
    const dst = createDb(':memory:');
    runImport({ root: PROJ, cfg: { ...defaultConfig(), identity: { project_id: PID } }, db: dst, pkgPath: PKG });
    const row = dst.prepare('SELECT decisions FROM sessions WHERE source_session_id = ?').get('s1') as { decisions: string };
    const decs = JSON.parse(row.decisions) as Array<any>;
    expect(decs.find((d) => d.text.includes('node:sqlite')).pinned).toBe(true);
    expect(decs.find((d) => d.text.includes('OFFSET')).kind).toBe('negative');
    dst.close();
  });
});
