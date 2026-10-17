// ZCode Adapter（统一接口版，改进方案 改动1 + 改动2 compaction 摘要）
// 存储：~/.zcode/cli/db/db.sqlite（WAL 活动库，只读连接）
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import type { SessionSourceAdapter, AdapterConfig, DiscoveredSession, ReadResult, CompactionInfo } from '../types.js';

export const SOURCE_ID = 'zcode';

// changeProbe 的失败留痕（适配器接口没有 logger / 警告通道，先把事实留在模块态，不让它无声无息）
export let changeProbeFailures = 0;
export let changeProbeLastError: string | null = null;

// 连接缓存：守护每 30 秒调用 discover/readNew，避免每次开/关导致句柄泄漏
let cachedConn: InstanceType<typeof Database> | null = null;
let cachedPath: string | null = null;

function getConn(dbPath: string): InstanceType<typeof Database> {
  if (cachedConn && cachedPath === dbPath && fs.existsSync(dbPath)) return cachedConn;
  if (cachedConn) { try { cachedConn.close(); } catch { /* 已关 */ } }
  cachedConn = new Database(dbPath, { readonly: true });
  cachedConn.pragma('busy_timeout = 3000');
  cachedPath = dbPath;
  return cachedConn;
}

/** 仅供测试：重置连接缓存（连带表结构探测缓存） */
export function resetConn(): void {
  if (cachedConn) { try { cachedConn.close(); } catch { /* 忽略 */ } }
  cachedConn = null;
  cachedPath = null;
  cachedCols = null;
}

// ── 表结构探测（[1021 #04] 需要 time_updated 这一列，但老库/测试夹具不一定有）──
// 用 PRAGMA 明确问一次再选 SQL：缺列时**换判据**而不是 try/catch 兜 ——
// catch 兜会让「缺列」和「查询写错」看起来一模一样，本仓吃过这个形状的亏。
let cachedCols: { dbPath: string; message: Set<string>; part: Set<string>; session: Set<string> } | null = null;

function tableCols(z: InstanceType<typeof Database>, table: 'message' | 'part' | 'session'): Set<string> {
  const rows = z.prepare('PRAGMA table_info(' + table + ')').all() as Array<{ name?: unknown }>;
  return new Set(rows.map((r) => String(r.name ?? '')));
}

function schemaOf(z: InstanceType<typeof Database>, dbPath: string) {
  if (!cachedCols || cachedCols.dbPath !== dbPath) {
    cachedCols = {
      dbPath,
      message: tableCols(z, 'message'),
      part: tableCols(z, 'part'),
      session: tableCols(z, 'session'),
    };
  }
  return cachedCols;
}

/** 「最近一次写入/更新」的时间列：有 time_updated 就用它 —— **原地 UPDATE 会把它往前推**，
 *  这正是 #04 要的信号（同一条 part 正文变完整时 rowid 不变）；老库没有这一列时退回 time_created。
 *  本机真实 ZCode 库实测：message / part 两表都有 time_created + time_updated。 */
function touchCol(cols: Set<string>): string {
  return cols.has('time_updated') ? 'time_updated' : 'time_created';
}

/**
 * 源库变更签名（[1021 #05]）。
 *
 * 病历：discover 之前只用 `fs.statSync(dbPath).mtimeMs` 当缓存键。ZCode 库是 **WAL 模式**，
 * 新增记录先写 `-wal`，主库文件的 mtime **一个字节都不动** ⇒ 缓存永远命中旧列表。
 * 实测（本机）：建表+插入后主库 mtime=1792257069983.0781；再插一行（不 checkpoint）后仍是
 * 1792257069983.0781，而 `-wal` 从 12392B 变成 16512B（mtime 也同步往前）。
 * 只读查询不动 -wal（实测连续 SELECT 前后完全一致）⇒ 把 -wal 放进签名不会让缓存白失效。
 * `-shm` **故意不纳入**：它是锁表不是内容，把判据挂在它上面会让缓存几乎永不命中。
 */
