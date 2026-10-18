// state.js — 两段式项目绑定状态机与上下文管理
//
// 铁律：
// 1. 模型调用 srelay_bind_project 只能提议（propose），绝不直接生效切换
// 2. 必须等待用户明确下达确认指令后，调用 confirmProject 才能切换
// 3. 避免单一全局变量串味：按 scopeId 隔离，支持多会话上下文
// 4. 留出清晰的存储适配器钩子（setStorageAdapter），便于主线后续接入 SQLite 持久化
import fs from 'node:fs'
import path from 'node:path'

/**
 * 默认项目根。**不再硬编码任何作者个人路径**——那会在所有探测都失败时
 * 静默返回一个不属于用户的目录（审查报告 P0：直接破坏插件"注错比不注更糟"的承诺）。
 * 现在只认 env；两者都没有就是 null，调用方必须显式处理"不知道"。
 */
export const DEFAULT_PROJECT_ROOT = process.env.SRELAY_PROJECT_ROOT || process.env.SRELAY_BRIEF_ROOT || null

/** 内存态存储：支持按 scopeId 区分 */
const activeProjects = new Map()
const pendingProposals = new Map()

/** 可插拔的存储适配器（给主线 ZCode 预留） */
let customStorageAdapter = null

/**
 * 生命周期钩子：由 index.js 在 ctx.effect 的 disposer 里调用。
 * 模块级 Map 在 DSH 热重载（HMR）时不会自动释放——旧 fiber 的绑定/pending 状态
 * 会残留，可能与新 fiber 的状态互相污染（审查报告指出的 HMR 风险）。
 */
export function disposeBindState() {
  activeProjects.clear()
  pendingProposals.clear()
  customStorageAdapter = null
}

/**
 * 设置自定义存储适配器（主线扩展点）
 * @param {{ getActive?: (scopeId: string) => string, setActive?: (scopeId: string, path: string) => void, getPending?: (scopeId: string) => any, setPending?: (scopeId: string, p: any) => void }} adapter
 */
export function setStorageAdapter(adapter) {
  customStorageAdapter = adapter
}

/**
 * 获取指定作用域的当前生效项目根目录
 * @param {string} [scopeId='default']
 * @returns {string}
 */
export function getActiveProject(scopeId = 'default') {
  if (customStorageAdapter?.getActive) {
    const val = customStorageAdapter.getActive(scopeId)
    if (val) return val
  }
  return activeProjects.get(scopeId) || DEFAULT_PROJECT_ROOT || null
}

/**
 * 获取当前等待用户确认的提议
 * @param {string} [scopeId='default']
 * @returns {{ targetPath: string, proposedAt: number, note?: string } | null}
 */
export function getPendingProposal(scopeId = 'default') {
  if (customStorageAdapter?.getPending) {
    return customStorageAdapter.getPending(scopeId) ?? null
  }
  return pendingProposals.get(scopeId) || null
}

/**
 * 校验目标路径是否为合法的项目目录
 * @param {string} targetPath
 * @returns {{ valid: boolean, normalizedPath: string, reason?: string }}
 */
export function validateProjectPath(targetPath) {
  if (!targetPath || typeof targetPath !== 'string') {
    return { valid: false, normalizedPath: '', reason: '项目路径不能为空' }
  }
  const normalized = path.resolve(targetPath.trim())
  try {
    const stat = fs.statSync(normalized)
    if (!stat.isDirectory()) {
      return { valid: false, normalizedPath: normalized, reason: '目标路径不是一个有效目录' }
    }
  } catch (err) {
    return { valid: false, normalizedPath: normalized, reason: `目标目录不存在或无法访问：${err.message}` }
  }
  // 必须校验记忆库存在：只判目录会让"绑定一个还没 init 的目录"假成功——
  // 提议通过 → 用户确认 → 切过去 → 所有工具报「未找到 .sessionrelay」静默失败。
  // 实测踩中（Antigravity 报告 Bug 2）。
  if (!fs.existsSync(path.join(normalized, '.sessionrelay', 'relay.sqlite'))) {
    return {
      valid: false,
      normalizedPath: normalized,
      reason: '该目录尚未初始化记忆库（先在该目录运行 srelay init，或让用户说一声"接入"）',
    }
  }
  return { valid: true, normalizedPath: normalized }
}

/**
 * 【第一段：模型提议】
 * 仅记录为待确认提议，绝不立即更改当前生效路径
 * @param {string} targetPath 欲绑定的项目路径
 * @param {string} [scopeId='default'] 会话/作用域标识
 * @returns {{ ok: boolean, targetPath: string, currentPath: string, message: string }}
 */
export function proposeProject(targetPath, scopeId = 'default') {
  const check = validateProjectPath(targetPath)
  if (!check.valid) {
    return {
      ok: false,
      targetPath,
      currentPath: getActiveProject(scopeId),
      message: `项目路径校验失败：${check.reason}`,
    }
  }

  const normalized = check.normalizedPath
  // current 可能为 null（无绑定、无 env——P0 修复后不再兜底硬编码路径）。
  // 必须显式处理，否则 current.toLowerCase() 直接 TypeError。
  const current = getActiveProject(scopeId)

  if (current && normalized.toLowerCase() === current.toLowerCase()) {
    return {
      ok: true,
      targetPath: normalized,
      currentPath: current,
      message: `目标项目已经是当前生效的工作区：${normalized}（无需切换）`,
    }
  }

  const proposal = {
    targetPath: normalized,
    proposedAt: Date.now(),
  }

  if (customStorageAdapter?.setPending) {
    customStorageAdapter.setPending(scopeId, proposal)
  } else {
    pendingProposals.set(scopeId, proposal)
  }

  return {
    ok: true,
    targetPath: normalized,
    currentPath: current,
    message: [
      `【项目切换提议已记录】`,
      `提议目标：${normalized}`,
      `当前生效：${current}`,
      `\n⚠️ 铁律安全提示：切换项目将改变记忆库读写目标（后续技术决策将写入新库）。`,
      `为防止 AI 误操作导致记忆交叉污染，此操作尚未生效，必须等待用户明确下达"确认切换"指令。`,
    ].join('\n'),
  }
}

/**
 * 【第二段：用户确认】
 * 仅在用户明确确认后，由宿主/插件调用此方法正式切换项目
 * @param {string} [scopeId='default']
 * @returns {{ ok: boolean, activeProject: string, message: string }}
 */
export function confirmProject(scopeId = 'default') {
  const proposal = getPendingProposal(scopeId)
  if (!proposal) {
    return {
      ok: false,
      activeProject: getActiveProject(scopeId),
      message: '当前没有待确认的项目切换提议。',
    }
  }

  const newPath = proposal.targetPath
  if (customStorageAdapter?.setActive) {
    customStorageAdapter.setActive(scopeId, newPath)
  } else {
    activeProjects.set(scopeId, newPath)
  }

  // 清除提议
  if (customStorageAdapter?.setPending) {
    customStorageAdapter.setPending(scopeId, null)
  } else {
    pendingProposals.delete(scopeId)
  }

  return {
    ok: true,
    activeProject: newPath,
    message: `✓ 项目工作区已成功切换至：${newPath}（后续记忆读写已锁定至该库）`,
  }
}

/**
 * 取消当前提议
 * @param {string} [scopeId='default']
 */
export function cancelProposal(scopeId = 'default') {
  if (customStorageAdapter?.setPending) {
    customStorageAdapter.setPending(scopeId, null)
  } else {
    pendingProposals.delete(scopeId)
  }
}
