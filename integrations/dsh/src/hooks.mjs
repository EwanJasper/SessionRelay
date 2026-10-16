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

import path from 'node:path'

/** 载入内核（与简报同源：插件 vendor 里的 dist/recall.js） */
async function loadCore() {
  try {
    const m = await import('../vendor/dist/recall.js')
    return typeof m.runLifecycle === 'function' ? m : null
  } catch { return null }
}

/** 单项目增量采集：直接调内核 runSync（进程内，不起子进程） */
async function captureProject(core, root, log) {
  try {
    const fs = await import('node:fs')
    const cfgPath = path.join(root, '.sessionrelay', 'config.json')
    if (!fs.existsSync(cfgPath)) return '未建库'
    const { loadConfig } = await import('../vendor/dist/recall.js').catch(() => ({}))
    if (typeof loadConfig !== 'function') return '内核缺 loadConfig'
    const cfg = loadConfig(root)
    const sync = core.runSync ?? null
    if (typeof sync !== 'function') return '内核缺 runSync'
    const r = await sync({ projectRoot: root, config: cfg })
    return '+' + (r?.newMessages ?? 0) + ' 消息'
  } catch (e) { return '采集失败：' + String(e?.message ?? e).slice(0, 60) }
}

/**
 * 挂上 DSH 的会话钩子。ctx 是插件宿主上下文；stub（自测）没有 on/effect 时安静跳过。
 * @param {any} ctx
 * @param {{ log?: (s: string) => void }} [opts]
 */
export function registerHooks(ctx, opts = {}) {
  const log = opts.log ?? (() => {})
  if (!ctx || typeof ctx.on !== 'function') return { registered: [], reason: 'ctx 不支持 on（stub 或旧宿主）' }

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
      if (!core) return
      const note = await captureProject(core, root, log)
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
