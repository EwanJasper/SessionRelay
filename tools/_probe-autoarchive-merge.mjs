// 探测：合并后 autoArchiveProject 的判据会在真库上归档多少（只读，不动数据）
// 为什么要有这一步：planAging 以前从没被守护用过，合并上线前必须先知道"会删掉多少正文"。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { planAging } from '../dist/recall.js'

const HOME = process.env.USERPROFILE || os.homedir()
const REG = path.join(HOME, '.sessionrelay-registry', 'projects.json')
const gate = (d) => Number(Math.max(0, Math.min(1, 1 - d / 90)).toFixed(3))
const roots = JSON.parse(fs.readFileSync(REG, 'utf8')).projects.map((p) => p.root)
const VERSION = 20
let totArch = 0, totMsg = 0
for (const root of roots) {
  const db = path.join(root, '.sessionrelay', 'relay.sqlite')
  if (!fs.existsSync(db)) { console.log(root, '(无库)'); continue }
  const d = new DatabaseSync(db, { readOnly: true, timeout: 8000 })
  const rows = d.prepare('SELECT id, origin, state, last_event_at, message_count, extracted_version, decisions, cleanup_at FROM sessions').all()
  const pick = (subset, days) => planAging(subset, { currentVersion: VERSION, minAgeDays: days, maxStrength: gate(days), minDecisions: 0, cap: 200 })
  const wf = rows.filter((r) => String(r.origin || '') === 'workflow')
  const oth = rows.filter((r) => String(r.origin || '') !== 'workflow')
  const pw = pick(wf, 7), po = pick(oth, 30)
  const msgs = [...pw.archive, ...po.archive].reduce((s, r) => s + (r.message_count || 0), 0)
  const reasons = {}
  for (const r of [...pw.kept, ...po.kept]) { const k = String(po.reasons[r.id] || pw.reasons[r.id] || '?').replace(/\d+(\.\d+)?/g, 'N'); reasons[k] = (reasons[k] || 0) + 1 }
  const top = Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => k + '×' + v).join(' | ')
  totArch += pw.archive.length + po.archive.length; totMsg += msgs
  console.log(path.basename(root).padEnd(22), '会话', String(rows.length).padStart(4),
    '· 计划归档', String(pw.archive.length).padStart(3), '+', String(po.archive.length).padStart(3),
    '· 正文', String(msgs).padStart(6), '条')
  console.log('  '.padEnd(22), '保留原因 top:', top)
  d.close()
}
console.log('合计：归档', totArch, '场会话 / 正文', totMsg, '条（封顶 200/轮，多轮渐进）')
