# `srelay forget` 设计方案 · v4（三角色评审折入版，实现依据）

> 目标：把"删除权"交还给人（CLI），AI 保持零删除权。可追加的记忆有了受控出口。
> 演进：v1→v3 三轮自审查（13 项修订）→ 三角色评审（PM/架构师/设计师，7 项发现）→ v4。
> 评审记录见 §8/§9。

---

## 1. 问题定义

当前 15 个 MCP 工具 + CLI 全部只能追加或修改，无法删除：

| 困境 | 现状 |
|---|---|
| AI 写错笔记（save_note 直接进决策库） | 永久污染检索与决策，无法撤回 |
| 隐私对话（"删掉这条"） | 只进不出，与本地优先叙事矛盾 |
| 测试/垃圾数据清场 | 只能开 SQLite 手改，破坏封装 |
| annotate 越写越肥 | 错误注解只增不减 |

**边界（不可协商）**：AI（MCP 工具）永远不获得删除能力。删除是人的特权。

## 2. 能力矩阵

| 能力 | 载体 | 说明 |
|---|---|---|
| 删自建内容（note/注解/链接） | CLI `srelay forget` | AI 写错的，人清 |
| 删单条会话（含 auto 捕获） | CLI，带预览确认 | 隐私删除 |
| 删整个项目记忆库 | CLI，双重确认 | 测试/清场 |
| MCP 删除工具 | **不做** | AI 永不删 |
| 删除原始会话文件 | **不做** | 原始文件是唯一事实源 |

### 2.1 `forget` 与 `archive --hard` 的裁决（评审 P0，用户已待拍板）

产品里已存在两个删除语义，用户不会读文档，必须给出唯一裁决表：

| | `archive`（默认） | `archive --hard` | **`forget`** |
|---|---|---|---|
| 用户意图 | **降级**（省空间、归档老化） | 批量清理 | **抹除**（隐私/纠错/精确单点） |
| 删什么 | 正文 + FTS（决策/话题/摘要/标题保留） | 同左且全量 | **整个会话消失**（含决策列） |
| 防复活闸 | 不需要（会话行还在） | **无**（源文件残留可被 sync 重捕——现状缺口，文档标注） | **双闸**（ignore `session:` + 墓碑） |
| 可逆 | rebuild --force 可恢复 | 否（除非源文件在） | 否（防复活闸生效时源文件也不再生效） |
| 粒度 | 按老化策略批量 | 按老化策略批量 | 单会话/note/全库 |
| 审计 | cleanup_log | cleanup_log | forget_log + detail |

**选型口诀（进 README 与 `--help`）**：空间与老化用 `archive`；让一条对话彻底消失、永不回来，用 `forget`。
`archive --hard` 的防复活缺口不在本轮修复（它面向回填窗口外的老会话，mtime 已过 cutoff），
但在其 `--help` 中加一行提示："若需防止源文件再次被收录，用 srelay forget"。

## 3. 架构设计

### 3.1 删除语义分层

| 层 | 对象 | 手段 |
|---|---|---|
| L2 记录删除 | sessions 行 | SQL DELETE（已验证：FK CASCADE 连带 messages/session_links/transfer_log；messages 与 sessions 的 FTS 外部内容触发器在 CASCADE 下正常同步——已用 better-sqlite3 实验证明） |
| L3 投影失效 | decisions/topics/files_mentioned 均为 sessions 列 | 随行消失 |

L1（部分消息删除）明确不做——破坏"原文完整"承诺，只做会话/笔记粒度。

### 3.2 防复活（核心难题）

被删会话的原始文件仍在磁盘，守护 30s 扫描 + rebuild 全量重扫，有两条复活路径。
断路器设计（v2 修订，v3 砍掉 --no-ignore）：

1. **精确 ignore 规则（新前缀 `session:`）**：`.sessionrelayignore` 追加
   `session:zcode/a3f8c2d1`。ignore 匹配器（`src/capture/ignore.ts`）新增分支：
   `source + source_session_id` 精确匹配（`DiscoveredSession` 在两处 ingest 调用点都携带
   此二者，见 §3.3）。**取代 v1 的"追加 glob"**——v1 的方案要么太粗（source: 全源屏蔽）
   要么易误伤（title: 关键词），且文本模糊匹配不可审计。
   **此规则强制追加，不可选退**——它是防复活主防线。
