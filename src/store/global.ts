// 全局经验层（设计见 docs/1016-全局经验层设计.md）
//
// 为什么单独一个库：我们的记忆一直是「一个项目一个库」，而经验是**跨项目**的。
// 直接塞进项目库 = 跨项目泄露；直接合并所有库 = 违背既定边界。
// 所以另起一个**只存提炼后条目**的库：不存原文、不存消息、不存跨项目文件路径。
//
// 借鉴（DSH 生态实测，见 community-plugins/dsh-experience-memory）：
//   ① 写入即定级、此后不重算；② 两道闸（定级 + 相关性）；③ 预算固定；④ 会老会退休。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { searchTextOf } from './db.js';
import { normalize, parseQuery } from '../core/tokenize/tokenizer.js';
import { workspaceKey } from '../shared/workspace.js';

// [1017 夜] 闸门判据搬进**零依赖**的 store/lesson-gate.ts。
// 理由：面板宿主半要读"哪条经验现在能进注入层"，而它跑在没有原生模块的进程里，
// 一旦 import 本文件就会被 better-sqlite3 拖住。判据仍只有一份，这里**原样再导出**，
// 所有老调用点（CLI / MCP / 插件 / hook）一字不改。
import { GRADES, INJECT_THRESHOLD, DECAY_PER_DAY, isInjectable, liveImportance } from './lesson-gate.js';
import type { Grade, Scope, Status, LessonRow } from './lesson-gate.js';
export { GRADES, INJECT_THRESHOLD, DECAY_PER_DAY, isInjectable, liveImportance };
export type { Grade, Scope, Status, LessonRow };

/** 全局库路径：~/.sessionrelay/global.sqlite（与项目库物理分开）。实体在 shared/paths.ts。 */
import { globalDbFile } from '../shared/paths.js';
export { globalDbFile };

export function openGlobal(file?: string): Database.Database {
  const f = file ?? globalDbFile();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const db = new Database(f);
  db.pragma('journal_mode = WAL');
  db.exec(
    'CREATE TABLE IF NOT EXISTS lessons ('
    + ' id INTEGER PRIMARY KEY AUTOINCREMENT,'
    + " scope TEXT NOT NULL DEFAULT 'project',"
    + ' workspace_id TEXT,'
    + ' domain TEXT,'
    + ' text TEXT NOT NULL,'
    + ' quote TEXT,'
    + ' search_text TEXT,'
    + ' source_ref TEXT,'
    + " route TEXT NOT NULL DEFAULT 'none',"
    + " grade TEXT NOT NULL DEFAULT 'inferred',"
    + ' importance REAL NOT NULL,'
    + " status TEXT NOT NULL DEFAULT 'draft',"
    + ' hits INTEGER NOT NULL DEFAULT 0,'
    + ' uses INTEGER NOT NULL DEFAULT 0,'
    + ' needs_review INTEGER NOT NULL DEFAULT 0,'
    + ' created_at TEXT NOT NULL, updated_at TEXT NOT NULL'
    + ');'
    + 'CREATE INDEX IF NOT EXISTS lessons_scope ON lessons(scope, workspace_id, domain);'
    + 'CREATE INDEX IF NOT EXISTS lessons_status ON lessons(status);'
    + 'CREATE VIRTUAL TABLE IF NOT EXISTS lessons_fts USING fts5(search_text, domain, content=\'lessons\', content_rowid=\'id\', tokenize=\'unicode61\');'
  );
  return db;
}

export interface AddInput {
  text: string; grade?: Grade; scope?: Scope; workspaceId?: string; domain?: string;
  quote?: string; sourceRef?: string; route?: string; status?: Status;
}