export function dbSig(dbPath: string): string {
  const sig = (p: string) => {
    if (!fs.existsSync(p)) return '-';
    const st = fs.statSync(p);
    return st.mtimeMs + ':' + st.size;
  };
  return sig(dbPath) + '|' + sig(dbPath + '-wal');
}

/** 消息正文指纹：判「重读到的内容是否真的变了」（#04） */
function contentHash(s: string): string {
  return createHash('sha1').update(s).digest('hex').slice(0, 16);
}

// [fork 0922] discover 结果缓存：源库未被写入时直接复用上一轮结果，
// 空闲周期 0 SQL。原实现每周期对 ZCode 库全表 lower(directory) 扫描（无索引），
// 全局守护 N 个 worker × 每个事件都各扫一遍。
// ⚠️ 键必须含项目根：多个项目共享同一源库，只按签名键会让 B 项目拿到 A 项目的
// 会话列表并错误入库（0922 晚实测污染：music 42→559、novel 15→495）。
// ⚠️ [1021 #05] 签名值改用 dbSig（主库 + -wal）：只看主库 mtime 会漏掉 WAL 里的新增，
//   实测缓存永远返回旧列表（库里有 2 个会话、适配器只报 1 个）。
const discoverCache = new Map<string, { sig: string; rows: DiscoveredSession[] }>();

/**
 * [1015 夜 · 出口③第一刀] ZCode **自己就标了会话目的**（`session.task_type`）——不要再拿标题猜。
 *
 * 病历：原实现用 `/^workflow subagent/i` 匹配标题来判定「这是施工日志不是项目会话」。
 * 实测对拍（tools/_probe_zcode_purpose_leak.mjs，2026-10-15）：
 *   · 主库 zcode 源 568 场里，真值 subagent_child 的 **382 场全部漏过标题正则**，贡献 **254 条决策**（占全库 27%）；
 *   · 对照库漏 69 场 / 54 条决策；
 *   · 反向（标题像子代理但真值不是）：**0 场**。
 * 即：真值就在库里，我们却在猜，而且漏掉了绝大多数。
 * task_type 取值（本机实测分布）：subagent_child 754 / workflow_child 595 / interactive 209 /
 * selection_side_chat 12 / fork 1。只把「子代理/工作流子会话」判为 workflow ——
 * selection_side_chat（划词侧问）是用户自己驱动的，interactive 是正常会话，都不动。
 */
export function isSubagentKind(t: string | null | undefined): boolean {
  return t === 'subagent_child' || t === 'workflow_child'
}

export function discover(projectRoot: string, dbPath: string): DiscoveredSession[] {
  if (!fs.existsSync(dbPath)) return [];
  const sig = dbSig(dbPath);
  const cacheKey = `${path.resolve(projectRoot).toLowerCase()}\u0000${path.resolve(dbPath).toLowerCase()}`;
  const hit = discoverCache.get(cacheKey);
  if (hit && hit.sig === sig) return hit.rows;
  const z = getConn(dbPath);
  try {
    // ⚠️ task_type 是较新版本才有的列：老库上直接 SELECT 会抛，整条采集链会静默变空
    // （实测：test/integration/capture.spec.ts 与 forget/resurrection.spec.ts 的假库都没有这列，
    //   9 条测试当场红）。缺列判断**与 time_updated 共用同一份 PRAGMA 探测**（schemaOf）——
    // 不再用 try/catch 换判据：那样「缺列」和「查询写错」看起来一模一样。老库照常退化为标题正则。
    const hasTaskType = schemaOf(z, dbPath).session.has('task_type');
    type Row = { id: string; title: string; task_type: string | null; time_created: number; time_updated: number };
    const rows = (hasTaskType
      ? z.prepare('SELECT id, title, task_type, time_created, time_updated FROM session WHERE lower(directory) = lower(?)').all(path.resolve(projectRoot))
      : z.prepare('SELECT id, title, time_created, time_updated FROM session WHERE lower(directory) = lower(?)').all(path.resolve(projectRoot))
    ) as Row[];
    if (!hasTaskType) for (const r of rows) r.task_type = null;
    const out = rows.map((r) => ({
      source: SOURCE_ID,
      sourceSessionId: r.id,
      sourceFile: `zcode:${r.id}`,
      title: r.title,
      createdAt: new Date(r.time_created).toISOString(),
      updatedAt: new Date(r.time_updated).toISOString(),
      sizeBytes: 0,
      mtimeMs: r.time_updated,
      // [fork 0924] 工作流子代理会话标注 origin=workflow：它们是施工日志不是项目会话，
      // 决策提取/检索默认排除（mc整合包实测：88% 决策碎片来自它们）。
      // [1015 夜] 判据换成**库里的真值** task_type；标题正则只作老库/缺字段时的兜底。
      originHint: (isSubagentKind(r.task_type) || /^workflow subagent/i.test(r.title ?? '')) ? ('workflow' as const) : undefined,
    }));
    discoverCache.set(cacheKey, { sig, rows: out });
    return out;
  } finally {
    // 使用缓存连接，不关闭（由 resetConn 或进程退出时关闭）
  }
}

