// 捕获同步引擎（技术方案 §5.1 / 改进方案 改动1 注册表化 + 改动3 compaction 警告）
import { createDb, upsertCapturedSession, insertMessage, upsertMessage, rollbackSession,
         bumpMessageCount, getCursor, recordCursor, loadTombstones } from '../store/db.js';
import type { DB } from '../store/db.js';
import type { RelayConfig } from '../shared/config.js';
import { projectIdOf, dbFile } from '../shared/paths.js';
import { loadIgnoreRules, isSessionBlocked } from './ignore.js';
import { ensureRegistered, get, adapterConfig, list } from '../adapters/registry.js';
import type { DiscoveredSession } from '../adapters/types.js';
import type { StatsCounter } from '../core/stats/counter.js';

export interface SyncStats {
  mode: string;
  discovered: number;
  newSessions: number;
  newMessages: number;
  /**
   * 已存在消息的**正文被覆盖**了几条（[1021 审查 #04]）。
   *
   * 为什么要单独计数：流式回答（ZCode 的 part 原地更新）第二次读到的不是新消息，
   * 而是同一条消息的完整正文 —— 它不该计入 newMessages（那会让"新增"这个数字虚高），
   * 但**必须**计入某个可观测的量，否则"重读并覆盖"这件事本身又变成静默行为。
   */
  updatedMessages: number;
  /**
   * 同一 seq 上出现**不同内容**的条数（[1021 回归 P1]）。
   *
   * 这不是"更新"，是**冲突**：源端被整段重写/截断时，旧 seq 会指向另一段话。
   * 我们保留旧正文、不覆盖，并在这里计数 + 往 warnings 里写一条人话 ——
   * 计数存在的意义就是「不许静默丢弃」。
   */
  conflicts?: number;
  resumed: number;
  badLines: number;
  blocked: number;
  warnings: string[];  // 改动 3：compaction 丢数据警告等
}

export interface SyncOptions {
  projectRoot: string;
  config: RelayConfig;
  db?: DB;
  stats?: StatsCounter;
  now?: Date;
  backfillDays?: number;
}

function titleFromMessages(msgs: Array<{ role: string; content: string }>): string | null {
  const first = msgs.find((m) => m.role === 'user' && m.content.trim());
  if (!first) return null;
  return first.content.replace(/\s+/g, ' ').trim().slice(0, 60);
}

// [fork 0922] 会话水位线：内容签名未变 且 会话仍在库里 → 整跳过（discover 仍跑，ingestOne 清零）。
// 背景：N 个项目守护各自监听同一批源目录，源库任何写入都触发所有守护各跑一轮 cycle，
// 每个 cycle 又对每个已知会话跑 3-4 条查询——活跃时段单守护 7.5% 单核，守护越多放大越狠。
// 签名铁律：内容由 adapter.changeProbe（zcode=MAX(rowid) 聚合，每周期 2 条 SQL）决定；
// 文件型源退回 mtimeMs+sizeBytes。不得只用 mtime——内容变更未必 bump mtime（上游测试契约）。
// "仍在库里"缺一不可（上游测试抓出的真缺陷）：rebuild/forget/手动删行后库与签名脱钩，
// 没有它重建后的库永远收不到重摄。已知会话集=每周期一条本地聚合查询，代价毫秒级。
// 内存态即够：守护重启后首轮全量（本就是补账需求）；10 分钟一次全量清扫兜底一切"以为没变其实变了"。
const syncWatermark = new Map<string, string>();
/** 兜底全量扫描间隔：10 分钟。 */
export const FULL_SWEEP_INTERVAL_MS = 600_000;
// [1021 审查 #15 修复] 记录「上一次**真正完成**一轮完整发现」的时刻。
//   病历：原实现每轮同步都执行 `lastFullSweep = Date.now()`，而判据是
//   `Date.now() - lastFullSweep > 600_000` —— 只要同步间隔 < 10 分钟（守护常态，30s/60s 一拍），
//   这个条件**永远不会成立**，"10 分钟兜底全量清扫" 在持续同步时一次都没发生过
//   （报告用假适配器模拟 12 分钟 24 次同步：实测只读了 1 次源）。
//   现在：只有该轮**完整跑完发现阶段**（没抛错 + 所有配置源都注册到了适配器）才推进时间戳；
//   时间源取 opts.now（可注入），测试/脚本能模拟长跨度而不真的睡觉。
let lastFullSweepMs = 0;
/** 这一轮是否该做兜底全量扫描（导出：测试与脚本用同一个判据，不许两处各写一套）。 */
export function fullSweepDue(nowMs: number): boolean {
  return nowMs - lastFullSweepMs > FULL_SWEEP_INTERVAL_MS;
}
/** 一轮**完整**发现结束后调用。失败/半途的轮次不许调（否则兜底又被自己刷掉 = 原 bug）。 */
export function noteFullSweepDone(atMs: number): void {
  lastFullSweepMs = atMs;
}