2. **墓碑表 `forget_tombstones`**：`source + source_session_id` 唯一键。
   次级防线：ignore 规则被用户手删后的兜底。
   **载入形态（评审 A2，定为规范）**：sync 两处入口启动时各调一次
   `loadTombstones(db): Set<string>`（key = `source:sid`，整表一次载入），
   与 `loadIgnoreRules` 同构；**禁止 per-discovered-session 的点查**——墓碑表常态
   <100 行，Set 常驻零成本，防止未来有人顺手写成 per-message 查询。
3. ~~游标推进~~：v2 起不做（cursor 结构 per-adapter，CLI 无法构造"文件尾"；只挡增量
   不挡 rebuild）。游标自然推进无害。

### 3.3 复活路径全分析（v2 新增，v1 缺失）

| 路径 | 触发条件 | 挡板 |
|---|---|---|
| 增量 sync（守护 30s / `srelay sync`） | 原始文件新字节 | ignore `session:` + 墓碑 |
| **rebuild 全量重建**（建新库，墓碑随旧库进 .bak！） | 用户主动 rebuild | **ignore `session:` 规则存活于根目录文件**，`runSync` 两处入口（sync.ts:75 增量、sync.ts:117 手动注入）+ rebuild 复用的同一条 `loadIgnoreRules` 链路都会命中；**墓碑在 rebuild 后不存在**（新库无此表数据），所以墓碑只是次级防线 |
| runSync sessions 注入入口（sync.ts:112 manual origin） | save/导入路径 | 同上 ignore 检查已在 112-121 覆盖 |

结论：**ignore `session:` 规则是第一防线（跨 rebuild 存活），墓碑是第二防线（防 ignore 文件被用户清理）**。与 v1 相反（v1 把墓碑当主防线）。

### 3.4 审计：forget_log（删除本身被记住）

```sql
CREATE TABLE forget_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  triggered_by TEXT NOT NULL,      -- 'cli:forget'
  mode TEXT NOT NULL,              -- note | session | all
  criteria TEXT NOT NULL,
  sessions_affected INTEGER NOT NULL,
  messages_affected INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE forget_detail (
  forget_log_id INTEGER NOT NULL REFERENCES forget_log(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  title TEXT, source TEXT, message_count INTEGER, created_at TEXT
);
```

"删了什么"永久可查（`srelay forget --history`），检索不索引它。先例：cleanup_log/cleanup_detail。

**规范决策（评审 A1）**：`forget_detail.session_id` 为**裸 TEXT、故意无外键**——
被删行的 id 必须留在审计里，而审计链自身永不删除。与 `cleanup_detail.session_id` 同例。
此为显式决策而非疏漏，禁止后续"补上 FK"（会级联破坏审计）。

### 3.5 CLI 交互（两阶段确认）

```bash
srelay forget <id|前缀>          # 预览（无参不删——防误触）
srelay forget <id|前缀> --yes    # 执行
srelay forget --session <id> / --note <id>   # 类型过滤（id 形如 note-xxx 时自动识别）
srelay forget --all              # 整库重置：① 守护运行中直接拒绝（照抄 rebuild 拦截逻辑）
                                 # ② 要求 --confirm <projectId> 输入项目 id 逐字匹配（防脚本误触）
srelay forget --history          # 审计：默认紧凑表（时间/模式/影响数，评审 D3）
srelay forget --history --verbose # 展开每次影响的会话明细（对齐 archive --history --verbose 风格）
```

**前缀歧义防护（v3 新增）**：`findSessionByPrefix` 是 `LIKE prefix% LIMIT 1`——
`a` 会静默命中 `a3f8...` 也可能本意是 `a9...`，查询场景无害、**删除场景致命**。
forget 不复用它：改为先按前缀 COUNT，命中 >1 时列出全部候选并拒绝执行，
命中 =1 才进入预览。完整 id（32/16 位 hash 或 note- 前缀）直接精确匹配。
歧义输出**表格化（评审 D2）**：`id · 标题 · 日期 · 来源 · 条数` 逐行列出 +
提示"用更多字符或完整 id 重试"，不用一句话 error 打发。

预览（对齐 archive 的视觉语言，评审 D1）：

```
📊 遗忘预览（不可逆）
──────────────────────────────────────────
会话 a3f8c2d1 「数据库选型（PG vs MongoDB）」
  来源 zcode · 2026-08-20（13 天前）· 12 条消息 · 1 决策 · imported 否
  移除：对话正文 · 决策 · 话题 · 双向链接（对方 2 条：f1e2d3c4、b2a3c4d5）
  保留：原始会话文件（磁盘上不受影响，但本库不再收录）
  写入防复活闸：ignore session: 规则 + 墓碑
  审计：本次操作将记入 forget_log
  确认执行加 --yes
```

