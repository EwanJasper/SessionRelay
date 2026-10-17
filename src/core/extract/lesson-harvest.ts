// 规则抽取：从项目记忆里**刨**出`踩过的坑`这类句子，落成**草稿**。
//
// 三条纪律（设计 §11.2 / §11.3）：
//   ① **只产草稿**：draft 永远不进注入层 —— 自动化的东西不许直接污染全局注入；
//   ② **必须能回指**：每条都带 quote（原句）与 source_ref（会话:消息），人可复核；
//   ③ **等级不吹牛**：原句逐字出自**用户消息** ⇒ verified-user；否则一律 inferred。
//      哪怕是 verified-user，也只让它**有资格**进注入层，仍然先是草稿 —— 升 verified 要人点头或证据复核。
//
// 为什么不做成守护自动跑：抽错一句话就会污染**所有项目**的注入。让它是个显式命令，
// 人（或排程）决定什么时候跑、跑完要不要收。
import { addLesson } from '../../store/global.js';

const PATTERNS = [
  '踩坑', '血的教训', '教训是', '下次一定', '以后再', '以后要', '千万别', '别再', '不要再',
  '坑在', '根因是', '根因在', '原因是', '问题在于', '注意不能', '一定要注意', '务必',
  '失败的原因', '为什么不成功', '走过的弯路', '绕了远路', '白折腾', '浪费了',
];

const SENT_SPLIT = /(?<=[。！？；!?;\n])/;

export interface Harvested { text: string; quote: string; sourceRef: string; role: string; level: 'verified-user' | 'inferred' }

/**
 * 从一批消息里刨候选。纯函数，便于测试；写库由调用方做。
 * @param msgs [{ role, content, seqNum, sessionId }]
 */
export function harvestCandidates(msgs: Array<{ role: string; content: string; seqNum?: number; sessionId?: string }>, opts: { minLen?: number; maxLen?: number } = {}): Harvested[] {
  const minLen = opts.minLen ?? 12;
  const maxLen = opts.maxLen ?? 120;
  const out: Harvested[] = [];
  const seen = new Set<string>();
  for (const m of msgs) {
    const content = String(m.content ?? '');
    if (!content) continue;
    for (const raw of content.split(SENT_SPLIT)) {
      const s = raw.trim().replace(/\s+/g, ' ');
      if (s.length < minLen || s.length > maxLen) continue;
      if (!PATTERNS.some((p) => s.includes(p))) continue;
      // 必须像`一条经验`而不是`一句吐槽`：至少含一个动词性词尾或因果词
      if (!/[是为要别的不没]/.test(s)) continue;
      if (seen.has(s)) continue;
      seen.add(s);
      out.push({
        text: s.length > 80 ? s.slice(0, 80) : s,
        quote: s,
        sourceRef: (m.sessionId ?? '') + ':' + (m.seqNum ?? ''),
        role: String(m.role ?? ''),
        level: m.role === 'user' ? 'verified-user' : 'inferred',
      });
    }
  }
  return out;
}

// ─────────── 写库（1021：从 CLI 提进内核）───────────
//
// 为什么提进来：生命周期要跑采集，而"外挂脚本降级为内核 API 的薄壳"是本仓铁律 ——
// 若生命周期去 spawn CLI，判据就分成两份（CLI 参数 vs 内核默认值）。
//
// ⚠️ 行为变化（必须知道）：它**现在会被生命周期自动跑**（默认开）。
//   为什么敢自动跑：产出永远是 draft，draft 不进注入层；逐项目独立、按全文去重；
//   抽错的代价最多是"草稿里多一条"，而每条都带 quote + sourceRef，人复核一眼可见。
//
// ⚠️ 与 grade 的关系（上一轮我一度说错，记在这里防再错）：
//   level = role==='user' ? 'verified-user' : 'inferred'
//   ⇒ **用户消息产的候选是能进注入层的**（confirm 成 verified 之后 7.5 分 > 阈值 5.5）；
//     只有当"助手消息产的 inferred"才是出生即死（1.5 分，且闸 1 硬排除 inferred）。

export interface HarvestReport {
  /** 扫过的消息数 */
  scanned: number;
  /** 刨出的候选数 */
  found: number;
  /** 去掉库里已有之后的新条数 */
  fresh: number;
  /** 真写进库的条数（draft） */
  written: number;
  /** 落库后不是 draft 的（写入语义被别处改了）—— 任何 >0 都要吼出来 */
  notDraft: string[];
  /** 本轮"库里已有、只把 hits 加了 1"的条数（重复遇到 = 反复发生的真坑） */
  repeated: number;
  /** 取样（前 20 条新候选；dry-run 与事件日志用） */
  samples: Harvested[];
}

export interface HarvestOptions {
  /** 回看多少天（默认 7） */
  days?: number;
  /** 只统计不写（默认 false） */
  dry?: boolean;
  /** 每个项目最多扫多少条消息（默认 4000） */
  cap?: number;
  /**
   * 项目所属领域（来自 .sessionrelay/config.json 的 domain 字段）。
   *
   * 给了 ⇒ 产出 scope='domain'，**同领域的项目共享**这批草稿；
   * 没给 ⇒ 退回 scope='project'，只有本项目看得见。
   *
   * 为什么是"给了才共享"而不是默认共享：domain 是**人显式分的组**（writing / music-app /
   * minecraft …）。没分组就共享等于"把写代码的经验注入到写小说的项目"——猜错比不猜更糟。
   * 未分组项目的行为与之前完全一致（scope='project'），所以这条改动对它们零影响。
   */
  domain?: string;
}