export function addLesson(db: Database.Database, input: AddInput): { id: number; reason: string } {
  const grade: Grade = input.grade ?? 'inferred';
  const scope: Scope = input.scope ?? 'project';
  const text = String(input.text ?? '').trim();
  if (!text) throw new Error('经验正文不能为空');
  // [红队 M1] scope 必须校验枚举：原来只校验 project/domain 的配套字段，
  //   传一个拼错的 scope（如 --scope bogus）会**静默写进去**，而 visibleWhere 只认
  //   global/project/domain ⇒ 那条经验任何入口都看不见，等于凭空吞掉一条。
  if (scope !== 'global' && scope !== 'project' && scope !== 'domain') {
    throw new Error('未知 scope: ' + String(input.scope) + '（只允许 global / project / domain）');
  }
  if (scope === 'project' && !input.workspaceId) throw new Error('scope=project 必须给 workspaceId');
  if (scope === 'domain' && !input.domain) throw new Error('scope=domain 必须给 domain');
  const now = new Date().toISOString();
  // 证据定级：只有真给了出处/引文才配得上非 inferred（与实测设计一致：插件自己去核对）
  let effectiveGrade: Grade = grade;
  let reason = '';
  if (grade !== 'inferred' && !input.sourceRef) { effectiveGrade = 'inferred'; reason = '给了定级但没给来源，降为 inferred'; }
  // 状态：有证据的显式录入 = verified；自动产 / 无来源 = draft（设计 §11.2 的「不能随便入库」）
  //
  // ⚠️ [1021 审查 #11] **凡是自动/批量写入方，必须显式传 status**，不许吃这个默认值。
  //   病历：lesson-harvest（采集）只传了 grade + sourceRef，没传 status ⇒ 命中"有证据=verified" ⇒
  //   库里落成 verified，而命令输出还在说「写入草稿」——**输出与库不一致**，人工复核门槛被绕过。
  //   补救：采集侧已显式 status:'draft' 并回读核对；这里保留默认值不动，是因为**手工录入**
  //   （srelay lesson add --source X --grade verified-user）本来就该是 verified，
  //   改默认会破坏那个正常路径。
  //   判据：你是"人在录"还是"程序在攒"？程序一律显式传 status。
  let status: Status = input.status ?? (effectiveGrade !== 'inferred' && !!input.sourceRef ? 'verified' : 'draft');
  // [红队 A-9] 显式 `--status verified` 不能绕开"没有定级就是草稿"：注入闸有 `grade <> 'inferred'` 兜着，
  // 但库里留一条"verified 且 inferred"的矛盾记录会让人误判（列表里到底算 ● 还是 ○）。
  if (status === 'verified' && effectiveGrade === 'inferred') {
    status = 'draft';
    reason = reason ? reason + '；inferred 只能是草稿' : 'inferred 只能是草稿（要进注入层先 lesson confirm）';
  }
  const info = db.prepare(
    'INSERT INTO lessons (scope, workspace_id, domain, text, search_text, quote, source_ref, route, grade, importance, status, created_at, updated_at)'
    + ' VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(scope, input.workspaceId ?? null, input.domain ?? null, text, searchTextOf(text), input.quote ?? null,
    input.sourceRef ?? null, input.route ?? 'none', effectiveGrade, GRADES[effectiveGrade],
    status, now, now);
    const id = Number(info.lastInsertRowid);
  // 手工维护 FTS：不用触发器 —— 触发器与表定义容易不同步（实测：改了 FTS 列名，触发器还在写旧列，
  // 报错却是「no column named text」，指向上游看不出真因）。写在同一条代码路径上，改一次就够。
  db.prepare("INSERT INTO lessons_fts(rowid, search_text, domain) VALUES (?,?,?)").run(id, searchTextOf(text), input.domain ?? null);
  return { id, reason };
}

/**
 * 作用域可见性（**唯一实现**，四个面都从这里取）：project 只看自己；domain 看同领域；global 谁都看。
 *
 * ⚠️ 两条实测教训，别再改回去：
 *   ① 这段 SQL 曾经被 DSH 插件与 ZCode hook **各抄一份**，抄完就漂移（插件缺 domain、hook 缺 workspace）
 *      —— 结果 `--scope domain` 的经验两端都看不见，且没有任何报错。
 *   ② workspace 用**路径比较键**比，不用字符串直接相等：Windows 上 `D:\proj` 与 `d:/proj`
 *      是同一个目录，直接相等会把同一个项目劈成两半（子目录里 add 的经验读不出来，就是这个病的轻症）。
 *      SQL 侧用 replace(lower(...), char(92), '/') 归一（**char(92) 而不是反斜杠字面量**：
 *      SQL 字符串里嵌反斜杠是这套代码踩过三次的坑），JS 侧用 workspaceKey，两侧口径必须一致。
 */
