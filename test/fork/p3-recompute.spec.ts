// 审计报告 P3：提取规则版本 + 后台分批重算
// 依据：E:\music player\docs\sessionrelay-审计报告-20261013.md
// 病根：规则改了但历史会话不重算 → 用户观感"修了没用"。
// 这三个不变量必须钉住：
//   ① 版本落后时真的重算了（不是空转）
//   ② 分批可续跑（中断后从头跳过已算的，不重算）
//   ③ 版本已跟上时空转零成本
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { recomputeExtractions, extractVersionOf, EXTRACT_VERSION } from '../../src/capture/recompute.js';
import type { DB } from '../../src/store/db.js';

function seed(db: DB) {
  db.exec(`CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY, source TEXT NOT NULL, source_session_id TEXT NOT NULL,
    project_id TEXT NOT NULL, origin TEXT NOT NULL DEFAULT 'auto',
    state TEXT NOT NULL DEFAULT 'active', git_branch TEXT, title TEXT,
    created_at TEXT NOT NULL, last_event_at TEXT, confirmed_at TEXT, pending_at TEXT,
    message_count INTEGER NOT NULL DEFAULT 0, files_mentioned TEXT, topics TEXT,
    decisions TEXT, key_questions TEXT, code_changes TEXT, summary_rule TEXT,
    summary_ai TEXT, user_summary TEXT, user_tags TEXT, author TEXT,
    imported_from TEXT, origin_project TEXT, content_hash TEXT, source_file TEXT,
    synced_at TEXT, meta_text TEXT, cleanup_at TEXT, original_message_count INTEGER DEFAULT 0
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL,
    content TEXT NOT NULL, search_text TEXT, seq_num INTEGER NOT NULL, created_at TEXT
  )`);
}

function addSession(db: DB, id: string, msgs: Array<[role: string, content: string, seq: number]>, state = 'confirmed') {
  db.prepare(
    `INSERT INTO sessions (id, source, source_session_id, project_id, state, title, created_at, confirmed_at, message_count)
     VALUES (?, 'dsh', ?, 'p', ?, ?, '2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z', ?)`,
  ).run(id, id, state, 'sess-' + id, msgs.length);
  for (const [role, content, seq] of msgs) {
    db.prepare('INSERT INTO messages (session_id, role, content, seq_num) VALUES (?, ?, ?, ?)')
      .run(id, role, content, seq);
  }
}

const decisionsOf = (db: DB, id: string): string[] => {
  const row = db.prepare('SELECT decisions FROM sessions WHERE id = ?').get(id) as { decisions: string | null };
  return row.decisions ? (JSON.parse(row.decisions) as Array<{ text: string }>).map(d => d.text) : [];
};

