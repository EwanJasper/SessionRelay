# 数据归档机制 — 最终设计方案 v0.2

> **日期**：2026-08-28（三轮评审后）
> **状态**：待用户确认后实施
> **评审轮次**：产品经理 / 架构师 / 软件设计师 三轮
> **核心变更**（vs v0.1）：cleanup 改名 archive；自动清理推到 Phase 4；purge/remove 合并进 archive；补充批量处理/会话复活/配置校验

---

## 一、我们要解决什么问题

**一句话**：长期使用后数据库膨胀，需要一种安全释放空间的方式。

### 数据增长模型

```
每个会话的存储构成（典型 200 条消息）：

┌──────────────────────────────────────────────────────┐
│ messages.content        400KB  ██████████████  36%    │ ← 对话原文
│ messages.search_text    300KB  ███████████     27%    │ ← 分词后文本
│ messages_fts 索引        390KB  █████████████   36%    │ ← 全文索引
│──────────────────────────────────────────────────────│
│ 消息相关小计           1,090KB  ████████████████████ 99.4%│
│ sessions 行（元数据）       5KB  ▏                 0.5%│ ← 标题/话题/决策/摘要
│ sessions_fts 索引           2KB  ▏                 0.2%│ ← 元数据索引
│──────────────────────────────────────────────────────│
│ 总计                   1,097KB                             │
└──────────────────────────────────────────────────────┘
```

**关键发现**：99.4% 的存储被消息正文占据，元数据只占 0.6%。这意味着——只要删掉消息正文，几乎完全释放空间，而知识骨架（决策/话题/摘要）几乎不占空间。

### 什么时候会遇到这个问题

| 使用时长 | 预计库大小 | 用户感知 |
|---------|-----------|---------|
| 1 个月 | ~12 MB | 无感知 |
| 6 个月 | ~72 MB | 无感知 |
| 1 年 | ~144 MB | 轻微（搜索稍慢） |
| 2 年 | ~288 MB | 明显（磁盘/性能） |
| 3 年+ | ~432 MB+ | 需要处理 |

**产品判断**：当前阶段（v0.1，用户 < 10 人）不急迫，但功能必须在用户遇到之前就存在。手动 `archive` 命令本期做，自动归档推到 Phase 4。

---

## 二、归档什么、不归档什么（完整数据流图）

