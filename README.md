# 会话接力 SessionRelay

> **属于项目、不属于任何厂商的本地记忆层。**
> Memory is always complete. Retrieval is always yours to shape.
> 记忆始终完整收录；检索边界由你划定。

你和 AI 聊了 3 天的方案，不应该随关窗消失。它属于项目，属于下一个接手的人。

## 它解决什么

| 痛点 | 会话接力的答案 |
| ---- | -------------- |
| **跨时间失忆**：新会话问"上周讨论的方案？"——AI 不知道 | 按需检索历史会话，带出处 |
| **跨工具断裂**：Claude Code 定的方案，ZCode 不知道 | 双源同库，任何 agent 通过 MCP 查同一份记忆 |
| **跨人交接**：你和 AI 聊了 3 天，接手的人只能"去看代码" | 导出 `.hop` 交接包，对方的 AI 立刻拥有全部上下文 |

## 与 claude-mem 的架构区别：会话级存储

这是最核心的设计决策，不是功能差异，是**存储粒度**的架构差异：

| | claude-mem | **SessionRelay** |
| -- | ---------- | ---------------- |
| 存储单位 | 记忆片段（压缩摘要，跨会话打散混合） | **会话**（完整对话，有标题/时间线/来源/状态/决策） |
| AI 看到的 | 一堆"你之前说过…"碎片 | "根据 8 月 28 日 ZCode 会话《数据库选型》第 12 条…" |
| 幻觉风险 | 高：上下文污染 + 压缩失真 + 无法溯源 | **结构性抑制**：出处强制 + 按需查询 + 原文可回跳 |

三个反幻觉设计（不是功能，是架构承诺）：

1. **出处强制**：AI 回答必须带"哪个会话/哪条消息/哪个 agent"——有源可查，不能瞎编
2. **按需查询**（pull）：AI 不问就不查 → 上下文干净，不被无关记忆污染
3. **原文可回跳**：AI 拿到的是原始对话全文，不是压缩摘要——决策的"为什么"完整保留

## 核心能力

### 🖥️ 被动捕获（零打扰）
- **双源适配**：Claude Code（JSONL）+ ZCode（SQLite，国产一手适配）
- **三档隐私**：`full`（默认） / `meta`（只存元数据） / `off`（仅手动）
- **`.sessionrelayignore` 硬边界**：隐私排除对自动捕获、手动 save、导出全部生效
- **两阶段判定**：`active → pending_end → confirmed`，resume 自动回滚，原始会话文件是唯一事实源（库随时可 `rebuild`）
- **历史回填**：`srelay init` 默认回填近 30 天；`srelay sync --backfill all` 一条命令全量入库

### 🔍 中文检索
- jieba 分词 + SQLite FTS5 双索引（六条中文验收用例门禁）
- 会话级 AND 覆盖 + OR 兜底：连写词拆分（"认证方案"→ 认证+方案）、短语精确匹配（`"按月分区"`）
- 每条结果**强制携带出处块**（会话 ID / 来源 agent / 日期 / 消息序号 / 摘要片段）

### 🤖 MCP Server（15 个工具，8 读 + 7 写域）
任何支持 MCP 的 AI agent 接入后，从此在这个项目里不再是失忆的：

<details>
<summary><b>8 个读工具</b>——AI 从此能回答的问题</summary>

| 工具 | 回答的问题 |
| ---- | ---------- |
| `search_sessions` | "我们之前讨论过 X 吗？"（中文全文 + 元数据过滤） |
| `get_session_detail` | "那场讨论具体聊了什么？"（完整消息，支持范围） |
| `list_sessions` | "这个项目都聊过哪些话题？" |
| `get_decisions` | "为什么决定用 X 而不是 Y？"（全部已确认决策，带出处） |
| `get_file_history` | "这个文件为什么这么写？"（跨会话文件讨论史） |
| `get_unresolved` | "还有什么没定的？"（未决问题清单） |
| `get_stats` | "记忆库什么状态？"（会话数/来源分布/体积） |
| `set_scope` | 检索边界逃生口 |

</details>

<details>
<summary><b>7 个写域工具</b>——AI 不再只是读者</summary>

| 工具 | 能力 | 安全边界 |
| ---- | ---- | -------- |
| `annotate_session` | 给会话打标签 / 写人工摘要 | 只改元数据，不改写对话 |
| `save_note` | AI 把结论写成笔记（决策句式直接入决策库） | source=note，可识别可审计 |
| `export_handoff` | 生成 .hop 交接包 | 只读导出 |
| `import_handoff` | 导入交接包（sha256 校验 + 归化） | **默认隔离模式**（正文待放行） |
| `release_quarantine` | 放行隔离会话正文 | 需显式调用 |
| `link_sessions` | 建立会话关联（continues/related/pinned） | 关联可查可撤销 |
| `get_linked_sessions` | 双向查询会话关联（出边/入边） | 只读 |

</details>

**写域三原则**（D21）：旁路写入（不碰状态机）· 导入默认隔离 · 笔记可溯源——每条 AI 写入都能被识别、审计、撤销。

