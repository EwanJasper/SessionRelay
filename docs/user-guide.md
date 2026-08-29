# 会话接力 SessionRelay — 用户手册

> 从安装到团队交接的完整指南。适合所有用户阅读。

---

## 目录

1. [安装](#一安装)
2. [初始化项目](#二初始化项目)
3. [日常使用](#三日常使用)
4. [搜索与决策](#四搜索与决策)
5. [守护进程](#五守护进程)
6. [AI Agent 接入（MCP）](#六ai-agent-接入mcp)
7. [团队交接](#七团队交接)
8. [归档与数据管理](#八归档与数据管理)
9. [隐私控制](#九隐私控制)
10. [自定义适配器](#十自定义适配器)
11. [常见问题](#十一常见问题)

---

## 一、安装

### 要求

- **Node.js ≥ 22**（Windows / macOS / Linux）
- 至少一个支持的 AI 编程工具（Claude Code / ZCode / Codex / Qoder）

### 从源码安装

```bash
git clone https://github.com/EwanJasper/SessionRelay.git
cd SessionRelay
npm install
npm run build
npm link          # 之后全局可用 srelay 命令
```

### 验证安装

```bash
srelay --version   # 应显示 0.1.0
srelay doctor      # 环境自检
```

---

## 二、初始化项目

在**你的项目根目录**执行一次：

```bash
cd /你的项目
srelay init
```

**init 会做什么**：
1. 检测本机已安装的 AI 工具（跨平台路径检测）
2. 让你选择要捕获哪些来源（交互式，或 `--sources zcode,claude-code` 指定）
3. 创建 `.sessionrelay/` 目录（数据库 + 配置）
4. 创建 `.sessionrelayignore`（隐私排除规则模板）
5. 回填最近 30 天的历史会话
6. 邀请你试搜一个关键词（验证一切正常）

### 来源选择

init 时会自动检测：

```
🔍 检测到以下 AI 编程工具：

  ✅ Claude Code          ~/.claude/projects
  ✅ ZCode              ~/.zcode/cli/db/db.sqlite
  ✅ Codex              ~/.codex
  ✅ Qoder              ~/.qoder-cn
  ⬜ Trae（部分支持）      未检测到

选择要捕获的来源：
  回车 或 A = 全选已安装的
  逗号分隔 = 只选指定的（如 zcode,claude-code）
>
```

跳过交互：

```bash
srelay init --sources zcode,claude-code   # 只要这两个
srelay init --yes                          # 自动选所有已安装的
```

**回填更多历史**：

```bash
srelay sync --backfill all     # 全量回填（不管多早）
srelay sync --backfill 180d    # 回填最近 180 天
```

**重复执行 init 安全吗？** 安全——检测到已初始化后只做增量同步，不产生重复数据。

---

## 三、日常使用

### 查看已捕获的会话

```bash
srelay status            # 总览：会话数 / 来源分布 / 守护状态
srelay list              # 列出所有会话
srelay list --source zcode    # 只看 ZCode 的
srelay list --source claude-code  # 只看 Claude Code 的
srelay show <会话ID前缀>       # 查看某场对话的内容
```

### 手动保存特定会话

```bash
srelay save <会话ID>                # 手动保存（标记为 manual）
srelay save --recent 7d            # 保存最近 7 天的
srelay save --interactive          # 交互勾选
srelay save <id> --tag "重要" --summary "定了JWT方案"  # 附加标签和摘要
```

### 重新同步

```bash
srelay sync             # 增量同步（只拉新消息）
srelay rebuild          # 从源文件全量重建索引
```

---

## 四、搜索与决策

### 中文搜索

```bash
srelay search "数据库索引"
srelay search "认证方案" --source zcode
srelay search "部署" --since 2026-08-01
srelay search "JWT" --json     # JSON 输出（供脚本用）
```

每条搜索结果都**带出处**：来源会话 ID、来源 agent（Claude Code / ZCode / Codex）、日期、消息序号——你可以随时 `srelay show <id>` 跳到原文验证。

### 查看决策

```bash
srelay decisions            # 所有已确认的技术决策
srelay decisions --topic "数据库"  # 按话题过滤
```

### 查看未决问题

```bash
srelay unresolved           # 讨论中提出但还没定论的问题
```

### 查看文件的讨论历史

```bash
srelay history src/db/schema.sql   # 这个文件被哪些会话讨论过
```

---

## 五、守护进程

### 为什么需要守护

**ZCode 在上下文压缩时会物理删除旧消息**。守护每 30 秒自动同步，确保消息在被删之前入库。不开守护的风险：手动 sync 之间如果 AI 触发压缩，被删的原始消息将**永久丢失**。

### 安装守护

```bash
srelay watch --install-service   # Windows：注册表自启动（无需管理员）
srelay watch --foreground        # macOS/Linux：前台运行
```

### 守护资源开销

| 资源 | 消耗 |
|------|------|
| CPU（空闲） | ≈ 0%（事件驱动） |
| 内存 | ~80MB |
| 网络 | **零外呼** |
| 磁盘 I/O | 极低（增量） |

### 懒启动

任何 `srelay` 命令执行时，如果守护不在运行，会自动拉起——你永远不需要手动想"守护在不在"。

---

## 六、AI Agent 接入（MCP）

### Claude Code（一条命令）

```bash
claude mcp add sessionrelay --scope user -- srelay serve
```

### ZCode / 其他 MCP 客户端

在项目的 MCP 配置中添加：

```json
{
  "mcpServers": {
    "sessionrelay": { "command": "srelay", "args": ["serve"] }
  }
}
```

### 接入后 AI 能做什么

注册后问你的 AI：

> **"我们之前为什么决定用 PostgreSQL？"**

它将调用 `get_decisions`，给出带出处的回答（日期、来源 agent、可回跳的会话 ID）。

<details>
<summary>15 个 MCP 工具完整列表（点击展开）</summary>

**读工具（8 个）**：

| 工具 | AI 能回答的问题 |
| ---- | -------------- |
| `search_sessions` | "我们之前讨论过 X 吗？" |
| `get_session_detail` | "那场讨论具体聊了什么？" |
| `list_sessions` | "这个项目都聊过哪些话题？" |
| `get_decisions` | "为什么决定用 X 而不是 Y？" |
| `get_file_history` | "这个文件为什么这么写？" |
| `get_unresolved` | "还有什么没定的？" |
| `get_stats` | "记忆库什么状态？" |
| `set_scope` | 检索边界逃生口 |

**写域工具（7 个）**：

| 工具 | 能力 |
| ---- | ---- |
| `annotate_session` | 给会话打标签 / 写摘要 |
| `save_note` | AI 把结论写成笔记 |
| `export_handoff` | 生成交接包 |
| `import_handoff` | 导入交接包（默认隔离） |
| `release_quarantine` | 放行隔离正文 |
| `link_sessions` | 建立会话关联 |
| `get_linked_sessions` | 查询关联 |

</details>

---

## 七、团队交接

### 导出（你 → 同事）

```bash
# 在你的项目根目录
srelay export --all                # 全量导出 → 生成 .hop 交接包
srelay export --decisions-only     # 只要决策（轻量，< 100KB）
srelay export --format markdown    # 直接生成 HANDOFF.md（人类可读）
```

### 导入（同事 → 他的项目）

```bash
# 同事在他的项目根目录（任何路径都行）
srelay import 你的交接包.hop --from "你的名字"
```

导入后同事的 AI 立刻能回答"为什么之前选了 X"。

### 交接包安全性

- **密钥自动脱敏**（数据库连接串 / AWS key / 私钥 / Bearer token）
- **sha256 完整性校验**（篡改任何一字节都会被拒绝）
- **隔离导入**（`--quarantine`：只入元数据，正文需逐条放行）

> 详细指南：[导入导出实操指南](import-export-guide.md)

---

## 八、归档与数据管理

### 什么是归档

归档 = 删除对话正文，**保留决策/话题/摘要骨架**。释放 99.4% 空间，知识仍可搜索。

```bash
# 预览（不实际执行）
srelay archive --days 90 --dry-run

# 执行归档
srelay archive --days 90

# 硬删除（彻底删除，含决策）
srelay archive --days 90 --hard

# 查看归档历史
srelay archive --history
srelay archive --history --verbose    # 逐会话明细
```

### 什么不会被归档

- 正在进行的对话（active）
- 交接包导入的会话（imported）
- AI 写的笔记（note）
- 标签含"保留"的会话

### 恢复被归档的数据

```bash
srelay rebuild --force    # 从源文件全量重建（忽略归档状态）
```

---

## 九、隐私控制

### 三层防线

| 层 | 工具 | 作用 |
|---|------|------|
| **预防** | `.sessionrelayignore` / `mode off` / `mode meta` | 不让敏感数据进来 |
| **归档** | `srelay archive` | 已入库，释放空间保留骨架 |
| **删除** | `srelay archive --hard` | 彻底删除 |

### .sessionrelayignore

在项目根目录创建，语法类似 .gitignore：

```bash
# 不捕获某个 AI 工具的会话
source:trae

# 标题含"薪资"的不入库
title:薪资

# 匹配文件路径
*.secret.jsonl
```

### 捕获模式

```bash
srelay mode full    # 全量捕获（默认）
srelay mode meta    # 只存元数据，不存正文
srelay mode off     # 关闭自动捕获，仅手动 save
```

---

## 十、自定义适配器

支持新 AI 工具 = 在 `.sessionrelay/adapters/` 放一个 JS 文件：

```javascript
// .sessionrelay/adapters/my-agent.js
module.exports = {
  id: 'my-agent',
  displayName: 'My Agent',
  discover(projectRoot, config) {
    // 返回属于该项目的会话列表
    return [{ source: 'my-agent', sourceSessionId: 'xxx', sourceFile: '...', sizeBytes: 1024, mtimeMs: Date.now() }];
  },
  async readNew(ds, cursor, config) {
    // 增量读取新消息
    return { messages: [{ role: 'user', content: '...', seqNum: 1 }], badLines: 0, cursor: {} };
  },
};
```

然后在 config.json 的 `capture.sources` 里加 `"my-agent"`。

> 完整接口文档：[Adapter SDK](adapters/README.md)

---

## 十一、常见问题

**Q: .hop 文件多大？**
A: 100 个会话约 5-50MB；`--decisions-only` 通常 < 100KB。

**Q: 多次 init 会怎样？**
A: 安全——只做增量同步，不产生重复。

**Q: 导入别人的会话会跟我的冲突吗？**
A: 不会。会话身份是 `(来源, 会话ID)`，不同用户的会话 ID（UUID）永远不同。

**Q: ZCode 压缩上下文后消息丢了怎么办？**
A: 开启守护（30 秒窗口）。已丢失的不可恢复（源文件被 ZCode 删了）。守护会自动捕获压缩摘要。

**Q: 能在多个项目使用吗？**
A: 能——每个项目目录独立一个 `.sessionrelay/`，数据互不干扰。

**Q: 支持哪些 AI 工具？**
A: Claude Code（JSONL）、ZCode（SQLite）、Codex（JSONL）、Qoder（JSONL），加自定义适配器。Trae 部分支持（加密限制）。

**Q: 数据会上传吗？**
A: 不会。完全本地，零网络外呼。遥测仅为本地计数器。

---

## 快速参考卡

```bash
# 初始化
srelay init                          # 初始化 + 回填 30 天
srelay sync --backfill all           # 全量回填

# 查询
srelay search <关键词>                # 中文搜索
srelay decisions                     # 全部决策
srelay list --source <来源>           # 按来源列出
srelay show <ID>                     # 查看对话
srelay history <文件路径>             # 文件讨论史

# 守护
srelay watch --install-service       # 注册自启动
srelay watch --status                # 查看状态
srelay doctor                        # 环境自检

# 交接
srelay export --all                  # 导出交接包
srelay import <file>.hop --from 名字  # 导入

# 归档
srelay archive --days 90 --dry-run   # 预览
srelay archive --days 90             # 归档
srelay archive --history             # 历史

# 隐私
srelay mode <full|meta|off>          # 捕获模式
# .sessionrelayignore                # 排除规则
```