type AnyStmt = {
  all: (...a: unknown[]) => unknown[];
  get?: (...a: unknown[]) => unknown;
  run?: (...a: unknown[]) => unknown;
};
type AnyDb = { prepare: (s: string) => AnyStmt };

/**
 * 从一个项目库采集经验，写进全局库。**只产草稿**、幂等（按全文去重）。
 *
 * @param gdb 全局库存取（addLesson 落这里）
 * @param pdb 项目库（读 messages）
 * @param workspaceId 该项目的工作区键（写进 lessons.workspace_id，决定"哪些项目能看到"）
 */
export function harvestLessons(gdb: AnyDb, pdb: AnyDb, workspaceId: string, opts: HarvestOptions = {}): HarvestReport {
  const days = opts.days ?? 7;
  const cap = opts.cap ?? 4000;
  const since = new Date(Date.now() - days * 86400000).toISOString();

  let msgs: Array<{ sid: string; role: string; content: string; seq: number }> = [];
  try {
    msgs = pdb.prepare(
      'SELECT m.session_id AS sid, m.role AS role, m.content AS content, m.seq_num AS seq'
      + ' FROM messages m JOIN sessions s ON s.id = m.session_id'
      + ' WHERE m.created_at >= ? AND length(m.content) BETWEEN 20 AND 400'
      + ' ORDER BY m.created_at DESC LIMIT ?'
    ).all(since, cap) as typeof msgs;
  } catch { msgs = []; }   // 老库没有 seq_num 之类 —— 采集失败不该让生命周期红

  const cands = harvestCandidates(msgs.map((m) => ({ role: m.role, content: m.content, seqNum: m.seq, sessionId: m.sid })));
  const existing = new Set(
    (gdb.prepare('SELECT text FROM lessons').all() as Array<{ text?: string }>).map((r) => String(r.text ?? '')),
  );
  const fresh = cands.filter((c) => !existing.has(c.text));

  // ── [1021 C1] 重复遇到 = 真信号，不再静默丢掉 ──
  //
  // 病历：原来库里已有的候选**直接跳过**，一点痕迹都不留。于是"同一句经验被反复挖出来"
  // 这个最强的信号被扔了 —— 反复出现恰恰说明它是**反复发生的真坑**，而不是一次性的吐槽。
  //
  // 现在：给已有条目 hits+1（封顶 HITS_CAP）。
  //   · hits 进 liveImportance 的 min(1, hits*0.1) ⇒ 最多 +1.0，**永远推不过注入线**
  //     （inferred 1.5 + 1.0 = 2.5 < 阈值 5.5）⇒ 不可能靠"被重复挖到"混进 prompt；
  //   · 它的真正用途是给 maintainLessons 一个"该拎出来给人看"的依据（见 C1 那段）。
  //   口径仍然是那句：**机器不确定时标记不确定，而不是替人下结论**。
  const HITS_CAP = 20;
  let repeated = 0;
  if (!opts.dry) {
    const dupTexts = new Set(cands.filter((c) => existing.has(c.text)).map((c) => c.text));
    if (dupTexts.size) {
      const bump = gdb.prepare('UPDATE lessons SET hits = MIN(hits + 1, ?), updated_at = ? WHERE text = ?');
      const nowIso = new Date().toISOString();
      for (const t of dupTexts) { bump.run?.(HITS_CAP, nowIso, t); repeated++; }
    }
  }

  const report: HarvestReport = {
    scanned: msgs.length, found: cands.length, fresh: fresh.length, written: 0, notDraft: [],
    repeated,
    samples: fresh.slice(0, 20),
  };
  if (opts.dry || !fresh.length) return report;

  for (const c of fresh) {
    const input = {
      text: c.text, quote: c.quote, sourceRef: c.sourceRef,
      route: c.role === 'user' ? 'user-message' : 'none',
      grade: c.level,
      // 有 domain ⇒ domain 级（同领域共享）；无 ⇒ project 级（仅本项目）
      scope: (opts.domain ? 'domain' : 'project') as 'domain' | 'project',
      workspaceId,
      ...(opts.domain ? { domain: opts.domain } : {}),
      // 显式 draft：自动提取 ≠ 人工确认（三者：抽取/confirm/评级，各自独立）
      status: 'draft' as const,
    };
    const r = addLesson(gdb as never, input);
    // 回读真实状态：不信任写入参数，也不信任 addLesson 的返回值
    const row = gdb.prepare('SELECT status FROM lessons WHERE id = ?').get?.(r.id) as { status?: string } | undefined;
    const saved = String(row?.status ?? '');
    if (saved === 'draft') report.written++;
    else report.notDraft.push(r.id + ' → ' + (saved || '读不到状态'));
  }
  return report;
}