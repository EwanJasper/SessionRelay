#!/usr/bin/env node
// vendor-srelay.mjs — 生成插件自带的 srelay 运行时（vendor/）。
//
// 为什么需要脚本而不是直接提交 vendor/：
//   vendor/ 是 67MB 的构建产物（含 better-sqlite3 全平台原生 binding）。
//   把它提交进 git 会让仓库体积膨胀 6 倍，上游不会接受。所以：
//     · git 只跟踪本脚本 + 源码
//     · vendor/ 在打包/安装时由本脚本生成（.gitignore 已忽略它）
//
// 用法：
//   node vendor-srelay.mjs                 # 从 npm 拉取（默认，需联网）
//   node vendor-srelay.mjs --from <path>   # 从本地已装的副本复制（离线）
//
// 产物结构：
//   vendor/dist/srelay.js      ← CLI 入口
//   vendor/package.json
//   vendor/node_modules/       ← 运行时依赖（含原生模块）
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const VENDOR = path.join(HERE, 'vendor')
const PKG = '@ewanjasper/sessionrelay'

const args = process.argv.slice(2)
const fromIdx = args.indexOf('--from')
const localSource = fromIdx >= 0 ? args[fromIdx + 1] : null

function log(m) { console.log(`[vendor-srelay] ${m}`) }

function rmrf(p) { fs.rmSync(p, { recursive: true, force: true }) }

if (fs.existsSync(VENDOR)) {
  log(`清空已有 vendor/`)
  rmrf(VENDOR)
}
fs.mkdirSync(VENDOR, { recursive: true })

