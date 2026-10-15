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
import Database from 'better-sqlite3';
import type { DB } from '../store/db.js';
import { listUnresolved, UBIQUITOUS_FILES } from '../store/db.js';
import { zcodeDbPath, type RelayConfig } from '../shared/config.js';

export interface KanbanInitResult {
  path: string;
  created: boolean;
  reason: string;
  rows: number;
}

const FILE_COL = '任务';

// ───────────────────── 结构化待办 → 看板（2026-10-15 夜 · B1） ─────────────────────
//
// 为什么：看板段的本来目的是「计划/下一步」——b3 实测这是全库最大盲区（只捕获 3.3%）。
// 而 ZCode 的 `todo` 表里**躺着真任务、真状态**（实测：主库 2059 条 / 进行中 187；
// music 622 / 24；内容形如「渲染管线换 GeckoLib（几何/UV 正确，截图已确认）」）。
// 之前的草稿只从文件清单/未决/会话标题里凑——那些是**盘点**不是计划，所以只能打 ⬜。
// 这一批是**结构化来源**，因此允许用 🔄 进简报的看板段（这正是那段存在的意义）。
//
// 自动化契约：这些行带 `auto:todos` 模块标记，`syncKanbanAuto` 每次只重写这些行，
// **人写的行一个字节都不动**（与「绝不覆盖」同一条纪律）。

export interface TodoItem { content: string; status: string; updatedAt: number }

const AUTO_MODULE = 'auto:todos'

/** 读 ZCode 里本项目的近期待办。绝不抛：读不到返回 []。 */
export function todoRowsOf(root: string, cfg: RelayConfig, days = 7, limit = 6): TodoItem[] {
  try {
    const p = zcodeDbPath(cfg)
    if (!fs.existsSync(p)) return []
    const z = new Database(p, { readonly: true })
    try {
      // ⚠️ 必须排除子代理/工作流子会话的待办——实测不加这条，抓到的 6 条全是子代理任务书里的
      //    「Submit structured result」「汇总 unclear / unsupported / willAsk」（audit actor 的 todo）。
      //    这跟决策侧同一个教训：**来源比内容更可靠**，而 task_type 就是来源的真值。
      const rows = z.prepare(`
        SELECT t.content AS content, t.status AS status, t.time_updated AS updatedAt
        FROM todo t JOIN session s ON s.id = t.session_id
        WHERE lower(s.directory) = lower(?) AND t.time_updated >= ?
          AND coalesce(s.task_type, '') NOT IN ('subagent_child', 'workflow_child')
        ORDER BY t.time_updated DESC LIMIT 200`).all(path.resolve(root), Date.now() - days * 86400000) as TodoItem[]
      const seen = new Set<string>()
      const out: TodoItem[] = []
      // 进行中优先（简报只读带 🔄/⛔ 的行），同内容去重留最新
      for (const pass of ['in_progress', 'pending']) {
        for (const r of rows) {
          if (r.status !== pass) continue
          const k = String(r.content ?? '').trim()
          if (!k || seen.has(k)) continue
          seen.add(k)
          out.push({ ...r, content: k })
          if (out.length >= limit) return out
        }
      }
      return out
    } finally { try { z.close() } catch { /* 已关闭 */ } }
  } catch { return [] }
}

/** 待办 → 看板行（进行中打 🔄 会被简报读取；待办打 ⬜ 不进简报）。 */
export function renderTodoRows(todos: TodoItem[]): string[][] {
  return todos.map((t) => [
    String(t.content).slice(0, 34),
    t.status === 'in_progress' ? '🔄 进行中' : '⬜ 待办',
    AUTO_MODULE,
    `来自 ZCode 待办（${new Date(t.updatedAt).toISOString().slice(5, 10)}）`,
  ])
}

