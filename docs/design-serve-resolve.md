# 设计：serve 根解析信号链与多项目模式（v1）

> 状态：已评审（三轮，记录见 §8）· 实现于 0.5.0
> 起因：Qoder 实测事件（2026-09-18）——Qoder 启动 MCP 子进程时不把 cwd 设为项目根，
> `srelay serve` 找不到 `.sessionrelay` 起手 exit(1)，客户端只看到
> `MCP_STDIO_PROCESS_EXITED_BEFORE_READY · exit code 1`，零可诊断信息。

## 1. 背景与问题

`srelay serve` 是项目级 MCP 服务：进程必须知道"服务哪个项目的 relay.sqlite"。
现行解析只有两个信号：`SRELAY_PROJECT_ROOT` 环境变量、cwd 向上探测。
这个组合隐含了一个假设：**客户端会把 MCP 子进程的工作目录设成项目根**。

- Claude Code / ZCode：成立 → 从未暴露。
- Qoder：不成立（cwd 落在家目录一带）→ 找不到根 → exit(1) → 客户端报天书。
  用户被迫用环境变量钉死单个项目——全局 mcp.json 一条配置只能管一个项目，多项目体验断裂。

## 2. 目标 / 非目标

**目标**
1. 免配置：常见客户端（支持 MCP roots 协议的）零配置连上正确项目。
2. 可诊断：所有解析失败都变成"连得上 + 工具返回带指导的错误"，绝不再是起手 exit(1)。
3. 零回归：现有 env / cwd 场景的解析路径一步不变（新信号只插在原有失败路径上）。
4. 多项目：一条 MCP 配置可服务多个项目；切换必须显式（AI 带参选择或用户配置），绝不静默猜。

**非目标**
- 不做跨项目检索（记忆仍是项目级硬边界）。
- 不改 16 工具的名称与既有参数（只新增一个可选 `project` 参数）。
- 不做 MCP 之外的传输（HTTP/SSE 不在本次范围）。

## 3. 根解析信号链

解析顺序（先命中先赢，后信号只在前面全部落空时才被咨询）：

| 序 | 信号 | 性质 | 说明 |
|---|---|---|---|
| 1 | `SRELAY_PROJECT_ROOT` | 显式 | 行为不变：`findRelayRoot(env) ?? env`（允许指向未 init 目录，沿用 0.4.x 语义） |
| 2 | cwd 向上探测 | 半显式 | 行为不变：`findRelayRoot(cwd)`；Claude Code / ZCode 在此命中 |
| 3 | MCP roots 协议 | 客户端声明 | **connect 之后**问客户端"工作区在哪"；仅当客户端声明了 roots 能力才发请求（否则标记 unsupported，不发、不等、不挂） |
| 4 | 全局项目注册表 | 启发式 | `~/.sessionrelay-registry/projects.json`；**仅当恰好一个项目的守护存活时**自动选中 |
| 5 | 显式 `project` 参数 | 用户/AI 决策 | 任意工具调用携带 `project: "<项目根绝对路径>"` 即刻选中（本连接记住）；前四个信号全落空时，工具返回候选列表引导选择 |

为什么 roots 在 cwd 之后：cwd 是"进程实际所在"，对 Claude/ZCode 是权威；roots 若报多根，
盲目取第一个可能偏离 cwd。**cwd 命中时 roots 根本不会被咨询**，这就是零回归的结构性保证。

**roots 多根**：过滤出含 `.sessionrelay` 的根；恰一个 → 选中；零个或多个 → 进候选列表（不猜）。

**红线（不变量）**：绝不静默猜项目。信号 3/4 只有"恰好一个有效候选"时才自动选中；
任何自动选中都在 stderr 声明；跨项目记忆绝不因解析歧义而串库——
宁可让 AI 多一次带参调用，不可让它在错误的项目记忆里自信作答。

## 4. Deferred 模式（解析失败不再退出）

**改造前**：无根 → stderr 一句 → `process.exit(1)`。GUI 客户端不透传 stderr，
用户只看到 `EXITED_BEFORE_READY`，0 可诊断。

