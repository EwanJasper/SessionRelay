# 数据保留与清理机制 — 设计方案 v0.1

> **日期**：2026-08-28
> **状态**：草案（需三轮评审后方可实施）
> **触发来源**：用户提出需要过期清理 + 手动/自动两种方式
> **核心约束**：这是**破坏性操作**，设计错误的代价是用户信任的永久丧失

---

## 一、问题定义

### 1.1 为什么需要清理

| 场景 | 问题描述 | 数据量级 |
|------|---------|---------|
| 长期使用积累 | 每天 5-10 个会话 × 每会话 100-300 条消息 × 每条 1-5KB | 一年后 DB 可达 1-5 GB |
| 磁盘空间受限 | 笔记本 SSD 空间宝贵，23MB 只是 2 个月的量 | 12 个月后可能 500MB+ |
| 过期信息噪声 | 两年前的会话对当前开发价值低，但占据搜索空间 | 降低检索信噪比 |
| 隐私需求 | 用户可能希望定期清除旧讨论记录 | 合规/个人偏好 |

### 1.2 为什么不能轻率

| 风险 | 后果 |
|------|------|
| 误删用户认为重要的会话 | 信任永久丧失，用户卸载 |
| 清理后决策丢失 | `get_decisions` 返回不全，AI 回答质量下降 |
| 自动清理在用户不知情时执行 | "这个工具偷偷删我数据"——产品口碑崩塌 |
| 与 rebuild 的交互不明确 | 清理后 rebuild 把删掉的又拉回来了？ |

### 1.3 核心设计原则

1. **不碰源文件**——清理只影响我们的索引（relay.sqlite），ZCode/Claude Code/Codex 的原始数据完全不动
2. **可恢复**——`srelay rebuild` 随时从源文件重建被清理的数据（前提：源文件还在）
3. **用户知情**——自动清理必须在 init 向导中明确告知并征得同意，不能默认开启
4. **决策优先保留**——决策是提炼后的知识，体积小价值高，尽量不删
5. **干跑优先**——任何清理操作都先提供 `--dry-run` 预览

---

## 二、数据模型分析

### 2.1 数据的体积分布

以 SocialSecurity 项目为例（136 会话，23.1 MB）：

| 数据类型 | 表 | 体积占比 | 价值密度 | 清理影响 |
|---------|---|---------|---------|---------|
| 消息正文 | messages.content + search_text | ~85% | 低（大部分是对话噪声） | 清掉后体积大幅下降 |
| FTS 索引 | messages_fts | ~10% | — | 随消息清理自动缩减 |
| 会话元数据 | sessions（title/topics/decisions/summary） | ~3% | **高**（决策/话题/摘要） | 保留则搜索仍能命中 |
| 关联/日志 | session_links / scope_log / transfer_log | ~2% | 中 | 应随会话清理 |

### 2.2 清理粒度选项

| 粒度 | 做法 | 体积回收 | 知识保留 | 实现复杂度 |
|------|------|---------|---------|-----------|
| A. 整会话删除 | DELETE sessions + messages | 100% | 0%（全丢） | 低 |
| B. 降级为元数据 | DELETE messages, 保留 sessions 行 | ~85% | ~80%（决策/话题/摘要可搜） | 中 |
| C. 只删消息正文，保留 FTS | 不可行（FTS 依赖正文） | — | — | — |

**推荐 B（降级为元数据）为默认，A 为可选。**

理由：B 模式下用户仍能通过 `search_sessions` 命中标题/话题/决策，`get_decisions` 仍返回完整决策列表——只是 `get_session_detail` 拿不到对话原文。**知识的"骨架"保留了，只是"血肉"清掉了。**

### 2.3 与 rebuild 的交互

| 清理方式 | rebuild 后 | 说明 |
|---------|-----------|------|
| 降级为元数据（B） | 源文件还在 → 消息恢复 | rebuild 从源重新拉取，降级的会话重新灌入消息 |
| 整会话删除（A） | 源文件还在 → 会话恢复 | 同上 |
| 源文件也被删了 | **不可恢复** | ZCode 压缩/Claude Code 清理 → 数据永久丢失 |