```
                        srelay archive --days 90
                                │
                                ▼
                    ┌───── 评估哪些会话符合条件 ─────┐
                    │                                │
                    │  条件（OR 关系，满足任一即归档）   │
                    │  · created_at < 90 天前         │
                    │  · DB 大小 > 设定阈值             │
                    │  · 指定来源 (--source zcode)     │
                    └────────┬───────────────────────┘
                             │
                ┌────────────┼────────────────┐
                ▼            ▼                ▼
        ┌── 保护规则 ──┐ ┌── 归档名单 ──┐ ┌── 跳过名单 ──┐
        │ 检查每个会话  │ │ 符合条件且    │ │ 符合条件但    │
        │              │ │ 不受保护      │ │ 受保护规则    │
        └──────┬───────┘ └──────┬───────┘ └──────┬───────┘
               │                │                  │
               │         ┌──────┴──────┐          │
               │         │ 对每个会话：  │          │
               │         │              │          │
               │         │ 1. DELETE     │          │
               │         │    messages   │          │
               │         │    (正文+FTS) │          │
               │         │              │          │
               │         │ 2. UPDATE     │          │
               │         │    sessions   │          │
               │         │    cleanup_at │          │
               │         │    = now()    │          │
               │         │              │          │
               │         │ 3. 保留：      │          │
               │         │   · title     │          │
               │         │   · topics    │          │
               │         │   · decisions │          │
               │         │   · summary   │          │
               │         │   · files     │          │
               │         │   · user_tags │          │
               │         │   · user_summary  │      │
               │         │   · meta_text  │          │
               │         │              │          │
               │         │ 4. 删除：      │          │
               │         │   · messages  │          │
               │         │     .content  │          │
               │         │     .search_text │      │
               │         │   · messages_fts       │
               │         │    (触发器自动)          │
               │         └──────┬──────┘          │
               │                │                  │
               ▼                ▼                  ▼
    ┌──────────────────────────────────────────────────┐
    │                   归档后的状态                       │
    ├──────────────────────────────────────────────────┤
    │                                                    │
    │  会话行（sessions 表）                               │
    │  ┌────────────────────────────────────┐            │
    │  │ id: abc123                         │            │
    │  │ title: "数据库选型讨论"              │  ✅ 保留    │
    │  │ topics: ["db", "postgresql"]       │  ✅ 保留    │
    │  │ decisions: [{"决定采用PG"...}]       │  ✅ 保留    │
    │  │ summary_rule: "选了PG因为..."       │  ✅ 保留    │
    │  │ files: ["src/db/schema.sql"]       │  ✅ 保留    │
    │  │ user_tags: ["重要"]                │  ✅ 保留    │
    │  │ user_summary: "定了PG"             │  ✅ 保留    │
    │  │ meta_text: "数据库 选型 PG..."     │  ✅ 保留    │
    │  │ cleanup_at: "2026-08-28T10:00"    │  🆕 归档标记 │
    │  │ message_count: 0                  │  🔄 归零    │
    │  │ original_message_count: 230       │  🆕 原始值  │
    │  └────────────────────────────────────┘            │
    │                                                    │
    │  消息（messages 表）                                │
    │  ┌────────────────────────────────────┐            │
    │  │ （空——已全部删除）                    │  ❌ 已清除  │
    │  └────────────────────────────────────┘            │
    │                                                    │
    │  全文索引（messages_fts）                            │
    │  ┌────────────────────────────────────┐            │
    │  │ （空——触发器自动清除）                │  ❌ 已清除  │
    │  └────────────────────────────────────┘            │
    │                                                    │
    │  元数据索引（sessions_fts）                          │
    │  ┌────────────────────────────────────┐            │
    │  │ title + topics + decisions +        │  ✅ 保留    │
    │  │ summary（仍可搜索命中）              │            │
    │  └────────────────────────────────────┘            │
    │                                                    │
    └──────────────────────────────────────────────────┘
```

### 保护规则——这些永远不归档

| 规则 | 原因 | 示例 |
|------|------|------|
| `state = 'active'` | 正在进行的对话 | 用户正在聊的会话 |
| `origin = 'imported'` | 交接包导入的，源文件不在本机，删了就**真的没了** | 同事发来的 .hop 包 |
| `origin = 'note'` | AI 写的笔记，体积小价值高 | save_note 创建的结论 |
| `user_tags` 含 `"保留"` | 用户显式标记为重要 | `annotate_session(add_tags: ["保留"])` |
| `decisions` 非空且 `keep_decisions=true` | 决策是核心知识资产（默认保留） | 有已确认决策的会话 |

**注意**：最后一条规则的实际效果是——如果 `keep_decisions=true`（默认），有决策的会话**永远不会被归档**。只有没有任何决策提取结果的会话才会被归档。

等等，这有问题。让我重新想...

**修正**：`keep_decisions` 的含义不是"不归档有决策的会话"，而是"归档时保留决策数据不删除"。会话本身仍然会被归档（消息正文删除），但决策字段保留在 sessions 行里。

| `keep_decisions` 的真正含义 | |
|---------------------------|---|
| `true`（默认） | 归档会话时：删除 messages，保留 sessions 行（含 decisions/topics/summary） |
| `false`（Phase 4 才允许） | 归档会话时：删除 messages + 整个 sessions 行（决策也删） |

所以保护规则里不应该有"有决策的会话不归档"——有决策的会话也会被归档，只是决策数据被保留了。

### 修正后的保护规则

| 规则 | 原因 |
|------|------|
| `state = 'active'` | 正在进行的对话 |
| `origin = 'imported'` | 源文件不在本机，不可恢复 |
| `origin = 'note'` | 体积小，不值得归档 |
| `user_tags` 含 `"保留"` | 用户显式标记 |

---

## 三、怎么干——完整执行流程

### 3.1 手动归档（CLI）

