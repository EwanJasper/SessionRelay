# ZCode 会话存储格式逆向笔记与 Adapter 规格草案

> **Phase 0 · Spike S5 产出** · 2026-08-28（风险声明更新 2026-08-29）
> **样本**：本机 ZCode 实例（236 会话 / 20,855 消息 / 70,667 parts，只读分析，未做任何写入）
> **状态**：格式已验证；adapter 已实现（`src/adapters/zcode/`）
> **隐私**：本文档只含 schema 与统计，不含任何会话正文

## ⚠️ 风险声明（2026-08-29 补充）

**本格式是通过逆向工程发现的 ZCode 内部实现，不是官方公开文档。**

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| ZCode **可能清理旧会话** | 源文件消失，rebuild 恢复不了 | 开启守护（30 秒窗口）缩短风险 |
| ZCode **可能修改存储格式** | adapter 解析失败 | 版本探测 + doctor 告警（已实现） |
| ZCode **可能迁移到云端** | 本地无源文件可读 | 无解，需 ZCode 提供 API |
| 上下文压缩**物理删除消息** | 原始对话不可恢复 | 守护 30 秒同步 + 压缩摘要捕获（已实现） |

**对比**：Claude Code 有[官方存储文档](https://code.claude.com/docs/en/sessions)和 30 天保留策略；ZCode 无任何公开的存储或保留文档。

**建议**：使用 ZCode 源的用户应**始终开启守护进程**，确保消息在被清理/压缩之前入库。

## 一、存储架构总览

ZCode 与 Claude Code（每会话一个 JSONL 文件）**根本不同**，它有两层存储：

| 位置 | 内容 | 适配结论 |
| ---- | ---- | -------- |
| `~/.zcode/cli/db/db.sqlite`（WAL，本机 319MB） | **权威关系库**：session/message/part/session_entry 等 19 张表 | ✅ **Adapter 唯一读取面** |
| `~/.zcode/cli/rollout/model-io-sess_<uuid>.jsonl` | 模型级 I/O 遥测（完整请求体含 105 个工具定义、headers、usage，约 20MB/会话） | ❌ 不作捕获源（体积大、模型层而非会话层），记录在此防将来误用 |

## 二、核心表结构（实测 DDL 摘录）

### session（236 行）——会话元数据

```sql
CREATE TABLE session (
  id text primary key,            -- 'sess_<uuid>'，即 source_session_id
  project_id text not null,       -- 'proj_d-project-someideaproject-sessionrelay…'（路径派生）
  parent_id text,                 -- 会话链！→ session_links(kind='continues') 的现成素材
  directory text not null,        -- ★ 项目绝对路径，归属判定的一等信号
  title text not null,            -- ★ 会话标题免费可得（title_source: first_input/generated/custom）
  time_created integer not null,  -- epoch 毫秒
  time_updated integer not null,  -- ★ 结束判定信号（mtime 等价物）
  task_type text default 'interactive',
  version text not null,          -- 格式版本漂移检测用
  ... summary_*, share_url, revert, permission, trace_id
);
```

### message（20,855 行）——消息

```sql
CREATE TABLE message (
  id text primary key,
  session_id text not null references session(id),
  time_created integer not null,
  data text not null,   -- JSON：{role, time:{created,completed}, parentID, modelID, providerID, mode, agent, path:{cwd,root}}
  sequence integer      -- ★ 确定性序号，天然满足幂等键契约（技术方案 §3.1）
);
```

### part（70,667 行）——消息内容块

```sql
CREATE TABLE part (
  id text primary key,
  message_id text not null references message(id),
  session_id text not null,
  data text not null,   -- JSON，type ∈ {text, reasoning, tool, step-start, step-finish}
  sequence integer
);
```

实测 part 类型分布（4,000 样本）：`text` 3111 · `tool` 284 · `step-start` 282 · `step-finish` 273 · `reasoning` 50。

各类型 `data` 键结构（值已脱敏）：

| type | 关键字段 | 用途 |
| ---- | -------- | ---- |
| `text` | `text`, `time{start,end}` | **正文 → UnifiedMessage.content** |
| `tool` | `tool`, `callID`, `state{status, input{command/file/description…}}` | → files_mentioned / code_changes 提取素材（tool 名 + input） |
| `reasoning` | `text`, `metadata` | 默认丢弃（Phase 4 `--ai` 可选纳入） |
| `step-start` / `step-finish` | （无内容） | 跳过 |

### 辅助表

`session_input`（用户输入队列，1,217 行，含 admitted/promoted 状态）、`session_entry`（通用事件流，2,269 行）、`session_target`（任务型会话的目标/预算/`active_run_last_seen`）、`todo/tool_usage/model_usage`。Phase 3 只读 session/message/part 三表即可；`schema_migration`（18 个迁移）用于版本漂移检测。

## 三、Adapter 映射规格（ZCode → UnifiedSession）

| Unified 字段 | 来源 | 说明 |
| ------------ | ---- | ---- |
| `source_session_id` | `session.id` | `sess_<uuid>` |
| `project 归属` | `session.directory` | ★ 直接等值匹配项目根，**无需 cwd heuristic**——比 Claude Code 更强的身份信号 |
| `title` | `session.title` | 直接采用（优于我们的规则生成首问标题） |
| `created_at` | `session.time_created` | epoch ms → ISO8601 |
| `git_branch` | （无此字段） | fallthrough：从 `path.root` 做 git 探测（方针 §6.4 已知坑 #2 的预期行为） |
| `messages[].role` | `message.data.role` | user / assistant |
| `messages[].content` | 该 message 的 `part(type='text')` 按序拼接 | reasoning/tool 默认不入正文 |
| `messages[].seq_num` | `message.sequence` | ★ 确定性序号，幂等键 `(session_id, seq_num)` 直接可用 |
| `files_mentioned` 素材 | `part(type='tool').state.input` | tool ∈ {Read,Edit,Write,Bash} 的 file/command 字段 |
| 会话链 | `session.parent_id` | → `session_links(kind='continues')`，Phase 4 `get_linked_sessions` 的免费数据源 |

## 四、增量水位：cursor 泛化（S5 最重要发现）

**byte_offset 对 ZCode 不适用**（SQLite 没有"文件尾部追加"语义）。技术方案 R1 的 `source_files.byte_offset` 必须泛化为通用游标：

```
cursor TEXT  -- 文件型源：字节偏移（数字字符串）
             -- SQLite 型源：JSON {"sequence": <last message.sequence>, "time_created": <ms>}
增量查询：SELECT ... FROM message WHERE session_id = ? AND (sequence > ? OR (sequence = ? AND id > ?)) ORDER BY sequence
```

抽象层变化：`SessionSource.tail(file, fromByte)` → `tail(source, fromCursor)`；`source_files` 表相应改列名并兼容文件型语义（T34）。

## 五、结束判定信号

- 主信号：`session.time_updated` 静默 ≥ `idle_threshold_min`（与 JSONL mtime 完全同构，状态机零改动）；
- 任务型会话辅助信号：`session_target.active_run_last_seen`（运行中标记，比纯静默更准）；
- resume：同 session 的 `time_updated` 增长 / `message.sequence` 出现新高 → RESUMED（映射到既有状态机，无需新事件）。

## 六、安全与稳定性约束

1. **只读连接**：`new Database(path, { readonly: true })`；WAL 允许 ZCode 写入时的并发读，绝不写入、绝不长事务；
2. 每次同步批读取包在单个 SELECT 事务内（快照一致性，防读到半批）；
3. **版本漂移检测**：启动时读 `schema_migration` 最大版本号与 `session.version` 分布，超出 adapter 已知范围 → 标记 `suspect` 并 doctor 提示（方针风险 #11 的落地）；
4. 库路径发现：默认 `~/.zcode/cli/db/db.sqlite`，config 可覆盖；库不存在 → adapter 报"未安装 ZCode"而非报错。

## 七、Claude Code 真实格式交叉验证（S2 补充）

本机 `~/.claude/projects/<路径slug>/<sessionId>.jsonl` 实测确认：

- 目录 slug = 项目绝对路径的分隔符替换（`D--project-IdeaProjects` ⇄ `D:\project\IdeaProjects`）——**项目归属可从目录名直接还原**，辅以每行的 `cwd` 字段双保险；
- 行结构：`{type, message, sessionId, uuid, parentUuid, timestamp, isSidechain, cwd, …}`，另有 hook attachment 行（type 仍存在，attachment 字段承载钩子输出）——**S2 合成 fixture 的 `type/message/timestamp` 假设与真实格式一致**；
- 实施注意：`isSidechain=true` 的行（子代理）默认不入库；`attachment` 行跳过。

## 八、遗留问题（Phase 3 实现时确认）

1. `message.sequence` 是否存在空洞/重排（长时间运行库中 2 万行未发现异常，需在 fixture 测试覆盖）；
2. `session.version` 的取值集合（目前只观察到单一值）；
3. 工具名→files_mentioned 的映射表（Read/Edit/Write 直接有 file 字段，Bash 需从 command 提取路径）。
