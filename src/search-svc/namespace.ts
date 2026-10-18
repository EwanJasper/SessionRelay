import fs from 'node:fs';
import Database from 'better-sqlite3';
import { searchSessions, type SearchHit, type SearchOptions } from './engine.js';
import { registryCandidates } from '../shared/registry.js';
import { loadConfig } from '../shared/config.js';
import { dbFile, projectIdOf } from '../shared/paths.js';

/**
 * 检索的两种「命名空间」（研究报告 §1.2 建议 #1，抄 LangGraph Store 的 tuple 前缀语义，不抄它的 Postgres）。
 *
 * ── 为什么要它 ────────────────────────────────────────────────────────
 * 现状是**一个项目一个 SQLite**（写路径隔离最便宜可靠）。代价是：用户想找
 * 「我在别的项目里也遇到过这件事」时，没有入口 —— 只能逐个项目去翻。
 *
 * 但**不能反过来把库合了**。学术侧的证据（fan effect / EWC / 多租户记忆文献）
 * 指向同一件事：共享索引 = 共享表征，库越大检索精度越掉；隔离要**结构性**
 * （查询侧带 project 维度），不是事后过滤。所以：
 *   · 物理分库**不动**
 *   · 读时联邦（read-only fan-out + 合并），复用已有的每库引擎
 *
 * ── 合并规则：按名次轮转（rank interleaving）──────────────────────────
 * 这是本文件最关键的一个决定，理由不是"看起来公平"：
 *
 * 不同项目库的 BM25 分数**不可比**（语料规模、平均长度、词表都不一样）。
 * 直接按 score 排序会出现"大库永远霸榜"；而按分数归一化再排，又会引入一个
 * 新的、无法用单库回归测试验证的变换。
 *
 * 更硬的要求来自研究报告引的 admissibility 判据（2610.07309）：
 *   **「过滤跨项目条目」不得改变「项目内条目排序」**
 * 这个性质必须**由构造成立**，不能靠调参之后"看起来差不多"。
 *
 * 名次轮转天然满足：每个项目内部保持引擎给出的原次序，跨项目只决定
 * "第 k 轮谁先出场"。所以把别的项目过滤掉，剩下的序列与原序列**逐位相同**。
 */

export type NamespaceMode = 'project' | 'global';

export interface NamespacedHit extends SearchHit {
  /** 来自哪个项目根目录（global 模式下必须带，否则用户无法判断可信度） */
  projectRoot: string;
  /** 项目显示名（目录名） */
  projectName: string;
}

/**
 * 注意 project 在检索选项里是**可选**且**不对外**的：每个项目库都有自己的 project_id，
 * 联邦检索时必须用**那个库自己的**身份去查，不能把调用方的 project 套到别人的库上
 * （否则 extraWhere/scope 会把别人的结果全过滤掉 —— 这是很容易写出"全局检索永远 0 条"的坑）。
 */
export interface NamespaceSearchOptions extends Omit<SearchOptions, 'project'> {
  /** 'project'（默认，只查本库）| 'global'（跨库联邦，只读） */
  mode?: NamespaceMode;
  /** project 模式必填：要查哪个项目 */
  projectRoot?: string;
  /** global 模式最多扫几个库（防止几十个项目时一把梭） */
  maxProjects?: number;
  /** global 模式：只要这些项目（给"只看最近用过的"这种用法留口子） */
  onlyProjects?: string[];
}

/** 一个项目的检索结果（合并的输入单元） */
export interface ProjectHits {
  projectRoot: string;
  projectName: string;
  hits: SearchHit[];
}

/**
 * 合并：按名次轮转。**项目内次序原样保留**（admissibility 由构造保证）。
 * 轮次顺序由各组「首条命中」的分数决定 —— 只影响谁先出场，不影响组内顺序。
 */
export function mergeByRoundRobin(groups: ProjectHits[], limit = 20): NamespacedHit[] {
  const usable = groups
    .filter((g) => g.hits.length > 0)
    // 首条分数只用于决定"哪个项目先出场"，组内不改序
    .sort((a, b) => (b.hits[0]?.score ?? 0) - (a.hits[0]?.score ?? 0) || a.projectName.localeCompare(b.projectName));

  const out: NamespacedHit[] = [];
  const seen = new Set<string>();
  for (let rank = 0; out.length < limit; rank++) {
    let progressed = false;
    for (const g of usable) {
      const h = g.hits[rank];
      if (!h) continue;
      progressed = true;
      // 同一个 sessionId 跨项目不该出现（id 是全局唯一 hash），去重只为防御
      if (seen.has(h.sessionId)) continue;
      seen.add(h.sessionId);
      out.push({ ...h, projectRoot: g.projectRoot, projectName: g.projectName });
      if (out.length >= limit) break;
    }
    if (!progressed) break;
  }
  return out;
}

/**
 * admissibility 回归判据（**唯一实现**）：
 * 把合并结果过滤到某一个项目后，它的**相对次序**必须与该项目单独检索时逐位相同。
 * 返回 true = 通过。
 */
