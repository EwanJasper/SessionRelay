// DSH 项目判定（Z6）—— 解决"DSH 桌面端不知道自己在哪个项目"。
//
// 问题：ZCode 是 CLI 型工具，进程 cwd 天然等于项目根；DSH 是桌面 GUI，进程 cwd 永远是
// 安装目录，且 cmdlineArgs 为空、ScopeKey 是不透明句柄——三条路全断（详见
// docs\MASTER-HANDOFF-20261013.md §5.1）。
//
// 解法：DSH 自己把会话按"工作目录 slug"分组存放在 ~/.dsh/sessions/ 下，例如
//   --E-music~0020player--   ← E:\music player
//   --D-agent1super--        ← D:\agent1super
// 这是 DSH 自己记录的归属，是唯一可用的"当前在哪个项目"信号。取最近活跃的那个
// 会话组，反解出项目路径，再用它作为 cwd 调 srelay 子命令（子命令只认 cwd，
// SRELAY_PROJECT_ROOT 仅对 serve 生效——已实测）。
//
// 编码规则（与 core 的 dshSessionSlug 互为逆运算，见 src/adapters/dsh/format.ts）：
//   ':' → 删除（盘符冒号丢失，解码时补回）
//   '\' '/' → '-'
//   空格 → '~0020'
//   非 ASCII → '~' + 4 位大写 hex
//   两端包 '--'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DSH_SESSIONS = path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'sessions')

/** slug → 原始路径（尽力还原）。无法确定盘符时返回 null。 */
export function decodeSlug(slug) {
  // 去掉两端 '--'
  let s = slug
  if (s.startsWith('--')) s = s.slice(2)
  if (s.endsWith('--')) s = s.slice(0, -2)
  // 还原 ~XXXX（4 位 hex = 一个 BMP 码点）与 ~0020（空格，同样走 hex 通道）
  let out = ''
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '~' && /^[0-9a-fA-F]{4}$/.test(s.slice(i + 1, i + 5))) {
      out += String.fromCharCode(parseInt(s.slice(i + 1, i + 5), 16))
      i += 4
      continue
    }
    out += s[i]
  }
  // 路径分隔符已被统一成 '-'，无法与真实 '-' 区分——这是 DSH 编码的有损点。
  // 实务上还原不出精确路径，改用「盘符 + 逐段探测」策略（见 resolveFromSlug）。
  return out
}

/** 盘符 + slug 还原 + 磁盘探测：用真实存在的目录反推分段。 */
export function resolveFromSlug(slug) {
  const raw = decodeSlug(slug)
  const drive = raw[0] // 'E' / 'D' / 'C'
  if (!/^[A-Za-z]$/.test(drive)) return null
  const rest = raw.slice(1) // 已无盘符冒号，分隔符是 '-'
  // 逐段 DFS：把 '-' 当分隔符尝试还原成真实路径（- 也可能出现在目录名里，
  // 故用"存在性"剪枝——只有拼出的前缀真实存在才继续深入）。
  const parts = rest.split('-').filter(Boolean)
  const found = []
  const walk = (idx, acc) => {
    if (idx === parts.length) { if (fs.existsSync(acc)) found.push(acc); return }
    // 两种拼法：作为新段（加分隔符）或并入上一段（补回 '-'）
    const seg = parts[idx]
    const withSep = path.join(acc, seg)
    walk(idx + 1, withSep)
    if (idx > 0) walk(idx + 1, acc + '-' + seg)
  }
  walk(0, drive + ':\\')
  return found.length ? found[0] : null
}

/** 最近活跃的 DSH 会话组 → 项目根（含 .sessionrelay 才算数）。 */
export function projectFromRecentSession(maxAgeMs = 24 * 3600_000) {
  let entries
  try { entries = fs.readdirSync(DSH_SESSIONS, { withFileTypes: true }) } catch { return null }
  const cutoff = Date.now() - maxAgeMs
  const cands = []
  for (const e of entries) {
    if (!e.isDirectory() || !e.name.startsWith('--')) continue
    const dir = path.join(DSH_SESSIONS, e.name)
    let newest = 0
    try {
      for (const sub of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!sub.isDirectory()) continue
        const st = fs.statSync(path.join(dir, sub.name))
        if (st.mtimeMs > newest) newest = st.mtimeMs
      }
    } catch { continue }
    if (newest < cutoff) continue
    cands.push({ slug: e.name, at: newest })
  }
  cands.sort((a, b) => b.at - a.at)
  // 规则：**最近活跃的会话说了算**，不是"谁先有库谁说了算"。
  //
  // 曾按"线性扫描、返回第一个有库的项目"实现，实测断在新工作区链路上：
  // 用户在全新目录里跟 DSH 说话（该会话最新），代码却找到更旧的 music player
  // （有库）并返回它 → 新目录永远等不到"说一声接入"的提示，简报也一直是旧项目的。
  //
  // 所以：取 cands[0]（已按 mtime 降序）中第一个能解析出真实路径的，再看它有没有库。
  // 多项目同时开会话时这个信号本身就有歧义（DSH 不告诉插件"当前会话是哪个"），
  // 那是已知限制；但单项目场景必须对。
  for (const c of cands) {
    const root = resolveFromSlug(c.slug)
    if (!root) continue
    if (!fs.existsSync(root)) continue // 目录已删/被移动：跳过，看下一个
    if (fs.existsSync(path.join(root, '.sessionrelay', 'relay.sqlite'))) return root
    // 最近的项目存在但没建库 → uninitialized（不要退回去找更旧的有库项目）
    return { uninitialized: root }
  }
  return null
}

