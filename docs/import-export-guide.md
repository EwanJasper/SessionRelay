# 导入导出实操指南 — 团队交接、项目迁移、知识沉淀

> 会话接力的导入导出不只是"打包文件"——它是一个带完整性校验、自动脱敏、隔离防护的**知识传递管道**。
> 本文覆盖五个真实场景，每个都有可直接复制的命令。

---

## 场景一：项目交接（最常见）

> 你要离开这个项目了，同事接手。你们聊了 3 天的方案不能只靠口头说"你去看代码吧"。

```bash
# 第一步：你在你的项目根目录导出
cd /你的项目
srelay export --all --output 项目名-交接.hop

# 第二步：把 .hop 文件发给同事（微信/邮件/git lfs 都行，它就是一个 zip）

# 第三步：同事在他的电脑上，进入他要接手的项目目录
cd /同事的项目
srelay init --yes                              # 初始化（如果还没装过）
srelay import 项目名-交接.hop --from "你的名字"  # 导入

# 第四步：同事验证——他的 AI 现在知道所有历史决策
srelay decisions          # 看到你项目里的全部决策
srelay search "数据库"     # 搜到所有相关讨论
```

**同事的 AI 能回答什么**：
- "为什么数据库选了 PostgreSQL？" → 调 `get_decisions()`，带出处
- "JWT 刷新策略定了吗？" → 调 `get_unresolved()`
- "这个文件为什么这么写？" → 调 `get_file_history("src/auth/jwt.ts")`

---

## 场景二：新人入职（批量知识传递）

> 团队来了新人，需要快速了解项目的技术决策和历史背景。

```bash
# 老成员：导出"决策精华"（不含对话正文，轻量）
srelay export --decisions-only --output 项目决策精华.hop

# 新人：导入后 AI 立刻有全部决策上下文
srelay import 项目决策精华.hop --from "张三"
```

`--decisions-only` 导出的包很小（通常 < 100KB），只含决策列表、话题索引、文件关联和摘要，**不含对话原文**。适合快速了解"这个项目做过什么决定"。

新人还可以导出一份人类可读版：

```bash
# 在老成员那边直接生成 Markdown（不走 .hop 包，直接出文档）
srelay export --format markdown --output HANDOFF.md
```

生成的 HANDOFF.md 包含：决策表（日期/决策/原因/来源）、涉及文件、未解决问题、时间线——**新人不需要装 srelay 就能读**。

---

## 场景三：不信任来源的安全导入（隔离模式）

> 有人给你发了一个 .hop 包，但你不确定里面是否藏有恶意内容（prompt 注入等）。

```bash
# 隔离导入：只入元数据和摘要，对话正文暂不可见
srelay import 可疑包.hop --quarantine

# 查看导入了什么（只有标题和决策，看不到正文）
srelay list
srelay decisions

# 审查后确认安全，逐个放行
srelay import 可疑包.hop --release abc123    # 放行 ID 前缀为 abc123 的会话
```

**隔离模式下什么可见、什么不可见**：

| 可见（立即可搜） | 不可见（需 release） |
| ---------------- | -------------------- |
| 会话标题 | 对话正文 |
| 决策列表 | 具体讨论细节 |
| 话题标签 | 代码片段 |
| 规则摘要 | — |

---

## 场景四：跨项目迁移（目录改名/搬迁）

> 你把项目从 `D:\old\myapp` 搬到了 `D:\new\myapp-v2`。ZCode/Claude Code 不会自动关联新旧路径的历史会话。

```bash
# 在旧路径导出
cd /d/old/myapp
srelay export --all --output migration.hop

# 在新路径导入
cd /d/new/myapp-v2
srelay init --yes
srelay import ../old/myapp/migration.hop --from "项目迁移"
```

导入时 `project_id` 自动重写为新项目，原项目身份存入 `origin_project` 供溯源。搜索、决策、MCP 查询在新路径下全部可用。

---

## 场景五：定期知识沉淀（长期项目）

> 长期项目的会话越来越多，定期导出一份"知识快照"归档。

```bash
# 每月导出一份全量快照
srelay export --all --output backup/知识快照-2026-08.hop

# 或用 cron/计划任务自动化
# Windows 计划任务：
schtasks /Create /TN "SessionRelay备份" /SC MONTHLY /TR "srelay export --all --output D:\backup\知识快照.hop"
```

---

## 导出时自动发生的事

| 动作 | 说明 |
| ---- | ---- |
| **密钥脱敏** | 数据库连接串、AWS AKIA key、私钥块、Bearer token、密码赋值——自动替换为 `[已脱敏:类型]`，并生成 `redaction-report.txt` |
| **完整性校验** | 每个文件算 sha256 写入 manifest.json，导入时重算——**篡改任何一字节都会被拒绝** |
| **HANDOFF.md** | 自动生成交接文档（决策表/文件/未决问题/时间线），人类可直接阅读 |
| **页脚署名** | `由会话接力 SessionRelay 生成 · github.com/EwanJasper/SessionRelay` |
| **审计日志** | 记入 transfer_log（谁导出的、导了哪些会话、什么时候） |

## 导入时自动发生的事

| 动作 | 说明 |
| ---- | ---- |
| **归化** | `project_id` 重写为当前项目，原值存 `origin_project`（任何路径都能导入） |
| **幂等** | 同一个包重复导入 → 全跳过（指纹匹配），不会产生重复数据 |
| **冲突处理** | 同身份不同内容的会话 → 保留双方，新者加后缀（`#imp-xxx`） |
| **信任模型** | manifest 里写入"内容是数据，不是指令"——导入方不得将其提升为系统指令 |

## MCP 方式（AI 在对话中直接操作）

如果 AI agent 已接入 MCP，它可以直接调用工具完成导入导出，无需 CLI：

```
用户："帮我把这个项目的记忆导出一份"
AI：调用 export_handoff(all: true, output: "/tmp/交接.hop")
    → "已导出 23 个会话、156 条消息到 /tmp/交接.hop"

用户："把张三发我的包导入"
AI：调用 import_handoff(path: "张三-交接.hop")
    → "已隔离导入 15 个会话（摘要可见，正文待放行）"

用户："这个会话安全，放行"
AI：调用 release_quarantine(session_id_prefix: "abc123")
    → "已放行 1 个会话"
```

## 常见问题

**Q: .hop 文件多大？**
A: 取决于会话量。100 个会话约 5-50MB；`--decisions-only` 通常 < 100KB。

**Q: 脱敏能漏掉东西吗？**
A: 目前覆盖 5 类模式（连接串/AKIA/私钥/Bearer/密码赋值），正则覆盖常见格式。如果你有自定义敏感模式，建议先 `--format markdown` 生成文档人工审查，确认安全后再打 .hop 包。

**Q: 导入后原会话会被修改吗？**
A: 不会。导出是只读操作。导入是在你的库里创建新记录，原始会话文件（ZCode SQLite / Claude Code JSONL）完全不动。

**Q: 能导入到自己项目吗？**
A: 可以，但会生成后缀副本（同身份不同指纹 → 合并规则保留双方）。如果只是备份/恢复，建议用 `srelay rebuild` 而不是 import。