**改造后**：仍然 `connect()`，工具照常列出；此时任何工具调用返回
`isError: true` 的指导性载荷：

```json
{
  "error": "unresolved_project",
  "message": "未能确定要服务哪个项目的记忆库…",
  "tried": { "env": false, "cwd": false, "roots": "unsupported", "registry": "empty" },
  "candidates": [
    { "root": "D:\\project\\IdeaProjects\\SocialSecurity", "name": "SocialSecurity",
      "daemonAlive": true, "lastActiveAt": "2026-09-18T06:00:00Z" }
  ],
  "howTo": "重试任意工具并传 project=\"<candidates[].root>\"（本连接记住）；或在客户端 MCP 配置设 SRELAY_PROJECT_ROOT；或在项目根运行 srelay init"
}
```

- `tried` 记录每个信号的下场（命中 root / unsupported / empty / multiple / none_alive），
  AI 能把失败原因转述给用户——可诊断性闭环走对话本身。
- 候选显示不等于可服务：只有 `.sessionrelay` 存在的目录才进候选。
- TTY 特例保留：人在终端裸跑 `serve`（stdin.isTTY）且无根 → 维持旧行为
  （stderr 一句 + exit 1）。MCP 客户端全是管道，不受影响。

**实现形态**：`buildServer` 从闭包捕获 `(root, db, cfg)` 改为**调用时取上下文**
`get(): ServeCtx`，无根时抛 `UnresolvedProject(载荷)`，由统一的 wrap 捕获转 toolOut。
上下文可变（adoption 即重绑 `root/db/cfg/project`），16 个 handler 首行解构，
天然支持连接内切换项目。`ensureDaemon` 沿用 `VITEST`/`SRELAY_NO_DAEMON_SPAWN`
跳过守卫（CI Windows EBUSY 教训），adoption 时同样受守卫约束。

## 5. 全局项目注册表

**路径：`~/.sessionrelay-registry/projects.json`**
（绝不能是 `~/.sessionrelay`——`findRelayRoot` 向上探测的正是这个目录名，家目录建它会让
home 子目录下的项目解析全部误判；与 `~/.sessionrelay-semantic` 同款规避。测试可用
`SRELAY_REGISTRY_DIR` 重定向。）

```json
{ "version": 1, "projects": [
  { "root": "D:\\project\\IdeaProjects\\SocialSecurity",
    "registeredAt": "2026-09-18T06:00:00Z", "lastActiveAt": "2026-09-18T06:30:00Z" }
] }
```

**写入者**（全部 upsert 自己的 root 键 + 原子写 tmp→rename）：
- `srelay init`：登记。
- 守护（watch）：启动时 + 每 10 分钟刷 `lastActiveAt`（unref 定时器）。
- serve：任何一次成功解析（含信号 1/2 命中）都登记——用得越多注册表越准。

**读侧剪枝**：root 不存在、或 `.sessionrelay` 不存在的条目直接剔除（内存剔除 + 顺带重写）。
注册表损坏 → 视为空，不 crash。

**已知取舍**：多守护并发读改写有微小丢更新窗口（v1 接受：条目按 root 键合并，
丢一次 10 分钟心跳无实质影响）；旧版守护重启前不会登记，注册表自然为空——
env/cwd 路径不受影响。

## 6. 契约与兼容性

- 16 工具名称不变（契约测试钉死）；全部工具新增**可选** `project` 参数（字符串，
  项目根绝对路径）。已解析模式下传 `project` = 连接内切换项目（同样走校验 + 记住）。
- `session_id` 前缀解析按当前 project——切换后旧项目的会话 ID 解析不到是**正确行为**
  （项目边界），文档明示。
- env 指向无效目录（DB 打不开）：从"未捕获异常堆栈"改为"干净 stderr + exit(1)"——
  退出时机与非零码不变，报错可读性提升。
- 不改 DB schema、不改 CLI 其余命令、不改守护行为（除新增心跳登记）。
- `doctor` 新增注册表一节：列出候选项目与"当前会被自动选中谁"。

