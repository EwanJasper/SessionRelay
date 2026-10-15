// brief-sql.mjs — 简报数据的直查 SQL 通道（node:sqlite）
//
// ═══ 为什么存在 ═══
// 简报原先靠两个子进程取数：`node srelay.js decisions --json` / `unresolved --json`。
// 子进程方案有三个实测代价：
//   ① 冷路径同步 spawn 最坏 310ms，直接阻塞 DSH 的 prompt 组装（UI 卡一下）
//   ② 每轮热刷新两次 spawn，白烧 CPU 与进程句柄
//   ③ 取数能力被 vendor/全局 CLI 的存在性绑架——vendor 被跳过时简报静默变空
// node:sqlite 是 Node 22.5+ 内置（Node 24 免标志），读 WAL 库与 better-sqlite3 同一格式，
// 零依赖、零子进程。本机实测：只读打开 59.5MB WAL 真实库正常。
//
// ═══ 语义对齐（改核心库必须同步本文件，否则两端简报内容会分叉）═══
//   查询/排序/截断/保质期逐条复刻自：
//     store/db.ts        listDecisions / listUnresolved（SQL + JSON 展开 + 去重）
//     cli/meta.ts        cmdDecisions（limit 取"最近 N 条"再 reverse）/ cmdUnresolved（14 天保质期）
//     shared/paths.ts    projectIdOf（'proj_' + 路径 replace([\\/:] → '-').toLowerCase()）
//     shared/config.ts   identity.project_id 优先于路径推导
//
// ═══ 降级契约 ═══
// 任何一步失败都返回 null（不抛），由调用方回落 CLI 子进程——行为与改动前逐字节一致。
// 典型回落场景：Node < 22.5 无 node:sqlite；Node 22.x 需 --experimental-sqlite 标志；
// 库 schema 比本插件旧（origin 列不存在）；WAL 的 -shm 不可写（只读文件系统）。
//
// ⚠️ node:sqlite 必须**懒加载**：它是 Node 22.5+ 才有、且 22.x 上还要
// --experimental-sqlite 标志才放开的模块。若在文件顶部静态 import，Node 22
// 下一次 import 失败就会让**整个插件**加载不了（简报静默全灭），而不只是
// 本通道不可用。用 createRequire 同步取，失败即降级——这是本文件唯一的重构理由。

import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'

const require = createRequire(import.meta.url)
let DatabaseSync = null
try {
  ({ DatabaseSync } = require('node:sqlite'))
} catch { /* 无 node:sqlite 或需标志：本通道整体不可用，调用方走 CLI 兜底 */ }

const RELAY_DIR = '.sessionrelay'
const DB_FILE = 'relay.sqlite'
const CONFIG_FILE = 'config.json'

/** 复刻 shared/paths.ts projectIdOf */
function projectIdOf(root) {
  return 'proj_' + path.resolve(root).replace(/[\\/:]/g, '-').toLowerCase()
}

/** 复刻 shared/config.ts：identity.project_id 优先，缺省走路径推导 */
function readProjectId(root) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(root, RELAY_DIR, CONFIG_FILE), 'utf8'))
    const pid = cfg?.identity?.project_id
    return typeof pid === 'string' && pid ? pid : projectIdOf(root)
  } catch {
    return projectIdOf(root)
  }
}