/**
 * 全局注册表里的项目（读侧）。
 *
 * 剪枝规则对齐核心库 registryCandidates() 的前两条，缺一条就会误判：
 *  ① 临时目录拒收——核心库写侧有闸门，但存量的 %TEMP%\srelay-test-* 条目还在
 *    注册表里（本机实测 projects.json 里就有一条 Temp 下的测试库）。只判
 *    "relay.sqlite 存在" 会把它当成真项目，污染候选列表，还可能让
 *    "恰好一个" 这一级命中一个一次性沙盒。
 *  ② 必须有 relay.sqlite，.sessionrelay 目录本身不算。
 * TTL 与守护存活判定的剪枝留在核心库那边做——这里不写注册表，只读。
 */
export function registryProjects() {
  try {
    const f = path.join(os.homedir(), '.sessionrelay-registry', 'projects.json')
    const j = JSON.parse(fs.readFileSync(f, 'utf8'))
    const tmp = path.resolve(os.tmpdir()).toLowerCase() + path.sep
    return (j.projects ?? [])
      .map(p => (p && typeof p.root === 'string' ? path.resolve(p.root) : ''))
      .filter(Boolean)
      .filter(r => {
        // ① 临时目录不是项目
        if (r.toLowerCase().startsWith(tmp)) return false
        // ② 记忆库文件必须在
        try { return fs.existsSync(path.join(r, '.sessionrelay', 'relay.sqlite')) } catch { return false }
      })
  } catch { return [] }
}

/**
 * 项目判定降级链。返回 { root, via } 或 { root: null, candidates }。
 *   via: 'env' | 'dsh-session' | 'registry-single' | null
 */
export function resolveProjectRoot(envRoot) {
  // ① 显式 env（供开发联调或强制指定）
  if (envRoot && fs.existsSync(path.join(envRoot, '.sessionrelay'))) {
    return { root: envRoot, via: 'env' }
  }
  // ② DSH 自己的会话归属（最准的"当前在哪个项目"信号）
  const fromSession = projectFromRecentSession()
  if (fromSession && typeof fromSession === 'string') {
    return { root: fromSession, via: 'dsh-session' }
  }
  // ②b 会话归属明确、但该项目还没建库 → 单独状态，不落到"悬空"。
  // 若当成悬空，会把用户机器上另外几个项目列出来让他挑——那是误导（他就在这个项目里，
  // 只是还没接入）。这里不自动建库：自动建库等于猜意图（Desktop/Downloads/盘符根都会被误判），
  // 猜错即永久目录污染。与 ZCode 一致——普通目录零打扰，用户明确要求才 init。
  if (fromSession && fromSession.uninitialized) {
    return { root: null, uninitialized: fromSession.uninitialized, candidates: [], via: null }
  }
  // ③ 注册表恰好一个存活项目（新用户只有一个项目时的友好路径）
  const reg = registryProjects()
  if (reg.length === 1) return { root: reg[0], via: 'registry-single' }
  // ④ 悬空：给出候选，交给用户/模型确认
  return { root: null, candidates: reg, via: null }
}

// ── 自动接入（2026-10-14）──
//
// 用户诉求：新项目不用每次说"接入"。
//
// 为什么可以自动：init 的代价极低且**可逆**——实测只建 166KB 的 .sessionrelay/
// （config.json + relay.sqlite + stats.json），删掉目录就彻底消失。这与"自动绑定"
// 是截然不同的风险等级：绑定错会把决策写进错的库（不可逆），init 错只是多一个
// 可删的小目录。
//
// 为什么仍然要设门槛：无差别自动 init 会在桌面/下载/盘符根目录留下一堆垃圾库，
// 还会污染全局注册表。所以规则是——**只有强信号才自动**：
//   · 从 cwd 向上找到第一个含 .git 的目录（inferProjectRoot 同款逻辑）
//   · 那个目录没有 .sessionrelay → 才 auto-init 候选
//   · 没有任何 .git → 不猜，走原来的"说一声接入"
// 这样：clone 的仓库全自动；随手打开的文件夹零打扰。
//
// 上游 init 会写全局注册表（touchRegistry），所以误 init 的代价还包括注册表多一项。
// 但注册表已有 TTL 剪枝（30 天 + 守护已死 → 自动清除），误 init 会自愈。

/** 从 startDir 向上找第一个含 .git 的目录；找不到返回 null */
export function findGitRoot(startDir) {
  let dir = path.resolve(startDir)
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/** 是否应该自动接入：有 .git 且尚未建库 */
export function shouldAutoInit(startDir) {
  const root = findGitRoot(startDir)
  if (!root) return null
  if (fs.existsSync(path.join(root, '.sessionrelay', 'relay.sqlite'))) return null
  return root
}
