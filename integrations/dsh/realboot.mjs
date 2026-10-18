// 真实启动测试（real-boot）——不用 stub ctx，boot 真实的 dsh-system-prompt。
//
// 为什么存在：其余断言全是 stub ctx（`{ section: s => ... }` 接受任何形状），它固化的是
// "我对 API 的假设"，不是"API 的真实行为"。若 DSH 的 section 签名或 text 求值方式与假设不同，
// stub 测试照样全绿而真实环境崩。本测试用真实包建真实 SystemPrompt 服务，调真实 assemble()。
//
// [1015 债务3 修复] 从"孤立脚本"改为**可被 selftest 调用的导出函数 + 可跳过**：
//   · 原来硬编码 `PLUGIN = D:/dsh插件  记忆/plugins/dsh`（作者副本绝对路径）——部署副本里跑必然指错；
//     现在从 `import.meta.url` 推导，**跑在哪份副本就测哪份副本**。
//   · 原来找不到真实包就直接 `process.exit(1)`——在没装 DSH 的机器上等于把自测判死；
//     现在返回 `{ skipped: true, reason }`，让调用方**能区分"没条件测"与"测失败"**。
//   · 仍然保留 CLI 入口（`node realboot.mjs` 行为不变），只是多了一层可编程接口。
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** DSH 安装树候选（.pnpm 目录，内含 @deepseek-ai/* 的真实包）。可用 DSH_INSTALL_DIR 覆盖。 */
const DSH_CANDIDATES = [
  process.env.DSH_INSTALL_DIR,
  process.env.DSH_HOME ? path.join(process.env.DSH_HOME, 'node_modules', '.pnpm') : null,
  'D:/agent1super/dsh/node_modules/.pnpm',
  path.join(HERE, 'node_modules', '.pnpm'),
].filter(Boolean)

/** 在 .pnpm 树里找某个 @deepseek-ai/* 包的真实目录。
 *  pnpm 的目录名会**截断**长包名（dsh-system-prompt → dsh-system-pro），
 *  所以不能靠目录名前缀匹配；改为遍历后读 manifest 的 name 精确比对。 */
function pkgDir(root, name) {
  const want = '@deepseek-ai/' + name
  let dirs = []
  try { dirs = fs.readdirSync(root) } catch { return null }
  for (const d of dirs) {
    if (!d.startsWith('@deepseek-ai+')) continue
    const base = path.join(root, d, 'node_modules', '@deepseek-ai')
    let entries = []
    try { entries = fs.readdirSync(base) } catch { continue }
    for (const e of entries) {
      const pj = path.join(base, e, 'package.json')
      if (!fs.existsSync(pj)) continue
      try {
        if (JSON.parse(fs.readFileSync(pj, 'utf8')).name === want) return path.join(base, e)
      } catch { /* 跳过坏 manifest */ }
    }
  }
  return null
}

/** 找到第一个可用的 DSH 安装树（含 dsh-system-prompt 与 cordis 两个包）。 */
export function findDshTree() {
  for (const root of DSH_CANDIDATES) {
    if (!root || !fs.existsSync(root)) continue
    const SP = pkgDir(root, 'dsh-system-prompt')
    const CO = pkgDir(root, 'cordis')
    if (SP && CO) return { root, SP, CO }
  }
  return null
}

/**
 * 跑一次真实启动测试。**不抛异常**——一切结果都通过返回值表达。
 * @param {{ pluginDir?: string, log?: (s: string) => void }} opts
 * @returns {Promise<{ skipped: boolean, reason?: string, pass: number, fail: number, lines: string[] }>}
 */