export function visibleWhere(scopeSel: { workspaceId?: string; domain?: string }): { sql: string; params: unknown[] } {
  const parts = ["(scope = 'global')"];
  const params: unknown[] = [];
  if (scopeSel.workspaceId) {
    // trim 两侧都要：JS 侧 workspaceKey 先 .trim()（手输 --workspace 时多一个空格很常见），
    // SQL 侧不 trim 就会出现"JS 说相等、SQL 说不等"的**同一规则两种答案**（复审 C-5 实测）。
    parts.push("(scope = 'project' AND rtrim(replace(lower(trim(workspace_id)), char(92), '/'), '/') = ?)");
    params.push(workspaceKey(scopeSel.workspaceId));
  }
  if (scopeSel.domain) { parts.push("(scope = 'domain' AND domain = ?)"); params.push(scopeSel.domain); }
  return { sql: '(' + parts.join(' OR ') + ')', params };
}

export function listLessons(db: Database.Database, sel: { workspaceId?: string; domain?: string; status?: Status; top?: number }): LessonRow[] {
  const w = visibleWhere(sel);
  const extra = sel.status ? ' AND status = ?' : '';
  const rows = db.prepare('SELECT * FROM lessons WHERE ' + w.sql + extra + ' ORDER BY importance DESC LIMIT ?')
    .all(...w.params, ...(sel.status ? [sel.status] : []), sel.top ?? 50) as LessonRow[];
  return rows.map((r) => ({ ...r, importance: Number(liveImportance(r)) }));
}

export function searchLessons(db: Database.Database, q: string, sel: { workspaceId?: string; domain?: string; top?: number }): LessonRow[] {
  const w = visibleWhere(sel);
  const rows = db.prepare(
    'SELECT l.* FROM lessons_fts f JOIN lessons l ON l.id = f.rowid'
    + ' WHERE lessons_fts MATCH ? AND ' + w.sql + ' ORDER BY bm25(lessons_fts) LIMIT ?'
  ).all(ftsExpr(q), ...w.params, sel.top ?? 10) as LessonRow[];
  if (rows.length > 0) {
    const ids = rows.map((r) => r.id);
    // [红队 A-6] 原先每次检索命中都 hits+1（永久 +0.1/次）——**调试式检索会把条目顶过注入线**。
    // 现在只记「被返回过」这件事的**不落库**语义：不再自动加分；加分只走 maintain 里靠真实复用（uses）。
  }
  return rows.map((r) => ({ ...r, importance: Number(liveImportance(r)) }));
}

