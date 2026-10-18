// hooks.mjs —— ADR-002：记忆生命周期**长在 DSH 的钩子上**，而不是靠外部轮询
//
// 病历（ADR-002 原文）："我们现在一个钩子都没挂；采集靠外部守护轮询"。代价是延迟——
// 用户刚拍板的决定要等下一轮采集（最长 15 分钟）才进库，期间新会话问"我们刚才定了什么"
// 是查不到的。
//
// 设计纪律（都是从"宿主内跑重活会卡 UI"这条来的）：
//   ① **只跑轻阶段**：捕获单项目 → 抽取/去重（内核标了 weight:'light'）。全量重放、老化压缩
//      这些 heavy 阶段一律留给独立进程（守护/CLI）——绝不塞进宿主进程。
//   ② **每个项目去抖 + 冷却**：会话事件是高频的（一条消息一个事件），所以按项目合并：
//      去抖 8 秒、冷却 60 秒。宁可晚 8 秒，也不要每个 token 都去扫一遍会话目录。
//   ③ **绝不抛**：钩子里的异常必须吞掉并留痕——宿主的事件循环不能被记忆库搞崩。
//   ④ **拿不到内核就静静待命**：vendor 缺失（integrations/headless 副本）时直接返回，
//      不自己抄一套采集逻辑（铁律 1）。
//   ⑤ **[1021 审查 #17] 缺内核/缺导出必须吼出来**：这条失败原先只在 SRELAY_BRIEF_DEBUG=1
//      的日志里可见，于是「事件驱动即时采集坏了」没人发现（表现成"偶尔慢半拍"）。
//      现在：挂载时校验一次导出契约，缺失/异常一律 console.warn → 宿主正常日志。

import path from 'node:path'

/**
 * 发布模块的导出契约（**唯一声明处**）：钩子依赖哪些导出，就在这儿列全。
 * [1021 审查 #17] 原先只查 runLifecycle；loadConfig / runSync 缺失时静默 return，
 * 而那条日志又被 SRELAY_BRIEF_DEBUG 挡着 ⇒ 事件驱动即时采集坏了没人知道。
 */
const REQUIRED_EXPORTS = ['runLifecycle', 'loadConfig', 'runSync']
const TAG = '[srelay-hooks]'

/** 同一类告警只打一次：每个事件都打会把宿主日志刷屏，刷屏等于没人看（去抖 8s + 冷却 60s 也不够） */
const warned = new Set()
function warnOnce(key, msg) {
  if (warned.has(key)) return
  warned.add(key)
  console.warn(TAG + ' ' + msg)
}

/**
 * 载入内核（与简报同源：插件 vendor 里的 dist/recall.js）。
 * 返回 { mod, missing, error }；**绝不抛**（宿主事件循环不能被记忆库搞崩），
 * 但失败原因一律走 warnOnce → 宿主正常日志（不是 debug 日志）。
 */
let corePromise = null
export function loadCore() {
  if (!corePromise) {
    corePromise = (async () => {
      let mod = null
      let error = null
      try { mod = await import('../vendor/dist/recall.js') }
      catch (e) { error = String(e?.message ?? e).slice(0, 160) }
      const missing = mod ? REQUIRED_EXPORTS.filter((k) => typeof mod[k] !== 'function') : []
      if (error) {
        warnOnce('import', '载入发布模块失败：' + error + '（事件驱动即时采集停摆；主路径 srelay watch 仍在跑，所以只是慢半拍）')
      }
      if (missing.length) {
        warnOnce('exports', '发布模块缺导出：' + missing.join(', ') + '（事件驱动即时采集停摆，主路径 srelay watch 不受影响；'
          + '重跑工作区根 tools/ses-rebuild.mjs 重建 vendor 即可。契约见 src/recall-entry.ts 的采集导出）')
      }
      return { mod, missing, error }
    })()
  }
  return corePromise
}