**关键问题**：rebuild 会把清理掉的数据拉回来，这是"特性"还是"bug"？

**设计决策**：这是**特性**。清理的语义是"从索引中移除，释放空间"，不是"从历史中抹除"。如果用户想永久删除，需要同时删源文件（这不是我们控制的）。但如果 rebuild 把清理的数据拉回来，用户会觉得"清理没用"。

**解法**：引入 `sessions.cleanup_at` 字段：
- 清理时记录 `cleanup_at = now`
- rebuild 时跳过 `cleanup_at` 非空的会话（除非 `--force`）
- 这样清理的效果在 rebuild 后仍然持续

---

## 三、清理策略设计

### 3.1 触发条件

| 方式 | 触发者 | 时机 | 适用场景 |
|------|--------|------|---------|
| **手动** | 用户执行 `srelay cleanup` | 按需 | 用户主动清理 |
| **自动（守护内置）** | watch 守护 | 定期检查（默认每 24h） | 用户设置后无需干预 |
| ~~自动（init 默认）~~ | ~~init 时开启~~ | ~~首次初始化~~ | **不默认开启——必须用户显式同意** |

### 3.2 清理条件

| 条件 | 参数 | 说明 |
|------|------|------|
| 按时间 | `--days N` / `max_age_days` | 清理 N 天前的会话 |
| 按日期 | `--before <date>` | 清理指定日期前的 |
| 按体积 | `--size <N>mb` / `max_db_size_mb` | DB 超过 N MB 时从最老开始清 |
| 按来源 | `--source <id>` | 只清理特定来源的会话 |
| **组合** | 多条件同时生效 | 满足任一条件即清理（OR） |

### 3.3 清理模式

| 模式 | 参数 | 行为 | 体积回收 |
|------|------|------|---------|
| **降级**（默认） | `--keep-decisions`（默认 true） | 删 messages，保留 sessions 行（含决策/话题/摘要） | ~85% |
| **删除** | `--hard` | 整行删除（sessions + messages） | 100% |

### 3.4 保护规则（什么不清理）

| 规则 | 理由 |
|------|------|
| `state = 'active'` 的会话不清理 | 正在进行的对话 |
| `origin = 'imported'` 的会话不自动清理 | 交接包导入的，源文件不在本机，删了就真没了 |
| `origin = 'note'` 的会话不自动清理 | AI 写的笔记，体积小价值高 |
| 带 `user_tags` 含"保留"标签的会话不清理 | 用户显式标记为重要 |
| `--keep-decisions` 模式下决策数据永不删除 | 决策是核心知识资产 |

---

## 四、CLI 设计

### 4.1 手动清理命令

```bash
# 预览（不实际执行）
srelay cleanup --days 90 --dry-run
# 输出示例：
#   将清理 23 个会话（90 天前），释放约 15.2 MB
#   - 降级为元数据：21 个（保留决策/话题/摘要）
#   - 整体删除：2 个（无决策数据）
#   - 跳过：3 个（active/imported/保留标签）
#   确认执行请去掉 --dry-run

# 执行清理（降级模式，默认）
srelay cleanup --days 90
#   ✅ 清理完成：23 个会话 · 释放 15.2 MB
#   · 降级 21 个（决策保留）· 删除 2 个
#   · 可通过 srelay rebuild --force 恢复

# 硬删除模式
srelay cleanup --days 90 --hard

# 按体积清理
srelay cleanup --size 500mb

# 只清理特定来源
srelay cleanup --days 90 --source zcode

# 恢复被清理的数据
srelay rebuild --force    # 忽略 cleanup_at，从源文件全量重建
```

### 4.2 参数完整表