```
用户执行                          系统内部
──────────                      ──────────────────────────────────

srelay archive --days 90
        │
        ▼
    ┌─ 评估阶段 ─────────────────────────────────┐
    │ 1. 查询所有符合条件的会话                      │
    │    WHERE created_at < 90天前                  │
    │    AND state != 'active'                     │
    │    AND origin NOT IN ('imported', 'note')    │
    │    AND user_tags NOT LIKE '%保留%'            │
    │                                              │
    │ 2. 应用保护规则，计算最终归档名单               │
    │ 3. 计算预估释放空间                             │
    └──────────────────┬───────────────────────────┘
                       │
                       ▼
    ┌─ 预览阶段（--dry-run 或默认交互确认）─────────┐
    │                                              │
    │  📊 归档预览                                  │
    │  ─────────────────────────────────           │
    │  将归档 23 个会话（90 天前）                    │
    │  释放约 15.2 MB                               │
    │                                              │
    │  保留：决策(23条) · 话题 · 摘要 · 标题          │
    │  移除：对话正文 · 全文索引                       │
    │                                              │
    │  跳过：3 个（active 2 · imported 1）           │
    │                                              │
    │  确认归档？(y/N)                               │
    └──────────────────┬───────────────────────────┘
                       │ 用户确认 y
                       ▼
    ┌─ 执行阶段（批量 + 锁释放）─────────────────────┐
    │                                              │
    │  batch 1: 会话 1-50                           │
    │    → 获取写锁                                 │
    │    → DELETE FROM messages WHERE session_id IN │
    │    → UPDATE sessions SET cleanup_at = now()   │
    │    → 释放写锁                                 │
    │                                              │
    │  batch 2: 会话 51-100                         │
    │    → 获取写锁 → 执行 → 释放写锁                 │
    │                                              │
    │  ...（每批之间释放锁，sync 可插入执行）           │
    │                                              │
    │  最后：INSERT INTO cleanup_log                │
    └──────────────────┬───────────────────────────┘
                       │
                       ▼
    ┌─ 完成报告 ────────────────────────────────────┐
    │  ✅ 归档完成：23 个会话 · 释放 15.2 MB          │
    │     决策保留 23 条 · 话题保留 45 个              │
    │     可通过 srelay rebuild --force 恢复          │
    └──────────────────────────────────────────────┘
```

### 3.2 批量处理（为什么需要）

```
不用批量（一次性删除 1000 个会话的所有消息）：
  ┌────────────────────────────────────┐
  │ 持有写锁 ──────────────────────── 5 秒 │  ← sync 被阻塞 5 秒
  │                                    │    守护的 30 秒周期全部错过
  │ DELETE 200,000 rows from messages   │
  │                                    │
  └────────────────────────────────────┘

用批量（每批 50 个会话，批间释放锁）：
  ┌────┐ ┌────┐ ┌────┐     ┌────┐
  │锁 1│ │锁 2│ │锁 3│ ... │锁20│    ← 每批 ~250ms
  └─┬──┘ └─┬──┘ └─┬──┘     └─┬──┘
    │      │      │           │
    ▼      ▼      ▼           ▼
  sync  sync  sync        sync     ← sync 在批间正常执行
  插入   插入   插入        插入
```

### 3.3 会话复活（归档后又有新消息）

```
时间线：
  T1: 会话 A 被归档（cleanup_at = T1, messages 清空）
  T2: 用户继续在该会话中聊天（ZCode 追加新消息到源文件）
  T3: sync 发现新消息
  T4: sync 检测到该会话有 cleanup_at
  T5: sync 自动执行"复活"：
      UPDATE sessions SET cleanup_at = NULL WHERE id = ?
      → 新消息正常写入
      → 会话回到 hot 层
      → FTS 索引重建

为什么这样设计：
  · 用户继续聊 = 会话又活跃了 = 应该回到完整状态
  · 不复活会导致数据不一致（部分消息在，部分不在）
  · 跳过新消息会永久丢失数据
```

### 3.4 与 rebuild 的交互

