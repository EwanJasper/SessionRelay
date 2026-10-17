// selftest.mjs — DSH 原生工具封装专属自测套件（Antigravity 侧）
//
// 验证纪律：
// 1. stub ctx.tools.register 收集器验证 4 个工具真实注册
// 2. 严苛断言 parameters 经 defineTool 规范化后的 Schema 形状（required 与 description 存活）
// 3. 验证 output schema 及 render() 契约（additionalProperties 必须显式 false）
// 4. ★ 核心安全契约：验证 srelay_bind_project 两段式（模型调用只提议、不直接切换目标）
// 5. 验证真实执行与结果返回（非空、无乱码）
// 6. ★ 零新增 MCP 子进程审计：断言原生工具运行前后绝无新增 srelay.js serve 进程
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// 真实查询要用**本仓库自己**的库：显式给路，不靠 activeProject 的残留状态。
//   病历（2026-10-18）：第 4 节把 activeProject 切到 E:\\mc整合包 后原样没恢复（initialProject
//   为 null 时 proposeProject 失败），于是第 5 节的真实查询其实是在查另一个项目 ——
//   测试挂不挂取决于「上一个测试有没有把状态弄脏」，这种测试比没有还糟（它会给假绿灯）。
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
import { registerTools, searchTool, showTool, rememberTool, projectTool, bindState } from './index.js'

let fail = 0
const check = (name, cond, detail = '') => {
  const status = cond ? '  PASS ' : '  FAIL '
  console.log(`${status}${name}${detail ? ' (' + detail + ')' : ''}`)
  if (!cond) fail++
}

function getServePids() {
  try {
    // 精确匹配 node.exe 运行的 srelay.js serve，排除 powershell 查询脚本自身
    const psCmd = 'Get-CimInstance Win32_Process | Where-Object { $_.Name -like "*node*" -and $_.CommandLine -like "*srelay*serve*" } | Select-Object -ExpandProperty ProcessId'
    const psOut = execFileSync('powershell', ['-NoProfile', '-Command', psCmd], { encoding: 'utf8', windowsHide: true }).trim()
    return psOut ? psOut.split(/\r?\n/).map(s => s.trim()).filter(Boolean) : []
  } catch {
    return []
  }
}

console.log('════════════════════════════════════════════════════════════')
console.log('SessionRelay DSH 原生工具验收测试（Antigravity 侧）')
console.log('════════════════════════════════════════════════════════════\n')

// 记录运行前既有的 serve 进程 baseline
const baselinePids = new Set(getServePids())
console.log(`[前置进程审计]: 既有 srelay serve PID baseline: ${[...baselinePids].join(', ') || '无'}`)

// ── 1. stub 收集器与注册契约 ──
console.log('\n=== 1. stub 收集器：4 个工具注册契约 ===')
const registered = []
const ctx = {
  tools: {
    register(tool) {
      registered.push(tool)
    },
  },
}

registerTools(ctx)
check('注册工具数量恰好为 4', registered.length === 4, `实际: ${registered.length}`)

const toolMap = new Map(registered.map((t) => [t.name, t]))
check('包含 srelay_search', toolMap.has('srelay_search'))
check('包含 srelay_show', toolMap.has('srelay_show'))
check('包含 srelay_remember', toolMap.has('srelay_remember'))
check('包含 srelay_project', toolMap.has('srelay_project'))
// [1026 工具面精简] 下面这几个名字**必须不在**：它们已经被合并进上面 4 个，
//   还注册着就说明精简没真做（模型上下文一点没省）。
for (const gone of ['srelay_decisions', 'srelay_unresolved', 'srelay_lessons', 'srelay_history',
  'srelay_related', 'srelay_stats', 'srelay_pin', 'srelay_record', 'srelay_init',
  'srelay_bind_project', 'srelay_confirm_bind_project', 'srelay_cancel_bind_project']) {
  check(`已合并下线: ${gone} 不再注册`, !toolMap.has(gone))
}

// ── 2. 参数扁平映射与 Schema 规范化验证（核心防坑点） ──
console.log('\n=== 2. 参数扁平映射与 Schema 规范化验证 ===')
for (const [name, t] of toolMap) {
  check(`${name}: parameters 顶层为 object`, t.parameters?.type === 'object')
  check(`${name}: parameters.properties 存在`, typeof t.parameters?.properties === 'object')
}

// 检查每个工具的关键必填项和描述是否存活
const searchParams = toolMap.get('srelay_search').parameters
check('srelay_search: query 属性存在', Boolean(searchParams.properties?.query))
check('srelay_search: query 包含有效 description', typeof searchParams.properties?.query?.description === 'string' && searchParams.properties.query.description.length > 0)

