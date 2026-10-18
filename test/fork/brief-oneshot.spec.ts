// [1015 夜 · A] `srelay brief` 一次取全 + `listRecentFiles` 的口径钉死
//
// 为什么值得单测：这个命令的**唯一价值是与两条老命令逐字段一致**——一键取数只要有一处口径漂了
// （截断方向、保质期、去重、排序），客户端就会拿到和以前不一样的简报，而且是静默的。
// 所以这里不测「能不能跑」，测**口径**。
//
// 另有一条钉子：`recentFiles[].decisions` 是**这些会话的决策总数**（不是这个文件的），
// 同一批会话里的文件必然同值。1015 夜体检确认它没有判别力、已从简报显示里撤掉，
// 只保留作并列排序用——把它钉在这里，免得将来有人顺手又当成「每文件计数」显示出去。
import { describe, it, expect } from 'vitest';
import { createDb, listRecentFiles } from '../../src/store/db.js';
import type { DB } from '../../src/store/db.js';
import { collectBrief } from '../../src/cli/brief.js';

const NOW = Date.now();
const iso = (daysAgo: number) => new Date(NOW - daysAgo * 86_400_000).toISOString();

interface SeedRow { id: string; files: string[]; decs?: Array<{ text: string; seq: number; at?: string }>; qs?: Array<{ q: string; unresolved: boolean; at?: string }>; lastEventAt?: string }

function seed(rows: SeedRow[]): DB {
  const db = createDb(':memory:') as unknown as DB;
  const stmt = db.prepare(`INSERT INTO sessions (id, source, source_session_id, project_id, state, title, created_at, last_event_at, message_count, files_mentioned, decisions, key_questions)
    VALUES (?, 'zcode', ?, 'p', 'confirmed', 't', ?, ?, 3, ?, ?, ?)`);
  rows.forEach((r, i) => stmt.run(r.id, 's' + i, iso(1), r.lastEventAt ?? iso(1), JSON.stringify(r.files), JSON.stringify(r.decs ?? []), JSON.stringify(r.qs ?? [])));
  return db;
}

const dec = (text: string, seq: number, daysAgo = 1) => ({ text, seq, at: iso(daysAgo) });

