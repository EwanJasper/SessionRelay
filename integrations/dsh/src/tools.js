// tools.js — SessionRelay DSH 原生工具定义（4 个核心能力）
//
// 契约铁律：
// 1. defineTool 的 parameters 传扁平映射 { name: {type, required, description} }，
//    禁止外层包裹 {type:'object', properties:{}}，避免静默丢失 required/description。
// 2. output schema 必须显式声明 additionalProperties: false。
// 3. 绝不起 MCP serve 子进程，底层通过 cli.js 瞬态调用 CLI 命令。
// 4. srelay_bind_project 必须是两段式：模型调用只提议（propose），绝不直接更改生效项目。
import { defineTool } from './define-tool.js'
import { execSrelay, clip } from './cli.js'
import { getActiveProject, proposeProject, confirmProject, cancelProposal } from './state.js'

/** 标准工具返回输出契约，与 dsh-reach 一致 */
const resultSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    payload: { type: 'string' },
    error: { type: 'string' },
  },
}

/**
 * 1. srelay_search
 * 按关键词检索当前项目历史会话（中文全文 + 组合过滤）
 */
export const searchTool = defineTool({
  name: 'srelay_search',
  description: '按关键词检索当前项目的历史会话与上下文讨论（支持中文全文与多词过滤）。当需要了解过往相关背景、曾讨论过的设计思路时使用。',
  parameters: {
    query: { type: 'string', required: true, description: '检索关键词（支持多词空格分隔，如 "PostgreSQL 迁移"）' },
    limit: { type: 'number', description: '最多返回条数，默认 10' },
    topic: { type: 'string', description: '按特定话题过滤（可选）' },
    tag: { type: 'string', description: '按特定标签过滤（可选）' },
  },
  output: {
    schema: resultSchema,
    render: (_args, value) => [{
      type: 'text',
      text: value.ok ? value.payload : `检索失败：${value.error}`,
    }],
  },
  async execute(args) {
    const q = String(args?.query ?? '').trim()
    if (!q) return { ok: false, payload: '', error: 'query 关键词不能为空' }

    const cliArgs = ['search', q]
    const limit = Number(args.limit)
    if (Number.isFinite(limit) && limit > 0) {
      cliArgs.push('--limit', String(limit))
    }
    if (args.topic) cliArgs.push('--topic', String(args.topic))
    if (args.tag) cliArgs.push('--tag', String(args.tag))

    const cwd = getActiveProject()
    const res = await execSrelay(cliArgs, { cwd })

    if (!res.ok) {
      return { ok: false, payload: '', error: res.stderr || '检索执行异常' }
    }

    const output = (res.stdout || '').trim()
    return {
      ok: true,
      payload: clip(output || `未检索到包含 "${q}" 的历史会话。`),
      error: '',
    }
  },
})

/**
 * 2. srelay_show
 * 查看指定历史会话的详细对话片段与出处
 */
export const showTool = defineTool({
  name: 'srelay_show',
  description: '查看指定历史会话的具体对话消息与决策上下文详情。当通过 srelay_search 找到感兴趣的会话 ID 并需要阅读具体讨论细节时使用。',
  parameters: {
    sessionIdPrefix: { type: 'string', required: true, description: '会话 ID 或其前缀（如 search 结果中的 8-16 位 hash）' },
    range: { type: 'string', description: '消息序号范围，格式为 "起始:结束"（例如 "1:20"，可选）' },
  },
  output: {
    schema: resultSchema,
    render: (_args, value) => [{
      type: 'text',
      text: value.ok ? value.payload : `查看失败：${value.error}`,
    }],
  },
  async execute(args) {
    const id = String(args?.sessionIdPrefix ?? '').trim()
    if (!id) return { ok: false, payload: '', error: 'sessionIdPrefix 不能为空' }

    const cliArgs = ['show', id]
    if (args.range && typeof args.range === 'string') {
      cliArgs.push('--range', args.range.trim())
    }

    const cwd = getActiveProject()
    const res = await execSrelay(cliArgs, { cwd })

    if (!res.ok) {
      return { ok: false, payload: '', error: res.stderr || `未找到会话或读取失败：${id}` }
    }

    const output = (res.stdout || '').trim()
    return {
      ok: true,
      payload: clip(output || `会话 ${id} 无消息内容。`),
      error: '',
    }
  },
})

/**
 * 3. srelay_record
 * 主动记录重要技术决策与备忘笔记到当前项目记忆库
 */