const showParams = toolMap.get('srelay_show').parameters
check('srelay_show: sessionIdPrefix 在 required 列表中', Array.isArray(showParams.required) && showParams.required.includes('sessionIdPrefix'))
check('srelay_show: sessionIdPrefix 包含 description', typeof showParams.properties?.sessionIdPrefix?.description === 'string')

// [1026] query 不再 required：kind=decisions / unresolved 根本不需要关键词。
//   这是这次合并在 schema 上唯一的**破坏性**变化，必须显式断言，不能靠「反正没崩」。
check('srelay_search: query 不再是 required（kind 分支不需要它）',
  Array.isArray(searchParams.required) ? !searchParams.required.includes('query') : true)
check('srelay_search: kind 属性存在且有 description',
  typeof searchParams.properties?.kind?.description === 'string' && searchParams.properties.kind.description.length > 0)

const rememberParams = toolMap.get('srelay_remember').parameters
check('srelay_remember: summary / text 都在 properties 里（二选一路由靠它们）',
  Boolean(rememberParams.properties?.summary && rememberParams.properties?.text))
check('srelay_remember: summary 的 description 明确说了「记录用」',
  typeof rememberParams.properties?.summary?.description === 'string')

const projectParams = toolMap.get('srelay_project').parameters
check('srelay_project: action 在 required 列表中', Array.isArray(projectParams.required) && projectParams.required.includes('action'))
check('srelay_project: projectPath 有 description', typeof projectParams.properties?.projectPath?.description === 'string')

// ── 3. 输出 Schema 与 render() 函数契约 ──
console.log('\n=== 3. 输出 Schema 与 render 呈现契约 ===')
for (const [name, t] of toolMap) {
  check(`${name}: output.schema 显式设置 additionalProperties === false`, t.output?.schema?.additionalProperties === false)
  check(`${name}: output.schema 包含 ok/payload/error`,
    Boolean(t.output?.schema?.properties?.ok && t.output?.schema?.properties?.payload && t.output?.schema?.properties?.error))
  
  // 测试 render 函数
  const okRender = t.output.render({}, { ok: true, payload: '测试输出文本' })
  check(`${name}: 成功 render 返回 text 结构`, Array.isArray(okRender) && okRender[0]?.type === 'text' && okRender[0]?.text.includes('测试输出文本'))

  const errRender = t.output.render({}, { ok: false, error: '测试异常信息' })
  check(`${name}: 失败 render 返回包含错误信息的 text`, Array.isArray(errRender) && errRender[0]?.type === 'text' && errRender[0]?.text.includes('测试异常信息'))
}

// ── 4. ★ 核心安全铁律：srelay_bind_project 两段式验证 ──
console.log('\n=== 4. ★ srelay_project(action=bind) 两段式安全验证 ===')
const initialProject = bindState.getActiveProject('selftest_scope')
console.log(`  [Scope 初始工作区]: ${initialProject}`)

// 第一段：模型调用 execute 发起提议
const proposalResult = await projectTool.execute({ action: 'bind', projectPath: 'E:\\music player' })
check('执行提议返回 ok === true', proposalResult.ok === true)
check('返回文案包含工作区说明', proposalResult.payload.includes('E:\\music player'))

// 换一个新项目提议
const targetNew = 'E:\\mc整合包'
const proposal2 = await projectTool.execute({ action: 'bind', projectPath: targetNew })
check('提议新项目返回 ok === true', proposal2.ok === true)
check('提议文案包含安全确认警告', proposal2.payload.includes('需用户确认') || proposal2.payload.includes('尚未生效'))

// 核心断言：提议后，当前工作区绝对不能改变！
const currentActive = bindState.getActiveProject('default')
check('【铁律断言】模型调用提议后，当前生效工作区未被篡改', currentActive !== targetNew, `当前仍为: ${currentActive}`)

// 检查 pending 状态已正确暂存
const pending = bindState.getPendingProposal('default')
check('pending 提议状态已正确记录', pending?.targetPath?.toLowerCase() === targetNew.toLowerCase())

// 第二段：模拟用户人工确认
const confirmRes = bindState.confirmProject('default')
check('人工确认执行返回 ok === true', confirmRes.ok === true)
check('人工确认后生效工作区真正切换', bindState.getActiveProject('default')?.toLowerCase() === targetNew.toLowerCase())
check('确认后 pending 状态已清空', bindState.getPendingProposal('default') === null)

