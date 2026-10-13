// cli.js — SessionRelay CLI 子命令安全执行封装
//
// 铁律：
// 1. 绝不启动 srelay serve，只调瞬态命令（search / show / save）
// 2. 数组传参调 execFile，不经过 cmd / powershell shell，杜绝引号嵌套与注入风险
// 3. 截断保护 clip(text, 12000)，防止过长输出耗尽模型上下文
// 4. 清理终端 ANSI 转义字符，确保模型与用户看到纯净文本
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// node 可执行文件：用当前进程的（DSH 桌面端自带 runtime；CLI 宿主即用户 node）。
// 不再探测本机固定路径——那会写死作者环境。
export const NODE = process.execPath

// srelay CLI 入口，三级优先（与 index.js 同源逻辑）：
//   ① env 天窗 → ② 插件自带 vendor → ③ npm 全局兜底
//
// ⚠️ 路径解析必须用 fileURLToPath，不能用 new URL(...).pathname：
// 后者对非 ASCII 字符做百分号编码，中文目录会变成
//   D:/dsh%E6%8F%92%E4%BB%B6%20%20%E8%AE%B0%E5%BF%86/...
// 于是 fs.existsSync 必然 false，vendor 被静默跳过、回落到 npm 全局——
// 67MB 自包含白带，且在所有非 ASCII 路径下失效（本机工作目录
// `D:\dsh插件  记忆\` 正是这个情况，实测踩中）。
// 直接从 URL 得到 vendor 入口的绝对路径。注意别再 dirname+join 拼一次——
// 那样会多出一级（实测得到 vendor/dist/dist/srelay.js，existsSync 假 → 静默回落）。
const VENDOR_SRELAY = fileURLToPath(new URL('../vendor/dist/srelay.js', import.meta.url))

export const SRELAY = process.env.SRELAY_CLI_PATH
  || (fs.existsSync(VENDOR_SRELAY) ? VENDOR_SRELAY
      : join(process.env.APPDATA || '', 'npm', 'node_modules', '@ewanjasper', 'sessionrelay', 'dist', 'srelay.js'))

/** 过滤终端 ANSI 颜色控制字符 */
export function stripAnsi(s) {
  return String(s ?? '').replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
}

/** 模型文本截断保护，默认 12000 字符，与 dsh-reach 标准对齐 */
export function clip(s, n = 12000) {
  const t = stripAnsi(s ?? '')
  return t.length > n ? `${t.slice(0, n)}\n…[截断，共 ${t.length} 字符]` : t
}

/**
 * 安全异步执行 srelay CLI
 * @param {string[]} args 命令行参数数组
 * @param {{ cwd?: string, timeoutMs?: number }} options
 * @returns {Promise<{ ok: boolean, stdout: string, stderr: string, code: number }>}
 */
export function execSrelay(args, { cwd, timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    let settled = false

    const child = execFile(
      NODE,
      [SRELAY, ...args],
      {
        cwd,
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        if (settled) return
        settled = true
        const out = stripAnsi(stdout || '')
        const err = stripAnsi(stderr || (error ? String(error.message) : ''))
        if (error) {
          resolve({
            ok: false,
            stdout: out,
            stderr: err || String(error.message),
            code: typeof error.code === 'number' ? error.code : 1,
          })
        } else {
          resolve({
            ok: true,
            stdout: out,
            stderr: err,
            code: 0,
          })
        }
      }
    )

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { child.kill() } catch {}
      resolve({
        ok: false,
        stdout: '',
        stderr: `执行超时（超过 ${Math.round(timeoutMs / 1000)} 秒）`,
        code: 124,
      })
    }, timeoutMs)
    timer.unref?.()
  })
}