export async function runRealBoot(opts = {}) {
  // 容错：调用方可能传 file:// URL（selftest 里的 HERE 就是），直接 path.join 会拼出
  // `\file:\...` 这种鬼路径——实测踩过：real-boot 因此静默 SKIP 成「找不到插件入口」。
  const rawDir = opts.pluginDir ?? HERE
  const pluginDir = String(rawDir).startsWith('file:') ? fileURLToPath(rawDir) : rawDir
  const log = opts.log ?? ((s) => process.stdout.write(s + '\n'))
  const lines = []
  const say = (s) => { lines.push(s); log(s) }
  let pass = 0
  let fail = 0
  const check = (n, c) => { say((c ? '  PASS ' : '  FAIL ') + n); if (c) pass++; else fail++ }

  const tree = findDshTree()
  if (!tree) {
    const reason = '找不到 DSH 安装树（.pnpm 里没有 dsh-system-prompt/cordis）——本机未装 DSH 或路径不同，' +
      '可用 DSH_INSTALL_DIR 指定'
    say('  SKIP real-boot：' + reason)
    return { skipped: true, reason, pass: 0, fail: 0, lines }
  }

  const entry = path.join(pluginDir, 'index.js')
  if (!fs.existsSync(entry)) {
    const reason = '找不到插件入口：' + entry
    say('  SKIP real-boot：' + reason)
    return { skipped: true, reason, pass: 0, fail: 0, lines }
  }

  const req = createRequire(path.join(tree.CO, 'package.json'))
  const { Context } = req(path.join(tree.CO, 'lib/index.js'))
  const root = new Context()
  let SystemPrompt, renderPrompt
  try {
    const mod = req(path.join(tree.SP, 'lib/index.js'))
    SystemPrompt = mod.SystemPrompt
    renderPrompt = mod.renderPrompt
    check('真实 dsh-system-prompt 可加载', typeof SystemPrompt === 'function')
  } catch (e) {
    const reason = '无法加载真实 dsh-system-prompt：' + e.message
    say('  SKIP real-boot：' + reason)
    return { skipped: true, reason, pass, fail, lines }
  }

  say('=== 1. 直接实例化真实 SystemPrompt（Service 构造器）===')
  let svc
  try {
    svc = new SystemPrompt(root, {})
    check('真实 SystemPrompt 可 new', !!svc)
    check('有 section 方法', typeof svc.section === 'function')
    check('有 assemble 方法', typeof svc.assemble === 'function')
    check('有 getSectionOrder 方法', typeof svc.getSectionOrder === 'function')
  } catch (e) {
    say('  FAIL 实例化抛错: ' + e.message)
    fail++
    return { skipped: false, pass, fail, lines }
  }

  say('=== 2. 注册我的真实 provider，跑真实 assemble + render ===')
  const plugin = await import(pathToFileURL(entry).href)
  const reg = []
  plugin.apply({
    systemPrompt: {
      section: (spec) => { reg.push(spec); return () => {} },
      getSectionOrder: (n) => 10001,
    },
    tools: { register: () => () => {} },
    effect: (f) => f(),
  })
  check('插件注册 1 个 section', reg.length === 1)
  const spec = reg[0]

  let rendered = null
  try {
    const dispose = svc.section({ name: 'real-boot-probe', order: 10001, text: spec.text })
    const asm = await svc.assemble({})
    check('真实 assemble() 不抛', !!asm && Array.isArray(asm.sections))
    rendered = renderPrompt(asm)
    dispose()
  } catch (e) {
    say('  FAIL assemble/render 抛错: ' + e.message)
    fail++
  }
  check('真实 renderPrompt 产出字符串', typeof rendered === 'string')

  say('=== 3. 反证：Promise 返回值会被真实链路拒绝 ===')
  let promiseErr = ''
  try {
    const d = svc.section({ name: 'promise-probe', order: 10002, text: async () => 'hello' })
    const asm = await svc.assemble({})
    renderPrompt(asm)
    d()
    say('     真实链路容忍 Promise（那原来的防御是多余的，但无害）')
  } catch (e) {
    promiseErr = String(e.message || e)
  }
  check('真实链路对 Promise 报 indexOf/is not a function', /indexOf|is not a function/.test(promiseErr))
  if (promiseErr) say('     真实错误: ' + promiseErr.slice(0, 120))

  say('=== 4. 真实 assemble() 是否把 agent 透传给 text provider ===')
  let seen = null
  try {
    const probe = (assembly) => { seen = assembly ?? null; return '' }
    const d = svc.section({ name: 'ctx-probe', order: 10003, text: probe })
    const fakeAgent = { id: 'probe-session', session: { header: { cwd: 'E:\\music player' } } }
    await svc.assemble({ agent: fakeAgent })
    d()
  } catch (e) { say('     assemble 抛错: ' + e.message) }

  check('provider 收到了 assembly 对象', seen !== null)
  const gotCwd = seen && seen.agent && seen.agent.session && seen.agent.session.header && seen.agent.session.header.cwd
  check('assembly.agent.session.header.cwd 透传成功', gotCwd === 'E:\\music player')
  say('     透传结果: ' + JSON.stringify(gotCwd))
  say('     assembly 键: ' + (seen ? Object.keys(seen).join(', ') : '(无)'))

  return { skipped: false, pass, fail, lines }
}

// ── CLI 入口：`node realboot.mjs` 行为与原来一致（PASS/FAIL 文案 + 退出码）──
const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isCli) {
  const r = await runRealBoot()
  if (r.skipped) { console.log('\nREAL-BOOT SKIP（' + r.reason + '）'); process.exit(0) }
  console.log(r.fail === 0 ? '\nREAL-BOOT PASS' : '\n' + r.fail + ' 项 FAIL')
  process.exit(r.fail === 0 ? 0 : 1)
}