export function readNew(ds: DiscoveredSession, dbPath: string, cursor: unknown): ReadResult {
  // cursor.pending：上一轮读过、但正文可能还在长的消息（id + 正文指纹）——[1021 #04] 新增字段。
  // 老游标没有这个字段，按空数组处理（向后兼容，不需要 migration）。
  const cur = (cursor ?? {}) as {
    rowid?: number;
    lastCompaction?: number;
    pending?: Array<{ mid?: unknown; hash?: unknown }>;
  };
  if (!fs.existsSync(dbPath)) return { messages: [], badLines: 0, cursor: cur };
  const z = getConn(dbPath);
  const cols = schemaOf(z, dbPath);
  const msgTouch = touchCol(cols.message);
  const partTouch = touchCol(cols.part);
  const SELECT_ROW = 'SELECT id AS mid, rowid AS mrowid, sequence, time_created, ' + msgTouch + ' AS touch, data FROM message WHERE session_id = ?';
  type Row = { mid: string; mrowid: number; sequence: number | null; time_created: number; touch: number | null; data: string };
  try {
    z.pragma('busy_timeout = 3000');
    const rows = z
      .prepare(SELECT_ROW + ' AND rowid > ? ORDER BY rowid')
      .all(ds.sourceSessionId, cur.rowid ?? 0) as Row[];
    // ── [1021 #04] 半截正文的重读窗口 ──
    //   病历：readNew 原来只有 `rowid > 游标`。而 ZCode 的流式回答是**同一条 part 的正文原地变完整**：
    //   part 的 rowid 不变 ⇒ rowid 过滤永远追不到它；changeProbe 只看 MAX(rowid) 也同样看不出来。
    //   结果：库里永久停半截（实测：第二次 readNew 返回 0 条，探针签名 1/1 → 1/1 不变）。
    //   对策：把「上次读过、还没静默超过宽限期」的消息 id 记进游标，每轮按 id 取回来比正文指纹；
    //   变了才再吐一次（写入侧 upsertMessage 负责覆盖），没变就不吐 —— 这样 (session_id, seq_num) 的
    //   幂等契约（正常推进后第二轮 0 条）保持不变。
    const pendPrev = (cur.pending ?? [])
      .filter((p): p is { mid: string; hash?: unknown } => !!p && typeof p.mid === 'string');
    const known = new Set(rows.map((r) => r.mid));
    const pendRows = pendPrev.length > 0
      ? (z.prepare(SELECT_ROW + ' AND id IN (' + pendPrev.map(() => '?').join(',') + ')')
        .all(ds.sourceSessionId, ...pendPrev.map((p) => p.mid)) as Row[]).filter((r) => !known.has(r.mid))
      : [];
    const prevHash = new Map<string, string>();
    for (const p of pendPrev) if (typeof p.hash === 'string') prevHash.set(p.mid, p.hash);
    const selectParts = z.prepare(
      `SELECT data, ${partTouch} AS touch FROM part WHERE message_id = ? AND json_extract(data, '$.type') = 'text' ORDER BY sequence, rowid`
    );
    // 改动 2：compaction 摘要 part 查询
    const selectCompParts = z.prepare(
      `SELECT p.data, p.time_created FROM part p
       WHERE p.session_id = ?
         AND json_extract(p.data, '$.type') = 'compaction'
         AND p.time_created > ?
       ORDER BY p.time_created`
    );

    const messages: ReadResult['messages'] = [];
    let maxSeq = 0;
    let badLines = 0;   // 坏行不再被无声吞掉：坏 message.data / 坏 part.data / 坏 compaction 都记这里
    // 游标竞态防线（用户实测 assistant 消息整批丢失的根因）：
    // ZCode 先写 message 行、text part 流式后到。读到"无正文"的行时若游标照样
    // 越过，正文落库后永远不会再被扫描（rowid > cursor）。对策：宽限期内
    // （10 分钟）游标停在第一个空正文行之前，等下一轮重扫；过宽限的空行
    // （已删除/中断的消息）不再拖住游标。重扫靠 messages (session_id, seq_num)
    // 唯一键幂等，不会重复插入。
    const EMPTY_GRACE_MS = 10 * 60_000;
    const nowMs = Date.now();
    let firstRecentEmpty: number | null = null; // 宽限期内空正文行的最小 rowid
    let examined = cur.rowid ?? 0;
    // 下一轮要盯的消息：只留"最近宽限期内还被写过"的（过了静默期 = 写完/中断，不必再重读，
    // 否则活跃会话的尾部会被无限重扫）。最多 64 条：只有会话尾部可能还在流式增长。
    const nextPending: Array<{ mid: string; hash: string; mrowid: number }> = [];
    const MAX_PENDING = 64;

    /** 处理一行：算正文、判要不要吐、记 pending。advanceCursor=false 的是重读行（不参与游标推进） */
    const handleRow = (r: Row, advanceCursor: boolean) => {
      if (advanceCursor) examined = r.mrowid;
      let role: string;
      try {
        role = JSON.parse(r.data).role;
      } catch (e) {
        // 容错不许静默：坏 message.data 要留痕（走 badLines 计数，sync 会记进 source_files.suspect）
        badLines++;
        return;
      }
      const parts = selectParts.all(r.mid) as Array<{ data: string; touch: number | null }>;
      const content = parts
        .map((p) => { try { return (JSON.parse(p.data).text ?? '') as string; } catch { badLines++; return ''; } })
        .join('\n')
        .trim();
      // 「这条消息最后一次被动过」的时间：part 有更新就用 part 的（**原地 UPDATE 只动 part.time_updated**），
      // 否则用 message 行自己的（消息行可能先写、text part 后到）。
      let lastTouch = Number(r.touch ?? 0);
      for (const p of parts) { const t = Number(p.touch ?? 0); if (t > lastTouch) lastTouch = t; }
      // 「还在长」= 最近宽限期内被写过。加时间上界：时间戳跑到未来的（时钟偏了/脏数据）
      // 若不设上界会永远 hot ⇒ 这条消息会被每轮重读，永不结算。
      const hot = lastTouch >= nowMs - EMPTY_GRACE_MS && lastTouch <= nowMs + EMPTY_GRACE_MS;
      if (!content) {
        if (advanceCursor && hot && firstRecentEmpty === null) firstRecentEmpty = r.mrowid;
        if (hot) nextPending.push({ mid: r.mid, hash: '', mrowid: r.mrowid });
        return;
      }
      const hash = contentHash(content);
      const prev = prevHash.get(r.mid);
      // 重读行且正文指纹没变 ⇒ 不吐（否则会把已经存过的消息再吐一遍，破坏幂等契约）。
      if (advanceCursor || prev !== hash) {
        const seq = r.sequence ?? r.mrowid;
        messages.push({
          role: role === 'user' ? 'user' : 'assistant',
          content,
          seqNum: seq,
          createdAt: new Date(r.time_created).toISOString(),
        });
        maxSeq = Math.max(maxSeq, seq);
      }
      if (hot) nextPending.push({ mid: r.mid, hash, mrowid: r.mrowid });
    };
    for (const r of rows) handleRow(r, true);
    for (const r of pendRows) handleRow(r, false);

    // 改动 2：捕获 compaction 摘要（AI 生成的压缩摘要存为 system 角色消息）
    const cursorObj = cur as { rowid?: number; lastCompaction?: number };
    const compParts = selectCompParts.all(ds.sourceSessionId, cursorObj.lastCompaction ?? 0) as Array<{ data: string; time_created: number }>;
    for (const cp of compParts) {
      try {
        const data = JSON.parse(cp.data);
        // 从 summaryMessageId 找摘要的 text part
        let summaryText = '';
        if (data.summaryMessageId) {
          const summaryParts = z.prepare(
            `SELECT data FROM part WHERE message_id = ? AND json_extract(data, '$.type') = 'text' ORDER BY sequence, rowid`
          ).all(data.summaryMessageId) as Array<{ data: string }>;
          summaryText = summaryParts
            .map((p) => { try { return (JSON.parse(p.data).text ?? '') as string; } catch { return ''; } })
            .join('\n')
            .trim();
        }
        if (summaryText) {
          maxSeq += 1;
          messages.push({
            role: 'system',
            content: `[上下文压缩摘要] ${summaryText.slice(0, 2000)}`,
            seqNum: maxSeq,
            createdAt: new Date(cp.time_created).toISOString(),
          });
        }
      } catch { badLines++; /* 坏 compaction part：跳过但留痕（不静默） */ }
    }

    // 游标结算：宽限期内有空正文行 → 停在它之前（下一轮从这行重扫）；
    // 否则推进到本次扫描末尾（现行为）。取 max 防回退。
    const safeRowid = firstRecentEmpty !== null ? firstRecentEmpty - 1 : examined;
    const maxRowid = Math.max(cur.rowid ?? 0, rows.length > 0 ? safeRowid : cur.rowid ?? 0);
    const lastComp = compParts.length > 0 ? compParts[compParts.length - 1].time_created : (cursorObj.lastCompaction ?? 0);
    // pending 只留最近 MAX_PENDING 条（按 rowid 尾部）：越靠后的消息越可能还在流式增长
    nextPending.sort((a, b) => b.mrowid - a.mrowid);
    const pendingOut = nextPending.slice(0, MAX_PENDING).map((p) => ({ mid: p.mid, hash: p.hash }));
    return {
      messages,
      badLines,
      cursor: { rowid: maxRowid, lastCompaction: lastComp, pending: pendingOut },
    };
  } finally {
    // 缓存连接，不关闭
  }
}

