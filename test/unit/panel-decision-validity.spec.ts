import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDb } from '../../src/store/db.js';
import { dbFile } from '../../src/shared/paths.js';
import { decisionKey, markSuperseded } from '../../src/store/decision-validity.js';
import { panelProjectCard } from '../../src/panel/snapshot.js';

/**
 * #2 superseded 读路径 · 面板侧回归。
 *
 * 病历：面板的决策计数走原始 SQL（json_each 数 DISTINCT text），**完全不吃有效性旁表** ——
 * 一条决策被取代后，listDecisions 不再返回它，但面板还照数 ⇒ 两个入口对同一事实给出不同数字，
 * 即"面板在撒谎"的又一种形态（本仓已经因此修过两次计数口径）。
 */
function tmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'srelay-panel-validity-'));
  fs.mkdirSync(path.dirname(dbFile(dir)), { recursive: true });
  const db = createDb(dbFile(dir));
  const decisions = JSON.stringify([
    { text: '旧结论：用 A 方案', seq: 1 },
    { text: '新结论：改用 B 方案', seq: 2 },
    { text: '另一条无关结论', seq: 3 },
  ]);
  db.prepare("INSERT INTO sessions (id, source, source_session_id, project_id, created_at, decisions) VALUES (?,?,?,?,?,?)")
    .run('s1', 'dsh', 'x1', 'proj_t', new Date().toISOString(), decisions);
  return { dir, db };
}

describe('#2 决策失效语义 · 面板计数必须排除被取代的决策', () => {
  it('无旁表记录时全部计入（兼容铁律：不许让老决策凭空消失）', () => {
    const { dir, db } = tmpProject();
    try {
      db.close();
      const card = panelProjectCard(dir);
      expect(card.ok).toBe(true);
      expect(card.decisions).toBe(3);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('标记 superseded 后计数减一（面板与 listDecisions 同口径）', () => {
    const { dir, db } = tmpProject();
    try {
      markSuperseded(db as never, 's1', decisionKey('旧结论：用 A 方案'), decisionKey('新结论：改用 B 方案'));
      db.close();
      const card = panelProjectCard(dir);
      expect(card.ok).toBe(true);
      expect(card.decisions).toBe(2);   // 3 - 1
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('被取代的那条即使文本不同、只要 decisionKey 相同也算同一条（归一化一致性）', () => {
    const { dir, db } = tmpProject();
    try {
      // 全角/大小写/前后空白的差异不应让它变成"另一条"
      markSuperseded(db as never, 's1', decisionKey('  旧结论：用 A 方案  '), decisionKey('新结论：改用 B 方案'));
      db.close();
      const card = panelProjectCard(dir);
      expect(card.decisions).toBe(2);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