/** 把自动区（模块列 = auto:todos）替换成最新待办；**其余行逐字保留**。 */
export function syncKanbanAuto(root: string, cfg: RelayConfig): { ok: boolean; reason: string; rows: number } {
  const file = path.join(root, 'progress.md')
  if (!fs.existsSync(file)) return { ok: false, reason: '没有 progress.md（先跑 srelay kanban init）', rows: 0 }
  try {
    const todos = todoRowsOf(root, cfg)
    const fresh = renderTodoRows(todos)
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
    const isSep = (l: string) => /^\|[-\s|:]+\|$/.test(l.trim())
    const isAuto = (l: string) => l.trim().startsWith('|') && l.includes(AUTO_MODULE)
    // 自动行插在**表格末尾**（而不是表头之后）：
    // 实测插在开头会把人写的行挤出简报的 2 个名额（简报只读 🔄/⛔ 且按文件顺序取前 2 行）——
    // 人写的项目级计划优先，自动的细粒度待办排后面。
    const isRow = (l: string) => l.trim().startsWith('|')
    const out: string[] = []
    let dropped = 0
    let lastRowIdx = -1
    for (const l of lines) {
      if (isAuto(l)) { dropped++; continue }
      if (isRow(l)) lastRowIdx = out.length
      out.push(l)
    }
    const at = lastRowIdx >= 0 ? lastRowIdx + 1 : out.length
    out.splice(at, 0, ...fresh.map((r) => '| ' + r.join(' | ') + ' |'))
    const next = out.join('\n')
    const prev = lines.join('\n')
    if (next === prev) return { ok: true, reason: '无变化', rows: fresh.length }
    fs.writeFileSync(file, next, 'utf8')
    return { ok: true, reason: `自动区已刷新（旧 ${dropped} 行 → 新 ${fresh.length} 行）`, rows: fresh.length }
  } catch (e) {
    return { ok: false, reason: '刷新失败：' + String((e as Error)?.message ?? e).slice(0, 80), rows: 0 }
  }
}

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

  // ⚠️ 下面三行**一律用 ⬜**（而不是 🔄/⛔）——这是 1015 夜实测后改的，别顺手改回去：
  // 简报的看板段只读 🔄/⛔ 的行，且**最多 2 行**。原实现给这三行都打了 🔄/⛔，
  // 于是在一个全新项目上：简报的 2 个看板名额被「近 7 天反复在动的文件」「最近几场会话」
  // 两张**自动盘点**占满，而那一段的本意是「计划/下一步」（b3 实测全库最大盲区，只捕获 3.3%）。
  // 更糟的是内容重复：文件盘点与简报里已有的 `🗂 近 7 天反复在动` 行是同一批文件、同一批数字。
  // 所以：生成物只做**人看的骨架**，状态一律 ⬜（简报不读）；真正的任务由人写成 🔄/⛔。
  if (opts.recentFiles.length) {
    const files = opts.recentFiles.slice(0, 3).map((f) => `${f.file}(${f.sessions}场)`).join('、');
    rows.push(['自动盘点：近 7 天在动的文件', '⬜ 待办', '—',
      `${files}。（这是盘点不是任务——简报的 🗂 行已经会显示同一批文件）`]);
  }

  if (opts.unresolved.length) {
    rows.push(['自动盘点：待拍板的未决问题', '⬜ 待办', '—',
      `${opts.unresolved.length} 条，首条：${String(opts.unresolved[0]?.q ?? '').slice(0, 60)}`]);
  }

  if (opts.recentSessions.length) {
    const s = opts.recentSessions.slice(0, 2).map((x) => `${x.at} ${x.title}`).join('；');
    rows.push(['自动盘点：最近几场会话', '⬜ 待办', '—', s.slice(0, 100)]);
  }

  const head = [
    `# ${opts.projectName} · 进度看板（progress.md）`,
    '',
    `> 生成于 ${today}，由 srelay kanban init 从**已有数据**自动起草（近 7 天的文件 / 未决问题 / 最近会话）。`,
    '> **这份文件此后由人维护**——生成器只在文件不存在时写一次，绝不覆盖。',
    '> 格式：| 任务 | 状态 | 模块 | 明细 |，状态列以 ✅🔄⛔⬜ 开头。',
    '> ⚠️ 只有 **🔄 进行中 / ⛔ 阻塞** 的行会被简报读取（最多 2 行）——请把你真正在做的事写成 🔄，',
    '>    卡住的写成 ⛔；下面几行的 ⬜ 是自动盘点（不是任务），简报**不会**读它们。',
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
      // 泛在文件表**不再本地重写一份**：用 store/db.ts 的 UBIQUITOUS_FILES（与简报侧同源）。
      // 原先这里少列了 README.en.md / settings.json / vitest.config.ts / pnpm-lock.yaml，
      // 于是同一个概念在库内有两套口径——正是悄悄漂移的温床。
      recentFiles = [...agg.values()]
        .filter((x) => !UBIQUITOUS_FILES.has(String(x.file).split('/').pop() ?? ''))
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
