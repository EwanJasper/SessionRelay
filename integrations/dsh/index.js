// dsh-srelay-brief — SessionRelay 项目记忆 → DSH system prompt 自动简报。
//
// ═══ 为什么存在 ═══
// SessionRelay 是 MCP server，能被查询，但**不能注入**：MCP 规范里 initialize 的
// instructions 只是给客户端的元信息，resources/prompts 能力它一个都没声明（实测）。
// 用社区那句话：MCP is tool-shaped by design, so memory over MCP is a tool call
// by construction —— 模型不调用，记忆就不存在。
// 本插件把记忆从「按需调用」变成「始终在场」。
//
// ═══ 项目根怎么来（2026-10-14 重构）═══
// 旧方案：读 ~/.dsh/sessions/<目录slug> 反解。能用，但是猜——slug 有损（'-' 既表
// 分隔符又是真实连字符），且「最近活跃」在多项目并发时会串。
// 新方案：assembly.agent?.session?.header?.cwd —— DSH 自己的「validated absolute
// cwd」，按 agent 隔离，直接且权威。
//   类型链（全部从内核 .d.ts 实证）：
//     assembleContextFor()   → { agent, scope: agent, signal? }
//     Agent.session          → 运行时真实使用（dsh-agent/lib/index.js:198）
//     Session.header         → readonly header，注释 "always present"
//     SessionHeader.cwd      → "Absolute working directory the session was created in"
//   取不到时（诊断性 assembly / 无 cwd 会话）→ 回落旧 slug 方案；再取不到 → ''。
//   **绝不猜**：注错项目的简报比不注入更糟。
//
// ═══ text provider 的架构约束（本轮最重要修正）═══
// text 在**每次模型步骤前**的组装路径上同步执行。旧实现在这里 execFileSync 查库：
// mtime 缓存命中 ~1ms，但缓存失效那一刻 310ms 直接阻塞 DSH 组装 → UI 卡一下。
// 正确架构（参照已上线插件 plur 的教训 "prompt assembly should never wait on a
// database"）：
//   · text 只做 O(1) 同步读缓存，永不 spawn 子进程、永不抛
//   · 真正的子进程调用在组装路径之外：异步 single-flight 刷新 + 定时刷新
//   · 冷缓存（本进程第一次见到该 cwd）允许一次**有界**同步预热，否则首轮永远没记忆
//   · 诚实代价：预热失败时该轮无简报，下一轮才有
//
// ═══ 取数双通道（2026-10-14 第二轮修正）═══
// 上一条的"预热"仍然要 spawn 两个 node 子进程，最坏 310ms。现在首选**直查 SQL**
// （src/brief-sql.mjs，node:sqlite 内置、零依赖、毫秒级），CLI 子进程降级为兜底：
//   · 实测三个真实库 200 条决策 + 全部未决，与 CLI --json 逐字段零差异
//   · SQL 不可用（Node<22.5 / 库 schema 比插件旧 / WAL 只读打不开）→ 自动回落 CLI，
//     行为与本改动之前逐字节一致
//   · 直查只读开库，绝不与守护进程争写锁
//
// ═══ 已知未实测项 ═══
// cwd 字段尚未在真实 DSH 组装中打过日志（启动 DSH 不触发组装，需真实一轮对话）。
// 已用「cwd 优先 + slug 回落」防御：取不到时行为与旧版一致。
import { execFile, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
// [fork 1015] 简报过滤器的单一权威源——与 ZCode 侧 brief-shared.mjs import 同一份文件。
// 历史上两侧手抄导致过滤器漂移（DSH 多一条而 ZCode 没有，用户日常在 ZCode 侧干活）。
import { passesBriefFilters } from './src/brief-filters.mjs'
import { resolveProjectRoot, shouldAutoInit } from './project-resolve.mjs'
import { searchTool, showTool, recordTool, bindProjectTool, confirmBindTool, cancelBindTool, initProjectTool } from './src/tools.js'
import { setStorageAdapter, disposeBindState } from './src/state.js'
import { queryBriefData, sqlChannelAvailable } from './src/brief-sql.mjs'

export const name = 'dsh-srelay-brief'
export const inject = ['systemPrompt', 'tools']

// ── srelay CLI 入口：三级优先 ──
//   ① env 天窗 → ② 自带 vendor → ③ npm 全局兜底
// ⚠️ 必须 fileURLToPath：new URL(...).pathname 对非 ASCII 百分号编码，
//    中文目录下 existsSync 恒 false，67MB vendor 会被静默跳过（实测踩过）。
// fileURLToPath 对非 UTF-8 的百分号序列会抛 URIError（如 Shift-JIS 路径）。
// 中文 UTF-8 不会触发，但不该让插件因此静默崩——包一层，失败则放弃 vendor 走全局兜底。
let VENDOR_SRELAY = ''
try {
  VENDOR_SRELAY = fileURLToPath(new URL('./vendor/dist/srelay.js', import.meta.url))
} catch { /* 路径无法解码：放弃自带运行时，回落全局安装 */ }
const SRELAY = process.env.SRELAY_CLI_PATH
  || (fs.existsSync(VENDOR_SRELAY) ? VENDOR_SRELAY
      : path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@ewanjasper', 'sessionrelay', 'dist', 'srelay.js'))
const NODE = process.execPath

const MAX_CHARS = 1200
const FRESH_MS = 48 * 3600_000
// 简报名额。**必须与 ZCode 的 brief-shared.mjs 完全一致**，且本文件内只准有这一处定义。
// 1014 实测踩坑：这三个数字原先在 sqlItems / buildBrief / text provider 冷路径里各写了
// 一份（2/2），改名额时只改到两处，第三处静默留在旧值——症状是"SQL 路出 4 条决策、
// CLI 兜底路出 2 条"，而 self              est 的"两条路正文逐字节一致"正是抓这个的。
// 同一处知识多份副本，是这个项目反复吃的病。
const DEC_SLOTS = 4
const UNR_SLOTS = 3
const COLD_SYNC_TIMEOUT_MS = 1500 // 冷缓存同步预热上界：最坏慢一轮，不挂住组装
const WARM_REFRESH_MS = 60_000   // 热缓存定时刷新
const CACHE_TTL_MS = 5_000

// ── 过滤规则：与 ZCode 的 brief-shared.mjs 逐条对应（同一套简报语义）──
// ⚠️ 本块（CHATTER_TITLE + SUBAGENT_TASK_TITLE 两个常量，与 itemsFromArray 的过滤器链）
// 必须与 brief-shared.mjs 的同名块**逐字一致**。1015 实测两侧已经漂移过一次：DSH 有
// "报告/审稿碎片"过滤而 ZCode 没有，而用户日常在 ZCode 侧干活——缺的恰好是他唯一
// 会看到的那一侧。selftest 第 11 节断言两块逐字相同，别再靠人眼。
const CHATTER_TITLE = /^(你好|哈喽|您好|hi+|hello|hey|test|测试|在吗|在么)[!！。.~\s]*$/i
// 子代理任务书标题（Phase 3 层①）。派给 subagent 的那条任务书，标题就是任务书原文。
// 实测这类会话贡献全部决策的 16.7%（agent1super，90 会话 204 条）与 9.2%
// （music player，28 会话 47 条），且**它们的报告永远比主会话的决策写入更晚**——
// 所以简报"取最新 N 条"必然取到它。1015 实测简报 4 条决策 4 条全来自同一个
// 红队子代理会话（标题="你是红队审查员。任务：…"，14 条消息里唯一实质内容是
// seq=98 那条 10521 字的审查报告，报告里引用的示例决策反被抽成拍板）。
// **只挡简报，不挡存储与检索**：信息零丢失，反悔只需删这一行过滤器。
// 判据故意收得很窄：实测扩到"请精读/帮我"会连主会话的真决策一起挡掉——那类标题的
// 会话里有"改用 fileURLToPath()"这种真决策（1015 实测，两个候选判据都试过）。
const SUBAGENT_TASK_TITLE = /^(你是|你作为|任务[:：]|你的任务|act as|you are)/i

function runSrelay(args, root, timeoutMs) {
  return new Promise((resolve) => {
    execFile(NODE, [SRELAY, ...args],
      { cwd: root, timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout) => resolve(err ? null : String(stdout || '')))
  })
}

// ── 取数双通道 ──
// ① 直查 SQL（node:sqlite）：首选。零子进程、零依赖、毫秒级。
//    实测三个真实库（E:\music player 59.5MB / E:\mc整合包 / D:\agent1super），
//    200 条决策 + 全部未决，与 CLI --json 逐字段零差异。
// ② CLI 子进程：兜底。node:sqlite 不可用（Node < 22.5）、库 schema 比插件旧、
//    WAL 只读打不开时自动回落，行为与本改动之前逐字节一致。
// SRELAY_BRIEF_FORCE_CLI=1：诊断逃逸阀——SQL 通道一旦行为可疑，无需重装即可
// 强制走旧路径对照（selftest 8c 用它证明两条路产出同一份简报）。
const SQL_OK = sqlChannelAvailable() && !process.env.SRELAY_BRIEF_FORCE_CLI
let sqlFallbackLogged = false

function logSqlFallback(reason) {
  if (sqlFallbackLogged) return
  sqlFallbackLogged = true
  if (process.env.SRELAY_BRIEF_DEBUG) {
    console.error(`[dsh-srelay-brief] 直查 SQL 不可用（${reason}），回落 CLI 子进程`)
  }
}

/** 数组 → 简报条目（过滤/排序/截断）。两条取数通道共用，保证语义一致 */
function itemsFromArray(arr, key, max) {
  if (!Array.isArray(arr)) return []
  const cutoff = Date.now() - FRESH_MS
  const fresh = arr
    .filter(d => !/workflow subagent|actor#\d+/i.test(String(d.title ?? '') + ' ' + String(d.text ?? '')))
    .filter(d => !/[??？]\s*,\s*[-–]/.test(String(d.text ?? '')))
    .filter(d => !CHATTER_TITLE.test(String(d.title ?? '').trim()))
    .filter((d) => {
      if (key !== 'decisions') return true
      const t = String(d.text ?? '')
      return !/[??？]\s*$/.test(t) && !/怎么办|能不能|怎么说|是不是|要不要|原理是什么/.test(t)
    })
    .filter((d) => {
      const t = String(d.text ?? '')
      return !/^(报告|原文|上文|上述|文档|该文|这篇|那份)/.test(t.trim())
        && !/被当成|误命中|被判为|不是决策|纯垃圾|噪声|伪影/.test(t)
    })
    // [fork 1015] 七条规范过滤器（brief-filters.mjs 单一权威源，与 ZCode 侧同源）。
    // 实测：主库只拦 6/1172、音乐库 5/490，全部是噪声、0 误杀，且正好覆盖
    // Phase 3 治不掉的 3 条散文噪声（决定用 X"/作者点名表扬/按你在 Notes 里提议）。
    .filter((d) => passesBriefFilters(d.text))
    .filter((d) => {
      // Phase 3 层①：子代理任务书会话的决策/未决不进简报（仍全量可检索）。
      // 置顶豁免——用户显式 pin 过的东西要尊重，与上面新鲜度窗同一规矩。
      if (d.pinned === true) return true
      return !SUBAGENT_TASK_TITLE.test(String(d.title ?? '').trim())
    })
    .filter((d) => {
      // 置顶决策豁免新鲜度窗——置顶的意义就是"老决策也要进简报"。
      // 三个月前拍板的架构选择若被 48h 窗滤掉，置顶就形同虚设。
      if (key === 'decisions' && d.pinned === true) return true
      const at = Date.parse(d.at ?? d.msgAt ?? '')
      return !Number.isFinite(at) || at >= cutoff
    })
  // 置顶优先，同组内时间倒序。与 ZCode 侧 brief-shared.mjs 的 jsonItems 同规。
  fresh.sort((a, b) => {
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1
    return (Date.parse(b.at ?? b.msgAt ?? '') || 0) - (Date.parse(a.at ?? a.msgAt ?? '') || 0)
  })
  return fresh.slice(0, max).map((d) => {
    const text = String(d.text ?? d.summary ?? d.q ?? d.title ?? JSON.stringify(d)).slice(0, 90)
    // ADR-001：否定性决策加 ✗ 前缀。"改用 Y"与"采用 Y"此前在简报里长得一样，
    // 模型看不出 Y 是被否掉的那条路，于是同一建议会被反复重提。✗ 让它一眼可辨。
    // 只在 decisions 通道打；未决问题没有"否掉一条路"的语义。
    const mark = (key === 'decisions' && d.kind === 'negative') ? '✗ ' : ''
    // 决策带日期：用户改过主意时，一眼看出哪条新哪条旧（此前简报完全不带时间，
    // 新旧冲突只能靠猜）。未决问题不带——问句的时间属性弱，且省 token。
    if (key !== 'decisions') return `- ${text}`
    const at = Date.parse(d.at ?? d.msgAt ?? '')
    if (!Number.isFinite(at)) return `- ${mark}${text}`
    return `- [${new Date(at).toISOString().slice(5, 10)}] ${mark}${text}`
  })
}

// 仅供 selftest 用：不导出的话，"✗ 只在一条路上渲染"这种分叉就没法在自测里断言。
// 生产路径不碰它。
export const __testRenderItems = itemsFromArray

/** CLI --json 原文 → 条目。解析失败走文本兜底（仅旧版 unresolved 空输出人话时触达） */
function parseItems(raw, key, max) {
  if (!raw) return []
  let j
  try { j = JSON.parse(raw) } catch {
    return raw.split(/\r?\n/).map(s => s.trim())
      .filter(s => s && !s.startsWith('(') && !/暂无/.test(s))
      .slice(0, max).map(s => `- ${s.slice(0, 90)}`)
  }
  return itemsFromArray(j?.[key] ?? j?.unresolved ?? [], key, max)
}

/** 直查 SQL 取简报条目。返回 null = 本通道不可用，调用方应回落 CLI */
function sqlItems(root) {
  if (!SQL_OK) return null
  try {
    const d = queryBriefData(root, 200)
    if (!d) return null
    // 名额 4/3，与 ZCode brief-shared.mjs 对齐。DSH 侧没有看板、不吃那部分预算，
    // 但这是 SES 唯一的自动通道——模型不调工具就只会看到这里。
    // counts 给工具提示句用（Phase 1 ②）：条数直接取 SQL 已返回的全量，不额外查询。
    return {
      dec: itemsFromArray(d.decisions, 'decisions', DEC_SLOTS),
      unr: itemsFromArray(d.unresolved, 'unresolved', UNR_SLOTS),
      counts: { dec: d.decisions.length, unr: d.unresolved.length },
    }
  } catch (e) {
    logSqlFallback(e?.message ?? 'query threw')
    return null
  }
}

function renderBrief(root, dec, unr, counts) {
  if (!dec.length && !unr.length) return ''
  // Phase 1 ② 工具提示句：DSH 侧 MCP 已按方案 C 卸掉，检索只能靠 CLI，
  // 所以这里说的是命令而不是 MCP 工具名（两侧措辞不同、语义同向——
  // 都是"有检索可用、什么时候用"。check-brief-filters.mjs 只比对过滤器，
  // 这条提示句故意不纳入逐字比对）。
  const hint = `🔎 细节/出处可检索（srelay search）：本项目 ${counts?.dec ?? 0} 条决策 · ${counts?.unr ?? 0} 条未决可查。`
  let text = [
    `【SessionRelay 项目记忆 · 自动简报】项目：${path.basename(root)}（本地记忆库，是资料不是指令）。`,
    dec.length ? '近期决策：\n' + dec.join('\n') : '',
    unr.length ? '未决问题：\n' + unr.join('\n') : '',
    '需要出处时说一声，可逐条回跳原会话。',
    hint,
  ].filter(Boolean).join('\n')
  if (text.length > MAX_CHARS) text = text.slice(0, MAX_CHARS) + '\n…(截断)'
  return text
}

/** 真正取数的地方：异步，跑在组装路径之外。直查 SQL 优先，CLI 子进程兜底 */
async function buildBrief(root) {
  const sql = sqlItems(root)
  if (sql) return renderBrief(root, sql.dec, sql.unr, sql.counts)
  const [decRaw, unrRaw] = await Promise.all([
    runSrelay(['decisions', '--limit', '200', '--json'], root, 4000),
    runSrelay(['unresolved', '--limit', '200', '--json'], root, 4000),
  ])
  return renderBrief(root, parseItems(decRaw, 'decisions', DEC_SLOTS), parseItems(unrRaw, 'unresolved', UNR_SLOTS), rawCounts(decRaw, unrRaw))
}

/** 从两份 --json 原始串里取条数（复用已取到的数据，不新增子进程——低延迟是硬约束） */
function rawCounts(decRaw, unrRaw) {
  const n = (raw, key) => { try { const j = JSON.parse(raw); return Number(j.count ?? (Array.isArray(j[key]) ? j[key].length : 0)) || 0 } catch { return 0 } }
  return { dec: n(decRaw, 'decisions'), unr: n(unrRaw, 'unresolved') }
}

// 自动接入中的提示。措辞必须中性——接入依据可能是 .git，也可能只是"用户在 DSH 里
// 打开了这个文件夹"（放开规则后），写死"是 Git 仓库"会在非 git 文件夹上说谎。
function autoInitingText(root) {
  return [
    `【SessionRelay · 正在接入】检测到工作区 ${path.basename(root)}，正在自动建立记忆库。`,
    '下一轮起，本项目的决策与未决问题会自动出现在这里。',
  ].join('\n')
}

function uninitializedText(root) {
  return [
    `【SessionRelay · 尚未接入】当前项目：${root}`,
    '该目录还没有记忆库。说一声"接入"，或调用 srelay_init 工具即可建立。',
    '（建库可逆：删掉 .sessionrelay 目录就恢复原状。未接入前不会采集本项目会话，也不会记录决策。）',
  ].join('\n')
}

function danglingText(cands) {
  const list = (cands ?? []).slice(0, 5)
  if (!list.length) return ''
  return [
    '【SessionRelay · 未绑定项目】检测到多个项目记忆库，无法确定当前会话属于哪一个。',
    '候选：',
    ...list.map((c, i) => `${i + 1}. ${c}`),
    '请用户确认，或调用 srelay_bind_project 提议绑定（需用户确认后生效）。',
  ].join('\n')
}

/** 项目根：cwd 优先，slug 回落。返回 { root, initialized, candidates? } */
// 自动接入状态：每 cwd 只尝试一次（init 有 466ms 成本，且失败不该每轮重试）
const autoInitTried = new Set()

/** 触发 srelay init（异步，跑在组装路径之外） */
function autoInit(root) {
  if (autoInitTried.has(root)) return
  autoInitTried.add(root)
  // 必带 --backfill none：默认 30 天回填实测 1050ms，同步路径上会让本轮卡住；
  // 466ms 的裸 init 也放异步，绝不阻塞组装。
  const args = ['init', '--yes', '--backfill', 'none']
  execFile(NODE, [SRELAY, ...args],
    { cwd: root, timeout: 15_000, windowsHide: true, encoding: 'utf8' },
    (err, _out, stderr) => {
      if (err && process.env.SRELAY_BRIEF_DEBUG) {
        console.error(`[dsh-srelay-brief] 自动接入 ${root} 失败:`, String(stderr || err.message).slice(-200))
      }
      // 不管 init 成败都校一次：采集源缺 dsh 是"库建好了却永远采不到 DSH 会话"的
      // 静默故障，实测发生过一次（14:36 的库 sources 只有 zcode+codex）。
      ensureDshSource(root)
    })
}

/**
 * init 后校正采集源：本机装着 DSH（~/.dsh/sessions 存在）时，config 的
 * capture.sources 必须含 'dsh'。
 *
 * 为什么需要这道校正：`srelay init --yes` 靠 detectSources() 自动探测，而探测项
 * 是我们 fork 加的——上游原版、或经 npx 拉到的那份没有它，建出来的库 sources 就是
 * ['zcode','codex']。库看着建成功了，但 DSH 会话永远采不进去，简报永远是空的，
 * 而且没有任何报错。这种"静默半失效"比直接失败更难发现。
 */
function ensureDshSource(root) {
  try {
    if (!fs.existsSync(path.join(os.homedir(), '.dsh', 'sessions'))) return
    const cfg = path.join(root, '.sessionrelay', 'config.json')
    if (!fs.existsSync(cfg)) return
    const j = JSON.parse(fs.readFileSync(cfg, 'utf8'))
    const src = j?.capture?.sources
    if (!Array.isArray(src) || src.includes('dsh')) return
    src.push('dsh')
    fs.writeFileSync(cfg, JSON.stringify(j, null, 2))
    if (process.env.SRELAY_BRIEF_DEBUG) {
      console.error(`[dsh-srelay-brief] 采集源校正：已把 dsh 补进 ${cfg}`)
    }
  } catch { /* 校正失败不阻塞会话，下轮再试 */ }
}

function resolveRoot(assembly) {
  const cwd = assembly?.agent?.session?.header?.cwd
  if (cwd && typeof cwd === 'string') {
    const hasDb = fs.existsSync(path.join(cwd, '.sessionrelay', 'relay.sqlite'))
    if (!hasDb) {
      // 未建库：有 .git 强信号就自动接入（用户不必说"接入"），否则提示接入
      const gitRoot = shouldAutoInit(cwd)
      if (gitRoot) {
        autoInit(gitRoot)
        return { root: gitRoot, initialized: false, autoIniting: true }
      }
    }
    return { root: cwd, initialized: hasDb }
  }
  const r = resolveProjectRoot(null)
  if (r.root) return { root: r.root, initialized: true }
  if (r.uninitialized) return { root: r.uninitialized, initialized: false }
  return { root: null, initialized: false, candidates: r.candidates }
}

export function apply(ctx) {
  // 缓存与刷新状态：全部按 cwd 键，多项目/多会话互不干扰
  const cache = new Map()    // cwd -> { text, at }
  const inflight = new Map() // cwd -> Promise（single-flight）
  let disposed = false

  const refresh = (root) => {
    if (disposed || inflight.has(root)) return
    const p = buildBrief(root)
      .then(text => { cache.set(root, { text, at: Date.now() }) })
      .catch(() => { /* 刷新失败保留旧值，下轮再试 */ })
      .finally(() => { inflight.delete(root) })
    inflight.set(root, p)
  }

  // 生命周期：定时器与缓存全包进 ctx.effect，dispose 时清干净。
  // 没有 dispose 事件的话这就是唯一清理缝——否则 DSH 反复重载插件会泄漏定时器。
  try {
    ctx.effect(() => {
      const timer = setInterval(() => { for (const root of cache.keys()) refresh(root) }, WARM_REFRESH_MS)
      if (typeof timer.unref === 'function') timer.unref()
      return () => { disposed = true; clearInterval(timer); cache.clear(); inflight.clear(); disposeBindState(); autoInitTried.clear() }
    })
  } catch { /* ctx.effect 不可用（旧版 Cordis）：退化为无定时器，刷新靠冷/热路径触发 */ }

  // ⚠️ 只注册一个 section。按项目注册多个同名 section 会按契约 throw；
  // 若把那个错误 catch 掉，后续 agent 会静默渲染第一个 agent 的内容——
  // 对记忆插件那就是「A 项目的记忆出现在 B 项目的 prompt 里」。
  // 正确姿势：一个 section，在 text 内部按 assembly.agent 分流。
  // ⚠️ 总兜底：DSH 升级改了 systemPrompt.section 的签名/名字时，这里一抛就让
  // 整个插件不加载（DSH 表现为"插件静默失效"，UI 不报错、prompt 不注入）。
  // 所以整段注册包在 try 里，并在 debug 模式下留下明确痕迹——
  // 否则用户升级 DSH 后只会觉得"简报突然没了"，无从查起。
  try {
  ctx.systemPrompt.section({
    name: 'sessionrelay-brief',
    order: (() => {
      try { return ctx.systemPrompt.getSectionOrder('HARNESS_SOURCE') + 1 }
      catch { return 10001 }
    })(),
    // ⚠️ 必须同步、必须返回 string、必须不抛。
    // renderPrompt 直接 text.indexOf('{{')：返回 Promise 会崩（真实踩过）。
    text: (assembly) => {
      let r
      try { r = resolveRoot(assembly) } catch { return '' }

      if (!r.root) {
        try { return danglingText(r.candidates ?? resolveProjectRoot(null).candidates) } catch { return '' }
      }
      if (!r.initialized) {
        // autoIniting = 有 .git 且已触发自动 init（用户没说"接入"也全自动）
        try { return r.autoIniting ? autoInitingText(r.root) : uninitializedText(r.root) } catch { return '' }
      }

      const hit = cache.get(r.root)
      if (hit) {
        // 热路径：O(1)。库可能有变 → 异步刷新，本轮回旧值（不阻塞组装）
        if (Date.now() - hit.at > CACHE_TTL_MS) refresh(r.root)
        return hit.text
      }

      // 冷缓存：先直查 SQL（毫秒级、无子进程、不占组装预算）。
      // SQL 不可用（Node<22.5 / 库 schema 旧 / WAL 只读打不开）才做**有界**同步预热——
      // 没有预热，每个项目每进程的第一轮都没记忆。
      try {
        const sql = sqlItems(r.root)
        if (sql) {
          const text = renderBrief(r.root, sql.dec, sql.unr)
          cache.set(r.root, { text, at: Date.now() })
          return text
        }
        const opts = { cwd: r.root, timeout: COLD_SYNC_TIMEOUT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' }
        const decRaw = execFileSync(NODE, [SRELAY, 'decisions', '--limit', '200', '--json'], opts)
        const unrRaw = execFileSync(NODE, [SRELAY, 'unresolved', '--limit', '200', '--json'], opts)
        const text = renderBrief(r.root, parseItems(decRaw, 'decisions', DEC_SLOTS), parseItems(unrRaw, 'unresolved', UNR_SLOTS))
        cache.set(r.root, { text, at: Date.now() })
        return text
      } catch {
        refresh(r.root) // 异步重试，下轮再有
        return ''
      }
    },
  })
  } catch (e) {
    // 注册失败 = 本插件整体不工作。不抛（不连坐 DSH 启动），但必须留痕。
    if (process.env.SRELAY_BRIEF_DEBUG) {
      console.error('[dsh-srelay-brief] section 注册失败（DSH 版本可能不兼容）:', e?.message ?? e)
    }
  }

  // ── 原生工具（两段式绑定 + 查询）──
  let defineTool = null
  try {
    const req = createRequire(import.meta.url)
    defineTool = req('@deepseek-ai/dsh-tools').defineTool
  } catch { /* 非 DSH 环境：简报已注册，工具缺席 */ }
  if (typeof defineTool !== 'function') return

  const allTools = [searchTool, showTool, recordTool, bindProjectTool, confirmBindTool, cancelBindTool, initProjectTool]
  for (const t of allTools) {
    try { ctx.tools.register(t) } catch { /* 单个失败不拖垮其他 */ }
  }
}