（会话年龄必须显示——用户对 id 无感、对"是不是那条三个月前的"有感。）

### 3.6 执行流程（单事务）

```
1. 解析 id：完整 id 精确匹配；前缀先 COUNT，>1 拒绝并列出候选（见 §3.5）
2. 预览统计（含双向链接对方列表 + imported 标记）
3. --yes 后单事务：
   a. sessions DELETE → CASCADE（FTS 双表触发器自动同步，已实验验证）
   b. forget_tombstones INSERT（若有原始文件；note/imported 跳过）
   c. .sessionrelayignore 追加 session: 规则（默认行为；--no-ignore 砍掉，见 §3.7）
   d. forget_log + forget_detail
4. 非 note 会话：warn 用户原始文件仍在磁盘，产品库不再收录
```

**并发安全（v3 新增）**：守护进程 30s 一次 sync 与 forget 并发写同一 WAL 库。
单事务 + `busy_timeout=5000` 已保证 SQL 层不撕裂；但"预览→--yes"两阶段之间
守护可能新捕消息，**执行时重新统计并 diff 预览数字**，不一致则提示重跑预览（乐观锁语义）。

### 3.7 --all 整库重置（v3 强化）

照抄 rebuild 的守护拦截（`isDaemonAlive` → 运行中直接拒绝），确认方式为
`--confirm <projectId>`（逐字匹配项目 id，不 --yes）。执行 = 关库文件三连删
（sqlite/-wal/-shm）+ 重建空库 + 保留 ignore 文件（含全部 session: 规则——
这正是防复活关键：库没了规则还在）。forget_log 随库删除，仅保留
`.sessionrelay/forgot-at-<ts>.txt` 摘要（何时删了整个库，最后一行审计）。

### 3.8 跨项目语义（v3 新增）

被删会话若已被 `.hop` 导出到其他项目，**对端不受影响也不通知**（各自项目独立库，
本产品无中心服务器）。forget `--history` 的 detail 行记录 origin，方便用户自查扩散。
文档明示：**forget 是项目级操作，不是全局 GDPR 删除按钮**；导出包一旦交出，
删除权已不在本工具管辖内（与"导出脱敏"防线分工）。

### 3.9 审计日志增长（v3 新增）

forget_log 无限增长问题：单条审计 <200B，个人项目删除频率极低（周级别个位数），
10 年量级 <1MB——**不做自动清理**；`--history --json` 供外部工具归档。

## 4. 兼容性与文档联动

- schema +2 表 +1 列类规则前缀；`user_version` 2→3，createDb 自动建表（M 迁移模式照旧）
- `.hop` 导出不含墓碑与审计；导入方不继承删除（交接知识不交接删除史）
- rebuild：ignore 规则存于根目录文件，跨 rebuild 存活（见 §3.3）
- MCP 契约测试加断言：工具清单恒 15 个
- **话术联动（评审 P2）**：`save_note` 返回文案改为
  "笔记已可被 search / get_decisions / export 检索；可由用户以 srelay forget 移除"——
  防 AI 基于旧话术向用户担保"永久可查"
- **AI 标准答复（评审 P3）**：search_sessions 等 15 工具的 description 不动，
  但用户文档写明：当用户要求 AI 删记忆时，AI 的标准答复是
  "我没有删除能力；请运行 srelay forget <会话id>，或告诉我 id 我帮你查出来"
- **文档入口（评审 P3）**：README 在"Scope 检索边界"之后新增
  "### 🧹 遗忘权（srelay forget）"小节（含 §2.1 选型口诀）；
  CLI 注册在数据命令组（save/rebuild 附近），description 一句话点明与 archive 的区别

## 5. 测试计划

1. 单元：ignore `session:` 匹配、墓碑 skip、审计行数、前缀歧义拒绝
2. 集成：删后 search/decisions/detail 全链路不命中；FTS integrity-check 通过
3. **复活对抗**（每个挡板单独测）：删→runSync 两入口→不复活；删→rebuild→不复活；
   删→清空 ignore 文件→sync→墓碑挡住→不复活
4. 契约：MCP 工具清单恒 15
5. dist 冒烟 + pack-e2e 补 forget 路径
6. **并发（v3）**：预览后人为插入新消息再 --yes → 断言 diff 警告且不执行

实现期已知盲区（设计评审判定就地裁决，不另开评审）：删除后 `source_files` 游标行残留，
`get_file_history` 可能返回零会话文件——实现时在查询处过滤已无会话的文件行（以 sessions 存在为准），并补单测。