describe('[A] listRecentFiles 口径', () => {
  it('① 至少 2 场会话才列；只出现一次的不算反复在动', () => {
    const db = seed([
      { id: 'a100000000000001', files: ['src/hot.ts', 'src/cold.ts'] },
      { id: 'a100000000000002', files: ['src/hot.ts'] },
    ]);
    const out = listRecentFiles(db, { days: 7, top: 5 });
    expect(out.map((x) => x.file)).toEqual(['src/hot.ts']);
    expect(out[0].sessions).toBe(2);
    db.close();
  });

  it('② 到处都出现的文件被剔除（AGENTS.md / config.json / progress.md）', () => {
    const db = seed([
      { id: 'b100000000000001', files: ['AGENTS.md', 'config.json', 'progress.md', 'src/keep.ts'] },
      { id: 'b100000000000002', files: ['AGENTS.md', 'config.json', 'progress.md', 'src/keep.ts'] },
    ]);
    expect(listRecentFiles(db, { days: 7, top: 5 }).map((x) => x.file)).toEqual(['src/keep.ts']);
    db.close();
  });

  it('③ 窗口外的会话不算（30 天前动过的不进这一行）', () => {
    const db = seed([
      { id: 'c100000000000001', files: ['src/old.ts'], lastEventAt: iso(30) },
      { id: 'c100000000000002', files: ['src/old.ts'], lastEventAt: iso(30) },
    ]);
    expect(listRecentFiles(db, { days: 7, top: 5 })).toEqual([]);
    db.close();
  });

  it('④ 会话数降序；并列时 decisions 是这些会话的决策总数（同批会话里的文件必然同值）', () => {
    const db = seed([
      { id: 'd100000000000001', files: ['src/a.ts', 'src/b.ts'], decs: [dec('一', 1), dec('二', 2)] },
      { id: 'd100000000000002', files: ['src/a.ts', 'src/b.ts'], decs: [dec('三', 1)] },
      { id: 'd100000000000003', files: ['src/a.ts'] },
    ]);
    const out = listRecentFiles(db, { days: 7, top: 5 });
    expect(out.map((x) => x.file)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(out[0].sessions).toBe(3);
    expect(out[1].sessions).toBe(2);
    // 这就是体检发现的那个没有判别力的数：b 只有 2 场会话，却拿到和 a 同一批会话的总和 3
    expect(out[1].decisions).toBe(3);
    db.close();
  });

  it('⑤ 空库与坏 JSON 都不抛，一律返回数组', () => {
    const db = createDb(':memory:') as unknown as DB;
    expect(listRecentFiles(db, { days: 7, top: 3 })).toEqual([]);
    db.prepare(`INSERT INTO sessions (id, source, source_session_id, project_id, created_at, files_mentioned) VALUES ('e1','zcode','s','p',?,?)`)
      .run(iso(1), '{不是数组}');
    expect(listRecentFiles(db, { days: 7, top: 3 })).toEqual([]);
    db.close();
  });
});

describe('[A] collectBrief 与两条老命令同口径', () => {
  it('① decisions 最近在前、counts 等于实际条数', () => {
    // 夹具必须同时满足两道**后加的**过滤，否则测的不是"口径"而是"过不过滤"：
    //   · 文本 ≥ BRIEF_TEXT_MIN(5)  —— 1020 接上 passesBriefFilters 后，3 字以内会被滤掉
    //   · at 在 48h 内              —— R4 加的时效窗（简报说的是"最近在动什么"）
    // 用同一窗口内的不同时刻造先后，照样能验"最近在前"。
    // 两条文本必须**实质不同**：collectBrief 复用核心 isNearDuplicate 去重，
    // "旧/新" 只改一个字会被判为近重复而合并成 1 条（这不是口径问题，是夹具不像真实的两件事）。
    const db = seed([{ id: 'f100000000000001', files: [], decs: [dec('决定改用 SQLite 作为存储后端', 1, 0.5), dec('前端框架最终选定为 Vite 方案', 2, 0.1)] }]);
    const pay = collectBrief(db, 'p', { limit: 200 });
    expect(pay.decisions.length).toBe(2);
    expect(pay.decisions[0].text).toBe('前端框架最终选定为 Vite 方案');
    expect(pay.counts.decisions).toBe(pay.decisions.length);
    db.close();
  });

  it('② unresolved 有 14 天保质期，且 counts 等于实际条数', () => {
    const db = seed([{ id: 'f100000000000002', files: [], qs: [
      { q: '新鲜的未决问题到底是什么？', unresolved: true, at: iso(1) },
      { q: '陈年的未决问题到底是什么？', unresolved: true, at: iso(30) },
    ] }]);
    const pay = collectBrief(db, 'p', { limit: 200 });
    expect(pay.unresolved.map((u) => u.q)).toEqual(['新鲜的未决问题到底是什么？']);
    expect(pay.counts.unresolved).toBe(1);
    db.close();
  });

  it('③ limit 截断取最近 N 条而不是最老的 N 条', () => {
    // 同上：四条都落在 48h 窗内（0.4/0.3/0.2/0.1 天前），用先后顺序验"取最近 N 条"。
    const db = seed([{ id: 'f100000000000003', files: [], decs: [dec('决策一的内容', 1, 0.4), dec('决策二的内容', 2, 0.3), dec('决策三的内容', 3, 0.2), dec('决策四的内容', 4, 0.1)] }]);
    const pay = collectBrief(db, 'p', { limit: 2 });
    expect(pay.decisions.map((d) => d.text)).toEqual(['决策四的内容', '决策三的内容']);
    expect(pay.counts.decisions).toBe(2);
    db.close();
  });
});
