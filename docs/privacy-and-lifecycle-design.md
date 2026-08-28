# 隐私与数据生命周期 — 完整设计文档 v1.0

> **日期**：2026-08-28
> **状态**：定稿，待实施
> **来源**：三轮归档方案评审 + 用户追问 purge/ignore 价值后的完整推演
> **核心认知**：隐私不是单一功能，是三层防线；归档不只是释放空间，是隐私出口

---

## 一、推演过程（我们怎么得出这个设计的）

### 第一步：用户提出需要"清理"

> 用户："我们是不是应该有一个自动清理的功能，比如过期数据清理"

最初的理解：这是一个**存储管理**问题——数据库会膨胀，需要释放空间。

### 第二步：设计了 cleanup → 发现品牌矛盾

初版方案叫 `cleanup`（清理），直接删除旧数据。但产品经理视角发现：

> "我们的品牌承诺是 'Memory is always complete'，而 cleanup 的字面意思是删除记忆——直接矛盾。"

**修正**：改名为 `archive`（归档），默认模式从"删除"改为"保留骨架、释放正文"。

### 第三步：三轮评审 → 发现架构问题

架构师视角发现：
- 长时间 cleanup 会阻塞 sync（需要批量 + 锁释放）
- 归档后新消息到达需要"复活"逻辑
- 实际空间回收率是 99.4% 不是 85%

### 第四步：用户追问 "purge 和 remove 什么意思"

检查发现：`remove` 从未实现过（设计文档写错了），`purge --pending` 存在但很少用。

进一步追问：**为什么需要 purge？**

### 第五步：用户追问 "我们为什么要 purge"

推演发现 purge 解决的唯一场景是"在 6 小时冷却窗口内手动干预状态机"——极窄的边界情况。

用户真正需要的是：
- 不想捕获 → `.sessionrelayignore` / `mode off`（预防）
- 想删已入库的 → archive（事后处理）
- purge 是一个不必要的中间状态干预

**结论：删掉 purge，不合并进 archive。**

### 第六步：用户追问 ".sessionrelayignore 谁用，怎么用"

诚实评估发现：
- `.sessionrelayignore` 是一个"存在但没人用"的功能
- 它需要**预判**哪些会话敏感——但敏感对话往往是聊完才意识到
- 它是预防性工具，但用户更需要**事后删除**

**最终认知**：隐私不是单一功能，是三层防线。archive 不只是释放空间，它是隐私体系的核心出口。

---

## 二、三层隐私模型