if (localSource) {
  // 离线：从本地已装的副本复制
  const src = path.resolve(localSource)
  if (!fs.existsSync(path.join(src, 'dist', 'srelay.js'))) {
    console.error(`✗ 源目录没有 dist/srelay.js：${src}`)
    process.exit(1)
  }
  log(`从本地复制：${src}`)
  fs.cpSync(path.join(src, 'dist'), path.join(VENDOR, 'dist'), { recursive: true })
  fs.cpSync(path.join(src, 'package.json'), path.join(VENDOR, 'package.json'))
  if (!fs.existsSync(path.join(src, 'node_modules'))) {
    console.error(`✗ 源目录没有 node_modules —— 缺它插件无法离线运行`)
    process.exit(1)
  }
  // ⚠️ 只复制**运行时依赖**，不能整个 node_modules 照抄。
  // 实测踩坑：源是开发检出（git clone + npm install），node_modules 里含 devDependencies
  // ——typescript 23M + tsup 12M + @esbuild 12M + vitest 等，vendor 从 67MB 胀到 136MB，
  // 发布包翻倍。npm pack 那条路本来就只装 dependencies，离线这条路必须对齐。
  const srcPkg = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8'))
  const deps = Object.keys(srcPkg.dependencies ?? {})
  if (deps.length === 0) {
    console.error(`✗ 源 package.json 没有 dependencies 字段，拒绝盲目全量复制`)
    process.exit(1)
  }
  log(`复制运行时依赖（${deps.length} 个）…`)
  fs.mkdirSync(path.join(VENDOR, 'node_modules'), { recursive: true })
  let copied = 0, missing = []
  for (const dep of deps) {
    const from = path.join(src, 'node_modules', dep)
    if (!fs.existsSync(from)) { missing.push(dep); continue }
    fs.cpSync(from, path.join(VENDOR, 'node_modules', dep), { recursive: true })
    copied++
  }
  // 依赖闭包：dependencies + **optionalDependencies** 都要跟，直到定点收敛。
  // optionalDependencies 不是可选的——原生模块的平台包（@node-rs/jieba-win32-x64-msvc
  // 之类）全走这个字段，漏了它 CLI 直接 "Cannot find native binding"。
  //
  // ⚠️ [1016 真 bug 修复] 原实现每轮只扫 **顶层 deps 那张名单**：
  //   第 1 轮从 srelay 的 dependencies 里捞到 @inquirer/prompts → 复制它的 @inquirer/checkbox 等；
  //   但第 2/3 轮**依然只扫顶层名单**，于是 @inquirer/checkbox 自己声明的传递依赖
  //   （@inquirer/core / ansi / figures / type）**永远不会被扫描，也就永远不会被复制**。
  //   后果：DSH 里 srelay_record 一调用就炸在 "@inquirer/core 找不到"，而 vendor 看起来"有货"、
  //   所有自检全绿——典型的静默半失效（见 docs/ENGINEERING-NOTES.md 第一节）。
  //   修法：每轮扫 **vendor 里当前存在的每一个包**（含 @scope/ 一层），而不是那张顶层名单。
  const installedDirs = () => {
    const nm = path.join(VENDOR, 'node_modules')
    const out = []
    for (const e of fs.readdirSync(nm, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name === '.bin') continue
      if (e.name.startsWith('@')) {
        for (const s of fs.readdirSync(path.join(nm, e.name), { withFileTypes: true })) {
          if (s.isDirectory()) out.push(path.join(nm, e.name, s.name))
        }
      } else out.push(path.join(nm, e.name))
    }
    return out
  }
  for (let pass = 0; pass < 12; pass++) {
    const declared = new Set()
    for (const dir of installedDirs()) {
      const pj = path.join(dir, 'package.json')
      if (!fs.existsSync(pj)) continue
      try {
        const j = JSON.parse(fs.readFileSync(pj, 'utf8'))
        for (const d of Object.keys(j.dependencies ?? {})) declared.add(d)
        for (const d of Object.keys(j.optionalDependencies ?? {})) declared.add(d)
      } catch { /* 坏 package.json 跳过 */ }
    }
    let added = 0
    const notInSrc = []
    for (const d of declared) {
      const to = path.join(VENDOR, 'node_modules', d)
      const from = path.join(src, 'node_modules', d)
      if (fs.existsSync(to)) continue
      if (!fs.existsSync(from)) { notInSrc.push(d); continue }
      fs.cpSync(from, to, { recursive: true })
      added++
    }
    if (added === 0) {
      if (notInSrc.length) log('  ⚠️ 源里也没有（可能是 peer/平台可选）：' + [...new Set(notInSrc)].join(', '))
      break
    }
    log('  闭包第 ' + (pass + 1) + ' 轮：+' + added + ' 个')
  }
  log(`  已复制 ${copied} 个直接依赖${missing.length ? `，缺：${missing.join(', ')}` : ''}`)
  if (missing.length) {
    console.error(`✗ 有运行时依赖在源里找不到：${missing.join(', ')}——vendor 会缺功能`)
    process.exit(1)
  }
} else {
  // 联网：用 npm pack 拉取 tarball 再解包（比 npm install 干净，不碰项目 node_modules）
  log(`从 npm 拉取 ${PKG} …`)
  const tmp = path.join(HERE, '.vendor-tmp')
  rmrf(tmp); fs.mkdirSync(tmp, { recursive: true })
  try {
    const out = execFileSync('npm', ['pack', PKG, '--pack-destination', tmp], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
    const tarball = path.join(tmp, out.split(/\r?\n/).pop())
    log(`解包 ${path.basename(tarball)}`)
    execFileSync('tar', ['-xzf', tarball, '-C', tmp], { stdio: 'inherit' })
    const pkgDir = path.join(tmp, 'package')
    fs.cpSync(path.join(pkgDir, 'dist'), path.join(VENDOR, 'dist'), { recursive: true })
    fs.cpSync(path.join(pkgDir, 'package.json'), path.join(VENDOR, 'package.json'))
    // tarball 不含 node_modules；离线运行需要它 → 用 npm install --omit=dev 补齐
    log(`安装运行时依赖到 vendor/ …`)
    fs.writeFileSync(path.join(VENDOR, 'package.json'),
      JSON.stringify({ name: 'srelay-vendor', private: true, dependencies: JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).dependencies }, null, 2))
    execFileSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: VENDOR, stdio: 'inherit' })
  } finally {
    rmrf(tmp)
  }
}

// 验证
const entry = path.join(VENDOR, 'dist', 'srelay.js')
if (!fs.existsSync(entry)) { console.error('✗ 生成后仍找不到 dist/srelay.js'); process.exit(1) }
const hasNative = fs.existsSync(path.join(VENDOR, 'node_modules', 'better-sqlite3'))
log(`✓ vendor 就绪：${entry}`)
log(`  better-sqlite3 在场：${hasNative}`)
log(`  自测：node vendor/dist/srelay.js --version`)
