# SessionRelay × DeepSeek Harness 插件

把 [SessionRelay](https://github.com/EwanJasper/SessionRelay) 的项目记忆，接进 DSH（DeepSeek Harness）的 system prompt。

**它解决的问题**：ZCode、Claude Code 这类命令行工具，进程的工作目录天然等于项目根，开场注入一份项目简报是顺手的事。DSH 是桌面应用，三条常规信号全断（见下文），所以你在 DSH 里干活时，它对项目既有的决策、未决问题一无所知。这个插件把缺口补在它该在的位置。

**[English](./README.md) · [SessionRelay 上游仓库](https://github.com/EwanJasper/SessionRelay)**

---

## 三个核心能力

**1. 每轮自动带上项目简报**

不是写死在文件里，而是**每个模型步骤前现查一次记忆库**。所以这一轮你做的决定，下一轮它就知道——ZCode 的开场 hook 做不到这点，它在开会话时就把内容定死了。

简报限 1200 字符。取数走 **SQL 直查**（`node:sqlite` 只读打开，CLI 子进程只作兜底）：冷路径约 5ms、热路径约 1ms，而调 CLI 子进程要 310–360ms。想对照旧路径可以设 `SRELAY_BRIEF_FORCE_CLI=1`。

**2. 自动认出「当前在哪个项目」**

主信号是 DSH 自己交出来的 `agent.session.header.cwd`——会话创建时的绝对工作目录，按 agent 隔离，不用猜。取不到时才回落到下面这套会话反解：

```
~/.dsh/sessions/
  --E-music~0020player--      ← E:\music player
  --D-agent1super--           ← D:\agent1super
```

这个 slug 是 **DSH 自己记录的**会话归属，是插件能读到的兜底信号。

**3. 七个原生工具**

| 工具 | 作用 |
|---|---|
| `srelay_search` | 检索项目历史会话与讨论 |
| `srelay_show` | 查看某个会话的具体消息与出处 |
| `srelay_record` | 主动沉淀一条已确认的决策 |
| `srelay_init` | 给当前目录建记忆库（可逆，故单步执行） |
| `srelay_bind_project` | **提议**切换项目（仅提议） |
| `srelay_confirm_bind_project` | 用户确认后才生效 |
| `srelay_cancel_bind_project` | 放弃提议 |

**4. 新文件夹开箱即用**

在 DSH 里打开一个真实目录，记忆库会自动建好，不必说"接入"。规则是**黑名单制**：除了临时目录、DSH 自身安装目录、npm 全局根、盘符根，全都自动接。ZCode 侧的 hook 用同一套黑名单——**改规则要两边一起改**。

---

## 安装

### 方式一：DSH 插件管理器（推荐）

DSH 的 Plugins 页面 → 填入包名 → 安装：

```
dsh-srelay-brief
```

### 方式二：命令行

```bash
dsh plugin --profile web add dsh-srelay-brief
```

> ⚠️ 无论哪种方式，装完都要先确认 **vendor/ 在位**（见下文「自包含运行时」）。
> 没有 vendor 时插件不报错，只会静默回落到全局 npm 的 srelay——如果那份是上游原版，
> 你就会遇到"一切正常但简报永远空"的半失效状态。

### 方式三：直接落文件

```bash
# 从 GitHub 安装（会现场装依赖）
dsh plugin --profile web add https://github.com/rui08984-dot/sessionrelay-eco
```

**不需要预先安装 SessionRelay**——插件自带完整运行时，离线可用。

---

## 项目判定链

```
① agent.session.header.cwd  →  DSH 自己交出来的绝对工作目录（主信号，按 agent 隔离）
② env SRELAY_PROJECT_ROOT   →  显式指定，指向含 .sessionrelay 的目录即可
③ DSH 会话反解              →  24h 内最近活跃的会话组（兜底）
④ 注册表恰好一个存活项目     →  新用户只有一个项目时的友好路径
⑤ 悬空 / 未初始化           →  不猜，点名提示
```

第 ⑤ 级**拒绝猜测**是有意的：把 A 项目的简报注进 B 项目的会话，比什么都不注更糟——模型无法分辨这两件事无关。

---

## 两段式绑定：为什么模型不能自己切项目

`srelay_bind_project` 决定的是**决策写进哪个数据库**。如果模型能自主切换，它在项目 B 的会话里误判并绑到项目 A，那么之后记录的每一条决策都会被写进 A 的 SQLite——**不可逆**。

这与 SessionRelay 自身的原则同源：AI 永远没有删除权。同样的约束应该延伸到「写哪个库」。

- `srelay_bind_project({ projectPath })` —— **只提议**，返回文案明确要求用户确认
- `srelay_confirm_bind_project()` —— 用户同意后才生效
- `srelay_cancel_bind_project()` —— 放弃提议

提议按会话隔离，多个对话不会串味。目标路径必须**已含 `.sessionrelay` 数据库**才会被接受——否则绑定一个新目录会「报成功」，然后每次调用都静默失败。

---

## 自包含运行时（vendor/）

插件自带 62MB 的 srelay 运行时（`dist/` + 全部依赖），所以：

- 用户**不需要**自己 `npm install -g`
- **断网也能用**
- 不会和用户机器上已有的 srelay 版本打架

**仓库里不包含 vendor/**——62MB 二进制（含 8 个平台的 `better-sqlite3` 原生 binding 和中文分词词库）进 git 就永久留在历史里了。三条获取途径：

| 途径 | 命令 | 需要联网 |
|---|---|---|
| **Release 资产**（最省事） | 从 [Releases](https://github.com/rui08984-dot/sessionrelay-eco/releases) 下对应版本的 `vendor-*.tar.gz`，解压到本目录 | 否 |
| 从 npm 拉取 | `node vendor-srelay.mjs` | 是 |
| 从本地已装副本复制 | `node vendor-srelay.mjs --from <path>` | 否 |

```bash
node vendor-srelay.mjs                 # 从 npm 拉取（需联网）
node vendor-srelay.mjs --from <path>   # 从本地已装副本复制（离线）
```

到位后自检：

```bash
node -e "console.log(require('fs').existsSync('vendor/dist/srelay.js'))"   # 必须 true
```

npm 发布包由 `package.json` 的 `files` 白名单显式列入 —— 因为 npm 默认忽略一切 `node_modules/` 目录（包括嵌套的），漏掉这条规则会打出一个装上即崩的包。`src/brief-sql.mjs` 也曾从白名单里漏掉过一次，症状就是发布物缺了 SQL 直查通道。

---

## 踩过的坑（写下来省后来人踩一遍）

**1. `section` 的 `text` provider 必须返回字符串，不能是 Promise。**
`renderPrompt` 直接调 `text.indexOf('{{')`，收到 Promise 抛 `text.indexOf is not a function`。取数必须同步。

**2. `apply` 里 import 失败会抛异常，导致插件「加载失败」而非工具注册失败。**
症状是 DSH 报 `failed to import` 并静默跳过整个条目。看起来像 async 的问题，其实不是——Cordis 明确支持 thenable 返回值（`cordis/lib/index.js` 的 `_execute()` 有显式处理）。真正的原因是 `await import('@deepseek-ai/dsh-tools')` 在依赖不可用时抛错。用 `createRequire` + try/catch 解决。

**3. 路径解析必须用 `fileURLToPath`，不能用 `new URL(...).pathname`。**
`.pathname` 会对非 ASCII 字符做百分号编码：`D:\插件\` 会变成 `D:/%E6%8F%92%E4%BB%B6/`。于是 `existsSync` 恒为 false，插件跳过自带的运行时，静默回落到全局安装——在纯 ASCII 路径下测试完全发现不了。

**4. `SRELAY_PROJECT_ROOT` 只对 `serve` 生效。**
所有 CLI 子命令只认 `cwd`。实测在目录 A 执行时设这个环境变量指向 B，查出来的仍是 A。

**5. `defineTool` 的参数传扁平映射** `{name: {type, required, description}}`，它会自己归一化成 JSON Schema。不是 MCP 的 `{type:'object', properties:{}}`。

**6. 「启动不报错」不等于「工具注册对了」。**
必须写 selftest 用 stub 收集器验证 `ctx.tools.register` 真的收到了东西。静默 `catch` 会让这类 bug 藏很久。

**7. Windows 路径字面量的反斜杠必须双写。**
`'E:\music player'` 会静默变成 `E:music player`——`\d`、`\c`、`\S` 被当成转义序列吃掉，剩下一个没有分隔符的**盘符相对路径**，`path.resolve` 会拿**进程 cwd** 当基准悄悄解析到别处。selftest 里六处中招，后果是同一条断言在作者副本通过、在集成副本失败，区别只在于测试从哪个目录跑。现在 selftest 第 0 节会断言每个字面量仍是 `X:\` 形态且目录真实存在，一退化就先红。

**8. `node:sqlite` 必须懒加载。**
它只在 Node ≥ 22.5 上有，且 22.x 还要 `--experimental-sqlite` 标志，而 `engines` 允许 `^22.19.0`。顶部静态 `import` 会让**整个插件**在 Node 22 上加载失败（简报全灭、不报错），而不只是关掉快速通道。用 `createRequire` + try/catch 取，见 `src/brief-sql.mjs`。

---

## 取数通道：SQL 优先，CLI 兜底

简报直接用内置的 `node:sqlite` 读 `relay.sqlite`（`src/brief-sql.mjs`）——不起子进程、零依赖、冷路径约 5ms。查询条件、排序、去重、新鲜度窗口逐条复刻自核心库的 `listDecisions`/`listUnresolved` 与 `cli/meta.ts`；**改了核心库就必须同步改这个文件**，否则两条路会悄悄分叉。

`selftest.mjs` 第 8b 节断言两条路在真实库上逐字段一致，8c 节进一步证明走的确实是 SQL（CLI 兜底实测约 336ms，SQL 约 5ms，且两者渲染出的简报正文必须逐字节相同）。

CLI 子进程保留为兜底，用于：Node 没有 `node:sqlite`、库的 schema 比插件旧、WAL 的 `-shm` 不可写。想强制走旧路对照时设 `SRELAY_BRIEF_FORCE_CLI=1`。

---

## 致谢

- 上游作者 [EwanJasper](https://github.com/EwanJasper) 及 [SessionRelay](https://github.com/EwanJasper/SessionRelay) 项目
- DSH 官方插件契约（`@deepseek-ai/dsh-app-boot`）

本插件是独立项目，不隶属任何厂商。记忆属于项目，不属于工具。