### 🎯 Scope 检索边界
- **B 档**：`scope.json` 项目契约（CLI 与 MCP 共用），交集语义只能收窄
- **A 档**：auto-scope 兜底（MCP 侧近 30 天可配），防上下文污染
- **attach**：开新会话前挂载指定历史会话（最高优先级谓词）
- **热更新**：scope 改动下一次调用立即生效

### 📦 HOP 交接协议（`hop/1.0`，开放格式）
- [独立协议规格](spec/hop-1.0.md)（MIT，产品中立，欢迎第三方实现读取器）
- sha256 逐文件完整性校验（篡改整体拒绝）
- **默认密钥脱敏**：AWS key / 私钥 / Bearer / 密码赋值 / 数据库连接串 + 脱敏报告
- **隔离导入**（quarantine）：只入元数据与摘要，正文经 `release` 逐条放行——反 prompt 注入的结构性防线
- HANDOFF.md 自动生成（决策表 / 涉及文件 / 未解决问题 / 时间线 / 页脚署名）
- **跨项目导入**：交接包可导入到任何路径/名称的项目（自动归化，`origin_project` 溯源）

## 快速开始

要求 **Node ≥ 22**（Windows / macOS / Linux）：

```bash
git clone https://github.com/EwanJasper/SessionRelay.git
cd SessionRelay && npm install && npm run build
npm link                 # 之后全局可用 srelay 命令
```

### 初始化项目

```bash
cd 你的项目
srelay init              # 初始化 + 回填近 30 天（1 分钟内可搜到上月讨论）
srelay sync --backfill all   # 或全量回填所有历史（旧会话自动确认+提取决策）
```

### 日常使用

```bash
srelay search 中文关键词 [--topic --source --since --json]
srelay decisions         # 全部已确认决策（带出处，可回跳）
srelay history src/db/   # 该文件被哪些会话讨论过
srelay watch --install-service  # Windows 注册守护，登录自启
srelay doctor            # 环境自检
```

### 团队交接

```bash
srelay export --all      # 交接包（默认脱敏）→ 发给同事
# 同事在他的项目根（任何路径）：
srelay import xxx.hop --from 你的名字
```

### 注册为 AI agent 的 MCP 服务

```json
{
  "mcpServers": {
    "sessionrelay": { "command": "srelay", "args": ["serve"] }
  }
}
```

注册后问你的 AI："**之前为什么决定用 PostgreSQL？**"——它将调用 `get_decisions`，给出带出处的回答。

### Claude Code 生命周期钩子（可选，加速会话确认）

```json
{
  "hooks": {
    "Stop": [{ "hooks": [{ "type": "command", "command": "srelay hook session-end --id $CLAUDE_SESSION_ID" }] }]
  }
}
```

## 隐私设计

- **本地优先**：零云依赖、零运行时网络外呼（遥测 = 本地计数器 + 自愿提交）
- **三档捕获** + **ignore 硬边界** + **导出默认脱敏** + **隔离导入**，四层防线
- **信任模型**：交接包内容是数据不是指令，写入 `hop/1.0` 协议

## 质量与验证

- **90/90 测试**（单元 / 集成 / MCP stdio 真握手契约 / 端到端），`npm test` 一键
- **CI 三平台 × Node 22/24 常绿**（typecheck + test + build + dist 冒烟）
- TypeScript strict，`npm run typecheck` 零错误
- 每阶段实机验收（含用产品自身记录了自身的诞生过程）

## 已知限制（诚实清单）

- 规则提取精度约 60-70%（出处块让你逐条回跳核验；`--ai` 增强在 Phase 4）
- 守护服务注册仅 Windows（计划任务）；macOS / Linux 用 `srelay watch` 前台运行
- 开新会话的"自动关联重要会话"需要会话身份（branch/PID），Phase 4 落地；当前用 `attach` 手动挂载
- 多 agent 同项目并发时 Scope 按 project+cwd 归属
- 目录改名/搬迁的历史会话不被自动发现（用交接包迁移）
- 仅支持 Claude Code 与 ZCode 两个会话源（DSH / Cursor 在路线图）

## 路线图（Phase 4）

`--ai` 摘要与提取增强 · 会话身份（branch/PID）与自动关联 · `suggest_related_sessions`（话题重叠推荐） · DSH / Cursor / 自定义 adapter · npm 发包 · 语义检索（可选本地嵌入） · HOP 协议第三方推广

## 文档

- [产品与技术指导方针 v3.1](docs/product/sessionRelay-指导方针v3.1.md)（21 条决策日志 D1-D21）
- [技术方案 v1.1](docs/product/sessionRelay-技术方案v1.1.md)（38 条技术决策 T1-T38）
- [HOP 交接协议规格 hop/1.0](spec/hop-1.0.md)
- 阶段报告：[P0](docs/spike-report-p0.md) · [P1](docs/phase1-report.md) · [P2](docs/phase2-report.md) · [P3](docs/phase3-report.md) · [P3.5](docs/phase35-report.md)
- [ZCode 存储格式逆向笔记](docs/adapters/zcode-format.md)

## License

MIT © 2026 EwanJasper