export async function runSync(opts: SyncOptions): Promise<SyncStats> {
  const root = opts.projectRoot;
  const cfg = opts.config;
  const mode = cfg.capture.mode;
  const result: SyncStats = { mode, discovered: 0, newSessions: 0, newMessages: 0, updatedMessages: 0, resumed: 0, badLines: 0, blocked: 0, warnings: [] };

  if (mode === 'off') return result;

  // [fork 0922] 10 分钟全量清扫：清水位线跑一轮完整 ingest，堵一切"以为没变其实变了"的边角
  // [修 #15] 判定用可注入时钟；**只有本轮真的完整跑完**才推进 lastFullSweepMs（见文件顶部注释）
  const nowMs = (opts.now ?? new Date()).getTime();
  const sweepDue = fullSweepDue(nowMs);
  if (sweepDue) syncWatermark.clear();
  let sweepCompleted = true;   // 源缺适配器 / 中途抛错都会把它置 false

  // 改动 1：注册表初始化（含 custom adapter 加载）——[fork] 原 here 连调两次，
  // 第二次因 customLoaded 守卫恒返回空结果，custom adapter 的加载错误从未上报
  const customResult = ensureRegistered(root);
  for (const err of customResult.errors) result.warnings.push(`custom adapter 加载失败：${err}`);

  const own = !opts.db;
  const db = opts.db ?? createDb(dbFile(root));
  const projectId = cfg.identity.project_id ?? projectIdOf(root);
  // [fork 0922] 已知会话集：库里现存 (source, source_session_id)——水位线跳过的第二个必要条件
  const knownSessions = new Set<string>(
    (db.prepare("SELECT source || ':' || source_session_id AS k FROM sessions WHERE project_id = ?").all(projectId) as Array<{ k: string }>).map(r => r.k)
  );
  const ignoreRules = loadIgnoreRules(root);
  // forget 防复活次级防线（设计 v4 §3.2）：入口整表载入一次，ingest 内 Set 判定
  const tombstones = loadTombstones(db);
  const backfillCutoffMs = opts.backfillDays
    ? (opts.now ?? new Date()).getTime() - opts.backfillDays * 86400_000
    : -Infinity;

  try {
    for (const source of cfg.capture.sources) {
      // 改动 1：从注册表取 adapter（不再 if/else）
      const adapter = get(source);
      if (!adapter) {
        result.warnings.push(`未知会话源：${source}（可用：${list().map(a => a.id).join(', ')}）`);
        sweepCompleted = false;   // [修 #15] 源都没认全，这一轮不算"完整扫描"
        continue;
      }
      const aConfig = adapterConfig(cfg, source);
      const discovered = adapter.discover(root, aConfig);
      // [fork 0922] 内容签名探针：每源每周期一次聚合查询；无探针的源退回 mtime+size
      const probe = adapter.changeProbe?.(aConfig);

      for (const ds of discovered) {
        result.discovered++;
        if (ds.mtimeMs < backfillCutoffMs) continue;

        // [1015 夜 · 红队 B#2a 修复] originHint 必须**每次 sync 都重判**，且要在「墓碑 / ignore / 水位线」
        // 三道 continue **之前**——否则被它们挡下的会话永远拿不到新的分类。
        // 病历：主库残留 33 场真值 workflow_child 的会话 origin 仍是 auto。它们是被
        //   `.sessionrelayignore` 的 `title:workflow subagent` 规则挡下的（本次 sync 拦了 341 场），
        //   根本走不到落库那段；另有一批空闲会话因水位线跳过同样拿不到新分类。
        // 语义：ignore 管的是「别再存新内容」，**已存在的会话其分类应随时幂等收敛**；只动 origin 一列，
        //   manual（用户显式 save）不可降级；墓碑会话早已不在库里，UPDATE 自然 0 行。
        if (ds.originHint) {
          try {
            db.prepare("UPDATE sessions SET origin = ? WHERE source = ? AND source_session_id = ? AND origin != 'manual' AND origin IS NOT ?")
              .run(ds.originHint, ds.source, ds.sourceSessionId, ds.originHint);
          } catch { /* 单行失败不阻塞整批 */ }
        }

        // 墓碑（forget 次级防线）：被遗忘会话的新字节直接丢弃，游标也不推进
        if (tombstones.has(`${ds.source}:${ds.sourceSessionId}`)) {
          result.blocked++;
          continue;
        }

        // 两层 ignore
        if (isSessionBlocked(ignoreRules, { source: ds.source, sourceSessionId: ds.sourceSessionId, title: ds.title ?? null, sourceFile: ds.sourceFile })) {
          result.blocked++;
          opts.stats?.increment('blocked_by_ignore');
          continue;
        }

        // [fork 0922] 水位线：内容签名未变 且 会话仍在库里 → 跳过（rebuild/forget/删行后自动失效）
        const wmKey = `${ds.source}:${ds.sourceSessionId}`;
        const sig = probe
          ? probe.get(ds.sourceSessionId)
          : (ds.mtimeMs !== undefined ? `${ds.mtimeMs}:${ds.sizeBytes}` : undefined);
        if (sig !== undefined && syncWatermark.get(wmKey) === sig && knownSessions.has(wmKey)) continue;

        await ingestOne(db, ds, { mode, projectId, cfg, result, stats: opts.stats, ignoreRules, tombstones, source, aConfig });
        if (sig !== undefined) syncWatermark.set(wmKey, sig);
      }
    }
  } catch (e) {
    // [修 #15] 中途抛错的轮次不算"完整扫描"：保持旧时间戳，下一轮重试（finally 里也不会推进）
    sweepCompleted = false;
    throw e;
  } finally {
    if (own) db.close();
    // [修 #15] 只有**真正完整**的一轮才推进兜底时间戳；中途抛错/缺源时保持旧时间戳，下一轮重试。
    if (sweepDue && sweepCompleted) noteFullSweepDone(nowMs);
  }
  // [1015 夜] 看板自动区刷新必须挂在**守护这条路径**上（runSync），不能只挂在 `srelay sync` 命令上——
  // 实测守护进程跑的就是 runSync，于是「全自动」在真实使用里从没自动过（只有手动 sync 才会刷）。
  // 契约不变：只重写模块列 = auto:todos 的行 + 只刷新本工具生成的图；人写的行一个字节不动。
  // 动态 import 避免 capture→cli 的静态分层倒挂；失败不连坐捕获。
  try {
    const { syncKanbanAuto } = await import('../cli/kanban.js');
    syncKanbanAuto(opts.projectRoot, opts.config);
  } catch { /* 看板刷不新不影响捕获 */ }
  return result;
}