export function admissible(merged: NamespacedHit[], single: ProjectHits, opts: { totalGroups?: number; limit?: number } = {}): boolean {
  const inMerged = merged.filter((h) => h.projectRoot === single.projectRoot).map((h) => h.sessionId);
  const inSingle = single.hits.map((h) => h.sessionId);

  // [红队 ②] 旧实现只比较"合并里出现的那些"的相对次序，有两个盲区（都实测过）：
  //   · limit 小到让某组完全没出现 → 真空通过（组丢了也说 OK）
  //   · 丢中间一段 → 剩下的仍是递增 → 通过
  // 正确实现里轮转只取各组前缀、limit 只截尾，但**判据不能靠"实现应该是对的"来自证**，
  // 否则它就只能验证它自己假设过的东西。改成前缀等式：合并结果必须**逐位等于**单库结果的前缀。
  if (inMerged.length > inSingle.length) return false;
  for (let i = 0; i < inMerged.length; i++) {
    if (inMerged[i] !== inSingle[i]) return false;   // 位次不符（含丢中段、乱序）⇒ 不可容许
  }
  // 组里有货却一条都没出现：只有在 limit 确实装不下这么多组时才允许（否则就是漏项）
  if (inMerged.length === 0 && inSingle.length > 0) {
    const groups = opts.totalGroups ?? 1;
    const limit = opts.limit ?? Infinity;
    if (limit >= groups) return false;   // limit 装得下却没出现 ⇒ 漏了整组
  }
  return true;
}

/** 列出有库的项目（复用注册表，自动剪掉失效条目） */
export function projectsWithDb(): Array<{ root: string; name: string }> {
  return registryCandidates()
    .filter((c) => fs.existsSync(dbFile(c.root)))
    .map((c) => ({ root: c.root, name: c.name }));
}

/**
 * 两态检索入口。
 * · project：只开一个库（默认；行为与原来等价）
 * · global ：只读扇出到各项目库，合并后带 provenance 返回
 * 任何单个库打不开都**跳过并记下原因**，不许因为一个坏库废掉整次检索。
 */
export function searchNamespaced(opts: NamespaceSearchOptions): {
  hits: NamespacedHit[];
  mode: NamespaceMode;
  scanned: number;
  failed: Array<{ projectRoot: string; reason: string }>;
} {
  const mode: NamespaceMode = opts.mode ?? 'project';
  const limit = opts.limit ?? 20;
  const failed: Array<{ projectRoot: string; reason: string }> = [];

  const targets = mode === 'project'
    ? [{ root: String(opts.projectRoot ?? ''), name: String(opts.projectRoot ?? '').split(/[\\/]/).pop() ?? '' }]
    : projectsWithDb()
        .filter((p) => !opts.onlyProjects || opts.onlyProjects.includes(p.root))
        .slice(0, opts.maxProjects ?? 20);

  const groups: ProjectHits[] = [];
  for (const t of targets) {
    const file = dbFile(t.root);
    if (!file || !fs.existsSync(file)) { failed.push({ projectRoot: t.root, reason: '库不存在' }); continue; }
    let db: Database.Database | null = null;
    try {
      // **只读**打开：联邦检索绝不能顺手迁移别人的库
      db = new Database(file, { readonly: true, fileMustExist: true });
      // 用**该库自己的** project_id（读它自己的 config）；读不到就退回用 root。
      // 绝不能用调用方的 project —— 那会让别人的库把所有结果过滤光。
      // 身份顺序：配置里的 identity.project_id → 用 projectIdOf 现算（与写路径同一公式）→ 都没有才算失败。
      // ⚠️ 红队实证：以前兜底成 root 是**静默空结果** —— engine 按 s.project_id 过滤，
      //   而 agent1super 库里 project_id='proj_d--agent1super'，拿 'D:/agent1super' 去查是 0 行，
      //   还不算 failed。表现为"全局检索对这个库永远没结果"且不报错。
      let ownProject = '';
      try { ownProject = String(loadConfig(t.root).identity?.project_id ?? ''); } catch { /* 配置坏了就现算 */ }
      if (!ownProject) { try { ownProject = projectIdOf(t.root); } catch { ownProject = ''; } }
      if (!ownProject) { failed.push({ projectRoot: t.root, reason: '无法确定 project_id（配置与现算都失败），跳过以免返回空结果误导' }); continue; }
      const hits = searchSessions(db as never, { ...opts, project: ownProject, limit });
      groups.push({ projectRoot: t.root, projectName: t.name, hits });
    } catch (e) {
      failed.push({ projectRoot: t.root, reason: String((e as Error).message).slice(0, 60) });
    } finally { try { db?.close(); } catch { /* 已关 */ } }
  }

  // project 模式不做轮转（只有一个组），保证与旧行为逐位一致
  const hits = mode === 'project'
    ? groups.flatMap((g) => g.hits.slice(0, limit).map((h) => ({ ...h, projectRoot: g.projectRoot, projectName: g.projectName })))
    : mergeByRoundRobin(groups, limit);

  return { hits, mode, scanned: targets.length, failed };
}