/** 单项目增量采集：直接调内核 runSync（进程内，不起子进程） */
async function captureProject(coreMod, root) {
  try {
    const fs = await import('node:fs')
    if (!fs.existsSync(path.join(root, '.sessionrelay', 'config.json'))) return '未建库'
    const cfg = coreMod.loadConfig(root)
    const r = await coreMod.runSync({ projectRoot: root, config: cfg })
    return '+' + (r?.newMessages ?? 0) + ' 消息'
  } catch (e) {
    const why = String(e?.message ?? e).slice(0, 80)
    // 采集失败不能在 debug 闸门后面（去抖 + 冷却已保证不会每事件刷屏）
    console.warn(TAG + ' 采集失败(' + path.basename(root) + ')：' + why)
    return '采集失败：' + why
  }
}

/**
 * 挂上 DSH 的会话钩子。ctx 是插件宿主上下文；stub（自测）没有 on/effect 时安静跳过。
 * @param {any} ctx
 * @param {{ log?: (s: string) => void }} [opts]
 */
export function registerHooks(ctx, opts = {}) {
  const log = opts.log ?? (() => {})
  if (!ctx || typeof ctx.on !== 'function') return { registered: [], reason: 'ctx 不支持 on（stub 或旧宿主）' }

  // [1021 审查 #17] 挂载时就校验一次发布模块契约：缺导出必须在**插件加载时**出现在正常日志里，
  // 不等到第一个会话事件，更不能只在 debug 模式下（那条日志此前等于不存在）。
  void loadCore()

  const registered = []
  let core = null
  const pending = new Map()   // root → { timer, last }  去抖 + 冷却
  const DEBOUNCE_MS = 8_000
  const COOLDOWN_MS = 60_000

  const cwdOf = (e) => {
    const c = e?.session?.header?.cwd ?? e?.agent?.session?.header?.cwd ?? e?.cwd
    return typeof c === 'string' && c ? path.resolve(c) : null
  }

  const schedule = (root, why) => {
    if (!root) return
    const now = Date.now()
    const st = pending.get(root) ?? { timer: null, last: 0 }
    if (now - st.last < COOLDOWN_MS) return                       // 冷却中：刚采过
    if (st.timer) clearTimeout(st.timer)
    st.timer = setTimeout(async () => {
      st.timer = null; st.last = Date.now(); pending.set(root, st)
      if (!core) core = await loadCore()
      // 缺导出/载入失败已在 loadCore 里 warnOnce 报过，这里安静跳过（不重复刷屏、不静默——日志已经有了）
      if (!core.mod || core.missing.length) return
      const note = await captureProject(core.mod, root)
      log('[srelay-hooks] ' + why + ' → ' + path.basename(root) + ' ' + note)
    }, DEBOUNCE_MS)
    pending.set(root, st)
  }

  const onEvent = (e) => { try { schedule(cwdOf(e), 'session/event') } catch { /* 钩子不许抛 */ } }
  const onDisposed = (e) => { try { schedule(cwdOf(e), 'session/disposed') } catch { /* 同上 */ } }
  const onAgentStatus = (e) => {
    try {
      // agent 状态变化：只有在"空闲/结束"时才值得采一次（进行中还在写文件，采了也是半截）
      const s = String(e?.status ?? e?.state ?? '')
      if (s && !/idle|done|finished|stopped|completed/i.test(s)) return
      schedule(cwdOf(e), 'agent/status')
    } catch { /* 同上 */ }
  }

  for (const [ev, fn] of [['session/event', onEvent], ['session/disposed', onDisposed], ['agent/status', onAgentStatus]]) {
    try {
      // ctx.effect：HMR/卸载时自动清理（参考实现 dsh-observational-memory 的写法）
      const off = ctx.on(ev, fn)
      if (typeof ctx.effect === 'function') ctx.effect(() => () => { try { off?.() } catch { /* 已清理 */ } })
      registered.push(ev)
    } catch { /* 某个事件宿主不支持：跳过，不影响其它 */ }
  }
  log('[srelay-hooks] 已挂钩子：' + (registered.join(', ') || '(无)'))
  return { registered }
}
