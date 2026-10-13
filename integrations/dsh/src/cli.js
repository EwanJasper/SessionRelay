// cli.js — SessionRelay CLI 子命令安全执行封装
//
// 铁律：
// 1. 绝不启动 srelay serve，只调瞬态命令（search / show / save）
// 2. 数组传参调 execFile，不经过 cmd / powershell shell，杜绝引号嵌套与注入风险
// 3. 截断保护 clip(text, 12000)，防止过长输出耗尽模型上下文
// 4. 清理终端 ANSI 转义字符，确保模型与用户看到纯净文本
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import { join } from 'node:path'

export const NODE = fs.existsSync('D:/agent1super/node/node.exe')
  ? 'D:/agent1super/node/node.exe'
  : (fs.existsSync('C:/Program Files/nodejs/node.exe') ? 'C:/Program Files/nodejs/node.exe' : process.execPath)

export const SRELAY = process.env.SRELAY_CLI_PATH
  || join(process.env.APPDATA || '', 'npm', 'node_modules', '@ewanjasper', 'sessionrelay', 'dist', 'srelay.js')

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
