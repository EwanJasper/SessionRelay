// [1016 A6 · 动态实体锚点提示] 「其余未展开决策涉及模块」取数与渲染。
//
// 为什么需要它：简报硬上限 1200 字符、决策段只放得下 4 条 —— **剩余决策连影子都没有**，
// 模型不知道自己漏了什么，也就不会去检索。这条把「没显示的那些决策在讲哪些模块」点出来，
// 给它一个"要不要去查一下"的锚。
//
// 数据源：**已校验的 files 列**（不是散文、不是模型总结）——外部报告 §4.3 点名的那条。
// 口径与 queryRecentFiles 同规（同一套噪声过滤 + ≥2 场门槛），只是时间窗放宽到 30 天，
// 因为要覆盖的是"没被显示的决策"，不只最近 7 天在动的。
//
// 纪律：绝不抛（这是 prompt 组装路径上的函数）；库不存在/打不开一律返回空串。
import fs from 'node:fs'
import path from 'node:path'

let DatabaseSync = null
try { ({ DatabaseSync } = await import('node:sqlite')) } catch { DatabaseSync = null }

const RELAY_DIR = '.sessionrelay'
const DB_FILE = 'relay.sqlite'

// 到处都出现的文件（AGENTS.md / package.json 那一类）会把真正的"在动什么"挤掉——
// 实测主库前三名全是它们。用 basename 正则剔除，比维护一张字符串白名单更难漏。
const NOISE = /^(AGENTS|CLAUDE|SKILL|README|LICENSE)(\.[A-Za-z-]+)?\.(md|txt)$|^(package(-lock)?|tsconfig|config|settings|progress|vitest\.config|pnpm-lock)\.(json|ts|yaml|md)$/

/** basename → 去掉常见前缀，只留 1~2 段，避免把整条路径塞进注入 */
function shortName(f) {
  const parts = String(f).replace(/\\/g, '/').split('/').filter(Boolean)
  return parts.slice(-2).join('/')
}

export function decisionModulesText(root, { days = 30, top = 3, maxSessions = 300 } = {}) {
  if (!root || typeof root !== 'string') return ''
  if (!DatabaseSync) return ''
  const file = path.join(root, RELAY_DIR, DB_FILE)
  if (!fs.existsSync(file)) return ''
  let db = null
  try {
    db = new DatabaseSync(file, { readOnly: true })
    const cutoff = new Date(Date.now() - days * 86400000).toISOString()
    // 只看真的有决策的会话；子代理会话排除，与决策段同规。
    // ⚠️ SQL 里**不放字符串字面量**（length() 代替 != '[]'，origin 用绑定参数）——
    //    上一版就是栽在"生成代码时 SQL 的单引号与生成器定界符打架"，这样写从根上避开。
    const sql = 'SELECT files_mentioned FROM sessions'
      + ' WHERE decisions IS NOT NULL AND length(decisions) > 2'
      + ' AND files_mentioned IS NOT NULL AND length(files_mentioned) > 2'
      + ' AND (origin IS NULL OR origin <> ?)'
      + ' AND coalesce(last_event_at, created_at) >= ?'
      + ' ORDER BY coalesce(last_event_at, created_at) DESC LIMIT ?'
    const rows = db.prepare(sql).all('workflow', cutoff, maxSessions)
    const agg = new Map()
    for (const r of rows) {
      let files = []
      try { files = JSON.parse(r.files_mentioned) } catch { continue }
      for (const f of files) {
        if (typeof f !== 'string' || f.length < 4) continue
        agg.set(f, (agg.get(f) || 0) + 1)
      }
    }
    const picked = [...agg.entries()]
      .filter(([f]) => !NOISE.test(path.basename(String(f))))
      .filter(([, n]) => n >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, top)
    if (picked.length === 0) return ''
    const body = picked.map(([f, n]) => shortName(f) + ' (' + n + '条)').join(' · ')
    return '🗺 其余未展开决策涉及模块：' + body
  } catch {
    return ''
  } finally {
    try { db?.close() } catch { /* 已关闭或从未打开 */ }
  }
}