## 6. 不做什么

- MCP 删除工具（永久）
- 部分消息删除（破坏原文完整承诺）
- 跨项目删除（scope 边界）
- 删原始文件（事实源不可碰）
- 游标推进（v2 降级为不做，理由见 §3.2）

## 7. 开放问题（交用户裁决）

1. ~~--all 确认形态~~ → v3 已定：`--confirm <projectId>` 逐字匹配（输入项目名）
2. ~~--no-ignore 价值~~ → v3 已定：砍掉（ignore 追加是防复活主防线，不可选退）
3. forget 后 scope_log 历史引用是否标注"已删" → 维持不标（审计表已可查，标注会让 scope_log 语义复杂化）

## 8. 审查记录

### 第一轮（架构与复活路径）——6 项修订
| # | v1 缺陷 | 证据 | v2 修订 |
|---|---|---|---|
| 1 | "ignore 追加会话标识"无对应机制——现有匹配器只有 source:/title:/glob 三种 | ignore.ts 全文 | 新增 `session:` 精确前缀规则 |
| 2 | 墓碑被当主防线，但 rebuild 建新库、墓碑随 .bak 消失 | rebuild.ts:29 `createDb(tmp)` | 防线对调：ignore 为主（跨 rebuild 存活），墓碑为次 |
| 3 | "游标推到文件尾"不可实现——cursor 结构 per-adapter | recordCursor/T34 注释 | 首版不做游标推进 |
| 4 | 预览漏双向链接影响 | session_links 双向 PK | 预览必含对方列表 |
| 5 | "sync 入口查墓碑"未定位——实际两入口 | sync.ts:75 / 117 | 明确两处调用点 |
| 6 | 复活路径分析缺失 | rebuild.ts 全文 | §3.3 三路径表 |

### 第二轮（对抗性与误用）——4 项修订
| # | v2 缺陷 | 证据 | v3 修订 |
|---|---|---|---|
| 7 | 前缀解析复用 findSessionByPrefix——LIKE % LIMIT 1 多命中静默取一，删除场景致命 | db.ts findSessionByPrefix | 忘记复用；先 COUNT，>1 拒绝并列表 |
| 8 | --all 时间窗确认可被脚本 sleep 后二次调用绕过 | — | 改为 --confirm <projectId> 逐字匹配 |
| 9 | forget 与守护 sync 并发：预览到执行之间守护可能新捕消息 | lock.ts/busy_timeout | 执行时重统计 diff，不一致则拒绝（乐观锁） |
| 10 | 跨项目扩散未定义：被删会话可能已随 .hop 导出 | import.ts origin | §3.8 明示项目级边界 + 文档声明 |

### 第三轮（收尾扫描）——1 项修订
| # | v2 缺陷 | 证据 | v3 修订 |
|---|---|---|---|
| 11 | forget_log 增长无交代 | maint.ts 无日志清理先例 | §3.9：体量估算 <1MB/10年，不清理 |
| 12 | --all 删除 forget_log 自身 → 审计链断 | — | 库外摘要文件 forgot-at-<ts>.txt |
| 13 | imported 会话删了无法 rebuild 回来，预览未警示 | rebuild.ts 仅搬迁 imported | 预览必含 imported 标记 |

### 第四轮（三角色评审：产品经理 / 架构师 / 设计师）——7 项折入 v4
| # | 级别 | 发现 | v4 修订 |
|---|---|---|---|
| 14 | P0 | 与 archive --hard 语义重叠，用户无从选择；且 --hard 无防复活闸 | §2.1 裁决表 + 选型口诀；archive --hard --help 加 forget 提示 |
| 15 | P1 | forget_detail.session_id 裸 TEXT 无 FK 会被当 bug 补 FK，级联破坏审计 | §3.4 显式规范决策 |
| 16 | P1 | 墓碑查询形态未定，留有 per-message 查询口子 | §3.2 定为 loadTombstones 整表 Set，禁止点查 |
| 17 | P2 | save_note 承诺"可检索"在 forget 时代成为假话 | §4 话术联动 |
| 18 | P2 | 可发现性未定义（CLI 位置/README/AI 标准答复） | §4 文档入口三处 |
| 19 | P2 | 预览缺年龄与保留/移除两栏（对齐 archive 视觉语言） | §3.5 预览模板 |
| 20 | P3 | 歧义报错体验与 --history 输出密度未设计 | §3.5 表格化候选；--history 默认紧凑 |