```
srelay rebuild（正常）
  │
  ├── 扫描源文件，准备重建
  │
  ├── 检查 sessions 表中已有的会话
  │     ├── cleanup_at IS NULL → 正常重建（重新灌入消息）
  │     └── cleanup_at IS NOT NULL → 跳过（保持归档状态）
  │
  └── 结果：归档效果在 rebuild 后持续

srelay rebuild --force
  │
  ├── 扫描源文件，准备重建
  │
  ├── 忽略 cleanup_at（全部重建）
  │
  └── 结果：归档的数据被恢复（用户明确要求）
```

---

## 四、为什么这么干——设计理由

### 4.1 为什么叫"归档"而不是"清理"

| 用词 | 用户心理 | 品牌影响 |
|------|---------|---------|
| "清理" (cleanup) | "我的数据被删了" | 与 "Memory is always complete" 矛盾 |
| "归档" (archive) | "旧数据被收纳了，还在" | 与 "记忆完整收录" 一致 |

**一个词的差别，决定用户是否信任这个功能。**

### 4.2 为什么默认保留决策

```
一个典型会话的数据价值分布：

  对话正文（200 条消息）                    决策提取结果（3-5 条）
  ████████████████████████████████████     ███
  体积：1,090KB                            体积：~2KB
  价值密度：低（大量闲聊/重复/噪声）            价值密度：极高（结论性知识）
                                                    │
  占存储 99.4%                              占存储 0.2%  │
                                                    │
  ← 归档这些                                ← 保留这些 │
                                                    │
                                         这 0.2% 是产品的核心价值
```

**保留决策 = 保留 99.4% 的空间回收率 + 保留 80% 的知识价值。**

### 4.3 为什么自动归档推到 Phase 4

| 因素 | 分析 |
|------|------|
| 当前用户量 | < 10 人，最大的库 23MB |
| 到达 500MB 需要 | ~3 年 |
| 自动归档的实现复杂度 | 高（config 校验 + watch 集成 + 定时调度 + 日志） |
| 手动归档的实现复杂度 | 中（CLI 命令 + 核心逻辑） |
| 风险 | 自动归档出错 = 用户不知情丢数据 = 信任崩塌 |
| **结论** | **先做手动归档（安全可控），Phase 4 再做自动（用户量到了再加）** |

### 4.4 为什么 purge/remove 合并进 archive

```
之前的 API 面（4 个"删除"概念）：
  purge --pending          → 删 pending 会话
  remove <id>              → 删指定会话
  cleanup --days 90        → 按条件批量删（v0.1 新增）
  rebuild                  → 间接清空重建

之后的 API 面（1 个"归档"概念）：
  archive --state pending  → 归档 pending 会话
  archive --sessions <id>  → 归档指定会话
  archive --days 90        → 按条件批量归档
  rebuild                  → 独立概念，保持
```

**API 面从 4 个缩减到 2 个（archive + rebuild），用户心智负担减半。**

---

## 五、这么干有什么影响——全面影响分析

### 5.1 对现有功能的影响

| 功能 | 归档后的行为 | 影响 |
|------|-------------|------|
| `search_sessions` | 元数据索引仍命中归档会话（title/topics/decisions/summary） | ⚠️ 正文不可搜，snippet 显示 "[已归档]" + summary 首行 |
| `get_session_detail` | 返回 `messages: []`，session 行含 `degraded: true` | ⚠️ AI 看到空消息，需要处理 |
| `get_decisions` | **正常返回**归档会话中的决策 | ✅ 无影响 |
| `get_file_history` | 元数据命中归档会话 | ⚠️ 无对话片段 |
| `list_sessions` | 归档会话仍列出，显示 `📦` 标记 | ✅ 可见但标注清楚 |
| `export` | 归档会话的 messages 为空数组 | ⚠️ HANDOFF.md 标注 "已归档" |
| `import` | 导入的归档会话，messages 为空 | ✅ 正常（origin='imported'） |
| `rebuild` | 跳过 cleanup_at 非空的会话 | ✅ 归档效果持续 |
| `sync` | 新消息到达归档会话 → 自动复活 | ✅ 数据不丢 |
| `scope` | 对归档会话正常生效（它们仍在 sessions 表中） | ✅ 无影响 |

### 5.2 对 AI agent（MCP）的影响