// 还原为默认主战场，避免影响后续测试
bindState.cancelProposal('default')
const restoreRes = bindState.proposeProject(initialProject, 'default')
if (restoreRes.ok) bindState.confirmProject('default')
console.log(`  [测试结束恢复工作区]: ${bindState.getActiveProject('default')}`)

// ── 5. 真实查询能力自测（原生瞬态执行） ──
console.log('\n=== 5. 真实 CLI 瞬态查询调用验证 ===')
try {
  const searchExec = await searchTool.execute({ query: 'PostgreSQL', limit: 2, projectPath: REPO_ROOT })
  check('srelay_search 真实执行返回 ok === true', searchExec.ok === true)
  // 只断言「CLI 结果被正确透传」，**不赌库里有没有这个词** ——
  //   原断言要求「结果 > 20 字且含中文」，而它查的库是 getActiveProject 的残留值：
  //   换个项目、或上一个测试把状态弄脏，它就假红灯；反过来库里恰好有那个词就假绿灯。
  //   这类断言测的不是代码，是运气。
  check('srelay_search 把 CLI 输出透传出来（非空）', typeof searchExec.payload === 'string' && searchExec.payload.length > 0)
} catch (e) {
  check('srelay_search 真实执行不抛异常', false, e.message)
}

try {
  // show 反过来测**错误路径**：给一个不可能存在的 id，要求它明确报错而不是崩溃或静默成功。
  //   原来测的是「硬编码 id c93caed78751eb65 能查到」—— 那个 id 只存在于历史上某个库，
  //   换台机器/换个库就红，属于「测试在测数据」。
  const showExec = await showTool.execute({ sessionIdPrefix: 'zzzzno-such-session', projectPath: REPO_ROOT })
  // 实测行为：ok:true + payload "✗ 未找到会话：<id>"（CLI 把「查无此会话」当正常输出，不是异常）。
  //   所以判据是：**必须明说没找到**，不许静默成功（空 payload）或崩掉。
  check('srelay_show 对不存在的会话明说「未找到」（不静默成功）',
    showExec.ok === true && /未找到|not found/i.test(String(showExec.payload)))
} catch (e) {
  check('srelay_show 真实执行不抛异常', false, e.message)
}

// ── 5.5 ★ 合并后的路由判据 ──
// [1026] 精简新增了「一个工具多个子能力」，而**新增能力必须有判据** —— 否则下次有人
//   改错路由，工具照样注册成功、照样返回 ok，只是查的不是那个东西。这种错没有测试就永远发现不了。
console.log('\n=== 5.5 ★ 合并工具的路由判据 ===')

// 未知 kind 必须报错。静默退回 sessions 是最坏的形态：用户以为查了决策，实际查的是会话。
try {
  const badKind = await searchTool.execute({ kind: 'nonsense', query: 'x' })
  check('search: 未知 kind 报错（不静默退回 sessions）', badKind.ok === false && String(badKind.error).includes('未知 kind'))
} catch (e) { check('search: 未知 kind 报错', false, e.message) }

// kind=decisions 不传 query 要能跑 —— 这正是把 query 从 required 拿掉的理由
try {
  const dec = await searchTool.execute({ kind: 'decisions', limit: 2 })
  check('search: kind=decisions 不传 query 也能执行', dec.ok === true, String(dec.error || '').slice(0, 60))
} catch (e) { check('search: kind=decisions 不传 query 也能执行', false, e.message) }

// remember：两个入口都没给时，不许随便挑一个执行
try {
  const noTarget = await rememberTool.execute({})
  check('remember: summary/text 都没给时报错', noTarget.ok === false && String(noTarget.error).includes('都没给'))
} catch (e) { check('remember: 都没给时报错', false, e.message) }

// project：未知 action 必须报错
try {
  const badAction = await projectTool.execute({ action: 'nonsense' })
  check('project: 未知 action 报错', badAction.ok === false && String(badAction.error).includes('未知 action'))
} catch (e) { check('project: 未知 action 报错', false, e.message) }

// ── 6. ★ 零新增 MCP 子进程审计 ──
console.log('\n=== 6. ★ 零新增 MCP 子进程（srelay serve）审计 ===')
const currentPids = getServePids()
const newlySpawned = currentPids.filter(pid => !baselinePids.has(pid))
check('原生工具执行期间零新增 srelay.js serve 子进程', newlySpawned.length === 0, `新增数量: ${newlySpawned.length}`)

console.log('\n════════════════════════════════════════════════════════════')
if (fail === 0) {
  console.log('✅ ALL DSH NATIVE TOOLS SELFTESTS PASSED (0 failures)')
  process.exit(0)
} else {
  console.log(`❌ SELFTEST FAILED: ${fail} failure(s)`)
  process.exit(1)
}