```
┌─────────────────────────────────────────────────────────────┐
│                    用户与 AI 的对话                            │
│                                                             │
│  "上周我们讨论了薪资调整方案..."                                │
│  "这个客户的数据库密码是 xxx..."                               │
│  "我不同意这个技术选型，因为..."                                │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│  第一层：预防（不让敏感数据进来）                               │
│                                                             │
│  ┌─────────────────┐  ┌──────────────────┐  ┌────────────┐ │
│  │ .sessionrelay   │  │ mode off         │  │ mode meta  │ │
│  │   ignore        │  │ (关闭自动捕获)      │  │ (只存元数据) │ │
│  │                 │  │                  │  │            │ │
│  │ source:trae    │  │ 手动 save 是      │  │ 标题/话题   │ │
│  │ title:薪资     │  │ 唯一入口          │  │ 可搜，正文  │ │
│  │ *.secret.jsonl │  │                  │  │ 不入库      │ │
│  └─────────────────┘  └──────────────────┘  └────────────┘ │
│                                                             │
│  适合：提前知道哪些内容敏感                                     │
│  局限：需要预判，发现性差                                      │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  第二层：归档（已入库，释放空间，保留骨架）                       │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ srelay archive --days 90                             │   │
│  │                                                     │   │
│  │ 保留：决策 · 话题 · 摘要 · 标题 · 文件关联              │   │
│  │ 移除：对话正文 · 全文索引                              │   │
│  │                                                     │   │
│  │ 空间回收：99.4%                                      │   │
│  │ 可恢复：srelay rebuild --force                        │   │
│  │ 有审计：cleanup_log + cleanup_detail                 │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  适合：释放空间，降噪，旧数据管理                                │
│  局限：决策元数据仍保留（如果决策本身敏感，需要第三层）             │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  第三层：删除（彻底抹掉，不可恢复）                              │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ srelay archive --sessions abc123 --hard              │   │
│  │ srelay archive --topic "薪资" --hard                 │   │
│  │                                                     │   │
│  │ 删除：sessions 行 + messages + FTS + decisions        │   │
│  │ 不可恢复（除非源文件还在 + rebuild --force）            │   │
│  │ 有审计：cleanup_log 记录                              │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  适合：隐私删除，合规要求，真正要抹掉的数据                        │
│  局限：如果源文件还在，rebuild 会恢复                            │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 三层的对比

| 维度 | 第一层：预防 | 第二层：归档 | 第三层：删除 |
|------|-------------|-------------|-------------|
| 时机 | 捕获前 | 入库后 | 入库后 |
| 数据状态 | 根本不进库 | 骨架在，正文不在 | 彻底消失 |
| 可恢复 | — | rebuild --force | rebuild --force（需源文件） |
| 决策保留 | —（没入库） | ✅ 保留 | ❌ 删除 |
| 审计日志 | ❌ 无 | ✅ cleanup_log | ✅ cleanup_log |
| 空间回收 | 100%（没占过） | 99.4% | 100% |
| 用户操作 | 编辑 ignore 文件 | CLI 命令 | CLI 命令（--hard） |
| 适用场景 | 提前知道敏感 | 释放空间/降噪 | 隐私删除/合规 |

---

## 三、归档功能的完整设计

### 3.1 数据模型

```sql
-- 会话表增加归档字段
ALTER TABLE sessions ADD COLUMN cleanup_at TEXT;
-- NULL = 未归档（hot 层）
-- 非 NULL = 已归档时间（warm 层）

ALTER TABLE sessions ADD COLUMN original_message_count INTEGER DEFAULT 0;
-- 归档前的消息数（归档后 message_count 归零，此字段保留原始值）

-- 归档操作日志（每次 archive 命令一条）
CREATE TABLE cleanup_log (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    triggered_by      TEXT NOT NULL,      -- 'manual' | 'auto' | 'mcp'
    mode              TEXT NOT NULL,      -- 'archive' | 'hard'
    criteria          TEXT NOT NULL,      -- 触发条件 JSON
    sessions_affected INTEGER NOT NULL,   -- 归档了几个
    sessions_skipped  INTEGER NOT NULL,   -- 跳过了几个
    bytes_freed       INTEGER NOT NULL,   -- 逻辑释放字节数
    created_at        TEXT NOT NULL
);

-- 归档明细（每个被归档的会话一条）
CREATE TABLE cleanup_detail (
    cleanup_log_id INTEGER NOT NULL REFERENCES cleanup_log(id) ON DELETE CASCADE,
    session_id     TEXT NOT NULL,
    title          TEXT,              -- 归档时的标题快照
    source         TEXT NOT NULL,     -- 来源 agent
    message_count  INTEGER NOT NULL,  -- 归档前消息数
    decision_count INTEGER NOT NULL,  -- 保留的决策数
    created_at     TEXT NOT NULL
);
CREATE INDEX idx_cleanup_detail_log ON cleanup_detail(cleanup_log_id);
CREATE INDEX idx_cleanup_detail_session ON cleanup_detail(session_id);
```

### 3.2 CLI 命令

```bash
# 预览（不实际执行）
srelay archive --days 90 --dry-run

# 归档（默认：保留决策，删除正文）
srelay archive --days 90

# 硬删除（彻底删除，包括决策）
srelay archive --days 90 --hard

# 按体积归档
srelay archive --size 500mb

# 按来源归档
srelay archive --days 90 --source zcode

# 归档指定会话
srelay archive --sessions abc123,def456

# 查看归档历史
srelay archive --history

# 查看归档历史（详细，含逐会话明细）
srelay archive --history --verbose

