# SessionGraph — 产品需求与技术方案文档（最终版）

> **版本**：v2.0
> **日期**：2026-08-27
> **定位**：项目级跨 Agent 会话记忆层 + 团队知识传递管道

------

## 目录

1. [产品概述](https://www.qianwen.com/chat/b5403abd0e7e48829e8a078f0f5b3322#一产品概述)
2. [用户需求](https://www.qianwen.com/chat/b5403abd0e7e48829e8a078f0f5b3322#二用户需求)
3. [市场分析与竞争格局](https://www.qianwen.com/chat/b5403abd0e7e48829e8a078f0f5b3322#三市场分析与竞争格局)
4. [产品定位与差异化](https://www.qianwen.com/chat/b5403abd0e7e48829e8a078f0f5b3322#四产品定位与差异化)
5. [技术方案](https://www.qianwen.com/chat/b5403abd0e7e48829e8a078f0f5b3322#五技术方案)
6. [架构设计](https://www.qianwen.com/chat/b5403abd0e7e48829e8a078f0f5b3322#六架构设计)
7. [数据库设计](https://www.qianwen.com/chat/b5403abd0e7e48829e8a078f0f5b3322#七数据库设计)
8. [CLI 设计](https://www.qianwen.com/chat/b5403abd0e7e48829e8a078f0f5b3322#八cli-设计)
9. [MCP Tools 设计](https://www.qianwen.com/chat/b5403abd0e7e48829e8a078f0f5b3322#九mcp-tools-设计)
10. [跨 Agent 共享设计](https://www.qianwen.com/chat/b5403abd0e7e48829e8a078f0f5b3322#十跨-agent-共享设计)
11. [元数据提取策略](https://www.qianwen.com/chat/b5403abd0e7e48829e8a078f0f5b3322#十一元数据提取策略)
12. [增量同步机制](https://www.qianwen.com/chat/b5403abd0e7e48829e8a078f0f5b3322#十二增量同步机制)
13. [团队协作与知识传递](https://www.qianwen.com/chat/b5403abd0e7e48829e8a078f0f5b3322#十三团队协作与知识传递)
14. [优缺点分析](https://www.qianwen.com/chat/b5403abd0e7e48829e8a078f0f5b3322#十四优缺点分析)
15. [风险与应对](https://www.qianwen.com/chat/b5403abd0e7e48829e8a078f0f5b3322#十五风险与应对)
16. [开发计划](https://www.qianwen.com/chat/b5403abd0e7e48829e8a078f0f5b3322#十六开发计划)
17. [商业化路径](https://www.qianwen.com/chat/b5403abd0e7e48829e8a078f0f5b3322#十七商业化路径)
18. [总结](https://www.qianwen.com/chat/b5403abd0e7e48829e8a078f0f5b3322#十八总结)

------

## 一、产品概述

### 1.1 一句话定义

> **SessionGraph 是一个项目级跨 Agent 会话记忆工具，让 AI 编程助手能够跨会话、跨工具回忆历史讨论内容，并支持团队间的知识传递与交接。**

### 1.2 核心理念

- **记忆属于项目，不属于某个 agent**
- **记忆可以传递，不随人员变动而丢失**
- 用户显式选择存储，不自动扫描全部会话
- 本地优先，零外部依赖
- 预索引 → 结构化存储 → 按需查询

### 1.3 类比

| 类比对象                        | 对应关系                                               |
| ------------------------------- | ------------------------------------------------------ |
| **Git**                         | 不管用 VSCode 还是 Vim，`git log` 看到的都是同一份历史 |
| **Gmail**                       | 标签 + 全文搜索，而非复杂图谱                          |
| **浏览器书签** → **Git**        | 从"单工具记忆"升级为"项目级基础设施"                   |
| **交接文档** → **结构化记忆包** | 从"人写文档给人看"升级为"AI 记忆直接传递"              |

------

## 二、用户需求

### 2.1 核心痛点

| #    | 痛点                         | 场景                                               |
| ---- | ---------------------------- | -------------------------------------------------- |
| 1    | AI 每次新会话都"失忆"        | 每次都要重新解释项目背景、技术决策                 |
| 2    | 历史讨论无法追溯             | "上周讨论的方案是什么来着？"                       |
| 3    | 跨工具记忆断裂               | 在 Claude 讨论的方案，切到 Zcode 后它不知道        |
| 4    | 现有方案要么全自动要么太复杂 | claude-mem 全量扫描噪音大，Obsidian 需要手动写笔记 |
| 5    | **AI 对话中的知识无法传递**  | 聊了 3 天的方案，交接时只能口头说"你去看代码吧"    |
| 6    | **决策理由丢失**             | 代码里只有"是什么"，没有"为什么这么选"             |
| 7    | **新人上手慢**               | 需要重新理解所有历史决策，问人又不好意思           |

### 2.2 关键约束与偏好

| #    | 需求                  | 说明                                   |
| ---- | --------------------- | -------------------------------------- |
| 1    | **用户显式选择存储**  | 不自动扫描全部会话，用户决定存哪些     |
| 2    | **本地优先**          | 数据存本地，零外部依赖                 |
| 3    | **类 CodeGraph 范式** | 预索引 → 结构化存储 → 按需查询         |
| 4    | **CLI 交互**          | 独立命令行工具，不依赖 AI 环境也能使用 |
| 5    | **增量同步**          | 不全量重建，只处理新增/变更的会话      |
| 6    | **MCP Server**        | AI 通过 MCP 协议按需查询               |
| 7    | **项目级隔离**        | 每个项目独立的记忆空间                 |
| 8    | **跨 Agent 共享**     | 不同 agent 共享同一份记忆              |
| 9    | **可导出/可传递**     | 记忆可以打包导出，交接给同事           |

### 2.3 参考对标

| 工具           | 参考的点                                      | 不采用的点               |
| -------------- | --------------------------------------------- | ------------------------ |
| **CodeGraph**  | 预索引 + SQLite + FTS5 + CLI + MCP + 增量同步 | 它面向代码，我们面向会话 |
| **claude-mem** | 跨会话记忆的痛点验证                          | 不要它的全自动全量扫描   |
| **Obsidian**   | 本地存储、用户掌控感                          | 不要它的手动笔记方式     |
| **Git**        | 版本化、可传递、团队协作                      | 不需要分支/合并的复杂度  |

------

## 三、市场分析与竞争格局

### 3.1 市场验证数据

| 信号                   | 数据                                                         |
| ---------------------- | ------------------------------------------------------------ |
| **claude-mem**         | GitHub 62.6k Stars，单周暴涨 9,012 星                        |
| **中国智能体记忆市场** | 2025年 14.4 亿元 → 2030年预计 642.5 亿元，CAGR 114%          |
| **全球 AI Agent 市场** | 2025年 $78.4B → 2030年 $526.2B，CAGR 46.3%                   |
| **资本入场**           | 记忆张量亿元级 Pre-A（华为哈勃投资）；红熊AI 数亿元 A+       |
| **大厂布局**           | 腾讯云 Agent Memory；阿里云记忆能力；火山引擎开源 OpenViking |

### 3.2 竞争格局图

```
                    企业级/云端
                        ↑
                        │
   腾讯云 Agent Memory  │  阿里云记忆
   红熊AI              │  记忆张量
                        │
  ←─────────────────────┼─────────────────────→
  单Agent              │              跨Agent
                        │
   claude-mem          │  ★ SessionGraph
   (62k⭐,仅Claude)    │  (跨Agent,本地,开源,可传递)
                        │
   Cursor内置记忆       │
   Windsurf内置记忆     │
                        │
                        ↓
                    开发者/本地
```

### 3.3 窗口期判断

> **6-12 个月。** 如果 2027 年初还没有建立"跨 agent 记忆 = SessionGraph"的心智，大厂或 claude-mem 的扩展版本会吃掉这个位置。

------

## 四、产品定位与差异化

### 4.1 定位

> **项目级跨 Agent 会话记忆层 + 团队知识传递管道。**
>
> 不管你用 Claude、Zcode、DSH 还是任何 AI 工具，所有讨论记忆统一存储、统一检索、跨 agent 共享。需要交接时，一键导出，同事的 AI 立刻拥有全部上下文。

### 4.2 差异化对比

| 维度         | 大厂方案   | claude-mem       | **SessionGraph**     |
| ------------ | ---------- | ---------------- | -------------------- |
| 部署         | 云端       | 本地             | **本地**             |
| 服务范围     | 企业全场景 | 仅 Claude        | **所有 Agent**       |
| 隐私         | 数据上云   | 本地             | **本地**             |
| 成本         | 付费       | 免费             | **免费**             |
| 用户         | 企业       | 个人开发者       | **个人/小团队**      |
| 开放性       | 封闭       | 开源但绑定Claude | **开源，agent无关**  |
| 用户控制     | 低         | 低（全自动）     | **高（显式选择）**   |
| **团队传递** | 无         | 无               | **✅ 导出/导入/交接** |

### 4.3 为什么不做图谱？

| 维度         | 图谱方案                   | 结构化存档方案（推荐）          |
| ------------ | -------------------------- | ------------------------------- |
| 开发周期     | 6-8 周                     | **2-3 周 MVP**                  |
| 实体提取难度 | 需提取节点 + 边 + 关系类型 | 只需提取扁平标签列表            |
| 容错性       | 关系错 → 图谱断裂          | 标签漏 → FTS 兜底，仍可用       |
| 查询复杂度   | 图遍历算法                 | SQL WHERE + FTS5 MATCH          |
| 增量同步     | 新消息可能改变已有关系     | 追加新会话即可                  |
| 用户理解成本 | "什么是节点/边/trace?"     | "搜索 + 标签过滤"（Gmail 心智） |
| 向上兼容     | 难改架构                   | ✅ 后续可叠加图谱层              |

**核心判断**：80% 的场景用"全文搜索 + 元数据过滤"即可解决。图谱的关系推理只覆盖 20% 场景，但占 80% 开发成本。

------

## 五、技术方案

### 5.1 技术选型

| 组件       | 选择                      | 理由                                     |
| ---------- | ------------------------- | ---------------------------------------- |
| 存储       | SQLite                    | 零依赖、单文件、嵌入式、百万级数据无压力 |
| 全文搜索   | FTS5                      | SQLite 内置，无需额外服务                |
| 元数据提取 | 正则 + TF-IDF             | 零 LLM 依赖，MVP 阶段够用                |
| AI 接口    | MCP (stdio)               | 标准化协议，一次实现服务所有 agent       |
| CLI 框架   | Commander.js / Cobra      | 成熟稳定                                 |
| 文件监听   | fs.watch / inotify        | 增量同步 --watch 模式                    |
| 导出格式   | 压缩包（JSON + Markdown） | 人类可读 + 机器可解析                    |
| 开发语言   | TypeScript (Node.js)      | MCP SDK 生态最好，跨平台                 |

### 5.2 为什么不用向量数据库？

| 维度     | 向量方案                | FTS5 方案（选择）    |
| -------- | ----------------------- | -------------------- |
| 依赖     | 需要嵌入模型 + 向量存储 | 零依赖               |
| 语义能力 | ✅ 语义相似搜索          | ❌ 仅关键词匹配       |
| 速度     | 需要推理时间            | 毫秒级               |
| 成本     | API 调用费用            | 零                   |
| 离线     | 需要本地模型            | 完全离线             |
| 适用场景 | 大规模、语义模糊搜索    | 精确查找、已知关键词 |

**决策**：MVP 用 FTS5，Phase 4 可选加语义增强。

------

## 六、架构设计

### 6.1 整体架构

```
┌─────────────────────────────────────────────────────────┐
│              用户选定的历史会话（多来源）                    │
│                                                         │
│  Claude Code    Zcode    DSH    Cursor    其他           │
│  (JSONL)       (专有)   (专有)  (JSON)    (custom)      │
└────────────────────────┬────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────┐
│                    Adapter 层                             │
│                                                         │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐  │
│  │ Claude   │ │ Zcode    │ │  DSH     │ │ Custom   │  │
│  │ Adapter  │ │ Adapter  │ │ Adapter  │ │ Adapter  │  │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘  │
│       └─────────────┼────────────┼─────────────┘       │
│                     ↓            ↓                      │
│              统一会话模型（Unified Session）              │
└────────────────────────┬────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────┐
│              结构化提取器（规则为主）                       │
│                                                         │
│  • 文件路径提取（正则）                                   │
│  • 代码块检测                                           │
│  • 关键词/话题提取（TF-IDF / TextRank）                  │
│  • 决策句式匹配（"决定/选择/采用/放弃"）                   │
│  • 用户手动标签（可选）                                   │
└────────────────────────┬────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────┐
│              SQLite 数据库（本地，项目级）                  │
│                                                         │
│  sessions 表    → 会话元数据 + 标签                       │
│  messages 表    → 完整原始消息                            │
│  sessions_fts   → FTS5 全文索引                         │
│  sync_state 表  → 增量同步状态（hash/mtime）             │
└────────────────────────┬────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────┐
│              双入口查询                                    │
│                                                         │
│  ┌──────────────┐          ┌──────────────────┐        │
│  │  CLI 命令     │          │  MCP Server      │        │
│  │  (人类用)     │          │  (AI Agent 用)   │        │
│  └──────────────┘          └──────────────────┘        │
│                                                         │
│  所有 agent 通过 MCP 查询同一份数据                       │
│  → 跨 Agent 记忆共享                                    │
└────────────────────────┬────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────┐
│              导出 / 导入 / 团队传递                        │
│                                                         │
│  sessiongraph export → .sessiongraph 包                  │
│  sessiongraph export --format markdown → HANDOFF.md     │
│  sessiongraph import → 导入到另一个环境                   │
│                                                         │
│  一次导出 = 一次知识传递 = 一次产品推广                    │
└─────────────────────────────────────────────────────────┘
```

### 6.2 项目目录结构

```
项目目录/
├── .sessiongraph/
│   ├── db.sqlite          ← 所有 agent 的会话统一存储
│   ├── config.json        ← 项目级配置
│   └── adapters/          ← 各 agent 的解析适配器
├── src/
├── package.json
└── ...
```

------

## 七、数据库设计

### 7.1 统一会话模型

```typescript
interface UnifiedSession {
  id: string;
  source: 'claude-code' | 'zcode' | 'dsh' | 'cursor' | 'custom';
  source_session_id: string;
  project_id: string;
  created_at: string;
  messages: UnifiedMessage[];
  
  // 自动提取的元数据
  files_mentioned: string[];
  topics: string[];
  decisions: string[];
  key_questions: string[];
  
  // 用户标签
  user_tags: string[];
  user_summary?: string;
  
  // 团队信息
  author?: string;          // 谁存的
  imported_from?: string;   // 从谁那里导入的
}

interface UnifiedMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp?: string;
}
```

### 7.2 SQLite Schema

```sql
-- ═══════════════════════════════════════════
-- 会话表
-- ═══════════════════════════════════════════
CREATE TABLE sessions (
    id            TEXT PRIMARY KEY,
    source        TEXT NOT NULL DEFAULT 'claude-code',
    source_session_id TEXT,
    project_id    TEXT NOT NULL,
    created_at    DATETIME NOT NULL,
    message_count INTEGER,
    raw_json      TEXT,
    
    -- 自动提取的元数据（JSON 数组）
    files_mentioned  TEXT,
    topics           TEXT,
    decisions        TEXT,
    code_changes     TEXT,
    key_questions    TEXT,
    
    -- 用户手动补充
    user_tags     TEXT,
    user_summary  TEXT,
    
    -- 团队/来源信息
    author        TEXT,
    imported_from TEXT,
    
    -- 增量同步
    content_hash  TEXT,
    synced_at     DATETIME
);

-- ═══════════════════════════════════════════
-- 消息表
-- ═══════════════════════════════════════════
CREATE TABLE messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL REFERENCES sessions(id),
    role        TEXT NOT NULL,
    content     TEXT NOT NULL,
    seq_num     INTEGER NOT NULL,
    created_at  DATETIME
);

-- ═══════════════════════════════════════════
-- FTS5 全文索引
-- ═══════════════════════════════════════════
CREATE VIRTUAL TABLE sessions_fts USING fts5(
    session_id,
    content,
    topics,
    decisions,
    files_mentioned,
    key_questions,
    user_tags,
    user_summary,
    content='sessions',
    content_rowid='rowid'
);

-- ═══════════════════════════════════════════
-- 增量同步状态
-- ═══════════════════════════════════════════
CREATE TABLE sync_state (
    source        TEXT NOT NULL,
    session_file  TEXT NOT NULL,
    file_hash     TEXT NOT NULL,
    last_synced   DATETIME NOT NULL,
    PRIMARY KEY (source, session_file)
);

-- ═══════════════════════════════════════════
-- 导入/导出日志
-- ═══════════════════════════════════════════
CREATE TABLE transfer_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    type        TEXT NOT NULL,  -- 'export' | 'import'
    file_path   TEXT NOT NULL,
    from_user   TEXT,
    to_user     TEXT,
    session_ids TEXT,           -- JSON 数组
    created_at  DATETIME NOT NULL
);

-- ═══════════════════════════════════════════
-- 索引
-- ═══════════════════════════════════════════
CREATE INDEX idx_sessions_project ON sessions(project_id);
CREATE INDEX idx_sessions_source ON sessions(source);
CREATE INDEX idx_sessions_created ON sessions(created_at);
CREATE INDEX idx_sessions_author ON sessions(author);
CREATE INDEX idx_messages_session ON messages(session_id);
```

------

## 八、CLI 设计

### 8.1 存储 & 索引

```bash
# 存储单个会话
sessiongraph save <session-id>

# 交互式选择多个会话
sessiongraph save --interactive

# 存储最近 N 天的会话
sessiongraph save --recent 7d

# 存储时附加手动标签
sessiongraph save <id> --tag "架构决策" --summary "讨论了PG vs MySQL"

# 指定来源
sessiongraph save <session-id> --source claude-code
sessiongraph save <session-id> --source zcode

# 自动检测来源
sessiongraph save --auto-detect
```

### 8.2 查询

```bash
# 全文搜索
sessiongraph search "数据库索引"

# 组合过滤
sessiongraph search --topic "认证" --file "auth/" --since "2026-08-01"

# 按来源过滤
sessiongraph search "数据库" --source zcode

# 跨来源查询（默认行为）
sessiongraph search "认证方案"

# 列出所有决策
sessiongraph decisions

# 按话题过滤决策
sessiongraph decisions --topic "数据库"

# 某文件的讨论历史
sessiongraph history src/db/query.ts

# 查看某个会话详情
sessiongraph show <session-id>
```

### 8.3 管理

```bash
# 列出已存储的会话
sessiongraph list

# 按来源列出
sessiongraph list --source claude-code

# 索引统计
sessiongraph status

# 移除某个会话
sessiongraph remove <session-id>

# 按标签移除
sessiongraph remove --tag "临时"
```

### 8.4 增量同步

```bash
# 一次性增量同步
sessiongraph sync

# 持续监听
sessiongraph sync --watch

# 强制全量重建
sessiongraph sync --force

# 指定多个来源
sessiongraph sync --sources claude-code,zcode,dsh
sessiongraph sync --all-sources
```

### 8.5 导出 / 导入 / 团队传递

```bash
# === 导出 ===

# 导出整个项目的记忆（完整交接包）
sessiongraph export --project my-app

# 导出特定话题相关的所有会话
sessiongraph export --topic "认证"

# 导出特定时间范围
sessiongraph export --since "2026-08-20"

# 导出特定标签
sessiongraph export --tag "架构决策"

# 导出为人类可读的 Markdown 交接文档
sessiongraph export --format markdown --output HANDOFF.md

# 导出精简摘要（只含决策和结论）
sessiongraph export --format summary --output SUMMARY.md

# 只导出决策，不导出完整对话
sessiongraph export --decisions-only

# 排除敏感信息
sessiongraph export --exclude-tag "敏感"

# 交互式选择要导出的会话
sessiongraph export --interactive

# === 导入 ===

# 导入交接包
sessiongraph import my-app-handoff.sessiongraph

# 导入时合并（不覆盖已有数据）
sessiongraph import my-app-handoff.sessiongraph --merge

# 导入时标记来源
sessiongraph import my-app-handoff.sessiongraph --from "张三"

# 导入 Markdown（只导入摘要，不含原始对话）
sessiongraph import HANDOFF.md --as-reference

# === 团队 ===

# 查看谁贡献了哪些记忆
sessiongraph team status

# 查看导入/导出历史
sessiongraph team log
```

### 8.6 MCP Server

```bash
# 启动 MCP 服务器
sessiongraph serve
```

------

## 九、MCP Tools 设计

| Tool 名称            | 描述                         | 参数                                                         |
| -------------------- | ---------------------------- | ------------------------------------------------------------ |
| `search_sessions`    | 全文搜索 + 元数据过滤        | `query`, `topic?`, `file?`, `tag?`, `source?`, `since?`, `limit?` |
| `get_session_detail` | 获取会话完整消息或指定片段   | `session_id`, `start_msg?`, `end_msg?`                       |
| `list_sessions`      | 列出已存会话（带过滤）       | `topic?`, `file?`, `tag?`, `source?`, `since?`, `limit?`     |
| `get_decisions`      | 获取所有/过滤后的决策        | `topic?`, `session_id?`, `source?`                           |
| `get_file_history`   | 某文件在所有会话中的讨论记录 | `file_path`                                                  |
| `get_unresolved`     | 获取未解决的问题/待办        | `topic?`, `session_id?`                                      |
| `get_stats`          | 索引统计信息                 | 无                                                           |

**默认行为**：查所有 agent 的会话。`source` 参数为可选过滤。

------

## 十、跨 Agent 共享设计

### 10.1 核心原理

```
┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐
│  Claude   │  │  Zcode   │  │   DSH    │  │  Cursor  │
│  Code     │  │          │  │          │  │          │
└─────┬─────┘  └─────┬────┘  └────┬─────┘  └────┬─────┘
      │              │             │              │
      │         MCP Protocol (stdio)             │
      │              │             │              │
      └──────────────┼─────────────┼──────────────┘
                     ↓             ↓
        ┌────────────────────────────────────┐
        │       SessionGraph MCP Server      │
        │                                    │
        │    search_sessions()               │
        │    get_decisions()                 │
        │    get_file_history()              │
        │    ...                             │
        └───────────────┬────────────────────┘
                        ↓
        ┌────────────────────────────────────┐
        │    SQLite（项目级，统一存储）         │
        │    所有 agent 的会话在这里           │
        └────────────────────────────────────┘
```

### 10.2 为什么天然可行

- MCP Server 不关心调用者是谁
- 记忆绑定在**项目目录**上，不绑定在任何 agent 上
- 一个 MCP Server 服务所有 agent，零额外成本

### 10.3 Adapter 层

```
┌─────────────────────────────────────────────────────┐
│                   Adapter 层                         │
│                                                     │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐  │
│  │ Claude Code  │ │   Zcode     │ │    DSH      │  │
│  │ Adapter     │ │   Adapter   │ │   Adapter   │  │
│  │ JSONL解析   │ │ 专有格式解析 │ │ 专有格式解析 │  │
│  └──────┬──────┘ └──────┬──────┘ └──────┬──────┘  │
│         └───────────────┼───────────────┘         │
│                         ↓                         │
│              统一会话模型（Unified Session）         │
└─────────────────────────────────────────────────────┘
```

### 10.4 使用场景示例

**场景 1：跨 agent 继续工作**

```
上午：用 Claude Code 讨论了数据库架构，决定了用 PostgreSQL + 分区表
下午：切到 Zcode 写实现代码

Zcode 中：
  用户："帮我实现之前讨论的数据库方案"
  Zcode → MCP → sessiongraph.search_sessions("数据库方案")
  → 找到上午在 Claude Code 中的讨论
  → 返回决策："PostgreSQL + 按月分区，索引策略是..."
  → Zcode 直接基于这个决策写代码
```

**场景 2：跨 agent 追溯决策**

```
用户（在 DSH 中）："这个认证模块为什么用 JWT？"

DSH → MCP → sessiongraph.get_decisions(topic="认证")
→ 返回：
  [2026-08-20, Claude Code] 决策：放弃 Session，改用 JWT
  [2026-08-22, Zcode] 决策：JWT 用 RS256 签名
  
→ DSH 完整回答，包含不同 agent 中的讨论历史
```

------

## 十一、元数据提取策略

| 元数据类型          | 提取方式                               | 难度 | 需要 LLM？ |
| ------------------- | -------------------------------------- | ---- | ---------- |
| `files_mentioned`   | 正则匹配文件路径模式                   | ⭐    | ❌          |
| `code_changes`      | 检测代码块 + 上下文关键词              | ⭐⭐   | ❌          |
| `topics`            | TF-IDF / TextRank 关键词提取           | ⭐⭐   | ❌          |
| `decisions`         | 模式匹配："决定/选择/采用/放弃/最终用" | ⭐⭐   | ❌          |
| `key_questions`     | 问号句提取 + 简单分类                  | ⭐    | ❌          |
| `user_tags/summary` | 用户 CLI 输入                          | ⭐    | ❌          |

**MVP 全程零 LLM 依赖。** 后续可选加 AI 增强提取作为 `--ai` flag。

------

## 十二、增量同步机制

```
┌─────────────────────────────────────────┐
│  sessiongraph sync                       │
│                                         │
│  1. 扫描会话源目录（按 adapter 配置）     │
│  2. 对每个文件计算 hash                   │
│  3. 对比 sync_state 表                   │
│     ├─ 新文件 → 解析 + 入库              │
│     ├─ hash 变化 → 重新解析 + 更新       │
│     └─ hash 不变 → 跳过                  │
│  4. 源文件已删除 → 标记/清理              │
│  5. 更新 sync_state                      │
└─────────────────────────────────────────┘

--watch 模式：
  使用文件系统监听（fs.watch / inotify）
  检测到变更 → 触发单文件增量同步
```

------

## 十三、团队协作与知识传递

### 13.1 核心场景

```
你：和 AI 聊了 3 天，讨论了 20+ 个会话
    - 数据库选型（决定了 PostgreSQL）
    - 认证方案（JWT vs Session，最终选 JWT）
    - API 设计（REST vs GraphQL，讨论了 3 轮）
    - 部署方案（K8s vs ECS）
    - 各种 bug 排查过程

现在：你要去干别的项目，需要把这块交给同事小王

传统做法：
  ❌ 写个文档？→ 你根本没时间写，写了也丢 80% 上下文
  ❌ 口头交接？→ "你去看代码吧"，小王一脸懵
  ❌ 录屏？→ 20 个会话录完要 2 小时，没人看

用 SessionGraph：
  ✅ sessiongraph export --project my-app
  → 生成一个完整的交接包
  → 小王导入后，他的 AI 助手立刻知道所有历史
```

### 13.2 为什么这个功能是杀手级的

| 痛点                    | 严重程度 | 现状                               |
| ----------------------- | -------- | ---------------------------------- |
| AI 对话中的知识无法传递 | 🔴 极高   | 完全无解，只能重新聊               |
| 交接成本高              | 🔴 极高   | 写文档/口头/录屏，都丢失大量上下文 |
| 新同事上手慢            | 🟡 高     | 需要重新理解所有历史决策           |
| 决策理由丢失            | 🔴 极高   | 代码里只有"是什么"，没有"为什么"   |

**为什么只有 SessionGraph 能做**：

```
传统交接：人 → 文档 → 人（信息损失 80%）
SessionGraph：人+AI → 结构化记忆 → 人+AI（信息损失 < 5%）

关键：记忆已经是结构化的（决策、话题、文件、时间线），
     导出 = 序列化，导入 = 反序列化。
     不需要重新整理。
```

### 13.3 导出格式设计

```
.sessiongraph 文件格式（本质是一个压缩包）：

my-app-handoff.sessiongraph
├── manifest.json          ← 元信息
├── sessions/
│   ├── session-001.json   ← 每个会话的完整数据
│   ├── session-002.json
│   └── ...
├── metadata/
│   ├── decisions.json     ← 所有决策
│   ├── topics.json        ← 话题索引
│   └── files.json         ← 文件关联
└── summary/
    ├── HANDOFF.md         ← 人类可读摘要（自动生成）
    └── timeline.md        ← 时间线
```

### 13.4 manifest.json

```json
{
  "version": "1.0",
  "format": "sessiongraph-export",
  "exported_at": "2026-08-27T15:40:00+08:00",
  "exported_by": "zhangsan",
  "project_id": "my-app",
  "session_count": 23,
  "sources": ["claude-code", "zcode", "dsh"],
  "date_range": {
    "start": "2026-08-20",
    "end": "2026-08-27"
  },
  "includes": {
    "full_messages": true,
    "decisions": true,
    "topics": true,
    "file_history": true
  },
  "import_instructions": "sessiongraph import my-app-handoff.sessiongraph"
}
```

### 13.5 自动生成交接文档

`sessiongraph export --format markdown` 生成：

```markdown
# 项目交接文档 - my-app
> 自动生成于 2026-08-27，包含 23 个会话记录

## 📋 关键决策

| 日期 | 决策 | 原因 | 来源 |
|------|------|------|------|
| 08-20 | 数据库选 PostgreSQL | MySQL 分区表支持不够 | Claude Code |
| 08-21 | 认证用 JWT RS256 | 微服务间无法共享 Session | Zcode |
| 08-22 | API 用 REST 不用 GraphQL | 团队不熟悉，学习成本高 | Claude Code |
| 08-23 | 部署用 ECS 不用 K8s | 项目规模小，运维成本太高 | DSH |

## 📁 涉及文件

- `src/db/schema.sql` - 数据库建表（讨论 3 次）
- `src/auth/jwt.ts` - JWT 实现（讨论 5 次）
- `src/api/routes/` - API 路由设计（讨论 4 次）
- `deploy/docker-compose.yml` - 部署配置（讨论 2 次）

## ❓ 未解决的问题

- [ ] JWT token 刷新策略还没定（08-22 讨论过但没结论）
- [ ] 数据库连接池大小需要压测后确定
- [ ] 是否需要 rate limiting

## 📖 详细讨论记录

### 会话 1：数据库选型（08-20，Claude Code）
**摘要**：讨论了 MySQL vs PostgreSQL，最终选择 PG...
**关键消息**：
> 用户：我们的数据量预计每月增长 500 万条，需要按月分区...
> AI：PostgreSQL 的原生分区表支持更好，建议...

### 会话 2：认证方案（08-21，Zcode）
...
```

### 13.6 团队场景矩阵

| 场景                 | 操作                                  | 价值     |
| -------------------- | ------------------------------------- | -------- |
| **个人交接**         | 你要走了，导出给接手的人              | 核心场景 |
| **新人入职**         | 导入项目历史，新人的 AI 立刻有上下文  | 高价值   |
| **跨团队协作**       | 前端导出 API 相关讨论给后端           | 中价值   |
| **项目复盘**         | 导出所有决策，回顾"为什么这么做"      | 中价值   |
| **知识沉淀**         | 定期导出，形成项目知识库              | 长期价值 |
| **Code Review 辅助** | 导出某文件相关讨论，reviewer 知道背景 | 中价值   |

### 13.7 新人入职场景

```
小王入职，接手 my-app 项目：

1. 张三：sessiongraph export --project my-app
2. 发给小王：my-app-handoff.sessiongraph
3. 小王：sessiongraph import my-app-handoff.sessiongraph
4. 小王打开 Claude Code / Zcode / 任何 agent：
   
   小王："这个项目的数据库为什么用 PostgreSQL？"
   AI → MCP → sessiongraph → 找到 08-20 的讨论
   AI："根据 08-20 在 Claude Code 中的讨论，选择 PostgreSQL 
       是因为 MySQL 分区表支持不够，你们的数据量预计每月
       增长 500 万条，需要按月分区..."
   
   小王："JWT 的刷新策略定了吗？"
   AI："08-22 讨论过但还没最终确定，当时有两个方案..."
```

**小王不需要问任何人，AI 直接知道所有历史。**

### 13.8 自然病毒传播

```
张三导出 → 小王导入 → 小王觉得好用 → 小王也在自己的项目用
                                    → 小王推荐给小李
                                    → 团队所有人都用

一次交接 = 一次产品推广
```

### 13.9 对产品定位的影响

```
之前：个人开发者的跨 Agent 记忆工具
现在：个人 + 团队的跨 Agent 项目知识管理层

新增维度：
  个人记忆 → 团队知识资产
  单次使用 → 持续积累
  工具 → 基础设施
```

| 维度     | 之前               | 加上导出/交接后       |
| -------- | ------------------ | --------------------- |
| 用户锁定 | 个人使用，随时可弃 | 团队依赖，迁移成本高  |
| 数据价值 | 个人记忆           | 团队知识资产          |
| 传播方式 | 一人一人推         | 一人导出 → 全团队导入 |
| 商业化   | 难（个人工具）     | 有路径（团队版）      |

------

## 十四、优缺点分析

### 14.1 优点

#### 产品层面

| 优点           | 说明                                         |
| -------------- | -------------------------------------------- |
| **品类空白**   | "跨 agent 本地记忆"目前零竞品                |
| **用户掌控感** | 显式选择存什么，开发者喜欢"我知道它存了什么" |
| **本地隐私**   | 数据不上云，天然吸引力                       |
| **零依赖**     | SQLite 内置，一行安装即用                    |
| **agent 无关** | 换工具不丢记忆                               |
| **可传递**     | 记忆可以导出/导入，团队交接零成本            |

#### 技术层面

| 优点             | 说明                             |
| ---------------- | -------------------------------- |
| **架构简单**     | SQLite + FTS5 + 正则，没有黑科技 |
| **容错性高**     | 元数据提取错了，全文搜索兜底     |
| **增量同步轻量** | 文件 hash 对比，秒级完成         |
| **MCP 一次搞定** | 一个 Server 服务所有 agent       |
| **向上兼容**     | 未来可叠加图谱层                 |
| **导出即序列化** | 结构化数据天然支持导出/导入      |

#### 市场层面

| 优点           | 说明                               |
| -------------- | ---------------------------------- |
| **需求已验证** | claude-mem 62k 星                  |
| **传播成本低** | 开源 + 话题性                      |
| **时机对**     | 赛道刚起步                         |
| **网络效应**   | agent 越多 → 记忆越丰富 → 越离不开 |
| **病毒传播**   | 每次交接 = 一次推广                |

### 14.2 缺点

#### 产品层面

| 缺点                 | 严重程度 | 说明                      |
| -------------------- | -------- | ------------------------- |
| **需要用户主动操作** | 🔴 高     | 反人性，大多数人懒        |
| **冷启动体验差**     | 🔴 高     | 空数据库 = "这工具没用"   |
| **价值感知延迟**     | 🟡 中     | 需要 20-50 个会话后才明显 |
| **用户教育成本**     | 🟡 中     | 新概念需要解释            |

#### 技术层面

| 缺点                   | 严重程度 | 说明                          |
| ---------------------- | -------- | ----------------------------- |
| **元数据提取质量有限** | 🟡 中     | 正则准确率约 60-70%           |
| **无语义理解**         | 🟡 中     | "性能优化"搜不到"查询慢"      |
| **adapter 维护负担**   | 🟡 中     | 新 agent 出现就要写新 adapter |
| **会话格式不稳定**     | 🟡 中     | agent 可能随时改格式          |

#### 市场层面

| 缺点                    | 严重程度 | 说明                            |
| ----------------------- | -------- | ------------------------------- |
| **大厂可能直接做**      | 🔴 高     | 腾讯云/阿里云/火山引擎都在布局  |
| **Agent 官方可能内置**  | 🔴 高     | Claude 已有 6 层上下文架构      |
| **claude-mem 可能扩展** | 🟡 中     | 62k 星社区，加多 agent 支持不难 |
| **上下文窗口增长**      | 🟡 中     | 长期可能降低外部记忆必要性      |
| **护城河浅**            | 🟡 中     | 技术门槛不高，复制成本低        |

### 14.3 核心矛盾与缓解

| 矛盾                   | 缓解方案                                              |
| ---------------------- | ----------------------------------------------------- |
| 手动存储 vs 用户懒惰   | `save --recent 7d` 批量导入；会话结束提示             |
| 简单搜索 vs 深度理解   | Phase 4 加 `--ai` flag 或本地嵌入模型                 |
| 开源传播 vs 商业可持续 | 核心开源 + 团队版/云同步付费                          |
| 隐私保护 vs 团队共享   | `--exclude-tag` 排除敏感；`--decisions-only` 精简导出 |

------

## 十五、风险与应对

| 风险             | 影响               | 应对                                                |
| ---------------- | ------------------ | --------------------------------------------------- |
| 用户不愿主动存储 | 工具无人用         | 极低操作成本 + 批量导入 + 会话结束提示              |
| 元数据提取不准   | 过滤结果差         | FTS5 全文搜索兜底 + 用户手动补充                    |
| 会话格式变更     | 解析失败           | 模块化 adapter，按版本适配                          |
| 大厂/官方内置    | 第三方工具失去价值 | 速度 + 本地化/隐私叙事 + 跨 agent 差异化 + 团队传递 |
| 后续想加图谱     | 架构不兼容         | 元数据标签天然是图谱节点，可平滑升级                |
| 会话量太大       | 性能下降           | SQLite FTS5 百万级无压力 + 分页查询                 |
| 导出包含敏感信息 | 隐私泄露           | `--exclude-tag` + `--decisions-only` + 交互式选择   |
| 团队导入冲突     | 数据覆盖           | `--merge` 模式，不覆盖已有数据                      |

------

## 十六、开发计划

### Phase 1：核心存储 + 搜索（Week 1-2）

**目标**：验证"用户是否愿意主动存储会话"

| 任务                                     | 交付物                 |
| ---------------------------------------- | ---------------------- |
| 会话解析器（Claude Code JSONL）          | 读取 + 解析会话文件    |
| SQLite 存储层                            | sessions + messages 表 |
| FTS5 全文索引                            | 基本搜索能力           |
| CLI: `save` / `search` / `list` / `show` | 最小可用命令           |
| 增量同步基础                             | `sync` 命令            |

**验证标准**：用户存入 5+ 个会话后，搜索能找到想要的内容。

------

### Phase 2：智能元数据（Week 3）

**目标**：验证"结构化过滤是否比纯搜索有显著增益"

| 任务                                    | 交付物                |
| --------------------------------------- | --------------------- |
| 文件路径自动提取                        | `files_mentioned`     |
| 话题关键词提取（TF-IDF）                | `topics`              |
| 决策句式匹配                            | `decisions`           |
| CLI: `decisions` / `history` / 组合过滤 | 元数据查询命令        |
| 用户标签 & 摘要                         | `--tag` / `--summary` |

**验证标准**：`sessiongraph history src/db/query.ts` 能返回该文件所有相关讨论。

------

### Phase 3：MCP + 跨 Agent + 增量同步（Week 4）

**目标**：AI 可以按需查询，跨 agent 共享生效

| 任务                      | 交付物                 |
| ------------------------- | ---------------------- |
| MCP Server（stdio）       | AI 可调用的 7 个 Tools |
| Adapter 层（Zcode / DSH） | 多源解析               |
| `--watch` 增量同步        | 后台自动同步           |
| CLI: `serve`              | 启动 MCP 服务          |
| 项目级隔离                | 不同项目独立数据库     |

**验证标准**：在 Claude Code 中提问"之前讨论过数据库方案吗？"，AI 通过 MCP 找到答案。在 Zcode 中也能查到同一个结果。

------

### Phase 3.5：导出 / 导入 / 团队传递（Week 5）🆕

**目标**：验证"交接场景是否成立，团队是否愿意用"

| 任务                         | 交付物                               |
| ---------------------------- | ------------------------------------ |
| 导出为 `.sessiongraph` 包    | `sessiongraph export`                |
| 导入 `.sessiongraph` 包      | `sessiongraph import`                |
| 自动生成 Markdown 交接文档   | `export --format markdown`           |
| 精简摘要导出                 | `export --format summary`            |
| 选择性导出（标签/话题/时间） | `--tag` / `--topic` / `--since`      |
| 隐私控制                     | `--exclude-tag` / `--decisions-only` |
| 导入合并                     | `import --merge`                     |
| 来源标记                     | `import --from "张三"`               |
| 团队日志                     | `team status` / `team log`           |

**验证标准**：

- 张三导出 → 小王导入 → 小王的 AI 能回答"数据库为什么选 PG"
- 生成的 HANDOFF.md 人类可直接阅读，不需要额外解释

------

### Phase 4：增强（Week 6+，视反馈）

| 方向           | 说明                                   |
| -------------- | -------------------------------------- |
| 多源支持       | 更多 agent 的 adapter                  |
| AI 辅助提取    | `--ai` flag，用 LLM 提升元数据质量     |
| 语义搜索       | 本地嵌入模型，可选增强                 |
| 图谱层叠加     | 在元数据基础上构建轻量关系边           |
| 导出为其他格式 | Obsidian 笔记、Notion、Confluence      |
| 团队共享       | 共享数据库 + 权限管理 + 云同步（可选） |
| 自动交接文档   | 定时生成周报/月报形式的项目知识总结    |

------

## 十七、商业化路径

### 17.1 最可能的成功路径

```
Phase 1: 开源 → GitHub 传播 → 开发者社区口碑
         （目标：6个月内 5k+ stars）

Phase 2: 成为"跨 agent 记忆"的品类代名词
         （目标：被博客/教程引用为解决方案）

Phase 3: 团队版 → 商业化
         （目标：团队交接场景验证后，推出付费团队版）
```

### 17.2 变现模式

| 模式                  | 说明                       | 可行性 |
| --------------------- | -------------------------- | ------ |
| 纯开源攒声望          | 个人品牌 + 影响力          | ⭐⭐⭐⭐   |
| 开源核心 + 团队版付费 | 团队协作、权限管理、云同步 | ⭐⭐⭐⭐   |
| 企业版                | 审计、合规、SSO            | ⭐⭐⭐    |
| 被收购/整合           | 大厂想做跨 agent 记忆      | ⭐⭐     |
| 做成标准/协议         | 定义"跨 agent 记忆协议"    | ⭐⭐⭐    |

### 17.3 团队版的付费点

| 免费（开源） | 付费（团队版）                 |
| ------------ | ------------------------------ |
| 个人使用     | 团队共享记忆库                 |
| 本地存储     | 可选云同步（加密）             |
| 导出/导入    | 权限管理（谁能看什么）         |
| 基本搜索     | 高级分析（决策趋势、知识图谱） |
| 单项目       | 多项目统一管理                 |
| 无           | 审计日志                       |
| 无           | 自动交接文档（定时生成）       |

------

## 十八、总结

### 一句话

> **SessionGraph = 本地会话仓库 + 自动标签 + 全文搜索 + MCP 接口 + 增量同步 + 跨 Agent 共享 + 团队知识传递。**
>
> 不是图谱，是**带结构化标签的跨 Agent 会话搜索引擎 + 团队交接管道**。先跑通个人价值，再扩展到团队，最后按需叠加复杂度。

### 产品价值公式

```
个人价值 = 跨会话记忆 × 跨 Agent 共享
团队价值 = 个人价值 × 可传递性 × 可复用性
商业价值 = 团队价值 × 用户数 × 粘性
```

### 评分卡

| 维度           | 评分      | 说明                                      |
| -------------- | --------- | ----------------------------------------- |
| 市场需求真实性 | ⭐⭐⭐⭐⭐     | claude-mem 62k 星 + 记忆赛道 642 亿已验证 |
| 差异化         | ⭐⭐⭐⭐⭐     | "跨 agent + 本地 + 可传递"目前无人做      |
| 技术可行性     | ⭐⭐⭐⭐⭐     | SQLite + FTS5 + MCP，无黑科技             |
| 竞争压力       | ⭐⭐⭐       | 大厂和 claude-mem 是潜在威胁              |
| 用户获取难度   | ⭐⭐⭐⭐      | 交接场景自带传播                          |
| 商业化空间     | ⭐⭐⭐⭐      | 团队版有清晰付费点                        |
| 时机           | ⭐⭐⭐⭐      | 赛道刚起步，窗口期 6-12 月                |
| **综合**       | **⭐⭐⭐⭐½** | **值得做，要快，团队功能是差异化壁垒**    |

### 关键行动建议

1. **快**。6-12 个月窗口期，MVP 2-3 周必须出来
2. **卡位**。抢占"跨 agent 记忆"这个品类词
3. **别贪**。先做好"存 + 搜 + 跨 agent 查"
4. **团队是壁垒**。导出/交接是别人抄不走的场景（需要数据积累）
5. **传播**。写一篇"我在 5 个 AI 工具之间共享记忆"的博文
6. **观察**。密切关注 claude-mem 是否扩展、大厂是否出开发者版本

### 核心叙事

> **"你和 AI 聊了 3 天的方案，不应该随着你关掉终端就消失。**
> **它应该属于项目，属于团队，属于下一个接手的人。"**