```
用户问 AI："我们之前为什么决定用 PostgreSQL？"

归档前：
  AI → get_decisions() → 返回完整决策 + 出处（session_id + msg#12）
  AI → get_session_detail(id, seq: 12) → 拿到原始对话上下文
  AI → "根据 8 月 20 日在 ZCode 中的讨论..."（带完整上下文）

归档后：
  AI → get_decisions() → 返回完整决策 + 出处（session_id，msg# 标注"已归档"）
  AI → get_session_detail(id) → messages: []，degraded: true
  AI → "根据 8 月 20 日的讨论记录（已归档），当时决定..."（决策在，原始对话不在）
```

**影响**：AI 仍能回答"为什么"，但无法引用原始对话的完整措辞。**决策的"结论"保留，"推导过程"丢失。**

### 5.3 对交接（HOP 导出）的影响

```
归档前导出的 HANDOFF.md：
  ### 数据库选型（08-20，Claude Code）
  > 讨论了 MySQL vs PostgreSQL...
  > 用户："我们的数据量预计每月增长 500 万条..."
  > AI："PostgreSQL 的原生分区表支持更好..."
  （完整对话片段）

归档后导出的 HANDOFF.md：
  ### 数据库选型（08-20，Claude Code）📦已归档
  > 决策：采用 PostgreSQL
  > 注：此会话已归档，仅保留决策元数据
  （只有结论，没有过程）
```

**影响**：交接包的完整性下降。如果需要完整交接，在导出前执行 `srelay rebuild --force`。

### 5.4 对数据库性能的影响

| 操作 | 归档前 | 归档后 | 变化 |
|------|--------|--------|------|
| search_sessions | 扫描 messages_fts + sessions_fts | 仅扫 sessions_fts（更少数据） | ✅ 更快 |
| get_decisions | 扫描 sessions 表 | 同上（行还在） | ✅ 无变化 |
| get_session_detail | 读 messages 表 | 返回空（不读表） | ✅ 更快 |
| sync（增量） | 写 messages + FTS | 归档会话如果复活则重建索引 | ⚠️ 复活稍慢 |
| export | 读全部数据 | 归档会话只读元数据 | ✅ 更快 |

### 5.5 风险矩阵

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| 用户误归档重要会话 | 低 | 高 | 二次确认 + dry-run + 保护规则 |
| 归档后决策丢失 | 极低 | 极高 | keep_decisions 强制 true（Phase 4 前不可关） |
| 归档导致搜索质量下降 | 中 | 中 | summary_rule 质量提升 + 元数据索引保证基础可用 |
| 归档后源文件也被删 | 极低 | 极高 | 源文件不归我们管，但 rebuild 需要源文件 |
| 并发归档 + sync 冲突 | 低 | 中 | 批量处理 + 锁释放 |
| 归档后会话复活逻辑 bug | 低 | 中 | 充分测试 + 单元覆盖 |

---

## 六、实施计划

### 本期（v0.2）做这些

| # | 任务 | 说明 |
|---|------|------|
| 1 | Schema：`cleanup_at` + `original_message_count` + `cleanup_log` + `cleanup_detail` 表 | 数据基础（含归档明细） |
| 2 | `runArchive()` 核心函数 | 归档逻辑（条件/保护/批量/复活/记录明细） |
| 3 | CLI `srelay archive` 命令 | 替代 purge + remove + cleanup |
| 4 | CLI `srelay archive --history [--verbose]` | 查看归档历史（含逐会话明细） |
| 5 | `srelay rebuild` 跳过 cleanup_at | 归档效果持续 |
| 6 | sync 会话复活逻辑 | 归档后有新消息自动恢复 |
| 7 | 搜索/列表的归档标注 | `[已归档]` 标记 + snippet 降级 |
| 8 | 测试 | 单元 + 集成 + 并发 + 端到端 |

### Phase 4 再做这些

| # | 任务 | 说明 |
|---|------|------|
| 9 | config.retention 字段 + 校验 | 自动归档配置 |
| 10 | watch 守护定期检查 | 自动归档执行 |
| 11 | init 向导（仅在用户数据 > 100MB 时提示） | 避免新用户焦虑 |
| 12 | MCP `archive_sessions` 工具 | AI 侧操作 |
| 13 | `keep_decisions = false` 选项 | 硬归档模式 |