describe('P3 · 提取规则版本与分批重算', () => {
  let db: DB;
  beforeEach(() => { db = new Database(':memory:') as DB; seed(db); });

  it('① 脏数据 + 版本落后 → 重算清掉转述/词中误命中', () => {
    addSession(db, 's1', [
      ['user', '决定论 规则明确，能算出来 象棋残局这种场景', 1],
      ['user', '我们决定改用 SQLite 做本地索引', 2],
    ]);
    // 预置"旧规则"产物：决定论误命中还在库里
    db.prepare('UPDATE sessions SET decisions = ? WHERE id = ?')
      .run(JSON.stringify([{ text: '决定论 规则明确', seq: 1 }]), 's1');
    expect(decisionsOf(db, 's1')).toContain('决定论 规则明确');

    expect(extractVersionOf(db)).toBe(0);
    const r = recomputeExtractions(db);
    expect(r.recomputed).toBe(1);
    expect(extractVersionOf(db)).toBe(EXTRACT_VERSION);
    // 重算后：误命中消失，真决策保留
    expect(decisionsOf(db, 's1')).not.toContain('决定论 规则明确');
    expect(decisionsOf(db, 's1').some(t => /改用 SQLite/.test(t))).toBe(true);
  });

  it('② 分批可续跑：小 batch 中断后不重算已算过的', () => {
    for (let i = 1; i <= 3; i++) addSession(db, 'b' + i, [['user', `第${i}轮决定采用方案${i}`, 1]]);
    const r1 = recomputeExtractions(db, 2); // 只算 2 个
    expect(r1.recomputed).toBe(2);
    expect(r1.remaining).toBe(1);       // 还剩 1 个
    expect(extractVersionOf(db)).toBe(0); // 没算完不推进版本

    const r2 = recomputeExtractions(db, 2); // 续跑
    expect(r2.recomputed).toBe(1);
    expect(r2.remaining).toBe(0);
    expect(extractVersionOf(db)).toBe(EXTRACT_VERSION); // 全部完成才标版本
    // 三个会话都被正确重算
    expect(decisionsOf(db, 'b1').length).toBe(1);
    expect(decisionsOf(db, 'b3').length).toBe(1);
  });

  it('③ 版本已跟上 → 零成本空转', () => {
    addSession(db, 'c1', [['user', '决定改用方案', 1]]);
    recomputeExtractions(db);
    expect(extractVersionOf(db)).toBe(EXTRACT_VERSION);
    const r = recomputeExtractions(db);
    // [v14] RecomputeResult 增加 failed 计数（提取抛异常被跳过的会话数），行为不变
    expect(r).toEqual({ recomputed: 0, remaining: 0, failed: 0 });
  });

  it('④ 归档会话（cleanup_at 非空）不进重算队列——正文已删，无从重算', () => {
    addSession(db, 'a1', [['user', '决定改用方案', 1]]);
    // 真实归档会清空 message_count（runArchive 删正文后实测 mc=0，线上 160 个归档会话全为 0）；
    // 这里照真实形态同时置两列，避免夹具比量产更宽松而掩盖边界。
    db.prepare("UPDATE sessions SET cleanup_at = '2026-10-03T00:00:00Z', message_count = 0 WHERE id = 'a1'")
      .run();
    const r = recomputeExtractions(db);
    expect(r.recomputed).toBe(0);
    expect(extractVersionOf(db)).toBe(EXTRACT_VERSION); // 无可算 → 直接标完成
  });

  it('⑤ active 会话不重算（还没确认，规则结果会被 judge 覆盖）', () => {
    addSession(db, 'd1', [['user', '决定改用方案', 1]], 'active');
    const r = recomputeExtractions(db);
    expect(r.recomputed).toBe(0);
  });

  it('⑥ 重算不动消息本体（源数据是唯一事实源）', () => {
    addSession(db, 'e1', [['user', '决定改用方案X', 1], ['assistant', '好的', 2]]);
    recomputeExtractions(db);
    const n = (db.prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?').get('e1') as { n: number }).n;
    expect(n).toBe(2);
    const row = db.prepare('SELECT message_count FROM sessions WHERE id = ?').get('e1') as { message_count: number };
    expect(row.message_count).toBe(2);
  });
});

// ── 1014 深夜：progress 游标跨版本复用的静默损坏 ──
// 病根：progress 记的是"已算过几个会话"，但它是在**某个** EXTRACT_VERSION 下累积的。
// 版本 bump 发生在重算中途时，旧游标被当成新版本的进度继续用 → 只重算尾巴就把版本
// 标记成完成，前面几百个会话永远拿着旧规则数据，而元数据说"已是最新"。
// 本机实测中招：版本被打回 0 后游标停在 500，bump 到 v7 后从 500 继续，
// 576 会话的库只重算了 75 个就报完成（doctor 的「提取规则版本」检查也被骗过）。
describe('progress 游标必须与版本配对，否则静默跳过前几百个会话', () => {
  function seedDb(): DB {
    const db = new Database(':memory:') as unknown as DB;
    seed(db);
    return db;
  }

  it('⑦ 版本 bump 后，旧 progress 一律作废重来（不是接着跳', () => {
    const db = seedDb();
    for (let i = 0; i < 6; i++) addSession(db, `s${i}`, [['user', '决定改用方案', 1]]);
    // 第一轮：跑到中途（batch=2），留下 progress
    recomputeExtractions(db, 2);
    const mid = (db.prepare('SELECT progress FROM extract_meta WHERE id = 1').get() as { progress: number }).progress;
    expect(mid).toBeGreaterThan(0);
    // 模拟"版本 bump 但游标还在"：手动把 version 拨回旧值，progress 保留
    db.prepare('UPDATE extract_meta SET version = version - 1, progress_version = version - 1 WHERE id = 1').run();
    const before = countDecisions(db);
    // 再跑：必须从头来，不能从 progress 接着跳
    recomputeExtractions(db, 100);
    const after = countDecisions(db);
    // 6 个会话全部按当前规则重算过（每会话 1 条决策）
    expect(after).toBe(6);
    expect(after).toBeGreaterThanOrEqual(before);
    expect(extractVersionOf(db)).toBe(EXTRACT_VERSION);
  });

  it('⑧ 同版本内 progress 仍然有效（中断后续跑，不重算）', () => {
    const db = seedDb();
    for (let i = 0; i < 6; i++) addSession(db, `t${i}`, [['user', '决定采用方案', 1]]);
    recomputeExtractions(db, 2);
    const p1 = (db.prepare('SELECT progress FROM extract_meta WHERE id = 1').get() as { progress: number }).progress;
    // 同版本续跑：progress 必须被尊重（不归零）
    const r = recomputeExtractions(db, 2);
    const p2 = (db.prepare('SELECT progress FROM extract_meta WHERE id = 1').get() as { progress: number }).progress;
    expect(p2).toBeGreaterThanOrEqual(p1);
    expect(r.recomputed).toBeGreaterThan(0);
  });
});

function countDecisions(db: DB): number {
  const rows = db.prepare('SELECT decisions FROM sessions WHERE decisions IS NOT NULL').all() as Array<{ decisions: string }>;
  let n = 0;
  for (const r of rows) {
    try { n += (JSON.parse(r.decisions) as unknown[]).length; } catch { /* 坏行跳过 */ }
  }
  return n;
}

// ── 1014 红队 F2：游标必须是会话 ID，不能是"已算几个位置" ──
// 位置计数在批次间集合变动时会跳过会话：归档（每小时）/forget/resume 回滚都会让目标集
// 缩小，OFFSET 相对集合过计一格，其后每个未算会话顺移，最后 progressed >= total 提前
// 触发 finishVersion——被跳过的会话永远拿旧规则数据，而 extract_meta 说
// version=N, remaining=0「已是最新」，doctor 的「提取规则版本」检查同样被骗。
// 守护 6 小时一批、554 个目标会话要 72 小时追完，这 72 小时里归档与判定持续改集合。
describe('重算游标：批次间集合变动不能跳过会话', () => {
  function seedDb(): DB {
    const db = new Database(':memory:') as unknown as DB;
    seed(db);
    return db;
  }
  // 造 12 个合规会话（confirmed + 有消息）
  function fill(db: DB, n: number) {
    for (let i = 0; i < n; i++) addSession(db, `s${String(i).padStart(2, '0')}`, [['user', '决定改用方案', 1]]);
  }
  // 把会话踢出目标集：置 cleanup_at 且 message_count=0（模拟 autoArchive 的真实形态）
  function kick(db: DB, id: string) {
    db.prepare("UPDATE sessions SET cleanup_at = '2026-10-14T00:00:00Z', message_count = 0 WHERE id = ?").run(id);
  }

  it('⑦ 已算过的会话离开集合后，后面的会话不被跳过', () => {
    const db = seedDb();
    fill(db, 12);
    // 第一批（batch=4）算 s00..s03 —— 按 id 升序
    recomputeExtractions(db, 4);
    // 归档一个**已算过的**会话 → 目标集从 12 缩到 11，位置游标会从此错位
    kick(db, 's00');
    // 继续跑到完成
    let guard = 0;
    for (;;) {
      const r = recomputeExtractions(db, 4);
      if (r.recomputed === 0 && r.remaining === 0) break;
      if (++guard > 50) throw new Error('未收敛');
    }
    // 11 个仍在集合内的会话必须全部带上 kind（即全部被当前版本规则重算过）
    const rows = db.prepare('SELECT id, decisions FROM sessions WHERE cleanup_at IS NULL AND message_count > 0').all() as Array<{ id: string; decisions: string }>;
    expect(rows.length).toBe(11);
    for (const r of rows) {
      let hasKind = false;
      try { hasKind = (JSON.parse(r.decisions) as Array<{ kind?: string }>).every((d) => typeof d.kind === 'string'); } catch { /* 坏行 */ }
      expect(hasKind, `会话 ${r.id} 未被重算（被游标跳过）`).toBe(true);
    }
    expect(extractVersionOf(db)).toBe(EXTRACT_VERSION);
  });

  it('⑧ 未算过的会话离开集合后，不影响其他会话', () => {
    const db = seedDb();
    fill(db, 12);
    recomputeExtractions(db, 4);
    // 归档一个**还没算到的**会话
    kick(db, 's09');
    let guard = 0;
    for (;;) {
      const r = recomputeExtractions(db, 4);
      if (r.recomputed === 0 && r.remaining === 0) break;
      if (++guard > 50) throw new Error('未收敛');
    }
    const rows = db.prepare('SELECT id, decisions FROM sessions WHERE cleanup_at IS NULL AND message_count > 0').all() as Array<{ id: string; decisions: string }>;
    expect(rows.length).toBe(11);
    for (const r of rows) {
      let hasKind = false;
      try { hasKind = (JSON.parse(r.decisions) as Array<{ kind?: string }>).every((d) => typeof d.kind === 'string'); } catch { /* 坏行 */ }
      expect(hasKind, `会话 ${r.id} 未被重算`).toBe(true);
    }
  });
});