| 参数 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `--days <N>` | number | — | 清理 N 天前的会话 |
| `--before <date>` | string | — | 清理指定日期前的 |
| `--size <N>mb` | string | — | DB 超过此值时清理 |
| `--source <id>` | string | 全部 | 只清理此来源 |
| `--keep-decisions` | boolean | **true** | 保留决策元数据（降级模式） |
| `--hard` | boolean | false | 硬删除（含 sessions 行） |
| `--dry-run` | boolean | false | 只预览不执行 |
| `--force` | boolean | false | 跳过保护规则（清理 active/imported/note） |
| `--json` | boolean | false | JSON 输出 |

### 4.3 交互保护

- 有 `--dry-run` → 直接显示预览
- 无 `--dry-run` + TTY → 显示预览 + 二次确认（"将清理 N 个会话，确认？(y/N)"）
- 无 `--dry-run` + 非 TTY → 需要显式 `--force`，否则拒绝

---

## 五、自动清理设计（守护内置）

### 5.1 配置

```json
// .sessionrelay/config.json
{
  "retention": {
    "enabled": false,             // 默认关闭！必须用户显式开启
    "max_age_days": null,         // 按时间清理（null = 不启用）
    "max_db_size_mb": null,       // 按体积清理（null = 不启用）
    "keep_decisions": true,       // 保留决策
    "check_interval_hours": 24    // 检查频率
  }
}
```

### 5.2 init 向导中的告知

```
⚠️  数据保留策略

会话接力会持续收录你与 AI 的对话。长期使用后数据库会增长。
你可以设置自动清理策略，也可以手动执行 srelay cleanup。

是否开启自动清理？(y/N) [默认: N]
→ 如果 y：
  清理超过多少天的会话？ [默认: 180]
  清理时保留决策数据？(y/N) [默认: y]
  ✓ 已设置：180 天后自动降级清理（决策保留），每 24h 检查

你也可以随时在 .sessionrelay/config.json 中调整 retention 配置。
```

### 5.3 watch 守护的清理周期

```
watch 守护启动
  ├── 每 30 秒：sync + judge（现有）
  ├── 每 24 小时：检查 retention 策略（新增）
  │     ├── 读取 config.retention
  │     ├── 如果 enabled 且条件满足
  │     │     ├── 计算 DB 大小 / 检查最老会话日期
  │     │     ├── 执行清理（降级模式）
  │     │     └── 日志："[cleanup] 清理 N 个会话，释放 X MB"
  │     └── 不满足条件 → 跳过
  └── ...
```

### 5.4 自动清理的日志

自动清理必须留下审计痕迹：

```
// .sessionrelay/logs/cleanup.log
2026-08-28T10:00:00Z [cleanup] 检查：DB 23.1MB，最老会话 67 天前，策略 max_age=180d
2026-08-28T10:00:00Z [cleanup] 无需清理
2026-10-01T10:00:00Z [cleanup] 检查：DB 156MB，最老会话 194 天前，策略 max_age=180d
2026-10-01T10:00:00Z [cleanup] 清理 12 个会话（降级），释放 89.3MB
```

---

## 六、数据模型变更

### 6.1 Schema DDL

```sql
-- 会话表增加清理标记
ALTER TABLE sessions ADD COLUMN cleanup_at TEXT;
-- NULL = 未清理
-- 非 NULL = 清理时间（降级模式：元数据保留；hard 模式：行已删除）

-- 清理审计日志
CREATE TABLE cleanup_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    triggered_by TEXT NOT NULL,      -- 'manual' | 'auto'
    mode        TEXT NOT NULL,       -- 'degrade' | 'hard'
    criteria    TEXT NOT NULL,       -- 触发条件 JSON（如 {"days":90}）
    sessions_affected INTEGER NOT NULL,
    sessions_skipped  INTEGER NOT NULL,
    bytes_freed       INTEGER NOT NULL,
    created_at  TEXT NOT NULL
);
```

### 6.2 rebuild 交互

```typescript
// rebuild 时跳过已清理的会话（除非 --force）
const skipCleaned = !force;
// SELECT id FROM sessions WHERE cleanup_at IS NULL → 这些可以重建
// cleanup_at IS NOT NULL → 跳过（保留清理状态）
```

### 6.3 降级模式的数据变化