export function ftsExpr(q: string): string {
  const toks = parseQuery(q).units.flat();
  if (toks.length === 0) return '"' + q.replace(/"/g, '') + '"';
  return toks.map((t) => '"' + t + '"').join(' OR ');
}

/**
 * [1021 C1] inferred 的"待复核保留"阈值：被反复采集到几次才值得拎出来给人看。
 * 3 次 = 至少横跨三个采集窗口（每个 6h）还能重现，说明是真反复发生的坑，不是一次口误。
 */
const REPEAT_MARK = 3;
/** 豁免轮数上限：超过这么多轮就不再拦，防止一个永远挖得到的垃圾条目长期占据复核队列 */
const KEEP_ALIVE_MAX_ROUNDS = 30;
/**
 * [1021 C1 修正] inferred 的**观察窗**（天）。
 *
 * 为什么需要它（这是个真 bug，不是补丁）：
 *   C1 第一版只写了"hits ≥ 3 才拦下不退休"。但**节奏对不上** ——
 *   consolidate 每小时跑，harvest 6 小时才跑一次，于是第一轮进来的 inferred
 *   在 hits 还没涨到 2 的时候就被 consolidate 退休了。**保护代码永远走不到**。
 *   真库印证：28 条 inferred 全 retired，hits 合计正好 28（每条只涨了 1 次）。
 *
 * 现在：inferred 且 hits < REPEAT_MARK 时，若年龄还不到观察窗就**先不动它**
 *   （既不退休也不标记），让它有机会在后续几轮采集里证明自己"会反复出现"。
 *   观察窗过后仍没攒够 hits ⇒ 照常退休。所以最终仍然只有两类结局：
 *   攒够 → 待人工确认；攒不够 → 退休。只是把"判决"推迟到证据够了之后。
 *
 * 安全边界不变：这些条目仍是 inferred ⇒ 闸 1 硬排除 ⇒ **进不了注入层**。
 */
const INFERRED_GRACE_DAYS = 7;

/**
 * 给 inferred 条目挂"待人工确认"标记；返回 true 表示本轮**拦下不退休**。
 *
 * 豁免次数记在 source_ref 末尾的 `×N` 里（不新增列：DB 迁移成本不值当，
 * 而且 source_ref 本来就是人看的字符串）。
 */
/** 条目的年龄（天）。解析不出来按 0 算（= 当作新条目，给观察窗）。 */
function ageDays(r: LessonRow): number {
  const t = Date.parse(String(r.created_at || ''));
  return Number.isFinite(t) ? Math.max(0, (Date.now() - t) / 86400000) : 0;
}

function keepAlive(db: Database.Database, r: LessonRow, now: string): boolean {
  const m = /×(\d+)$/.exec(String(r.source_ref || ''));
  const used = m ? Number(m[1]) : 0;
  if (used >= KEEP_ALIVE_MAX_ROUNDS) return false;
  const base = String(r.source_ref || '').replace(/ ?×\d+$/, '');
  const suffix = '反复出现(hits=' + Number(r.hits || 0) + ') 待人工确认 ×' + (used + 1);
  // [红队 S2] **保尾截断**。原来写的是整串 note.slice(0, 400) —— ref 一长就把末尾的 ×N 切掉，
  //   /×(d+)$/ 永远匹配不上 ⇒ 计数恒为 0 ⇒ KEEP_ALIVE_MAX_ROUNDS=30 **永不触发**，
  //   条目可以被无限次"拦下"却不退休。实测 ref=390 字符时末尾被切成 "...反复出现(hi"。
  //   现在只在 base 过长时截 base，×N 一律保住（保留"不新增列"的取舍，但把取舍做对）。
  const LIMIT = 400;
  let note = (base ? base + ' · ' : '') + suffix;
  if (note.length > LIMIT) {
    // 4 = ' ·' + '…' 的那点余量，留够才能保证截完不超长（这里差一个字符都会让 /×N$/ 匹配失败）
    const room = Math.max(0, LIMIT - suffix.length - 4);
    const head = room > 0 ? (base.length > room ? base.slice(0, room) + '…' : base) : '';
    note = (head ? head + ' · ' : '') + suffix;
  }
  // 只标 needs_review + 记次数；**status 一个字都不动** ⇒ 进不了注入层
  db.prepare('UPDATE lessons SET needs_review = 1, updated_at = ?, source_ref = ? WHERE id = ?')
    .run(now, note, r.id);
  return true;
}

export function maintainLessons(db: Database.Database): {
  decayed: number; retired: number; resurrected: number; superseded: number;
  /** 因"反复出现"被拦下、标了 needs_review 的条数 */
  held: number;
  /** 因"还在观察窗内"暂不判决的 inferred 条数 */
  probation: number;
} {
  const rows = db.prepare('SELECT * FROM lessons').all() as LessonRow[];
  const upd = db.prepare('UPDATE lessons SET status = ?, updated_at = ? WHERE id = ?');
  const now = new Date().toISOString();
  let decayed = 0, retired = 0, resurrected = 0;
  let held = 0;
  let probation = 0;
  const heldIds: number[] = [];
  for (const r of rows) {
    // [红队 A-3] **人明确否决的不许被自动复活**：rejected 是终态。
    if (String(r.status) === 'rejected') continue;
    const live = liveImportance(r);
    if (live < INJECT_THRESHOLD) {
      decayed++;
      // ── [1021 C1] inferred 的上升通道：**反复被采集到的不退休，标成待人工确认** ──
      //
      // 病历：采集给助手消息产的候选一律 inferred（1.5 分），而本函数每小时跑一次、
      //   1.5 < 阈值 5.5 ⇒ **出生即死**。实测 17 条里有 7 条就是这么没的，
      //   而它们当中可能真有价值 —— 机器不该替人判"这条没用"，它只该说"我不确定"。
      //
      // 现在：inferred 且 hits ≥ REPEAT_MARK（=被反复挖到 3 次）⇒ 标 needs_review=1 并**保持原状态**，
      //   不进回收站。人复核时一眼能看到"这条反复出现过，你来定"。
      //
      // 边界守死（三处都不可放宽）：
      //   · 只对 inferred 生效 —— verified-* 有自己的路径，不走这个例外；
      //   · 只标 needs_review，**绝不改 status、绝不提分** ⇒ 仍然进不了注入层
      //     （inferred 被闸 1 硬排除，哪怕 hits 拉满也只有 2.5 分）；
      //   · 有上限（KEEP_ALIVE_MAX_ROUNDS）：豁免次数记在 source_ref 里，超过 30 轮就不再拦，
      //     否则一个永远挖得到的垃圾条目会永久占着复核队列。
      const isInferred = String(r.grade) === 'inferred';
      const hits = Number(r.hits || 0);
      if (isInferred && r.status !== 'retired') {
        // 攒够重复次数 ⇒ 拦下并标记待人工确认
        if (hits >= REPEAT_MARK && keepAlive(db, r, now)) { held++; heldIds.push(Number(r.id)); continue; }
        // 还没攒够，但仍在观察窗内 ⇒ 先不判，给它机会再被挖到
        if (hits < REPEAT_MARK && ageDays(r) < INFERRED_GRACE_DAYS) { probation++; continue; }
      }
      if (r.status !== 'retired') { upd.run('retired', now, r.id); retired++; }
    } else if (r.status === 'retired') { upd.run('verified', now, r.id); resurrected++; }
  }
  // [新] 冲突消解：新话压旧话 —— 此前只有"环境事实"抽取有 supersede，决策/经验层完全没有。
  //
  // ⚠️ **实测之后改的设计（诚实记录）**：第一版做的是"自动把旧的那条退休"，
  // 拿真库一跑，判出的 4 对**全是误判** —— 共用的词是"必须/于是/会话/实测"这类泛词，
  // 两条其实互补而不是矛盾。**自动作废在这里是不可信的**：错杀一条真经验，比漏判十条严重得多。
  // 所以降级为**advisory**：只把旧的标成 needs_review（人工看一眼），绝不改它的 status ——
  // 这本身就是"自我怀疑"原则的正确用法：机器不确定的时候，标记不确定，而不是替人下结论。
  let conflicts = 0;
  const alive = db.prepare("SELECT * FROM lessons WHERE status = 'verified'").all() as LessonRow[];
  for (const pair of findSupersedeConflicts(alive)) {
    const older = alive.find((x) => x.id === pair.olderId);
    if (!older || Number(older.needs_review) === 1) continue;
    const note = (String(older.source_ref || '') ? String(older.source_ref) + ' · ' : '') + pair.reason;
    db.prepare('UPDATE lessons SET needs_review = 1, updated_at = ?, source_ref = ? WHERE id = ?')
      .run(now, note.slice(0, 400), pair.olderId);
    conflicts++;
  }
  // held = 本轮因"反复出现"被拦下没退休的条数（它们被标了 needs_review，等人看一眼）
  return { decayed, retired, resurrected, superseded: conflicts, held, probation };
}

/** Markdown 导出：经验库必须人可读、可 git、可手改（借鉴实测做法） */
export function exportMarkdown(db: Database.Database): string {
  const rows = db.prepare('SELECT * FROM lessons ORDER BY scope, importance DESC').all() as LessonRow[];
  const g = ['# 全局经验库（自动导出，可手改；改动以数据库为准）', '', '共 ' + rows.length + ' 条', ''];
  let last = '';
  for (const r of rows) {
    // [红队 A-3] **人明确否决的不许被自动复活**：rejected 是终态。
    if (String(r.status) === 'rejected') continue;
    if (r.scope !== last) { g.push('', '## ' + r.scope, ''); last = r.scope; }
    g.push('- [' + r.grade + ' | ' + r.status + ' | ' + Number(liveImportance(r)).toFixed(1) + '] ' + r.text);
  }
  return g.join(String.fromCharCode(10)) + String.fromCharCode(10);
}
/**
 * 注入挑选：**两道闸 + 预算**（设计见 docs/1016-经验层收什么怎么筛.md §11.2）
 *
 *   闸 1 定级：只有 importance ≥ INJECT_THRESHOLD 的才算（draft 与 retired 一律不进）
 *   闸 2 相关性：与本轮要有**具体**重合——三层证据（标识符 / 共享 ≥3 字子串 / 两个不同弱证据），
 *              判据只有 gate2Score 一处；常用词不算数（实测有插件因为「这个」两个字把无关经验注进无关的一轮）。
 *   预算：超了就截（默认 ≤200 字符 / ≤3 条），**没命中就返回空数组**——空输出优于塞噪声。
 */
const COMMON_WORDS = new Set(['这个','那个','什么','怎么','为什么','可以','需要','应该','我们','你们','他们','现在','然后','没有','不是','还是','或者','因为','所以','但是','如果','已经','还有','就是','一下','东西','时候','问题','这样','那样','之外','而且']);

/**
 * 闸 2 的判据结果（判据本体见下面 gate2Score 的注释；**前端适配器一律用 .pass，不要自己比 score**）。
 */
export interface Gate2Hit {
  /** 排序用总分（只看相对大小，不是概率） */ score: number;
  /** 命中的 ASCII 标识符个数（≥3 字符，或含 . _ - / 的词，如 pnpm / RRF / max_chars） */ idents: number;
  /** 命中的强证据个数（共享 ≥3 字的 CJK 子串） */ strong: number;
  /** 命中的孤立二元组个数（各自单独出现，凑不成 3 字子串） */ weak: number;
  /** 查询里"配得上当判据"的单元总数（全是常用词时 = 0） */ usable: number;
  /** 最终判据：**唯一一处阈值** */ pass: boolean;
}

const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g;

/**
 * 闸 2：相关性打分（**唯一实现** —— DSH 插件、ZCode hook、CLI 都只有这一个判据）。
 *
 * 三层证据，**都不需要 jieba**（纯字符串操作：hook 里不用加载词典，也不会因为分词差异而两边不一致）：
 *   ① **ASCII 标识符命中** = 强证据。大小写先经 normalize 统一 ——
 *      这是红队 B 报的"正文写 MAX_CHARS 就永远匹配不上"那个病历的根治处。
 *   ② **共享 ≥3 字的 CJK 子串**（如"长度归一"）= 强证据。3 字窗口能跨过词形差异：
 *      查询写"长度归一**化**"、正文写"长度归一"，仍算命中（词级匹配在这里会漏）。
 *   ③ **孤立的 2 字二元组** = 弱证据，**要两个不同的一起出现才作数**。
 *
 * 为什么弱证据必须成对（实测两例，都是真事故）：
 *   · 写诗题（…帮我写一首关于春天的诗）↔ 决策里的"跳下**一首**"：只共享「一首」；
 *   · "MAX_CHARS 简报上限是多少" ↔ 决策里的"挤出**简报**"：只共享「简报」。
 * 前者就是红队 B 7.3 报的"📌 段不静默"——只共享一个 2 字词就判相关，等于拿 2 个名额赌噪声。
 * 反过来，**单一判据**（查询里只有一个可判据的单元，比如就问"截图"）命中即算 —— 那是用户的本意。
 *
 * 常用词（这个/怎么/一下…）一律不作证据；整窗都是常用词的 3 字窗口也跳过（"怎么样"不算）。
 */
export function gate2Score(query: string, text: string): Gate2Hit {
  const q = normalize(query);
  const t = normalize(text);

  // ① ASCII 标识符：大小写已在 normalize 里统一（compare 两侧都是小写）
  let idents = 0;
  for (const w of q.split(/[^a-z0-9._\-/]+/)) {
    if (w.length < 2) continue;
    if (!(w.length >= 3 || /[._\-/]/.test(w))) continue;
    if (t.includes(w)) idents++;
  }

  // ②③ CJK：3 字窗口 = 强；非停用二元组 = 弱
  let strong = 0;
  const weakSet = new Set<string>();
  const usableSet = new Set<string>();
  for (const run of q.match(CJK_RUN) ?? []) {
    for (let i = 0; i + 3 <= run.length; i++) {
      const win = run.slice(i, i + 3);
      if (COMMON_WORDS.has(win.slice(0, 2)) || COMMON_WORDS.has(win.slice(1, 3))) continue;  // "怎么样"这类不算
      if (t.includes(win)) strong++;
    }
    for (let i = 0; i + 2 <= run.length; i++) {
      const bg = run.slice(i, i + 2);
      if (COMMON_WORDS.has(bg)) continue;
      usableSet.add(bg);
      if (t.includes(bg)) weakSet.add(bg);
    }
  }
  for (const w of q.split(/[^a-z0-9._\-/]+/)) {
    if (w.length >= 2 && (w.length >= 3 || /[._\-/]/.test(w))) usableSet.add(w);
  }

  const weak = weakSet.size;
  const usable = usableSet.size;
  const score = idents * 2 + strong * 2 + weak;
  const pass = idents > 0 || strong > 0 || weak >= 2 || (usable === 1 && weak === 1);
  return { score, idents, strong, weak, usable, pass };
}

/** 兼容旧调用点：查询里"配得上当判据"的单元（调试/探针用） */
export function gate2Tokens(query: string): string[] {
  const q = normalize(query);
  const out = new Set<string>();
  for (const w of q.split(/[^a-z0-9._\-/]+/)) if (w.length >= 2 && (w.length >= 3 || /[._\-/]/.test(w))) out.add(w);
  for (const run of q.match(CJK_RUN) ?? []) {
    for (let i = 0; i + 2 <= run.length; i++) {
      const bg = run.slice(i, i + 2);
      if (!COMMON_WORDS.has(bg)) out.add(bg);
    }
  }
  return [...out];
}

export interface PickOptions {
  workspaceId?: string; domain?: string; query?: string; top?: number; maxChars?: number;
}

/** 注入预算可用环境变量调，不用改代码：SRELAY_INJECT_TOP / SRELAY_INJECT_BUDGET（总字数） */
function envNum(name: string, dflt: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : dflt;
}

export function pickForInjection(db: Database.Database, o: PickOptions = {}): LessonRow[] {
  const top = o.top ?? envNum('SRELAY_INJECT_TOP', 3);
  // maxChars 是**总预算**（几条加起来），不是每条上限。
  const maxChars = o.maxChars ?? envNum('SRELAY_INJECT_BUDGET', 240);
  const w = visibleWhere(o);
  const rows = (db.prepare(
    "SELECT * FROM lessons WHERE " + w.sql
    + " AND status IN ('verified','confirmed') AND grade <> 'inferred'"
    + " ORDER BY importance DESC LIMIT 40"
  ).all(...w.params) as LessonRow[]).map((r) => ({ ...r, importance: Number(liveImportance(r)) }))
    // SQL 里那两段（status IN (…) AND grade <> 'inferred'）是**便宜的预筛**；
    // 真正的判据是 isInjectable（多了阈值那一条）—— 显示与实际共用它。
    .filter((r) => isInjectable(r));
  if (rows.length === 0) return [];

  // 闸 2 相关性：有本轮查询时才筛；没有查询（如 ZCode 开场 / DSH 冷路径）就退化为
  // 「按重要度给最重要的几条」。**判据本身只有 gate2Score 一处**（红队 A-5/B-7 的收敛点）。
  let ranked = rows;
  if (o.query && o.query.trim()) {
    const scored = rows
      .map((r) => ({ r, ...gate2Score(o.query!, String(r.text ?? '')) }))
      // pass 的判据在 gate2ScoreTokens 里（一处）；全查询只有"这个/怎么/一下"这类词时
      // usable=0 ⇒ 谁都不 pass ⇒ 宁可什么都不给（空输出优于塞噪声）
      .filter((s) => s.pass)
      .sort((a, b) => b.score - a.score || b.r.importance - a.r.importance);
    ranked = scored.map((s) => s.r);
  }

  const out: LessonRow[] = [];
  let used = 0;
  for (const r of ranked) {
    if (out.length >= top) break;
    const len = String(r.text).length;
    // 预算装不下就**跳过这一条、继续看下一条**（原来是 break 直接收摊）。
    // 差别：一条长经验不该把后面短而更相关的经验一起挡掉 —— 预算应该买"最多条有用信息"，
    // 不是"最早遇到的那几条"。排序仍然是相关性优先，所以先到先得更相关，跳过不吃亏。
    if (used + len > maxChars) continue;
    out.push(r);
    used += len;
  }
  return out;
}// ─────────────────────── 冲突消解：新话压旧话（判据唯一一份）───────────────────────
// 用户直接质疑过："记忆会过期、会冲突，这些你们到底做了没？"
// 实测审计（2026-10-17）：出生证 ✅（source_ref/created_at/extracted_version）、
// 保质期 ✅（liveImportance 按日衰减 + INJECT_THRESHOLD，过期自动不注入）、
// 会忘 ✅（cleanup_at/archive/retire/reject）、自我怀疑 ⚠️半做（needs_review 覆盖面有限）、
// **新话压旧话 ⚠️只存在于环境事实抽取**（extractEnvFacts 的 supersede）——决策与经验层完全没有。
// 这正是"今天说了新要求，它却翻出半年前旧记忆继续执行"的根因，所以在这里补上。
//
// 判据**故意保守**：宁可漏判（交人工），也不乱杀一条真经验。四条全中才算冲突。
const NEG_MARKERS = ['不要', '不能', '不用', '不许', '不再', '别用', '避免', '禁止', '弃用', '废弃', '取消',
  '关闭', '禁用', '停止', '撤掉', '移除', '删掉', '不准', '不', '别', '勿', '没有'];

/** 泛词表：它们出现在任何两段技术文字里都不代表"同一主题"（实测误判就是这么来的） */
const GENERIC_TOKENS = new Set([
  '必须', '于是', '因为', '所以', '但是', '而且', '可以', '需要', '使用', '问题', '情况', '时候', '东西',
  '地方', '一个', '这个', '那个', '这些', '那些', '自己', '里面', '上面', '下面', '直接', '基本', '一下',
  '会话', '实测', '根因', '测试', '结果', '原因', '方案', '做法', '写法', '处理', '出现', '导致', '就是',
  '不是', '没有', '不会', '不能', '不要', '如果', '来说', '而是', '还是', '这样', '那样', '什么',
]);

/** 取"实词"：英文词 + CJK 二元组（不引分词器：判据自洽、可单测） */
export function subjectTokens(text: string): Set<string> {
  const s = String(text || '');
  const out = new Set<string>();
  for (const m of s.matchAll(/[A-Za-z][A-Za-z0-9_.\-]{1,}/g)) out.add(m[0].toLowerCase());
  for (const seg of s.replace(/[^一-龥]+/g, ' ').split(' ')) {
    for (let i = 0; i + 2 <= seg.length; i++) out.add(seg.slice(i, i + 2));
  }
  return out;
}

export function hasNegation(text: string): boolean {
  const s = String(text || '');
  return NEG_MARKERS.some((m) => s.includes(m));
}

export interface SupersedePair { olderId: number; newerId: number; shared: string[]; reason: string }

/** 找出"同一主题、极性相反"的经验对（新的在前）。纯函数 ⇒ 可单测；判据错了要立刻红。 */
export function findSupersedeConflicts(rows: LessonRow[]): SupersedePair[] {
  const out: SupersedePair[] = [];
  const seen = new Set<number>();
  const cand = rows.filter((r) => String(r.status) === 'verified');
  for (let i = 0; i < cand.length; i++) {
    for (let j = i + 1; j < cand.length; j++) {
      const a = cand[i], b = cand[j];
      const ka = String(a.scope) + '|' + String(a.workspace_id || '');
      const kb = String(b.scope) + '|' + String(b.workspace_id || '');
      if (ka !== kb) continue;
      const ta = subjectTokens(a.text), tb = subjectTokens(b.text);
      const sharedAll = [...ta].filter((t) => tb.has(t));
      // ⚠️ 关键收紧（实测教训）：泛词（"必须/于是/会话/实测/根因"）不该算共同主题 ——
      // 第一版就是被它们骗出 4 对误判。要求**至少 3 个具体词**，且两条文本本身要够像。
      const shared = sharedAll.filter((t) => !GENERIC_TOKENS.has(t));
      if (shared.length < 3) continue;
      // 相似度用**重叠系数**（除以较短那条的词数）而不是 Jaccard：
      // 两条长度差一倍时 Jaccard 会被稀释到 0.15，把真冲突也筛掉了（实测）。
      const shorter = Math.min(ta.size, tb.size) || 1;
      if (sharedAll.length / shorter < 0.25) continue;
      if (hasNegation(a.text) === hasNegation(b.text)) continue;
      const ta2 = String(a.updated_at || a.created_at || ''), tb2 = String(b.updated_at || b.created_at || '');
      const newer = ta2 >= tb2 ? a : b, older = ta2 >= tb2 ? b : a;
      if (seen.has(older.id)) continue;
      seen.add(older.id);
      out.push({ olderId: older.id, newerId: newer.id, shared: shared.slice(0, 6),
        reason: '被 #' + newer.id + ' 取代（同一主题上出现了相反的说法：' + shared.slice(0, 3).join('/') + '）' });
    }
  }
  return out;
}