export const recordTool = defineTool({
  name: 'srelay_record',
  description: '主动向当前项目的 SessionRelay 记忆库中沉淀记录一条已确认的技术决策或重要笔记。记录后即可被后续所有 AI 会话及自动简报检索到。',
  parameters: {
    summary: { type: 'string', required: true, description: '已确定的技术决策内容、方案结论或备忘总结' },
    tag: { type: 'string', description: '分类标签，多个标签用英文逗号分隔（如 "architecture,database"，可选）' },
    sessionId: { type: 'string', description: '关联的特定会话 ID 前缀（可选，缺省时自动关联最近 1 天内的活跃会话）' },
  },
  output: {
    schema: resultSchema,
    render: (_args, value) => [{
      type: 'text',
      text: value.ok ? value.payload : `记录失败：${value.error}`,
    }],
  },
  async execute(args) {
    const summary = String(args?.summary ?? '').trim()
    if (!summary) return { ok: false, payload: '', error: 'summary 决策摘要不能为空' }

    const cliArgs = ['save']
    if (args.sessionId) {
      cliArgs.push(String(args.sessionId).trim())
    } else {
      cliArgs.push('--recent', '1d')
    }
    cliArgs.push('--summary', summary)
    if (args.tag) {
      cliArgs.push('--tag', String(args.tag).trim())
    }
    cliArgs.push('--json')

    const cwd = getActiveProject()
    const res = await execSrelay(cliArgs, { cwd })

    if (!res.ok) {
      return { ok: false, payload: '', error: res.stderr || '记录决策失败' }
    }

    let report = ''
    try {
      const parsed = JSON.parse(res.stdout.trim())
      report = [
        `✓ 决策笔记已成功记录至项目记忆库：`,
        `- 工作区：${cwd}`,
        `- 决策摘要：${summary}`,
        `- 标签：${parsed.tags?.join(', ') || args.tag || '无'}`,
        `- 确认会话数：${parsed.saved ?? 1}`,
      ].join('\n')
    } catch {
      report = res.stdout.trim() || `✓ 决策笔记已记录：${summary}`
    }

    return {
      ok: true,
      payload: clip(report),
      error: '',
    }
  },
})

/**
 * 4. srelay_bind_project
 * 提议切换/绑定工作区（★两段式：模型调用仅记录提议，必须等用户确认才生效）
 */
export const bindProjectTool = defineTool({
  name: 'srelay_bind_project',
  description: '提议绑定或切换当前项目工作区路径（两段式安全保护：模型调用仅发起提议并做路径校验，绝不直接切换写入目标，必须经用户明确回复确认后才能正式生效）。',
  parameters: {
    projectPath: { type: 'string', required: true, description: '欲绑定的目标项目绝对路径（例如 "E:\\music player" 或 "E:\\mc整合包"）' },
  },
  output: {
    schema: resultSchema,
    render: (_args, value) => [{
      type: 'text',
      text: value.ok ? value.payload : `绑定提议失败：${value.error}`,
    }],
  },
  async execute(args) {
    const rawPath = String(args?.projectPath ?? '').trim()
    if (!rawPath) return { ok: false, payload: '', error: 'projectPath 不能为空' }

    const proposalResult = proposeProject(rawPath)
    if (!proposalResult.ok) {
      return {
        ok: false,
        payload: '',
        error: proposalResult.message,
      }
    }

    return {
      ok: true,
      payload: proposalResult.message,
      error: '',
    }
  },
})

/**
 * 【两段式第二段】确认绑定。仅在用户明确回复"确认"后由模型调用。
 * 缺失这个工具时，第一段的提议永远无法生效——用户说"确认"模型也无从执行。
 */
export const confirmBindTool = defineTool({
  name: 'srelay_confirm_bind_project',
  description: '确认上一个项目绑定提议（两段式第二段）。仅在用户明确同意切换后才调用；没有待确认提议时会失败。',
  parameters: {},
  output: {
    schema: resultSchema,
    render: (_args, value) => [{
      type: 'text',
      text: value.ok ? value.payload : `确认失败：${value.error}`,
    }],
  },
  async execute() {
    const r = confirmProject()
    if (!r.ok) return { ok: false, payload: '', error: r.message }
    return { ok: true, payload: r.message, error: '' }
  },
})

/** 取消待确认的绑定提议（用户改主意时用）。 */
export const cancelBindTool = defineTool({
  name: 'srelay_cancel_bind_project',
  description: '取消待确认的项目绑定提议。用户反悔或想换个项目时使用。',
  parameters: {},
  output: {
    schema: resultSchema,
    render: (_args, value) => [{ type: 'text', text: value.ok ? value.payload : value.error }],
  },
  async execute() {
    cancelProposal()
    return { ok: true, payload: '已取消待确认的项目绑定提议。', error: '' }
  },
})
