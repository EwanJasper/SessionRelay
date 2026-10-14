// 真实启动测试（real-boot）——不用 stub ctx，boot 真实的 dsh-system-prompt。
//
// 为什么单独写这个：此前 46 项断言全是 stub ctx（`{ section: s => ... }` 接受任何形状），
// 它固化的是"我对 API 的假设"，不是"API 的真实行为"。若 DSH 的 section 签名或
// text 求值方式与假设不同，stub 测试照样全绿而真实环境崩。
// 本测试用 profile 的 createRequire 加载真正的 @deepseek-ai/dsh-system-prompt，
// 建真实 SystemPrompt 服务，调真实 assemble()，断言真实渲染结果。
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const PLUGIN = 'D:/dsh插件  记忆/plugins/dsh'
const PROFILE = 'C:/Users/crx/.dsh/profiles/web'

let fail = 0
const check = (n, c) => { console.log((c ? '  PASS ' : '  FAIL ') + n); if (!c) fail++ }

// 用 profile 的解析路径（与 DSH 运行时同源）加载真实 dsh-system-prompt
// 用 DSH 安装树内的真实路径（profile 的 node_modules 没有这两个包，
// 它们在 .pnpm 里；DSH 运行时靠两锚点解析才找得到）
const DSH_PKG = 'D:/agent1super/dsh/node_modules/.pnpm'
function pkgDir(name) {
  // pnpm 的 .pnpm 目录名会**截断**长包名（dsh-system-prompt → dsh-system-pro），
  // 所以不能靠目录名前缀匹配。改为：遍历候选目录，读里面的
  // node_modules/@deepseek-ai/<name>/package.json，用 name 字段精确比对。
  const want = '@deepseek-ai/' + name
  for (const d of fs.readdirSync(DSH_PKG)) {
    if (!d.startsWith('@deepseek-ai+')) continue
    const base = path.join(DSH_PKG, d, 'node_modules', '@deepseek-ai')
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
const SP = pkgDir('dsh-system-prompt')
const CO = pkgDir('cordis')
if (!SP || !CO) { console.log('找不到真实包:', { SP, CO }); process.exit(1) }
const req = createRequire(path.join(CO, 'package.json'))
const { Context } = req(path.join(CO, 'lib/index.js'))
const root = new Context()
let SystemPrompt, renderPrompt
try {
  const mod = req(path.join(SP, 'lib/index.js'))
  SystemPrompt = mod.SystemPrompt
  renderPrompt = mod.renderPrompt
  check('真实 dsh-system-prompt 可加载', typeof SystemPrompt === 'function')
} catch (e) {
  console.log('  FAIL 无法加载真实 dsh-system-prompt:', e.message)
  console.log('  → 跳过 real-boot（改回 stub 覆盖）')
  process.exit(1)
}

console.log('=== 1. 直接实例化真实 SystemPrompt（Service 构造器）===')
let svc
try {
  svc = new SystemPrompt(root, {})
  check('真实 SystemPrompt 可 new', !!svc)
  check('有 section 方法', typeof svc.section === 'function')
  check('有 assemble 方法', typeof svc.assemble === 'function')
  check('有 getSectionOrder 方法', typeof svc.getSectionOrder === 'function')
} catch (e) {
  console.log('  FAIL 实例化抛错:', e.message)
  process.exit(1)
}

console.log('=== 2. 注册我的真实 provider，跑真实 assemble + render ===')
const plugin = await import(pathToFileURL(path.join(PLUGIN, 'index.js')).href)
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
  console.log('  FAIL assemble/render 抛错:', e.message)
  console.log('    ', (e.stack || '').split('\n')[1]?.trim())
}
check('真实 renderPrompt 产出字符串', typeof rendered === 'string')

console.log('=== 3. 反证：Promise 返回值会被真实链路拒绝 ===')
// 这是 real-boot 的核心价值——证明"必须返回 string"不是我的假设，是真实契约
let promiseErr = ''
try {
  const d = svc.section({ name: 'promise-probe', order: 10002, text: async () => 'hello' })
  const asm = await svc.assemble({})
  renderPrompt(asm)
  d()
  console.log('     真实链路容忍 Promise（那我原来的防御是多余的，但无害）')
} catch (e) {
  promiseErr = String(e.message || e)
}
check('真实链路对 Promise 报 indexOf/is not a function', /indexOf|is not a function/.test(promiseErr))
if (promiseErr) console.log('     真实错误:', promiseErr.slice(0, 120))

console.log('=== 4. 真实 assemble() 是否把 agent 透传给 text provider ===')
// 这是 cwd 方案的最后一个未证实环节：我的 provider 读 assembly.agent.session.header.cwd。
// 若真实 SystemPrompt 不透传 context 给 provider，整套 cwd 优先就落空。
let seen = null
try {
  const probe = (assembly) => { seen = assembly ?? null; return '' }
  const d = svc.section({ name: 'ctx-probe', order: 10003, text: probe })
  const fakeAgent = { id: 'probe-session', session: { header: { cwd: 'E:\\music player' } } }
  await svc.assemble({ agent: fakeAgent })
  d()
} catch (e) { console.log('     assemble 抛错:', e.message) }

check('provider 收到了 assembly 对象', seen !== null)
const gotCwd = seen && seen.agent && seen.agent.session && seen.agent.session.header && seen.agent.session.header.cwd
check('assembly.agent.session.header.cwd 透传成功', gotCwd === 'E:\\music player')
console.log('     透传结果:', JSON.stringify(gotCwd))
console.log('     assembly 键:', seen ? Object.keys(seen).join(', ') : '(无)')

console.log(fail === 0 ? '\nREAL-BOOT PASS' : `\n${fail} 项 FAIL`)
process.exit(fail === 0 ? 0 : 1)