/** 供 save/CLI 使用的发现器（注册表版） */
export function discoverAll(root: string, cfg: RelayConfig): DiscoveredSession[] {
  ensureRegistered(root);
  const out: DiscoveredSession[] = [];
  for (const source of cfg.capture.sources) {
    const adapter = get(source);
    if (!adapter) continue;
    out.push(...adapter.discover(root, adapterConfig(cfg, source)));
  }
  return out;
}

/** 手动 save 专用（D2 并存范式） */
export async function captureSessions(opts: {
  projectRoot: string;
  config: RelayConfig;
  db: DB;
  sessions: DiscoveredSession[];
  stats?: StatsCounter;
}): Promise<SyncStats> {
  const cfg = opts.config;
  const result: SyncStats = { mode: 'manual', discovered: opts.sessions.length, newSessions: 0, newMessages: 0, updatedMessages: 0, resumed: 0, badLines: 0, blocked: 0, warnings: [] };
  const ignoreRules = loadIgnoreRules(opts.projectRoot);
  const tombstones = loadTombstones(opts.db);
  const projectId = cfg.identity.project_id ?? projectIdOf(opts.projectRoot);
  ensureRegistered(opts.projectRoot);

  for (const ds of opts.sessions) {
    if (tombstones.has(`${ds.source}:${ds.sourceSessionId}`)) {
      result.blocked++;
      // C7：save 命中遗忘闸必须非静默（用户在场）；自动守护路径（runSync）只计数防刷屏
      result.warnings.push(`会话「${ds.title ?? ds.sourceSessionId}」曾被 srelay forget，已拒绝重新收录（如确需恢复：删除墓碑表对应行与 .sessionrelayignore 的 session: 规则后 rebuild）`);
      continue;
    }
    if (isSessionBlocked(ignoreRules, { source: ds.source, sourceSessionId: ds.sourceSessionId, title: ds.title ?? null, sourceFile: ds.sourceFile })) {
      result.blocked++;
      opts.stats?.increment('blocked_by_ignore');
      result.warnings.push(`会话「${ds.title ?? ds.sourceSessionId}」被忽略规则拦截（.sessionrelayignore），未存储`);
      continue;
    }
    const adapter = get(ds.source);
    if (!adapter) { result.warnings.push(`未知源：${ds.source}`); continue; }
    await ingestOne(opts.db, ds, { mode: 'full', projectId, cfg, result, stats: opts.stats, ignoreRules, tombstones, source: ds.source, aConfig: adapterConfig(cfg, ds.source), origin: 'manual' });
  }
  return result;
}

