// 「一键生成看板初稿」——把 progress.md 从"必须人写"变成"开箱就有"（2026-10-15 夜）。
//
// 为什么需要它：简报的「计划/下一步」段唯一来源就是项目根的 progress.md，
// 而全仓库此前**只有读、没有写**——没人写就是空的。b3 的捕获率盘点实测
// 「计划/下一步」只被捕获 3.3%（5763 条未捕获），是全库最大盲区。
//
// 设计约束（三条，都是这个项目踩出来的）：
//   ① **绝不覆盖**：已存在 progress.md 时只报告"已存在"，一个字都不改——
//      它是人手写的文件，自动生成物没有资格盖它；
//   ② **只用可观测量**：生成内容来自库里已有的数据（近 7 天的 files_mentioned、未决问题、
//      最近会话标题），不做任何"从对话里嗅意义"的猜测；
//   ③ **格式必须能被解析**：列序固定为 | 任务 | 状态 | 模块 | 明细 |，状态列以 ✅🔄⛔⬜ 开头，
//      否则插件读不到（解析器只认这几种 emoji 开头的状态）。
import fs from 'node:fs';
import path from 'node:path';
import type { DB } from '../store/db.js';
import { listUnresolved } from '../store/db.js';

export interface KanbanInitResult {
  path: string;
  created: boolean;
  reason: string;
  rows: number;
}

const FILE_COL = '任务';

/** 生成看板初稿。不写盘，纯计算——便于测试与 dry-run。 */
export function renderKanbanDraft(opts: {
  projectName: string;
  recentFiles: Array<{ file: string; sessions: number; decisions: number }>;
  unresolved: Array<{ q: string }>;
  recentSessions: Array<{ title: string; messages: number; at: string }>;
  hasKanbanAwareness?: boolean;
}): string {
  const rows: string[][] = [];
  const today = new Date().toISOString().slice(0, 10);

  // 第 1 行：给人一条明确的"从这里开始写"的占位——不是空模板，是带指令的占位。
  rows.push(['（把真实任务写在这里）', '⬜ 待办', '—', '状态列以 ✅/🔄/⛔/⬜ 开头才会被简报读取；明细写"下一步做什么"']);

  if (opts.recentFiles.length) {
    const files = opts.recentFiles.slice(0, 3).map((f) => `${f.file}(${f.sessions}场)`).join('、');
    rows.push(['近 7 天反复在动的文件', '🔄 进行中', opts.recentFiles.slice(0, 3).map((f) => f.file).join(', '),
      `自动盘点：${files}。若其中某项已收尾，把它挪到下面的已完成行`]);
  }

  if (opts.unresolved.length) {
    rows.push(['待拍板的未决问题', '⛔ 待定', '—',
      `${opts.unresolved.length} 条，首条：${String(opts.unresolved[0]?.q ?? '').slice(0, 60)}`]);
  }

  if (opts.recentSessions.length) {
    const s = opts.recentSessions.slice(0, 2).map((x) => `${x.at} ${x.title}`).join('；');
    rows.push(['最近几场会话', '🔄 进行中', '—', s.slice(0, 100)]);
  }

  const head = [
    `# ${opts.projectName} · 进度看板（progress.md）`,
    '',
    `> 生成于 ${today}，由 srelay kanban init 从**已有数据**自动起草（近 7 天的文件 / 未决问题 / 最近会话）。`,
    '> **这份文件此后由人维护**——生成器只在文件不存在时写一次，绝不覆盖。',
    '> 格式：| 任务 | 状态 | 模块 | 明细 |，状态列以 ✅🔄⛔⬜ 开头；DSH 简报会自动读取带 🔄/⛔ 的行（最多 2 行）。',
    '',
    '| ' + FILE_COL + ' | 状态 | 模块 | 明细 |',
    '|---|---|---|---|',
  ];
  const body = rows.map((r) => '| ' + r.join(' | ') + ' |');
  return [...head, ...body, ''].join('\n');
}

/** 写看板初稿到 <root>/progress.md。已存在则**绝不覆盖**。 */
export function writeKanbanDraft(root: string, db: DB | null, projectId: string | null): KanbanInitResult {
  const file = path.join(root, 'progress.md');
  if (fs.existsSync(file)) {
    return { path: file, created: false, reason: '已存在 progress.md（自动生成物绝不覆盖人手写的文件）', rows: 0 };
  }
  let recentFiles: Array<{ file: string; sessions: number; decisions: number }> = [];
  let unresolved: Array<{ q: string }> = [];
  let recentSessions: Array<{ title: string; messages: number; at: string }> = [];
  if (db) {
    try {
      const rows = db.prepare(`SELECT files_mentioned, decisions, title, message_count, coalesce(last_event_at, created_at) AS t
        FROM sessions WHERE files_mentioned IS NOT NULL AND files_mentioned != '[]'
          AND coalesce(last_event_at, created_at) >= ? ORDER BY t DESC LIMIT 300`)
        .all(new Date(Date.now() - 7 * 86400000).toISOString()) as Array<{ files_mentioned: string; decisions: string | null; title: string | null; message_count: number; t: string }>;
      const agg = new Map<string, { file: string; sessions: number; decisions: number }>();
      for (const r of rows) {
        let files: string[] = []; let decs = 0;
        try { files = JSON.parse(r.files_mentioned); } catch { continue; }
        try { decs = JSON.parse(r.decisions ?? '[]').length; } catch { decs = 0; }
        for (const f of files) {
          if (typeof f !== 'string' || f.length < 4) continue;
          const cur = agg.get(f) ?? { file: f, sessions: 0, decisions: 0 };
          cur.sessions += 1; cur.decisions += decs; agg.set(f, cur);
        }
      }
      const UBIQ = new Set(['AGENTS.md', 'CLAUDE.md', 'SKILL.md', 'README.md', 'package.json', 'package-lock.json', 'config.json', 'tsconfig.json', 'progress.md']);
      recentFiles = [...agg.values()]
        .filter((x) => !UBIQ.has(String(x.file).split('/').pop() ?? ''))
        .filter((x) => x.sessions >= 2)
        .sort((a, b) => b.sessions - a.sessions || b.decisions - a.decisions)
        .slice(0, 3);
      recentSessions = rows.slice(0, 3).map((r) => ({ title: String(r.title ?? '（无标题）').slice(0, 40), messages: r.message_count, at: r.t.slice(0, 10) }));
    } catch { /* 取不到数据就只写占位行 */ }
    if (projectId) { try { unresolved = listUnresolved(db, projectId, 5).map((u) => ({ q: u.q })); } catch { unresolved = []; } }
  }
  const text = renderKanbanDraft({ projectName: path.basename(root), recentFiles, unresolved, recentSessions });
  fs.writeFileSync(file, text, 'utf8');
  const rows = text.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| 任务')).length;
  return { path: file, created: true, reason: '已生成看板初稿（此后由人维护，生成器不再动它）', rows };
}