## 7. 测试计划

复用契约测试的 stdio 真握手 + `StdioClientTransport` 的 `cwd` 选项（模拟 Qoder 任意 cwd）。
`SRELAY_REGISTRY_DIR` 指向临时目录防止污染真实家目录；伪装存活守护 = 写 lock 文件
（pid=测试进程 + 新鲜心跳，`isDaemonAlive` 即真）。

- **R1** env 命中（cwd 故意放别处）→ 工具正常（钉死 0.4.x 行为）
- **R1b** env 指向 DB 打不开的目录 → 干净报错 exit≠0（非堆栈）
- **R2** cwd 命中（无 env）→ 工具正常（钉死 0.4.x 行为）
- **R3** 无 env、cwd 无关、客户端声明 roots 并回报唯一含 `.sessionrelay` 的根 → 自动选中
- **R4** 无 env、cwd 无关、客户端不支持 roots、注册表恰一个存活守护项目 → 自动选中
- **R5** 多个存活候选 → 工具返回 `unresolved_project`（isError）+ 候选列表；
  带 `project` 重试 → 成功；再不带参 → 仍成功（连接记住）
- **R6** 零信号零候选 → 指导性错误（howTo 提到 init / 环境变量）
- **R7** 注册表文件损坏 → 视为空，不 crash，走 R6 路径
- **R8** 全部模式下 tools/list 恒 16 个名字 + 删除类黑名单扫描通过
- **R9** 已解析模式下传指向另一项目的 `project` → 切换生效（get_stats 的 project 变化）

## 8. 评审记录（三轮）

**第一轮（结构）**
- A1 roots 请求必须在 connect 之后，而 env/cwd 在 connect 之前——引入 deferred 状态机，
  早期到达的工具调用拿指导载荷，adoption 完成后自然恢复（竞态安全：adoption 至多一次显式化）。
- A2 不声明 roots 能力的客户端发 listRoots 会挂到超时——改为先看
  `getClientCapabilities()?.roots`，没有就不发。
- A3 注册表路径踩 `findRelayRoot` 家目录探测坑——定名 `~/.sessionrelay-registry/`，
  并提供 `SRELAY_REGISTRY_DIR` 测试钩子（测试不得污染真实家目录）。
- A4 仓库根本身有 `.sessionrelay`（dogfood），无信号测试必须用 transport 的 `cwd` 选项
  把子进程 cwd 指到干净临时目录（已确认 SDK 支持）。

**第二轮（数据流与守卫）**
- B1 `buildHint` 与 16 个 handler 闭包捕获 db/project——统一改调用时解构，切换项目零陈旧句柄。
- B2 adoption 路径的 `ensureDaemon` 必须带同一组跳过守卫（VITEST / SRELAY_NO_DAEMON_SPAWN），
  否则复活 CI Windows EBUSY 老坑。
- B3 注册表候选 ad前必须验证 `.sessionrelay` 存在（openExisting 对缺失文件会静默建库，
  不能让"看起来能服务"的候选实际凭空建库——env 路径维持 0.4.x 语义不动）。
- B4 指导载荷用 `isError: true`（语义上是失败），Resolved 模式不变（契约 call() 助手不受影响）。
- B5 TTY 交互裸跑 serve 的旧行为（报错退出）保留，人机两条路径分治。

**第三轮（对抗与边界）**
- C1 roots 返回 `file:///D:/...`（Windows 盘符/百分号编码）——`fileURLToPath` + try/catch 逐个转换。
- C2 注册表并发写竞态——按 root 键 upsert + 原子替换，接受微小丢心跳窗口（§5 已记）。
- C3 候选列表暴露其他项目路径——本机自有 AI、路径非敏感，接受；红线是内容永不跨项目。
- C4 env 无效目录的报错改造（干净 stderr + exit 1）——退出码语义不变，属可读性修复。
- C5 切换项目后 `session_id` 前缀解析随 project 走——文档化为正确行为而非 bug。
- C6 doctor 补注册表视图（可诊断性闭环：本机能预先回答"Qoder 会选中谁"）。