async function ingestOne(
  db: DB,
  ds: DiscoveredSession,
  ctx: { mode: string; projectId: string; cfg: RelayConfig; result: SyncStats; stats?: StatsCounter; ignoreRules: string[]; tombstones: Set<string>; source: string; aConfig: import("../adapters/types.js").AdapterConfig; origin?: 'auto' | 'manual' },
): Promise<void> {
  const adapter = get(ds.source);
  if (!adapter) return;

  // 墓碑（forget 次级防线）：读都不读，直接丢弃（主防线 session: ignore 在入口已挡）
  if (ctx.tombstones.has(`${ds.source}:${ds.sourceSessionId}`)) {
    ctx.result.blocked++;
    return;
  }

  const cursorBefore = getCursor(db, ds.source, ds.sourceFile);
  const read = await adapter.readNew(ds, cursorBefore, ctx.aConfig);
  ctx.result.badLines += read.badLines;

  // 改动 3：compaction 丢数据检测
  if (adapter.detectCompaction) {
    const compaction = adapter.detectCompaction(ds, ctx.aConfig);
    if (compaction && compaction.estimatedDeleted > 10) {
      const sessionRow = db.prepare(
        'SELECT id FROM sessions WHERE source = ? AND source_session_id = ?'
      ).get(ds.source, ds.sourceSessionId) as { id: string } | undefined;
      if (sessionRow) {
        const hasCompMsg = (db.prepare(
          "SELECT COUNT(*) n FROM messages WHERE session_id = ? AND role = 'system' AND content LIKE '[上下文压缩摘要]%'"
        ).get(sessionRow.id) as { n: number }).n > 0;
        if (!hasCompMsg) {
          ctx.result.warnings.push(
            `⚠️ 会话「${ds.title ?? ds.sourceSessionId}」检测到上下文压缩，约 ${compaction.estimatedDeleted} 条原始消息可能已丢失（建议开启守护 srelay watch --install-service）`
          );
        }
      }
    }
  }

  const firstUserTitle = titleFromMessages(read.messages);
  const lastEventAt = read.messages.length > 0
    ? (read.messages[read.messages.length - 1].createdAt ?? ds.updatedAt ?? new Date().toISOString())
    : ds.updatedAt ?? new Date().toISOString();

  // 两层 ignore：入库前 title 复查（用已导入的 isSessionBlocked，不用动态 import）
  if (isSessionBlocked(ctx.ignoreRules, { source: ds.source, sourceSessionId: ds.sourceSessionId, title: ds.title ?? firstUserTitle, sourceFile: ds.sourceFile })) {
    ctx.result.blocked++;
    ctx.stats?.increment('blocked_by_ignore');
    db.transaction(() => recordCursor(db, ds.source, ds.sourceFile, read.cursor, { badLines: read.badLines }))();
    return;
  }

  db.transaction(() => {
    const up = upsertCapturedSession(db, {
      source: ds.source,
      sourceSessionId: ds.sourceSessionId,
      projectId: ctx.projectId,
      title: ds.title ?? firstUserTitle,
      createdAt: ds.createdAt ?? lastEventAt,
      lastEventAt,
      sourceFile: ds.sourceFile,
      // [fork 0924] 适配器的来源提示（如 zcode 工作流子代理→workflow）优先于默认 auto
      origin: ds.originHint ?? ctx.origin,
    });
    if (up.isNew) ctx.result.newSessions++;

    if (!up.isNew && up.prevState !== 'active' && read.messages.length > 0) {
      rollbackSession(db, up.id);
      ctx.result.resumed++;
      ctx.stats?.increment('resumed');
    }

    // 会话复活：归档后新消息到达 → 清除 cleanup_at，回到 hot 层
    if (!up.isNew && read.messages.length > 0) {
      db.prepare('UPDATE sessions SET cleanup_at = NULL WHERE id = ? AND cleanup_at IS NOT NULL').run(up.id);
    }

    if (ctx.mode === 'full') {
      // [1021 审查 #04] 流式回答的正文是**原地更新**的：同一条消息第二次读到的内容更长/更完整。
      //   原来这里只调 insertMessage（内部是 INSERT OR IGNORE + UNIQUE(session_id, seq_num)）
      //   ⇒ 覆盖被静默丢弃 ⇒ 库里永久留着半截回答，且没有任何迹象。
      //   改用 upsertMessage：新消息照常插入，已存在的正文变了就覆盖。
      //   计数要分开：覆盖不算 newMessages（否则"新增"虚高），但要计入 updatedMessages（否则又静默）。
      // [1021 回归 P1] 覆盖**只在流式生长时**发生（判据在 upsertMessage 里）。
      //   其余"同一 seq 上坐着不同内容"的情况说明源端被整段重写/截断了 ——
      //   保留旧正文，并把冲突**报出来**：静默盖掉等于替你丢了已采到的原文。
      let inserted = 0;
      let updated = 0;
      let conflicts = 0;
      for (const m of read.messages) {
        const u = upsertMessage(db, { sessionId: up.id, role: m.role, content: m.content, seqNum: m.seqNum, createdAt: m.createdAt });
        if (u.updated) updated++;
        else if (u.conflict) conflicts++;
        else inserted += u.changes;
      }
      if (inserted > 0) bumpMessageCount(db, up.id, inserted);
      ctx.result.newMessages += inserted;
      ctx.result.updatedMessages += updated;
      if (conflicts > 0) {
        ctx.result.conflicts = (ctx.result.conflicts ?? 0) + conflicts;
        ctx.result.warnings.push(
          '会话「' + (ds.title ?? ds.sourceSessionId) + '」有 ' + conflicts + ' 条消息在同一序号上内容不同'
          + '（源文件可能被整段重写/截断）——已保留库内旧正文，未覆盖。'
          + '如确认源端为新版本，可用 srelay forget 该会话后重新收录。',
        );
      }
    } else {
      bumpMessageCount(db, up.id, read.messages.length);
      ctx.result.newMessages += read.messages.length;
    }

    recordCursor(db, ds.source, ds.sourceFile, read.cursor, {
      badLines: read.badLines,
      suspect: read.badLines > 50,
    });
  })();
}