// ── 改动 3：compaction 检测 ──
export function detectCompaction(ds: DiscoveredSession, dbPath: string): CompactionInfo | null {
  if (!fs.existsSync(dbPath)) return null;
  // [fork] 复用 getConn 缓存连接——原实现每个会话每周期 new Database 却从不关闭
  // （注释"缓存连接"系自 getConn 误复制），连接全靠 GC 兜底 → 句柄泄漏 + 内存锯齿 + CPU 空烧（上游 #2 根因）
  const z = getConn(dbPath);
  try {
    z.pragma('busy_timeout = 3000');
    const comp = z.prepare(`
      SELECT data, time_created FROM part
      WHERE session_id = ?
        AND json_extract(data, '$.type') = 'compaction'
      ORDER BY time_created DESC LIMIT 1
    `).get(ds.sourceSessionId) as { data: string; time_created: number } | undefined;
    if (!comp) return null;
    const data = JSON.parse(comp.data);
    // 估算被删消息数：压缩前后 token 差 / 平均每条消息约 500 token
    const estimated = Math.max(0, Math.floor(
      ((data.preCompactTokenCount ?? 0) - (data.truePostCompactTokenCount ?? 0)) / 500
    ));
    return {
      compactedAt: new Date(comp.time_created).toISOString(),
      estimatedDeleted: estimated,
      summaryMessageId: data.summaryMessageId,
    };
  } finally {
    // 复用缓存连接，不关闭（与注释语义一致）
  }
}

