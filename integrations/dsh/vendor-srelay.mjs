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
  if (fs.existsSync(path.join(src, 'node_modules'))) {
    log(`复制 node_modules（约 67MB，稍等）…`)
    fs.cpSync(path.join(src, 'node_modules'), path.join(VENDOR, 'node_modules'), { recursive: true })
  } else {
    console.error('✗ 源目录没有 node_modules —— 缺它插件无法离线运行')
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
