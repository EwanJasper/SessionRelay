# SessionRelay × DeepSeek Harness 插件

把 [SessionRelay](https://github.com/EwanJasper/SessionRelay) 的项目记忆，接进 DSH（DeepSeek Harness）的 system prompt。

**它解决的问题**：ZCode、Claude Code 这类命令行工具，进程的工作目录天然等于项目根，开场注入一份项目简报是顺手的事。DSH 是桌面应用，三条常规信号全断（见下文），所以你在 DSH 里干活时，它对项目既有的决策、未决问题一无所知。这个插件把缺口补在它该在的位置。

**[English](./README.md) · [SessionRelay 上游仓库](https://github.com/EwanJasper/SessionRelay)**

---

## 三个核心能力

**1. 每轮自动带上项目简报**

不是写死在文件里，而是**每个模型步骤前现查一次记忆库**。所以这一轮你做的决定，下一轮它就知道——ZCode 的开场 hook 做不到这点，它在开会话时就把内容定死了。

简报限 1200 字符，并用「记忆库修改时间」做缓存判据：库没变就直接复用（约 1ms），避免每轮都等两个子进程（约 310ms）。

**2. 自动认出「当前在哪个项目」**

不需要任何配置。原理是 DSH 自己就按工作目录给会话分组存放：

```
~/.dsh/sessions/
  --E-music~0020player--      ← E:\music player
  --D-agent1super--           ← D:\agent1super
```

这个 slug 是 **DSH 自己记录的**会话归属，是插件唯一能读到的可靠信号。

**3. 六个原生工具**

| 工具 | 作用 |
|---|---|
| `srelay_search` | 检索项目历史会话与讨论 |
| `srelay_show` | 查看某个会话的具体消息与出处 |
| `srelay_record` | 主动沉淀一条已确认的决策 |
| `srelay_bind_project` | **提议**切换项目（仅提议） |
| `srelay_confirm_bind_project` | 用户确认后才生效 |
| `srelay_cancel_bind_project` | 放弃提议 |

---

## 安装

### 方式一：DSH 插件管理器（推荐）

DSH 的 Plugins 页面 → 填入包名 → 安装：

```
@crx1146/dsh-sessionrelay
```

### 方式二：命令行

```bash
dsh plugin --profile web add @crx1146/dsh-sessionrelay
```

### 方式三：直接落文件

```bash
# 从 GitHub 安装（会现场装依赖）
dsh plugin --profile web add https://github.com/rui08984-dot/dsh-sessionrelay
```

**不需要预先安装 SessionRelay**——插件自带完整运行时，离线可用。

---

## 项目判定链

```
① env SRELAY_PROJECT_ROOT  →  显式指定，指向含 .sessionrelay 的目录即可
② DSH 会话反解             →  24h 内最近活跃的会话组（最准的自动信号）
③ 注册表恰好一个存活项目    →  新用户只有一个项目时的友好路径
④ 悬空 / 未初始化          →  不猜，���名提示
```

第 ④ 级**拒绝猜测**是有意的：把 A 项目的简报注进 B 项目的会话，比什么都不注更糟——模型无法分辨这两件事无关。

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

插件自带 67MB 的 srelay 运行时（`dist/` + 全部依赖），所以：

- 用户**不需要**自己 `npm install -g`
- **断网也能用**
- 不会和用户机器上已有的 srelay 版本打架

仓库里**不包含** vendor/（67MB 二进制不该进 git）。需要时用生成脚本重建：

```bash
node vendor-srelay.mjs                 # 从 npm 拉取（需联网）
node vendor-srelay.mjs --from <path>   # 从本地已装副本复制（离线）
```

npm 发布包由 `package.json` 的 `files` 白名单显式列入 —— 因为 npm 默认忽略一切 `node_modules/` 目录（包括嵌套的），漏掉这条规则会打出一个装上即崩的包。

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

---

## 致谢

- 上游作者 [EwanJasper](https://github.com/EwanJasper) 及 [SessionRelay](https://github.com/EwanJasper/SessionRelay) 项目
- DSH 官方插件契约（`@deepseek-ai/dsh-app-boot`）

本插件是独立项目，不隶属任何厂商。记忆属于项目，不属于工具。