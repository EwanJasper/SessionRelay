// index.js — SessionRelay DSH 原生工具模块入口
//
// 导出 4 个原生工具实例以及统一注册函数 registerTools(ctx)，
// 供宿主插件或主线 index.js 在 apply(ctx) 阶段直接注入使用：
//
//   import { registerTools } from './src/index.js'
//   export function apply(ctx) {
//     registerTools(ctx)
//   }
import { searchTool, showTool, recordTool, bindProjectTool, confirmBindTool, cancelBindTool } from './tools.js'
import * as bindState from './state.js'
import { execSrelay, clip } from './cli.js'

export { searchTool, showTool, recordTool, bindProjectTool, confirmBindTool, cancelBindTool }
export { bindState }
export { execSrelay, clip }

/**
 * 将 4 个原生工具一次性注册到 DSH tools 服务中
 * @param {{ tools: { register: (tool: any) => void } }} ctx DSH 插件上下文
 */
export function registerTools(ctx) {
  if (!ctx?.tools?.register) {
    throw new Error('registerTools: ctx.tools.register is required (did you declare inject: [\'tools\']?)')
  }
  ctx.tools.register(searchTool)
  ctx.tools.register(showTool)
  ctx.tools.register(recordTool)
  ctx.tools.register(bindProjectTool)
  ctx.tools.register(confirmBindTool)   // 两段式第二段：缺它则提议永远无法生效
  ctx.tools.register(cancelBindTool)
}