function jsonArray(raw) {
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

/** 复刻 listDecisions + cmdDecisions 的 limit 语义（取最近 N 条，再倒序） */
function queryDecisions(db, projectId, limit) {
  // [1015 夜 · 性能] 两处纯浪费，删掉**不改任何输出**（改前先量：主库 queryBriefData 17.1ms）：
  //   ① `topics` 被 SELECT 出来、被 JSON.parse、然后 `void topics` —— 一次都没用到；
  //   ② `decisions != '[]'`：空数组的行占了大多数，解析它们等于白跑。
  const rows = db.prepare(`
    SELECT id, source, title, created_at, decisions FROM sessions
    WHERE project_id = ? AND decisions IS NOT NULL AND decisions != '[]' AND (origin IS NULL OR origin != 'workflow')
    ORDER BY created_at DESC
  `).all(projectId)
  const out = []
  // 跨会话去重：与核心库 listDecisions 的 seen 完全同规（v6 起两边都必须有）。
  // 此前核心库没去重、这边也没有，同一条决策重复入库 N 次，把简报 2 个名额占满。
  // 同键去重保留**决策自身时间更新**的那条（key → out 下标）。
  // 病历（1015 夜）：原实现是「先遇到的赢」，而遍历顺序是会话 created_at 降序 —— 实测会留下更旧的一条，
  // music 那组把 31h 的新决策顶成 48h 的旧重复，简报的决策段（48h 窗）提前 17 小时空掉。
  const seenIdx = new Map()
  for (const r of rows) {
    for (const d of jsonArray(r.decisions)) {
      // [1015 修] 与核心库 dedupKey 同规：标点与表格竖线一并剔掉（只去空白会让"被表格符号切分"的
  // 同一句话算两条 → 简报双显）。改这里必须同时改 core/SessionRelay/src/store/db.ts 的 dedupKey。
  const key = String(d.text ?? '').replace(/[\s，。！？、,.!?;；:：|｜]+/g, '').slice(0, 40)
      const at = d.at ?? r.created_at
      const item = {
        at,
        source: r.source,
        sessionId: r.id,
        title: r.title,
        text: d.text,
        seq: d.seq,
        msgAt: d.at,
        pinned: d.pinned === true,
        // ADR-001：kind 必须与核心库 listDecisions 同步带出，否则 SQL 通道渲染不出 ✗
        // 而 CLI 兜底通道能——两条路产出的简报会不一样（本项目反复吃过的分叉亏）。
        // 存量数据无此字段，按 'decision' 处理。
        kind: d.kind === 'negative' ? 'negative' : 'decision',
      }
      if (!key) { out.push(item); continue }
      const idx = seenIdx.get(key)
      if (idx === undefined) { seenIdx.set(key, out.length); out.push(item); continue }
      const kept = out[idx]
      if ((Date.parse(at) || 0) > (Date.parse(kept.at ?? '') || 0)) out[idx] = { ...item, pinned: kept.pinned || item.pinned }
      else if (item.pinned) kept.pinned = true
    }
  }
  // 原实现 a.at.localeCompare(b.at)：at 理论可能为 null（created_at 为空的行），
  // 原代码会直接抛；这里兜底成空串，等价于排在最前，不让一条脏行毁掉整份简报。
  // [fork 1014b] 置顶优先：函数末尾 slice(-limit) 取数组**末尾** N 条——所以 pinned
  // 必须排到数组末尾，置顶决策才一定落在取用窗口内（哪怕它时间很老，三个月前拍板的
  // 关键选择不会被今天的琐碎决策挤出简报）。组内保持原升序，与核心库 listDecisions
  // 的排序逐字同规（两端分叉 = 简报内容分叉）。
  out.sort((a, b) => {
    const pa = a.pinned ? 1 : 0
    const pb = b.pinned ? 1 : 0
    if (pa !== pb) return pa - pb
    return String(a.at ?? '').localeCompare(String(b.at ?? ''))
  })
  return out.slice(-limit).reverse()
}

/** 复刻 listUnresolved(pid, 100) + cmdUnresolved 的保质期与截断顺序 */
function queryUnresolved(db, projectId, limit) {
  const rows = db.prepare(`
    SELECT id, source, title, created_at, key_questions FROM sessions
    WHERE project_id = ? AND key_questions IS NOT NULL AND key_questions != '[]' AND (origin IS NULL OR origin != 'workflow')
    ORDER BY created_at DESC
  `).all(projectId)
  const collected = []
  const seen = new Set()
  for (const r of rows) {
    for (const q of jsonArray(r.key_questions).filter((x) => x.unresolved)) {
      // 同一问题跨会话去重（简报曾同条双显）——键与核心库逐字一致
      const key = String(q.q ?? '').replace(/[\s，。！？、,.!?;；:：|｜]+/g, '').slice(0, 40)
      if (key && seen.has(key)) continue
      if (key) seen.add(key)
      collected.push({ q: q.q, at: q.at ?? r.created_at, source: r.source, sessionId: r.id, title: r.title })
    }
  }
  // 顺序不可调换：先按 100 截断，再过滤 14 天保质期，最后取 limit——与 cmdUnresolved 相同
  const cutoff = Date.now() - 14 * 86400_000
  return collected
    .slice(0, 100)
    .filter((r) => new Date(r.at).getTime() >= cutoff)
    .slice(0, limit)
}

function openDb(file) {
  // [fork 1015] timeout: 5000 —— node:sqlite 的 DatabaseSync 默认 busy_timeout 是 0，
  // 遇到守护进程做增量 VACUUM 提交或 recompute 批量写 FTS 时会立刻抛 SQLITE_BUSY。
  // 实测 node:sqlite **没有 db.pragma() 方法**（`db.pragma is not a function`），
  // 所以不能照抄核心库 db.ts 的 `db.pragma('busy_timeout = 5000')` 写法，
  // 只能用构造选项。（外部专家报告 2.6 / 本机核验 7 同结论。）
  // 失败仍由 queryBriefData 的 try/catch 兜住并回落 CLI，不会挂住会话。
  const opts = { readOnly: true, timeout: 5000 }
  // 先试只读：插件永远不写库，只读是最安全的姿态（也避免与守护进程争写锁）
  try {
    return new DatabaseSync(file, opts)
  } catch {
    // 只读失败（典型：WAL 的 -shm 不存在且目录不可写）→ 退回普通打开。
    // 仍只发 SELECT，不会写数据；这一步与 CLI 的 openExisting 同等姿态。
    return new DatabaseSync(file, { timeout: 5000 })
  }
}

/**
 * 直查简报数据。返回 { decisions, unresolved }（数组，元素字段与 CLI --json 一致），
 * 或 null = 本通道不可用，调用方应回落 CLI。
 * 绝不抛：这是 prompt 组装路径上的函数。
 */
export function queryBriefData(root, limit = 200) {
  if (!root || typeof root !== 'string') return null
  if (!DatabaseSync) return null // 通道整体不可用：不抛，让调用方走 CLI
  const file = path.join(root, RELAY_DIR, DB_FILE)
  if (!fs.existsSync(file)) return null
  let db = null
  try {
    db = openDb(file)
    const projectId = readProjectId(root)
    return {
      decisions: queryDecisions(db, projectId, limit),
      unresolved: queryUnresolved(db, projectId, limit),
    }
  } catch {
    return null
  } finally {
    try { db?.close() } catch { /* 已关闭或从未打开 */ }
  }
}

/**
 * [1015 v17+] 「最近在动哪些文件」——**零模型、纯结构化**。
 *
 * 为什么加它：b3 的捕获率盘点实测「计划/下一步」只捕获 3.3%（5763 条未捕获），
 * 而 v17 把 files_mentioned 的精度从 26%/33% 修到 99%/100% 之后，
 * "最近动过哪些文件"就成了**可观测量**——它是全自动、零噪声的定位线索，
 * 不依赖任何"从对话里嗅意义"的猜测。
 *
 * 口径：近 N 天内被 mentioning 过的文件，按「出现过该文件的会话数」降序。
 * ⚠️ 返回值里的 `decisions` 是**这些会话的决策总数**（同一批会话里的文件必然拿到同一个数），
 *    不是"这个文件的决策数"——1015 夜体检实测：它没有判别力，且"决策文本里含文件名"的口径
 *    实测 18/18 全为 0。该字段现在只用于**并列时的次级排序**，不再进简报显示。
 *    全部数字见 docs/1015-深夜-最近在动-信号体检.md。
 * 绝不抛：这是 prompt 组装路径上的函数。返回 [] = 无数据/不可用。
 */
export function queryRecentFiles(root, { days = 7, top = 3, maxSessions = 300 } = {}) {
  if (!root || typeof root !== 'string') return []
  if (!DatabaseSync) return []
  const file = path.join(root, RELAY_DIR, DB_FILE)
  if (!fs.existsSync(file)) return []
  let db = null
  try {
    db = openDb(file)
    const cutoff = new Date(Date.now() - days * 86400000).toISOString()
    const rows = db.prepare(`SELECT files_mentioned, decisions, coalesce(last_event_at, created_at) AS t
      FROM sessions
      WHERE files_mentioned IS NOT NULL AND files_mentioned != '[]' AND coalesce(last_event_at, created_at) >= ?
      ORDER BY t DESC LIMIT ?`).all(cutoff, maxSessions)
    const agg = new Map()
    for (const r of rows) {
      let files = [], decs = 0
      try { files = JSON.parse(r.files_mentioned) } catch { continue }
      try { decs = JSON.parse(r.decisions || '[]').length } catch { decs = 0 }
      for (const f of files) {
        if (typeof f !== 'string' || f.length < 4) continue
        const cur = agg.get(f) || { file: f, sessions: 0, decisions: 0 }
        cur.sessions += 1
        cur.decisions += decs
        agg.set(f, cur)
      }
    }
    // 噪声过滤（实测）：AGENTS.md / config.json / SKILL.md 这类到处都出现的文件，
    // 会把真正的「在动什么」挤掉——测出来主库前三名全是它们，纯噪声。
    // 用 basename 白名单剔除（同一份 AGENTS.md 可能有多条路径写法）。
    const UBIQUITOUS = new Set(['AGENTS.md', 'CLAUDE.md', 'SKILL.md', 'README.md', 'README.en.md',
      'package.json', 'package-lock.json', 'config.json', 'tsconfig.json', 'progress.md',
      'settings.json', 'vitest.config.ts', 'pnpm-lock.yaml'])
    return [...agg.values()]
      // 只出现过 1 场会话的文件不进简报（列一次等于噪声；≥2 才说明是"反复在动"）
      .filter((x) => !UBIQUITOUS.has(String(x.file).split('/').pop() || ''))
      .filter((x) => x.sessions >= 2)
      .sort((a, b) => b.sessions - a.sessions || b.decisions - a.decisions)
      .slice(0, top)
  } catch {
    return []
  } finally {
    try { db?.close() } catch { /* 已关闭或从未打开 */ }
  }
}

/** node:sqlite 是否可用（Node < 22.5 / 22.x 无标志时为 false，调用方据此走 CLI） */
export function sqlChannelAvailable() {
  if (!DatabaseSync) return false
  try {
    const db = new DatabaseSync(':memory:')
    db.close()
    return true
  } catch {
    return false
  }
}
