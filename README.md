# 会话接力 SessionRelay

> **属于项目、不属于任何厂商的本地记忆层。**
> 完整收录你与所有 AI 编程助手的会话，让你划定检索边界，并以标准交接包（HOP）把知识传递给下一个人。

**Memory is always complete. Retrieval is always yours to shape.**
记忆始终完整收录；检索边界由你划定。

## 它解决什么

- **跨时间失忆**：新会话问"上周讨论的方案是什么来着？"——搜得到
- **跨工具断裂**：上午在 Claude Code 定的方案，下午 ZCode 直接基于它写代码
- **跨人交接**：你和 AI 聊了 3 天的方案，`export` 成一个 `.hop` 交接包，接手的人 `import` 后他的 AI 立刻拥有全部上下文

## 核心特性（MVP 已全部实现，81/81 测试）

| 特性 | 说明 |
| ---- | ---- |
| 🖥️ **被动捕获** | 默认监听 Claude Code（JSONL）与 ZCode（SQLite）会话源，零打扰；`full / meta / off` 三档隐私模式 + `.sessionrelayignore` 硬边界 |
| 🔍 **中文检索** | jieba 分词 + SQLite FTS5 双索引，会话级 AND 覆盖 + OR 兜底；每条结果强制携带**出处块**（来源会话/agent/消息序号） |
| 🤖 **MCP Server** | 8 个工具（stdio），任何支持 MCP 的 AI agent 可直接查询；`search / decisions / file_history / unresolved / set_scope…` |
| 🎯 **Scope 检索边界** | `scope.json` 项目契约 + auto-scope 兜底，交集语义只能收窄；`attach` 挂载指定历史会话 |
| 🧠 **结构化提取** | 零 LLM 规则提取：决策/话题/涉及文件/未决问题 + 免费规则摘要（confirmed 时自动生成） |
| 📦 **HOP 交接协议** | `hop/1.0` 开放格式：sha256 完整性校验 + **默认密钥脱敏** + quarantine 隔离导入（反 prompt 注入）+ 自动生成 HANDOFF.md |
| ⚙️ **两阶段判定** | `active → pending_end → confirmed`，resume 自动回滚；原始会话文件是唯一事实源，库可随时重建 |

## 快速开始（开发态）

```bash
git clone https://github.com/EwanJasper/SessionRelay.git
cd SessionRelay && npm install

# 在你的项目根目录（示例）：
node --import ./node_modules/tsx/dist/loader.mjs <本仓库>/src/bin/srelay.ts init   # 初始化 + 回填30天
node --import ./node_modules/tsx/dist/loader.mjs <本仓库>/src/bin/srelay.ts search 中文关键词
node --import ./node_modules/tsx/dist/loader.mjs <本仓库>/src/bin/srelay.ts status  # 透明度面板
```

npm 包分发（`npx sessionrelay`）在 Phase 4 发布，见[路线图](docs/phase35-report.md)。

### 注册为 AI agent 的 MCP 服务

```json
{
  "mcpServers": {
    "sessionrelay": { "command": "srelay", "args": ["serve"] }
  }
}
```

注册后，你的 agent 即可回答："之前为什么决定用 PostgreSQL？"——带出处。

## 常用命令

```bash
srelay init --yes           # 初始化（默认回填 30 天，1 分钟内可搜到上月讨论）
srelay sync                 # 增量捕获 + 两阶段判定
srelay watch --install-service  # 注册守护（Windows 计划任务，登录自启）
srelay search <关键词> [--topic --source --since --json]
srelay decisions            # 全部已确认决策（带出处，可回跳）
srelay history <文件路径>    # 该文件被哪些会话讨论过
srelay export --all         # 导出 .hop 交接包（默认脱敏）
srelay import <pkg.hop> --from 张三   # 接收方在自己的项目根执行
srelay team status | log    # 交接审计
srelay doctor               # 环境自检
```

## 隐私设计

- **本地优先**：零云依赖、零运行时网络外呼（遥测=本地计数器+自愿提交）
- **三档捕获模式**：`full`（默认）/ `meta`（只存元数据不存正文）/ `off`（仅手动）
- **导出防线**：默认密钥脱敏（连接串/AKIA/私钥/Bearer/密码赋值），出具脱敏报告；`--quarantine` 隔离导入
- **信任模型**：交接包内容是**数据不是指令**，写入 `hop/1.0` 协议

## 文档

- [产品与技术指导方针 v3.1](docs/product/sessionRelay-指导方针v3.1.md)（唯一有效，含决策日志 D1-D20）
- [技术方案 v1.1](docs/product/sessionRelay-技术方案v1.1.md)（T1-T37 决策）
- 阶段报告：[P0 Spike](docs/spike-report-p0.md) · [P1](docs/phase1-report.md) · [P2](docs/phase2-report.md) · [P3](docs/phase3-report.md) · [P3.5 收官](docs/phase35-report.md)
- [ZCode 存储格式逆向笔记](docs/adapters/zcode-format.md)

## 路线图（Phase 4）

`--ai` 摘要与提取增强 · 会话身份（branch/PID）与 `get_linked_sessions` · DSH/Cursor adapter · `spec/hop-1.0.md` 协议独立成文与第三方推广 · npm 发布 · 语义检索（可选本地嵌入）

## License

MIT © 2026 EwanJasper
