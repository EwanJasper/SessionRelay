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
import { registerTools, searchTool, showTool, recordTool, bindProjectTool, bindState } from './index.js'

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
check('包含 srelay_record', toolMap.has('srelay_record'))
check('包含 srelay_bind_project', toolMap.has('srelay_bind_project'))

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
check('srelay_search: query 在 required 列表中', Array.isArray(searchParams.required) && searchParams.required.includes('query'))

const showParams = toolMap.get('srelay_show').parameters
check('srelay_show: sessionIdPrefix 在 required 列表中', Array.isArray(showParams.required) && showParams.required.includes('sessionIdPrefix'))
check('srelay_show: sessionIdPrefix 包含 description', typeof showParams.properties?.sessionIdPrefix?.description === 'string')

const recordParams = toolMap.get('srelay_record').parameters
check('srelay_record: summary 在 required 列表中', Array.isArray(recordParams.required) && recordParams.required.includes('summary'))
check('srelay_record: summary 包含 description', typeof recordParams.properties?.summary?.description === 'string')

const bindParams = toolMap.get('srelay_bind_project').parameters
check('srelay_bind_project: projectPath 在 required 列表中', Array.isArray(bindParams.required) && bindParams.required.includes('projectPath'))
check('srelay_bind_project: projectPath 包含 description', typeof bindParams.properties?.projectPath?.description === 'string')

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
console.log('\n=== 4. ★ srelay_bind_project 两段式安全验证 ===')
const initialProject = bindState.getActiveProject('selftest_scope')
console.log(`  [Scope 初始工作区]: ${initialProject}`)

// 第一段：模型调用 execute 发起提议
const proposalResult = await bindProjectTool.execute({ projectPath: 'E:\\music player' })
check('执行提议返回 ok === true', proposalResult.ok === true)
check('返回文案包含工作区说明', proposalResult.payload.includes('E:\\music player'))

// 换一个新项目提议
const targetNew = 'E:\\mc整合包'
const proposal2 = await bindProjectTool.execute({ projectPath: targetNew })
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
  const searchExec = await searchTool.execute({ query: 'PostgreSQL', limit: 2 })
  check('srelay_search 真实执行返回 ok === true', searchExec.ok === true)
  check('srelay_search 检索结果非空且包含中文', searchExec.payload.length > 20 && /[\u4e00-\u9fa5]/.test(searchExec.payload))
} catch (e) {
  check('srelay_search 真实执行不抛异常', false, e.message)
}

try {
  const showExec = await showTool.execute({ sessionIdPrefix: 'c93caed78751eb65', range: '1:2' })
  check('srelay_show 真实执行返回 ok === true', showExec.ok === true)
  check('srelay_show 检索详情非空且包含会话头信息', showExec.payload.includes('confirmed') || showExec.payload.includes('消息'))
} catch (e) {
  check('srelay_show 真实执行不抛异常', false, e.message)
}

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
