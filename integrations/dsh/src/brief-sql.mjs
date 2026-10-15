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
  const rows = db.prepare(`
    SELECT id, source, title, created_at, decisions, topics FROM sessions
    WHERE project_id = ? AND decisions IS NOT NULL AND (origin IS NULL OR origin != 'workflow')
    ORDER BY created_at DESC
  `).all(projectId)
  const out = []
  // 跨会话去重：与核心库 listDecisions 的 seen 完全同规（v6 起两边都必须有）。
  // 此前核心库没去重、这边也没有，同一条决策重复入库 N 次，把简报 2 个名额占满。
  // rows 按 created_at DESC，先遇到的是最新那次，保留新丢弃旧。
  const seen = new Set()
  for (const r of rows) {
    const topics = jsonArray(r.topics)
    void topics
    for (const d of jsonArray(r.decisions)) {
      // [1015 修] 与核心库 dedupKey 同规：标点与表格竖线一并剔掉（只去空白会让"被表格符号切分"的
  // 同一句话算两条 → 简报双显）。改这里必须同时改 core/SessionRelay/src/store/db.ts 的 dedupKey。
  const key = String(d.text ?? '').replace(/[\s，。！？、,.!?;；:：|｜]+/g, '').slice(0, 40)
      if (key && seen.has(key)) continue
      if (key) seen.add(key)
      out.push({
        at: d.at ?? r.created_at,
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
      })
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
    WHERE project_id = ? AND key_questions IS NOT NULL AND (origin IS NULL OR origin != 'workflow')
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