// ── 统一接口导出（注册表用） ──
export const adapter: SessionSourceAdapter = {
  id: SOURCE_ID,
  displayName: 'ZCode',
  discover(root, config) {
    return discover(root, config.dbPath as string);
  },
  async readNew(ds, cursor, config) {
    return Promise.resolve(readNew(ds, config.dbPath as string, cursor));
  },
  watchRoots(_root, config) {
    const dbPath = config.dbPath as string;
    return fs.existsSync(dbPath) ? [path.dirname(dbPath)] : [];
  },
  healthCheck(_root, config) {
    const dbPath = config.dbPath as string;
    if (!fs.existsSync(dbPath)) return `数据库不存在：${dbPath}（未安装 ZCode 可忽略）`;
    try {
      const z = new Database(dbPath, { readonly: true });
      z.close(); // [fork] 探测完即关：一次性连接不留着等 GC（原实现泄漏句柄，doctor 路径）
      return null;
    } catch (e) {
      return `只读探测失败：${(e as Error).message}`;
    }
  },
  detectCompaction(ds, config) {
    return detectCompaction(ds, config.dbPath as string);
  },

  // 内容签名（[fork 0922] 建立，[1021 #04] 加宽）。
  //
  // 旧实现只取 MAX(rowid)：**追加**能看见，但「同一条 part 正文原地变完整」（流式半截 → 完整）
  // 的 rowid 不变 ⇒ 签名一个字节都不变 ⇒ runSync 本轮直接跳过该会话，readNew 根本不会被调用，
  // 库里永久停在半截（红队实测：签名 1/1 → 1/1 不变、第二次 readNew 0 条）。
  // 现在每表取两个值：MAX(最近写入/更新时间列) + COUNT(*) ——
  //   · 时间列抓 UPDATE（ZCode 真实表结构 message/part 都有 time_updated，实测 UPDATE 会推它）；
  //   · COUNT 抓「同一毫秒内的 INSERT」（时间戳相同的极端情况）。
  // 老库/测试夹具没有 time_updated 时，touchCol 自动退回 time_created（判据只此一份）。
  changeProbe(config) {
    const dbPath = config.dbPath as string;
    const out = new Map<string, string>();
    if (!fs.existsSync(dbPath)) return out;
    const z = getConn(dbPath);
    try {
      z.pragma('busy_timeout = 3000');
      const cols = schemaOf(z, dbPath);
      const mTouch = touchCol(cols.message);
      const pTouch = touchCol(cols.part);
      type Sig = { session_id: string; t: number | null; n: number };
      const msg = z.prepare('SELECT session_id, MAX(' + mTouch + ') AS t, COUNT(*) AS n FROM message GROUP BY session_id').all() as Sig[];
      const part = z.prepare('SELECT session_id, MAX(' + pTouch + ') AS t, COUNT(*) AS n FROM part GROUP BY session_id').all() as Sig[];
      for (const r of msg) out.set(r.session_id, 'm' + (r.t ?? 0) + '/' + r.n);
      for (const r of part) out.set(r.session_id, (out.get(r.session_id) ?? 'm0/0') + ';p' + (r.t ?? 0) + '/' + r.n);
      return out;
    } catch (e) {
      // 探针失败 → 空签名 → 全部不命中水位线 → 全量 ingest（安全侧）。
      // 不静默：计数 + 最近一次原因留在模块态（tools/测试可读；适配器接口没有 logger，
      // 要真正报给用户需要 ReadResult/SyncStats 加通道，那是 types.ts 的事）。
      changeProbeFailures++;
      changeProbeLastError = String((e as Error)?.message ?? e);
      return out;
    }
  },
};
