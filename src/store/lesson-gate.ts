// 经验闸门的**唯一判据**（纯函数模块：零依赖，不 import 任何数据库）
//
// 为什么要从 store/global.ts 里拆出来（1017 夜）：
//   面板宿主半必须能读到"哪条经验现在能进注入层"，而它跑在没有原生模块的进程里。
//   原先 GRADES/INJECT_THRESHOLD/isInjectable/liveImportance 住在 store/global.ts，
//   那个文件顶部静态 import 了 better-sqlite3 ⇒ 任何想用判据的模块都被拖上 27MB 原生依赖。
//   拆出来后：**判据只有这一份**（global.ts 原样再导出，老调用点一字不改），
//   而面板只需要 import 这个文件，vendor 里连 node_modules 都不用放。
//
// 纪律：本文件不许 import 任何东西。一旦有人加 import，面板的零依赖就没了 —— 加个测试钉住它。

export const GRADES = {
  'verified-tool': 9.0,
  'verified-user': 7.5,
  'verified-file': 6.0,
  inferred: 1.5,
} as const;
export type Grade = keyof typeof GRADES;
export type Scope = 'project' | 'domain' | 'global';
export type Status = 'draft' | 'verified' | 'retired';

/**
 * 能进注入层的最低分。
 *
 * ⚠️ 必须是 5.5 而不是 6.0：verified-file 的基础分正好是 6.0，阈值若也取 6.0，
 * 那么**任何一丁点年龄衰减都会把它压到线下**（哪怕只过了几毫秒）——实测被测试抓到过
 * （expected 1 to be 2）。留 0.5 的间隔 = 新经验白送约 60 天曝光期，之后要靠被用来续命。
 */
export const INJECT_THRESHOLD = 5.5;
/** 年龄衰减：每天扣多少分（照抄实测值） */
export const DECAY_PER_DAY = 0.0083;

export interface LessonRow {
  id: number; scope: Scope; workspace_id: string | null; domain: string | null;
  text: string; grade: Grade; importance: number; status: Status;
  hits: number; uses: number; needs_review: number; created_at: string;
  source_ref?: string | null; updated_at?: string | null; quote?: string | null; search_text?: string | null;
}

/**
 * 闸 1 的**唯一判据**：这一条现在能不能进注入层（状态 + 定级 + 阈值，三样一起看）。
 *
 * 为什么要单拎出来（复审 C-3）：lesson list 的 ●/○ 此前只看分数不看 status，
 * 于是一条 rejected 但分数 7.5 的条目会显示"● 可进注入层"——而它根本进不去。
 * 现在显示与实际共用这一个函数。
 */
export function isInjectable(row: LessonRow, now = Date.now()): boolean {
  const st = String(row.status);
  if (st !== 'verified' && st !== 'confirmed') return false;
  if (row.grade === 'inferred') return false;
  return liveImportance(row, now) >= INJECT_THRESHOLD;
}

/** 年龄衰减后的实时重要度（定级分**不重算**，重算的是这个） */
export function liveImportance(row: LessonRow, now = Date.now()): number {
  const days = Math.max(0, (now - Date.parse(row.created_at)) / 86400000);
  const bonus = Math.log1p(row.uses) * 1.5 + Math.min(1.0, row.hits * 0.1);
  return row.importance - days * DECAY_PER_DAY + bonus;
}