# 查看某个会话的归档记录
srelay archive --history --session abc123
```

### 3.3 参数表

| 参数 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `--days <N>` | number | — | 归档 N 天前的会话 |
| `--before <date>` | string | — | 归档指定日期前的 |
| `--size <N>mb` | string | — | DB 超过此值时归档 |
| `--source <id>` | string | 全部 | 只归档此来源 |
| `--sessions <ids>` | string | — | 归档指定会话（逗号分隔） |
| `--hard` | boolean | false | 硬删除（含决策） |
| `--dry-run` | boolean | false | 只预览不执行 |
| `--history` | boolean | false | 查看归档历史 |
| `--verbose` | boolean | false | 历史详细模式 |
| `--session <id>` | string | — | 查看指定会话的归档记录 |
| `--json` | boolean | false | JSON 输出 |

### 3.4 保护规则

| 规则 | 原因 |
|------|------|
| `state = 'active'` | 正在进行的对话 |
| `origin = 'imported'` | 源文件不在本机，删了不可恢复 |
| `origin = 'note'` | 体积小，不值得归档 |
| `user_tags` 含 `"保留"` | 用户显式标记为重要 |

### 3.5 批量处理

```
batch 1: 会话 1-50    → 获取写锁 → 执行 → 释放写锁   ~200ms
batch 2: 会话 51-100  → 获取写锁 → 执行 → 释放写锁   ~200ms
...
（每批之间释放锁，sync 可正常插入执行）
```

### 3.6 会话复活

```
归档（cleanup_at = T1）
  → 用户继续在该会话中聊天
  → sync 发现新消息
  → 检测到 cleanup_at 非空
  → UPDATE sessions SET cleanup_at = NULL  ← 复活
  → 新消息正常写入
  → 会话回到 hot 层
```

### 3.7 rebuild 交互

```
srelay rebuild（正常）
  → 跳过 cleanup_at 非空的会话
  → 归档效果在 rebuild 后持续

srelay rebuild --force
  → 忽略 cleanup_at
  → 归档的数据被恢复（用户明确要求）
```

### 3.8 搜索中的归档标注

```
$ srelay search "数据库"
1. 数据库选型讨论    zcode · 08-20 · 📦已归档
   [已归档] 决策：采用 PostgreSQL（决策保留，正文已归档）

$ srelay list
08-20  zcode  📦已归档  「数据库选型讨论」  abc123 · 0msg（原230）
```

### 3.9 删除 purge 命令

`purge --pending` 被移除，不合并进 archive。理由：
- 解决的场景极窄（6 小时冷却窗口内手动干预）
- 用户真正需要的是 ignore（预防）或 archive（事后处理）
- 减少一个命令 = 减少一个用户需要理解的概念

---

## 四、实施计划

| # | 任务 | 说明 | 优先级 |
|---|------|------|--------|
| 1 | Schema 迁移 M2 | cleanup_at + original_message_count + cleanup_log + cleanup_detail | 🔴 |
| 2 | `runArchive()` | 核心归档逻辑（条件/保护/批量/审计） | 🔴 |
| 3 | CLI `srelay archive` | 归档 + 硬删 + dry-run + 交互确认 | 🔴 |
| 4 | CLI `srelay archive --history` | 查看归档历史（简要/详细/单会话） | 🟡 |
| 5 | sync 会话复活 | 归档后有新消息自动恢复 | 🔴 |
| 6 | rebuild 跳过 cleanup_at | 归档效果持续 | 🔴 |
| 7 | 搜索/列表归档标注 | 📦已归档 + snippet 降级 | 🟡 |
| 8 | 移除 purge 命令 | 从 CLI 和测试中清除 | 🟡 |
| 9 | 测试 | 单元 + 集成 + 端到端 | 🔴 |

---

## 五、设计原则（从推演中提炼）

1. **预防优于治疗**——ignore 比删除好，不进来比删出去好
2. **知识骨架优先保留**——决策/话题/摘要体积小价值高，尽量不删
3. **操作必须有审计**——每一次归档/删除都记录在 cleanup_log
4. **用户心理：归档 ≠ 删除**——命名和文案体现"收纳"而非"销毁"
5. **不过度设计**——purge 这种"看起来有用但实际没人用"的功能，不加