| 字段 | 降级前 | 降级后 |
|------|--------|--------|
| sessions 行 | 完整 | 保留（title/topics/decisions/summary 不变） |
| messages 行 | 存在 | **删除** |
| messages_fts | 有索引 | **自动清理**（触发器） |
| message_count | 230 | **重置为 0**（加 `original_message_count` 保留原值？——不，让 rebuild 恢复） |
| cleanup_at | NULL | **清理时间** |
| 搜索 | 正文+元数据 | **仅元数据**（meta_text 仍可命中） |

---

## 七、MCP 工具

### 7.1 新增 `cleanup_sessions` 工具

```typescript
server.registerTool('cleanup_sessions', {
  title: '清理过期会话',
  description: '按条件清理旧会话（降级模式：保留决策，删除正文）。建议先用 dry_run 预览',
  inputSchema: {
    days: z.number().optional().describe('清理 N 天前的会话'),
    dry_run: z.boolean().optional().default(true).describe('默认 true 只预览；false 执行'),
  },
}, async (args) => {
  // AI 默认只做 dry_run；要实际执行需要用户确认
  const result = runCleanup({
    root, db,
    days: args.days,
    dryRun: args.dry_run ?? true,
    keepDecisions: true,
  });
  return toolOut(result);
});
```

### 7.2 AI 的使用场景

```
用户："帮我清理一下超过半年的旧会话"
AI：调用 cleanup_sessions(days: 180, dry_run: true)
    → "将清理 23 个会话，释放约 15.2 MB。确认执行吗？"
用户："确认"
AI：调用 cleanup_sessions(days: 180, dry_run: false)
    → "✅ 清理完成"
```

---

## 八、安全边界

### 8.1 永远不做的事

| 禁止 | 理由 |
|------|------|
| 修改/删除源文件 | 源文件是事实源，我们只是索引 |
| 默认开启自动清理 | 必须用户显式同意 |
| 清理 active 会话 | 正在进行的对话 |
| 清理后不记录日志 | 审计可追溯 |
| `--hard` 模式不需要确认 | 破坏性更大的操作需要更严格的确认 |

### 8.2 与 Scope/隐私系统的关系

- `.sessionrelayignore` 的优先级高于清理——被 ignore 的会话根本不在库里，无需清理
- 清理不影响 Scope——Scope 是检索边界，清理是存储管理
- 清理不会触碰导出/导入的交接包

---

## 九、实施清单

| 步骤 | 内容 | 依赖 |
|------|------|------|
| 1 | Schema：sessions.cleanup_at + cleanup_log 表 | 无 |
| 2 | `runCleanup()` 核心函数 | Schema |
| 3 | CLI `srelay cleanup` 命令 | runCleanup |
| 4 | config.retention 字段 | Schema |
| 5 | watch 守护定期检查 | runCleanup + config |
| 6 | init 向警告知 | config |
| 7 | rebuild 跳过 cleanup_at | Schema |
| 8 | MCP `cleanup_sessions` 工具 | runCleanup |
| 9 | 测试：干跑/执行/降级/硬删/保护规则/rebuild 交互/自动清理 | 全部 |
| 10 | 文档：README + 设计笔记 | 全部 |

---

## 十、评审检查点

### 第一轮评审应确认

- [ ] 清理粒度（降级 vs 硬删）的设计是否合理？
- [ ] 保护规则是否完整？有没有漏掉不该清理的场景？
- [ ] 与 rebuild 的交互（cleanup_at 跳过）是否正确？
- [ ] 自动清理默认关闭是否正确？

### 第二轮评审应确认

- [ ] CLI 参数设计是否完整、直觉？
- [ ] 配置字段命名是否清晰？
- [ ] MCP 工具的 dry_run 默认 true 是否安全？
- [ ] 降级模式下 message_count 归零是否会影响其他功能？

### 第三轮评审应确认

- [ ] 测试覆盖是否完整？
- [ ] 边界情况：清理后立刻 rebuild 会怎样？清理时守护在写入怎么办？
- [ ] 文档是否准确描述了行为？
- [ ] 是否有未考虑到的用户场景？