### 归档审计日志设计

#### 表结构

```sql
-- 归档操作日志（每次 archive 命令一条记录）
CREATE TABLE cleanup_log (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    triggered_by      TEXT NOT NULL,      -- 'manual' | 'auto' | 'mcp'
    mode              TEXT NOT NULL,      -- 'archive' | 'hard'
    criteria          TEXT NOT NULL,      -- 触发条件 JSON，如 {"days": 90, "source": "zcode"}
    sessions_affected INTEGER NOT NULL,   -- 归档了几个
    sessions_skipped  INTEGER NOT NULL,   -- 跳过了几个（保护规则）
    bytes_freed       INTEGER NOT NULL,   -- 释放了多少字节（逻辑删除量）
    created_at        TEXT NOT NULL       -- 什么时候执行的
);

-- 归档明细（每个被归档的会话一条记录，关联到 cleanup_log）
CREATE TABLE cleanup_detail (
    cleanup_log_id INTEGER NOT NULL REFERENCES cleanup_log(id) ON DELETE CASCADE,
    session_id     TEXT NOT NULL,         -- 被归档的会话 ID
    title          TEXT,                  -- 归档时的标题快照（防止后续标题变化）
    source         TEXT NOT NULL,         -- 来源 agent
    message_count  INTEGER NOT NULL,      -- 归档前的消息数
    decision_count INTEGER NOT NULL,      -- 归档时保留的决策数
    created_at     TEXT NOT NULL          -- 归档时间
);
CREATE INDEX idx_cleanup_detail_log ON cleanup_detail(cleanup_log_id);
CREATE INDEX idx_cleanup_detail_session ON cleanup_detail(session_id);
```

#### 查看归档历史

```bash
# 简要历史（每次归档一行）
srelay archive --history

#  ═══ 归档历史 ═══
#  2026-10-01 10:00  手动 · 90天前 · 23 个会话 · 释放 15.2MB · 决策保留 45 条
#  2026-12-15 03:00  自动 · 180天前 · 45 个会话 · 释放 32.1MB · 决策保留 89 条
#  ────────────────────────────────────
#  累计：68 个会话已归档 · 共释放 47.3MB

# 详细历史（展开每个会话的明细）
srelay archive --history --verbose

#  ═══ 归档历史（详细）═══
#  2026-10-01 10:00  手动 · --days 90
#    归档 23 个：
#      · abc123 「数据库选型讨论」       230msg → 0msg（决策 3 条保留）
#      · def456 「认证方案」             180msg → 0msg（决策 2 条保留）
#      · ghi789 「部署配置」              95msg → 0msg（决策 1 条保留）
#      · ...（共 23 个）
#    跳过 3 个：active 2 · imported 1
#
#  2026-12-15 03:00  自动 · --days 180
#    归档 45 个：
#      · ...
#    跳过 2 个：note 2

# 查看某个会话的归档记录
srelay archive --history --session abc123

#  会话 abc123 「数据库选型讨论」
#  · 2026-10-01 10:00 被归档（手动，--days 90）
#  · 归档前：230 条消息 · 3 条决策
#  · 归档后：0 条消息 · 3 条决策（保留）
```

#### 审计数据的价值

| 场景 | 怎么用 |
|------|--------|
| 用户："我上周归档了什么？" | `archive --history` 直接看 |
| 用户："那个数据库选型的会话去哪了？" | `archive --history --session abc123` |
| AI："这个会话为什么没有对话内容？" | `cleanup_detail` 有记录，AI 可查 |
| 排障："为什么库突然变小了？" | `archive --history` 有操作时间和释放量 |
| 合规："什么时候删的数据？" | `cleanup_log.created_at` 是权威时间戳 |

### API 变更

| 旧命令 | 新命令 | 兼容性 |
|--------|--------|--------|
| `purge --pending` | `archive --state pending` | v0.2 移除旧命令 |
| `remove <id>` | `archive --sessions <id>` | v0.2 移除旧命令 |
| （新增） | `archive --days N` | 新功能 |
| （新增） | `archive --size Nmb` | 新功能 |
| （新增） | `archive --history [--verbose] [--session <id>]` | 归档审计 |
