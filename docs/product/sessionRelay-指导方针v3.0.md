# 会话接力 SessionRelay — 产品与技术指导方针

> ⚠️ **已归档（2026-08-28）**：本文已被 `sessionRelay-指导方针v3.1.md`（Review #2）取代，仅作历史档案保留。

> **版本**：v3.0（Master Guideline）
> **日期**：2026-08-28
> **性质**：本文档是本产品**唯一有效的指导方针**，吸收并取代 v1.0、v2.0 产品文档与 v2.1 评审纪要的全部有效结论，修复其全部已知缺陷。旧文档降级为历史档案，与本文冲突之处一律以本文为准。
> **产品名**：会话接力（SessionRelay）。SessionGraph / sessiongraph 命名即日退役。
> **维护方式**：活文档。每次评审在头部追加 `Review #N` 与日期，并在第十七章决策日志中登记变更。

------

## 目录

1. [产品身份与命名](#一产品身份与命名)
2. [定位与战略](#二定位与战略)
3. [用户与场景](#三用户与场景)
4. [产品原则（十条）](#四产品原则十条)
5. [功能全景](#五功能全景)
6. [核心机制规范](#六核心机制规范)
7. [数据模型与 Schema](#七数据模型与-schema)
8. [CLI 命令规范](#八cli-命令规范)
9. [MCP 工具规范](#九mcp-工具规范)
10. [HOP 交接包协议](#十hop-交接包协议)
11. [整体架构](#十一整体架构)
12. [开发计划（重估版）](#十二开发计划重估版)
13. [风险登记册](#十三风险登记册)
14. [验收与度量](#十四验收与度量)
15. [非目标](#十五非目标)
16. [与旧文档的关系](#十六与旧文档的关系)
17. [决策日志](#十七决策日志)

------

## 一、产品身份与命名

### 1.1 一句话定义

> **会话接力是一个属于项目、不属于任何厂商的本地记忆层：完整收录你与所有 AI 编程助手的会话，让你划定检索边界，并把知识以标准交接包的形式传递给下一个人。**

### 1.2 命名规范（全局生效）

| 对象 | 命名 | 说明 |
| ---- | ---- | ---- |
| 产品中文名 | **会话接力** | 命中产品本质：跨时间、跨工具、跨人的三棒接力 |
| 产品英文名 | **SessionRelay** | "Graph" 恰是产品明确不做的东西，退役 |
| CLI 命令 | **`srelay`** | 短、无歧义；`sessionrelay` 作长别名 |
| 项目内目录 | **`.sessionrelay/`** | 含 db、config、scope.json |
| 数据库文件 | `relay.sqlite` | WAL 模式 |
| 隐私排除文件 | **`.sessionrelayignore`** | 语法沿用 gitignore |
| 交接包格式 | **HOP（Handoff Package）**，扩展名 **`.hop`** | 产品中立的协议名（接力棒之意），见第十章 |
| 交接包格式 ID | `hop/1.0` | 写入 manifest，供第三方识别 |

### 1.3 产品哲学（写入 README 首屏）

> **Memory is always complete. Retrieval is always yours to shape.**
> 记忆始终完整收录；检索边界由你划定。
> 内存不该猜你想看什么，该由你来画地图。

品牌文案（保留 v2.0 原句）：

> "你和 AI 聊了 3 天的方案，不应该随关窗消失；它属于项目，属于下一个接手的人。"

------

## 二、定位与战略

### 2.1 定位：中立记忆层

**核心身份不是"又一个记忆工具"，而是"唯一属于项目、不属于任何厂商的记忆层"。**

结构性的理由：没有任何厂商会去索引竞品的会话——Claude 不会读 ZCode 的日志，反之亦然。**跨厂商中立性是本产品唯一"别人做不了"的属性**，必须升格为对外叙事的第一句，而不是七分之一的功能点。

### 2.2 三大支柱（对外叙事，替代已证伪的"零竞品"表述）

> 我们是唯一同时做齐这三件事的项目：
> 1️⃣ **全量被动捕获，零打扰**（配显式隐私控制，不是黑盒录音）
> 2️⃣ **国产 Agent（ZCode / DSH / 通义灵码 / iFlyCode）一手 Adapter**
> 3️⃣ **结构化团队交接协议 HOP**——AI 直接拥有上下文，格式开放、第三方可读

### 2.3 竞争格局（校准后，沿用评审结论）

- "跨 Agent + 本地 + 免费"已是红海：claude-mem（~62k★，仅 Claude）、Mem0、Supermemory、ai-memory（重叠度极高，其 Markdown 交接机制与本产品撞车）、Memorix（号称 7 Agent，中文社区活跃）、agentmemory、omem、Memori、Aegis Memory。
- **删除一切"零竞品/品类空白"表述**；评分卡差异化自评不得超过 ⭐⭐⭐½。
- 三个必须盯的对手：claude-mem 是否扩展多 agent；ai-memory 的交接格式是否协议化；Memorix 是否冲英文社区。
- 文档中的市场数字（62.6k★、642 亿市场）一律视为待核引用，**不得作为决策依据**。

### 2.4 战略排序：协议优先

产品作为"功能"活不过平台补齐记忆的窗口（官方内置 + 长上下文，估计 12-24 个月）；作为"协议"（HOP 被第三方阅读和采用）才可能像 git 一样中立长存。因此：

1. HOP 规格独立成文（`spec/hop-1.0.md`，MIT 授权），与产品文档分离，**第一周就写**；
2. 每一次交接都是格式的外溢机会，export 永远免费；
3. 护城河优先级：**协议采纳 > 国产 adapter 深度 > 功能完备**。

### 2.5 窗口判断

6-12 个月。胜负手不在代码量，在两件事：国产 adapter 先做扎实；HOP 尽早长出产品之外。

------

## 三、用户与场景

### 3.1 用户画像

| 画像 | 描述 | 核心诉求 |
| ---- | ---- | ---- |
| 重度多工具开发者（自己就是一号用户） | 同时用 Claude Code / ZCode / DSH，日均多会话 | 跨时间、跨工具不失忆 |
| 交接者 | 项目转手、轮岗、离职 | 聊过 3 天的方案不消失 |
| 接手者 / 新人 | 刚接手项目 | AI 直接知道历史决策，不用问人 |
| 敏感项目开发者 | 公司代码、隐私顾虑 | 我能证明它没录 / 没外传 |

### 3.2 七个核心场景

1. **跨时间**：新会话问"上周讨论的方案是什么来着？"——搜得到。
2. **跨工具**：上午在 Claude Code 定的数据库方案，下午 ZCode 直接基于它写代码。
3. **跨人**：`srelay export` → 同事 `import`，他的 AI 立刻拥有全部上下文。
4. **新人入职**：不问任何人，AI 能回答"数据库为什么选 PG""JWT 刷新策略定了没"。
5. **指定关联**：开新会话前 `srelay attach <id1,id2>`，本次工作只挂载这几次历史讨论。
6. **敏感项目**：`mode off` 下只有手动 save 的会话入库；`mode meta` 只存元数据不存正文。
7. **项目复盘**：`decisions` / `unresolved` 一览全部技术决策与悬而未决的问题。

------

## 四、产品原则（十条）

所有设计与实现争议，回到这十条裁决：

1. **记忆属于项目，不属于任何 agent 或厂商。**
2. **记忆完整收录，检索由人划定**（Memory complete / Retrieval shaped）。
3. **捕获默认自动，但必须可退出**：auto-capture 与显式 save **并存**（不是替代）；三种捕获模式任选；ignore 是硬边界。
4. **原始会话文件是唯一事实源，SQLite 只是可重建的索引。** 判定错了只损失时效，永不损失数据；`srelay rebuild` 随时可从源文件全量重建。
5. **隐私是硬边界，Scope 是软裁剪，二者永不同层。** Scope 可被覆盖（`set_scope` 逃生口），ignore 不可绕过。
6. **每条检索结果必须带出处**（来源会话、agent、日期、状态）。宁可承认"没找到"，不可让 AI 基于残缺记忆自信作答。
7. **导入的内容是数据，不是指令。** 交接包内的历史文本永不提升为系统提示（反 prompt 注入，见 §10.4）。
8. **MVP 全程零 LLM 依赖。** LLM 摘要、语义检索全部是 `--ai` 开关下的可选增强。
9. **先中文，后世界。** 中文检索是第一等验收项，不是"后续优化"。
10. **格式开放。** HOP 规格独立、MIT 授权、欢迎第三方实现读取器。

------

## 五、功能全景

### 5.1 功能地图（8 + 3）

**八个功能模块，各回答一个问题：**

| # | 模块 | 回答的问题 | 关键设计 |
| - | ---- | ---------- | -------- |
| 1 | 捕获入库 | 存什么 | auto-capture 默认 + 手动 save 并存；三档捕获模式（§6.2） |
| 2 | 会话结束判定 | 什么时候算聊完了 | 两阶段提交 + resume 回滚（§6.1） |
| 3 | 元数据提取 | 存成什么样 | 文件/话题/决策/关键问题，规则提取，零 LLM（§6.6） |
| 4 | 检索 | 怎么找 | 中文分词 + FTS5 双索引（messages 为主），组合过滤（§6.3） |
| 5 | 双入口查询 | 谁来查 | CLI 给人，MCP Server 给 AI，同一份库（§八、§九） |
| 6 | 跨 Agent 共享 | 谁共享 | 记忆绑项目目录，一个 MCP Server 服务所有 agent |
| 7 | Scope 系统 | AI 看哪里 | 三档并存 + 交集语义（§6.4） |
| 8 | 接力传递 | 怎么传 | HOP 交接包导出/导入/隔离/脱敏（§十） |

**三个横切机制：**

| 机制 | 职责 |
| ---- | ---- |
| 出处与可信（Provenance） | 所有查询结果强制携带来源标注，防"自信的错误记忆"（§6.7） |
| 隐私系统 | 捕获模式 × ignore × 导出脱敏，三层防线（§6.2） |
| 增量同步与重建 | hash 对比增量捕获；`rebuild` 全量重建（原则 4） |

### 5.2 范式定案

| 维度 | v1/v2.0（旧） | **v3.0（本方针）** |
| ---- | ------------- | ------------------ |
| 存储 | 显式 save，反人性，冷启动差 | **auto-capture 默认开启；显式 save 并存保留**（补录、敏感项目、关掉自动后的唯一入口） |
| 查询 | 每次手动传 filter | 一次性 Scope 契约 + 调用时收窄 |
| 冷启动 | 空 DB 即"没用" | 装完即自动积累，次日可搜到昨天会话 |
| 隐私 | 存前可选 | **三档模式 + ignore + 导出脱敏**，比 v1.0 更强而非更弱 |
| 会话关联 | 无 | `attach` 挂载指定会话（§6.5），落为最高优先级 Scope 谓词 |

------

## 六、核心机制规范

### 6.1 捕获与会话结束判定

**原则：分层叠加，Adapter 封装复杂度，主程序只看统一事件流；绝不在 MCP 层做结束判定。**

```
捕获（写入即 active，零过滤）
  ↓ mtime 静默 ≥ idle_threshold（默认 10 min）且 Adapter 结束信号成立（如可得）
  ↓ 转 pending_end（生成规则元数据，不入主索引、不固化摘要）
  ↓ 再静默 ≥ cooldown_period（默认 6 h）无变化
  ↓ confirmed（纳入 FTS 主索引 + 提取 decisions/topics + 生成免费规则摘要 summary_rule）
```

- **Resume 回滚**：JSONL 行数增长或 hash 变化 → 任意状态立即回滚 active，清除 summary_rule 重算。JSONL 是 append-only、可跨天、`--resume` 可复活旧文件——单点检测必然误判，回滚是常态路径而非异常。
- **Adapter 信号声明**：每个 Adapter 声明自己最可信的结束信号（Claude Code → SessionEnd hook 为主、mtime 兜底；IDE 类 → host lifecycle；未适配期 → mtime heuristic only），拿不到就 fallthrough 下一层。
- **事件队列**：钩子层写队列，worker 异步处理，绝不阻塞 agent 主流程（claude-mem 的 Stop 死循环教训）。
- **手动干预**：`srelay confirm <id>` 强制转 confirmed；`srelay purge --pending` 一键清除全部未固化会话。
- **参数入配置**：`idle_threshold_min` / `cooldown_hours` 写入 `.sessionrelay/config.json`，项目级可调。
- **安全网**：原始 JSONL 永久保留、永不修改；pending 只是缓存优化，判错不丢数据。

### 6.2 隐私系统（三层防线）

auto-capture 后隐私叙事必须**比显式存储时代更强**，不是更弱：

| 层 | 机制 | 性质 |
| -- | ---- | ---- |
| 捕获层 | **三档模式**：`full`（默认，全量+ignore 排除）/ `meta`（只存元数据与统计，**不存消息正文**，检索只命中标题/话题/决策）/ `off`（关闭自动捕获，仅手动 save） | `srelay mode <full\|meta\|off>` |
| 边界层 | `.sessionrelayignore`，gitignore 语法，匹配 files/topics/tags/source | 硬边界，任何命令不可绕过 |
| 外发层 | 导出默认开启密钥脱敏（§10.4）+ `--exclude-tag` + `--decisions-only` + 交互式勾选 | 数据出项目前的最后一关 |

配套透明度：`srelay status` 面板实时显示当前模式、已捕获 N / pending K / confirmed M、被 ignore 拦截的条目数、库体积——**让用户随时能证明"它录了什么"**。

### 6.3 中文检索方案（v1/v2 的技术地雷，此处拆除）

FTS5 默认 unicode61 分词器不切中文（整句一个 token，搜"数据库"命中不了正文），trigram 分词器又挂掉二字词（"索引""认证"是最常见的查询）。方案定案：

**入库前分词（jieba）+ 空格连接 + unicode61 索引。**

```
写入: content → 规范化(小写/NFC) → jieba cutForSearch 切分 CJK 连续段
      → 英文/代码按 unicode61 规则切分 → 空格连接 → 写入 messages.search_text
查询: 同一管线处理 query → FTS5 MATCH (token1 AND token2 ...)，支持 "..." 短语
```

- 依赖选型：`@node-rs/jieba`（napi 预编译，Windows 免编译；若不可接受，回退方案为 **CJK bigram**——零依赖、索引约 1.5-2 倍、不支持单字查询）。
- **双索引面**：`messages_fts`（正文，主检索面，v2.0 竟然没建）+ `sessions_fts`（标题/话题/决策/标签/规则摘要拼接的 meta_text，覆盖 meta 模式与元数据命中）。
- 排序：bm25 为主，created_at 近期加权微调；confirmed 优先于 pending。
- **非目标**：拼音检索、模糊音、语义向量（Phase 4 可选）。
- 验收用例（进 Phase 1 门槛，见 §14）："索引"命中含"建索引"的会话；"认证方案"命中"用 JWT 做认证"；中英混合"JWT 过期"可查。

### 6.4 Scope 系统

**定位：Scope = 相关性裁剪（软、可覆盖）；隐私 = 数据边界（硬、不可绕过）。永不同层，UI 不做同层入口。**

三档并存，各司其职：

| 档 | 名称 | 触发 | 特性 |
| -- | ---- | ---- | ---- |
| A | silent auto-scope | 每次启动隐性 | cwd + git branch（可得时）+ 最近 N 天，零交互 |
| B | **CLI scope.json（主力）** | `srelay scope set/add/reset/show` | 写入 `.sessionrelay/scope.json`，本项目共享，类似 .gitignore 的显式范围契约 |
| C | TUI `scope pick` / MCP `set_scope` | 仅 fallback / 逃生口 | 列候选勾选；**绝不自动弹出**；`set_scope({mode:'full'})` 是收太紧时的逃生口 |

**谓词而非 ID 白名单**（发现悖论 + 漏挑即失忆）：五维谓词 topic / tag / file / time / source 组合为默认主力；`--sessions <ids>` 显式 ID 作为**最高优先级特例**（服务 attach 场景），且存谓词表达式、查询时动态展开（防 pending 会话 resume 后快照过期）。

**交集语义（对 v2.1 优先级链的修正）**：

```
生效范围 = scope.json 谓词 ∩ 调用时参数 ∩ auto-scope 兜底
隐私 ignore 恒定生效（集合之外，任何档不可触碰）
唯一放行通道: set_scope({mode:'full'}) —— 只解除 A/B/C 的裁剪，永远解除不了 ignore
```

即：调用时参数与 scope.json 只能互相**收窄**，不能互相放宽。这消除了 v2.1 平铺优先级链里"agent 用参数绕开项目契约"的歧义。

**命中不足提示**：FTS5 命中数 < 阈值（默认 3）时返回 hint：`"当前 scope 命中 N 条，全库另有 M 条可用，可 set_scope({mode:'full'}) 放宽"`。

**已知坑与对策**：scope 收太紧 → hint + 逃生口；国产 agent 无 cwd/git → Adapter 声明各自最强身份信号，拿不到 fallthrough；同窗口多 agent 并发 → MVP 按 project+cwd 归属（已知会串台，接受），Phase 4 引入 branch/PID 归属。

### 6.5 会话关联与挂载（新增功能，正式落位）

用户需求原话："开启新会话时，可以选择关联哪几次会话。"

- **MVP 落位**：`srelay attach <session-ids...>` = 把当前 Scope 设为恰含这几个会话的谓词（最高优先级），并写入 `session_links(kind='pinned')` 留痕；`srelay detach` 恢复。不发明新实体，复用 Scope。
- **Phase 4 升级**：MCP 具备会话身份（branch/PID）后，links 升为一等关系（`continues` / `related`），新增 MCP 工具 `get_linked_sessions`，实现"本会话挂载了哪些历史讨论"的显式语义。
- **理由**：MCP stdio 无会话 ID（评审 Q1），MVP 阶段任何"本次会话私有"的关联都无法可靠归属，强行做必然串台。

### 6.6 元数据提取与摘要分层

| 元数据 | 方式 | LLM |
| ------ | ---- | --- |
| files_mentioned | 文件路径正则 | ❌ |
| code_changes | 代码块检测 + 上下文关键词 | ❌ |
| topics | TF-IDF / TextRank | ❌ |
| decisions | 句式匹配（决定/选择/采用/放弃/最终用） | ❌ |
| key_questions | 问号句提取 | ❌ |
| user_tags / user_summary | 用户 CLI 输入 | ❌ |

**摘要三层（吸收用户口述需求，补齐 v2.0 缺口）**：

| 层 | 生成时机 | 成本 | 用途 |
| -- | -------- | ---- | ---- |
| `summary_rule`（规则摘要：决策 + 未解决问题 + 时间线 + 首问标题） | confirmed 时**免费自动** | 零 LLM | HANDOFF.md 的组装原料、列表页展示 |
| `user_summary` | 用户手动 | 零 | 用户权威覆盖，排序权重最高 |
| `summary_ai` | `--ai` 开关 | LLM | Phase 4 可选增强，自然语言总结 |

### 6.7 出处与可信检索（v1/v2 均缺失，本次补上）

**失败模式**：元数据准确率 60-70% 时，检索返回片面结果，AI 基于残缺记忆"自信作答"——比失忆更糟，被骗一次用户永久弃用。

**对策（强制契约）**：

1. 所有 MCP/CLI 检索结果**逐条携带出处块**：`{session_id, source(agent), created_at, state, excerpt(截断), 匹配位置}`；
2. MCP Server 在 system prompt 模板中要求 agent 引用出处作答（"根据 2026-08-20 在 Claude Code 中的讨论……"）；
3. 无命中时明确返回"未找到"而非空猜；
4. `get_decisions` 返回决策原文 + 支撑上下文片段，不返回孤句。

------

## 七、数据模型与 Schema

> 修复 v2.0 Schema 两处致命错误：① `content='sessions'` 外部内容表引用了不存在的列；② 检索主面 messages 正文竟无全文索引。
> 本 DDL 为可直接执行的定案版本（SQLite ≥ 3.37，启用 FTS5 + JSON1 + WAL）。

### 7.1 统一会话模型（TypeScript）

```typescript
type CaptureOrigin = 'auto' | 'manual' | 'imported';
type SessionState  = 'active' | 'pending_end' | 'confirmed';

interface UnifiedSession {
  id: string;                      // hash(source + ':' + source_session_id)
  source: 'claude-code'|'zcode'|'dsh'|'cursor'|'custom';
  source_session_id: string;
  project_id: string;
  origin: CaptureOrigin;           // 并存范式的落库字段
  state: SessionState;
  git_branch?: string;
  created_at: string;              // 首条消息时间
  last_event_at?: string;
  confirmed_at?: string;
  title?: string;                  // 规则生成：首个用户消息截断

  messages: UnifiedMessage[];

  // 自动提取（JSON 数组字符串落库）
  files_mentioned: string[];
  topics: string[];
  decisions: { text: string; at: string }[];
  key_questions: string[];
  code_changes?: string[];

  // 摘要三层
  summary_rule?: string;
  summary_ai?: string;             // Phase 4
  user_summary?: string;

  user_tags: string[];
  author?: string;
  imported_from?: string;
}

interface UnifiedMessage {
  role: 'user'|'assistant'|'system'|'tool';
  content: string;                 // 原文（meta 模式下不落库）
  seq_num: number;
  created_at?: string;
}
```

### 7.2 DDL（定案）

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ═══════════ 会话表 ═══════════
CREATE TABLE sessions (
    id                TEXT PRIMARY KEY,
    source            TEXT NOT NULL,
    source_session_id TEXT NOT NULL,
    project_id        TEXT NOT NULL,
    origin            TEXT NOT NULL DEFAULT 'auto',    -- auto | manual | imported
    state             TEXT NOT NULL DEFAULT 'active',  -- active | pending_end | confirmed
    git_branch        TEXT,
    title             TEXT,
    created_at        TEXT NOT NULL,
    last_event_at     TEXT,
    confirmed_at      TEXT,
    message_count     INTEGER NOT NULL DEFAULT 0,

    files_mentioned   TEXT,   -- JSON array
    topics            TEXT,   -- JSON array
    decisions         TEXT,   -- JSON array [{text, at}]
    key_questions     TEXT,   -- JSON array
    code_changes      TEXT,   -- JSON array

    summary_rule      TEXT,
    summary_ai        TEXT,
    user_summary      TEXT,
    user_tags         TEXT,   -- JSON array

    author            TEXT,
    imported_from     TEXT,

    content_hash      TEXT,   -- 源文件 hash（resume 检测）
    source_file       TEXT,
    synced_at         TEXT
);
CREATE UNIQUE INDEX ux_sessions_src ON sessions(source, source_session_id);
CREATE INDEX idx_sessions_project ON sessions(project_id);
CREATE INDEX idx_sessions_state   ON sessions(state);
CREATE INDEX idx_sessions_created ON sessions(created_at);
CREATE INDEX idx_sessions_author  ON sessions(author);
CREATE INDEX idx_sessions_branch  ON sessions(git_branch);

-- ═══════════ 消息表（检索主面）═══════════
CREATE TABLE messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    role        TEXT NOT NULL,
    content     TEXT NOT NULL,     -- 原文；meta 模式不写入本表
    search_text TEXT,              -- 分词后文本（§6.3），检索用
    seq_num     INTEGER NOT NULL,
    created_at  TEXT
);
CREATE INDEX idx_messages_session ON messages(session_id, seq_num);

-- ═══════════ 正文全文索引（外部内容表，修复版）═══════════
CREATE VIRTUAL TABLE messages_fts USING fts5(
    search_text,
    content='messages',
    content_rowid='id'
);
CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, search_text) VALUES (new.id, new.search_text);
END;
CREATE TRIGGER messages_fts_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, search_text)
        VALUES ('delete', old.id, old.search_text);
END;
CREATE TRIGGER messages_fts_au AFTER UPDATE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, search_text)
        VALUES ('delete', old.id, old.search_text);
    INSERT INTO messages_fts(rowid, search_text) VALUES (new.id, new.search_text);
END;

-- ═══════════ 会话元数据索引（meta 模式 + 元数据命中）═══════════
-- sessions.meta_text = 分词后(title + topics + decisions + tags + summary_rule 拼接)
CREATE VIRTUAL TABLE sessions_fts USING fts5(
    meta_text,
    content='sessions',
    content_rowid='rowid'
);
CREATE TRIGGER sessions_fts_au AFTER UPDATE OF meta_text ON sessions BEGIN
    INSERT INTO sessions_fts(sessions_fts, rowid, meta_text)
        VALUES ('delete', old.rowid, old.meta_text);
    INSERT INTO sessions_fts(rowid, meta_text) VALUES (new.rowid, new.meta_text);
END;

-- ═══════════ 会话关联（attach 留痕，Phase 4 升一等关系）═══════════
CREATE TABLE session_links (
    session_id        TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    linked_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    kind              TEXT NOT NULL DEFAULT 'pinned',  -- pinned | continues | related
    created_at        TEXT NOT NULL,
    PRIMARY KEY (session_id, linked_session_id, kind)
);

-- ═══════════ 捕获源状态（增量同步）═══════════
CREATE TABLE source_files (
    source     TEXT NOT NULL,
    file_path  TEXT NOT NULL,
    file_hash  TEXT NOT NULL,
    line_count INTEGER,
    last_seen  TEXT NOT NULL,
    deleted    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (source, file_path)
);

-- ═══════════ Scope 审计日志（Team 版复用）═══════════
CREATE TABLE scope_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    action     TEXT NOT NULL,      -- set | add | reset | attach | detach
    predicate  TEXT NOT NULL,      -- 谓词 JSON
    issued_by  TEXT,
    created_at TEXT NOT NULL
);

-- ═══════════ 导入/导出日志 ═══════════
CREATE TABLE transfer_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    type        TEXT NOT NULL,     -- export | import
    file_path   TEXT NOT NULL,
    from_user   TEXT,
    to_user     TEXT,
    session_ids TEXT,              -- JSON array
    created_at  TEXT NOT NULL
);
```

### 7.3 查询语义备忘

- 正文检索：`messages_fts MATCH ?` → join sessions 取过滤列；
- 元数据过滤：`EXISTS (SELECT 1 FROM json_each(s.topics) WHERE json_each.value = ?)`（千级会话规模足够；达到万级再谈倒排优化，属过早优化）；
- `rebuild`：`origin IN ('auto','manual')` 的会话可从 source_files 全量重建；`imported` 会话仅存于库中，rebuild 时跳过并保留。

------

## 八、CLI 命令规范

命令名 `srelay`。分组列出（`[]` 可选，`<>` 必填）：

### 8.1 捕获与状态

```bash
srelay init                      # 初始化 .sessionrelay/，写入默认 config
srelay watch [--foreground]      # auto-capture 守护（默认模式，读 config.capture）
srelay sync                      # 一次性增量捕获
srelay rebuild [--force]         # 从原始源文件全量重建索引（原则 4）
srelay save <id> [--tag T] [--summary S] [--source SRC]   # 手动存（与自动并存）
srelay save --recent 7d
srelay save --interactive
srelay mode <full|meta|off>      # 捕获模式切换
srelay status                    # 透明度面板：模式/N-K-M 计数/ignore 拦截数/库体积
srelay confirm <id>              # 手动强制 confirmed
srelay purge [--pending | --id ID]
srelay doctor                    # 环境自检：FTS5/分词器/adapter/源目录可达性
```

### 8.2 查询

```bash
srelay search <query> [--topic T] [--tag T] [--file F] [--source S]
                     [--since D] [--until D] [--state ST] [--limit N]
srelay show <session-id> [--range 5:20]
srelay decisions [--topic T]
srelay history <file-path>
srelay unresolved
```

### 8.3 Scope 与关联

```bash
srelay scope set --topic auth --since 7d
srelay scope add --tag architecture-decision
srelay scope show / reset
srelay scope pick                # TUI，仅 fallback，绝不自动弹出
srelay attach <id...>            # 关联挂载（§6.5）：Scope=恰含这些会话 + 写 session_links
srelay detach
```

### 8.4 接力（导出/导入/团队）

```bash
srelay export [--project P] [--topic T] [--tag T] [--since D] [--file F]
              [--source S] [--exclude-tag T] [--decisions-only]
              [--format hop|markdown|summary] [--output F]
              [--interactive] [--all] [--no-redact]
srelay import <pkg.hop> [--merge] [--from NAME] [--quarantine] [--release ID]
srelay team status | log
```

### 8.5 服务

```bash
srelay serve                     # MCP Server（stdio）
```

### 8.6 项目配置 `.sessionrelay/config.json`

```json
{
  "version": "1.0",
  "capture": {
    "mode": "full",
    "idle_threshold_min": 10,
    "cooldown_hours": 6,
    "sources": ["claude-code", "zcode"]
  },
  "search": { "tokenizer": "jieba", "min_hits_hint": 3 },
  "privacy": { "ignore_file": ".sessionrelayignore", "export_redact": true },
  "identity": { "project_id": "my-app", "author": "zhangsan" }
}
```

------

## 九、MCP 工具规范

**通用契约**：所有检索类工具返回结果**逐条携带出处块**（§6.7）；全部默认受 Scope 交集语义约束（§6.4）；隐私 ignore 恒定生效。

| Tool | 描述 | Scope-aware | 出处 | 参数 |
| ---- | ---- |:-----------:|:----:| ---- |
| `search_sessions` | 中文全文搜索 + 元数据过滤 | ✅ | ✅ | query, topic?, tag?, file?, source?, since?, limit? |
| `get_session_detail` | 会话完整消息或片段 | ✅ | ✅ | session_id, start_msg?, end_msg? |
| `list_sessions` | 列会话（带过滤） | ✅ | — | topic?, tag?, file?, source?, since?, limit? |
| `get_decisions` | 决策列表（带支撑上下文） | ✅ | ✅ | topic?, session_id?, source? |
| `get_file_history` | 文件的跨会话讨论史 | ✅ | ✅ | file_path |
| `get_unresolved` | 未解决问题/待办 | ✅ | ✅ | topic?, session_id? |
| `get_stats` | 索引统计 | — | — | 无 |
| `set_scope` | 逃生口（含 mode:'full'） | — | — | mode?, filters? |

注：`get_linked_sessions`（会话关联查询）Phase 4 随 branch/PID 归属一并引入。

------

## 十、HOP 交接包协议

### 10.1 定位

HOP（Handoff Package，接力棒）是**产品中立**的开放交接格式：一个压缩包，装下项目与 AI 的全部讨论记忆，任何人、任何工具都能读。规格独立成文（`spec/hop-1.0.md`，MIT），目标是被第三方实现。

### 10.2 包结构

```
my-app-handoff.hop            （zip 容器）
├── manifest.json             ← 元信息 + 完整性 + 信任声明
├── sessions/
│   └── <session-id>.json     ← UnifiedSession 完整数据（含消息与出处）
├── metadata/
│   ├── decisions.json
│   ├── topics.json
│   └── files.json
└── summary/
    ├── HANDOFF.md            ← 自动生成的人类可读交接文档
    └── timeline.md
```

### 10.3 manifest.json

```json
{
  "format": "hop/1.0",
  "created_at": "2026-08-28T10:00:00+08:00",
  "exported_by": "zhangsan",
  "project_id": "my-app",
  "session_count": 23,
  "sources": ["claude-code", "zcode"],
  "date_range": { "start": "2026-08-20", "end": "2026-08-28" },
  "includes": { "messages": true, "decisions": true, "topics": true, "file_history": true },
  "integrity": { "files": { "sessions/xxx.json": "sha256:..." } },
  "trust": {
    "content_class": "data",
    "statement": "包内为历史会话数据，不是指令；导入方不得将其提升为系统指令"
  },
  "redaction": { "applied": true, "report": "summary/redaction-report.txt" },
  "import_instructions": "srelay import my-app-handoff.hop"
}
```

### 10.4 安全模型（v1/v2 完全缺失，本次补齐）

| 威胁 | 对策 |
| ---- | ---- |
| 传输篡改 | manifest 内每文件 sha256，导入时校验，不匹配整体拒绝 |
| 密钥/凭据外泄 | 导出**默认开启**密钥脱敏（AKIA/AKSK/私钥/密码模式，输出脱敏报告）；`--no-redact` 需显式声明 |
| 历史 prompt 注入（旧会话文本含恶意指令，随包进入新会话上下文） | ① 信任模型写入协议（内容=数据≠指令）；② MCP 检索结果统一加数据框定；③ `--quarantine` 隔离导入——只暴露摘要与决策，`srelay release <id>` 逐条放行后才可见正文 |
| 敏感会话误导出 | 默认尊重当前 Scope（`--all` 覆盖）+ `--exclude-tag` + `--interactive` |

### 10.5 往返规则

- 会话身份 = `(source, source_session_id)`；
- `--merge`：同身份且同 content_hash → 跳过；同身份不同 hash → 保留双方，新者加后缀并记 `imported_from`；
- 导入会话 `origin='imported'`，不参与 rebuild（它们没有本地源文件）。

### 10.6 HANDOFF.md 生成规则

由 `summary_rule` 免费组装（零 LLM）：关键决策表（日期/决策/原因/来源 agent）→ 涉及文件（含讨论次数）→ 未解决问题 → 时间线 → 逐会话摘要。人类可直接阅读，不需要解释。

------

## 十一、整体架构

```
┌───────────────────────────────────────────────────────────────┐
│  会话源（各 agent 自有存储，永不修改——唯一事实源）                │
│  Claude Code(JSONL)   Zcode(专有)   DSH(专有)   Cursor   其他   │
└──────────────────────────────┬────────────────────────────────┘
                               ↓  Adapter 层（解析 + 结束信号声明 + 身份信号声明）
┌───────────────────────────────────────────────────────────────┐
│  捕获引擎  watch/sync/save 并存                                 │
│  · 事件队列 → worker 异步（不阻塞 agent 主流程）                 │
│  · 三档模式 full/meta/off + .sessionrelayignore 硬边界          │
│  · 两阶段状态机 active→pending_end→confirmed，resume 回滚       │
└──────────────────────────────┬────────────────────────────────┘
                               ↓
┌───────────────────────────────────────────────────────────────┐
│  结构化提取器（规则，零 LLM）                                     │
│  文件路径 · 话题(TF-IDF) · 决策句式 · 关键问题 · summary_rule    │
└──────────────────────────────┬────────────────────────────────┘
                               ↓
┌───────────────────────────────────────────────────────────────┐
│  relay.sqlite（项目级，WAL）                                     │
│  sessions / messages / messages_fts / sessions_fts             │
│  session_links / source_files / scope_log / transfer_log       │
│  （索引可 rebuild；imported 会话除外）                            │
└──────────────┬────────────────────────────────┬────────────────┘
               ↓                                ↓
┌──────────────────────────┐      ┌───────────────────────────────┐
│  CLI（srelay，人类）        │      │  MCP Server（srelay serve，AI）│
│  search/decisions/history │      │  8 tools · Scope 交集语义      │
│  scope/attach · mode      │      │  出处块强制 · 命中不足 hint     │
└────────────┬─────────────┘      └───────────────┬───────────────┘
             └──────────────┬─────────────────────┘
                            ↓
┌───────────────────────────────────────────────────────────────┐
│  接力层：HOP 导出/导入 · 脱敏 · 隔离 · team 审计                  │
│  （协议独立开放，目标是第三方愿意读 .hop）                         │
└───────────────────────────────────────────────────────────────┘
```

并发说明：`watch` 守护进程是唯一常驻写者；CLI 短命令以短暂写锁操作（save/scope/mode），SQLite WAL 支撑读写并发，另加 `.sessionrelay/lock` 防双守护。

技术栈定案：TypeScript (Node.js) · SQLite (better-sqlite3) · FTS5 + @node-rs/jieba · Commander.js · MCP SDK (stdio) · fs.watch。零云依赖、零 LLM 依赖（`--ai` 除外）。

------

## 十二、开发计划（重估版）

> v2.1 把 auto-capture、状态机、Scope 全部前压却未重估工期，"2-3 周 MVP" 已不现实。本计划按 **1 周 Spike + 5 周主线** 重估，砍不掉的就不许假装砍得掉。

### Phase 0 · Spike 与调研（W0，3-5 天）—— 门槛制，不过不进

| 任务 | 退出标准 |
| ---- | -------- |
| S1 中文检索 spike（jieba + FTS5） | §14 中文验收用例全绿 |
| S2 Claude Code JSONL tailing + resume 行为 | 能实时捕获 + 正确触发一次回滚 |
| S3 状态机原型（含回滚） | 状态转换全路径单测通过 |
| S4 MCP scope 注入 spike | `_scoped_where()` 一次搞定交集语义 |
| S5 本机 ZCode 会话格式逆向（本机即装即用） | 产出首份国产 Agent Adapter 规格草案 |

### Phase 1 · 存储与捕获（W1-2）

内容：DDL 落地 · `init/watch/sync/save/status/mode/doctor` · ignore · 三档模式 · 基础 `search/show/list`（中文用例达标）。
**验收**：不执行任何 save，次日能搜到昨天会话；`status` 面板数字自洽；`mode off` 下 watch 零写入。

### Phase 2 · 结构化与结束判定（W3）

内容：五类元数据提取 · summary_rule · 两阶段判定 + resume 回滚 + 事件队列 · `decisions/history/unresolved` · 出处块字段。
**验收**：resume 一次旧会话后状态与摘要正确重算；决策列表含出处。

### Phase 3 · MCP + Scope + 多源（W4）

内容：`serve` + 8 tools · Scope A/B 档（scope.json + auto-scope）+ 交集语义 + 命中 hint · `attach/detach` · Zcode adapter（依 S5）。
**验收**：scoped 语境下提问不再回溯无关话题；命中不足出现放宽提示；Claude Code 与 ZCode 查到同一份记忆。

### Phase 3.5 · 接力（W5）

内容：HOP export/import · HANDOFF.md · 脱敏 + 隔离导入 · scope C 档 TUI · `team status/log` · export 尊重 scope。
**验收**：张三导出 → 小王导入 → 小王的 AI 能答"数据库为什么选 PG"；HANDOFF.md 免解释可读；注入密钥的会话导出被脱敏并出具报告。

### Phase 4 · 增强（W6+，视反馈）

`--ai` LLM 摘要 · branch/PID 会话归属 + `get_linked_sessions` · 语义检索（可选本地嵌入） · 更多国产 adapter · **HOP 规格推广**（提交给 ai-memory/Memorix 类项目参考，争取第三方读取器） · meta 模式检索细化。

------

## 十三、风险登记册

| # | 风险 | 等级 | 应对（定案） |
| - | ---- | ---- | ------------ |
| 1 | 中文检索不达标 | 🔴 | §6.3 方案 + Phase 0 门槛制（S1 不过不立项开发） |
| 2 | 结束判定误判 / resume 错乱 | 🟡 | 两阶段 + 回滚常态化 + 原则 4（源文件是事实源，可 rebuild） |
| 3 | "自信的错误记忆"毁信任 | 🔴 | 出处强制契约（§6.7）+ 无命中明确说"没找到" |
| 4 | auto-capture 隐私焦虑 | 🔴 | 三档模式 + ignore + status 透明面板 + purge 一键清除 |
| 5 | 全量捕获噪声回流检索 | 🟡 | bm25 + 近期加权 + confirmed 优先 + Scope 裁剪；持续观察信噪比 |
| 6 | 交接包 prompt 注入 | 🔴 | HOP 信任模型 + 默认脱敏 + quarantine 隔离导入（§10.4） |
| 7 | 工期再失控 | 🟡 | 本计划已重估；Phase 0 门槛制；每周对照本表复盘 |
| 8 | 官方内置记忆 / 长上下文合拢窗口 | 🔴 | 协议优先（§2.4）：让 HOP 活过产品本身 |
| 9 | claude-mem / Memorix 扩展多 agent | 🟡 | 每月竞品扫描；胜负手在国产 adapter 深度 |
| 10 | HOP 无人采纳 | 🟡 | 规格独立 MIT + 每次交接都是外溢 + 主动推送同类项目 |
| 11 | Adapter 断代（agent 改格式） | 🟡 | 模块化 adapter + 版本探测 + doctor 自检 |
| 12 | 多 agent 并发 scope 串台 | 🟡 | MVP 接受 project+cwd 粒度（已知局限，写入文档）；Phase 4 branch/PID |
| 13 | 市场论据数字失实 | 🟢 | 已降级为"待核引用"，不作为决策依据 |
| 14 | 库体积增长 | 🟢 | WAL + 分页 + confirmed 才入主索引；SQLite 百万级无压力 |

------

## 十四、验收与度量

### 14.1 中文检索验收用例（Phase 1 门槛，全绿才准合并）

| # | 查询 | 必须命中 |
| - | ---- | -------- |
| C1 | 索引 | 含"建索引""索引策略"的会话 |
| C2 | 认证方案 | 含"用 JWT 做认证"的会话 |
| C3 | JWT 过期 | 中英混合正文 |
| C4 | 数据库 分区 | 跨消息多关键词 AND |
| C5 | "按月分区"（带引号短语） | 短语精确匹配 |
| C6 | 元数据模式会话 | 仅靠 title/topics 命中（meta 模式无正文） |

### 14.2 产品度量

| 指标 | 定义 | 目标 |
| ---- | ---- | ---- |
| 无干预捕获率 | auto 捕获会话数 / 源目录会话总数 | W2 后 > 90% |
| 检索转化率 | search 后 3 次内发生 show / get_session_detail 的比例 | > 30% |
| 出处覆盖率 | 携带完整出处块的结果 / 全部结果 | 100%（硬性） |
| 交接有效性 | 导入后 24h 内新用户 AI 引用导入记忆作答的次数 | 每包 ≥ 1 |
| 状态机正确性 | resume 回滚用例通过率 | 100%（回归必测） |

------

## 十五、非目标

以下明确不做，防止范围蔓延（做了就是违反本方针）：

1. 向量数据库 / 语义检索（Phase 4 可选本地嵌入除外）
2. 知识图谱（元数据标签天然可升级，但不是现在）
3. 云同步、多端（HOP 文件传递已覆盖交接场景）
4. 权限管理系统（Team 版课题，免费版只有隐私边界）
5. MVP 阶段任何 LLM 依赖（`--ai` 全部后置 Phase 4）
6. 拼音 / 模糊音检索
7. GUI / Web 面板（CLI + TUI 为界）
8. 修改任何 agent 的源会话文件（只读事实源）

------

## 十六、与旧文档的关系

| 旧文档 | 处置 |
| ------ | ---- |
| `sessionRelay-产品.md`（v1.0） | 归档。显式 save 范式被本方针 §6.2 取代；"零竞品"等表述作废 |
| `sessionRelay-产品v2.0.md` | 归档。团队交接章节并入本方针第十章（HOP）；Schema 全部由 §7.2 取代（含两处修复） |
| `sessionRelay-产品评审v1.0.md`（v2.1 draft） | 归档。其 §3 结束判定、§4 范式、§5 Scope 已吸收进 §6；其"下一步行动清单"由本方针**全部执行完毕**：README 叙事更新（§2.2）、PRD 合并（即本文）、MCP 表加 scope-aware 列（§九） |
| 评审遗留 P1 项的落位 | auto-capture watcher 原型 → Phase 0-1；状态机原型 → S3 + Phase 2；scope 注入 spike → S4 + Phase 3；Zcode JSONL 逆向 → S5；博文《我在 5 个 AI 编程工具之间共享记忆》→ 与 Phase 3 并行的对外动作 |

------

## 十七、决策日志

| # | 决策 | 理由 | 替代方案（被否原因） |
| - | ---- | ---- | -------------------- |
| D1 | 更名 会话接力/SessionRelay，退役 SessionGraph | "Graph"与"不做图谱"自相矛盾；"接力"命中三棒本质；目录名已是 sessionRelay | 保留旧名（叙事分裂成本永久存在） |
| D2 | auto-capture 与手动 save **并存**（用户裁定） | 敏感项目出口、老项目补录、隐私兜底；评审的"替代"措辞作废 | 纯替代（隐私叙事变弱）；纯手动（v1.0 已证伪） |
| D3 | 中文检索 = jieba 预分词 + unicode61 | FTS5 默认不切中文；trigram 挂二字词；此为最短正确路径 | 纯 trigram（"索引""认证"查不到）；向量（违反零依赖） |
| D4 | messages 建独立 FTS，作为检索主面 | v2.0 的 FTS 只索引 sessions 且引用了不存在的列，正文根本搜不到 | 沿用旧设计（跑不起来） |
| D5 | Scope 交集语义，仅 set_scope 可放宽 | 消除 v2.1 平铺优先级链中"agent 参数绕开项目契约"的歧义 | 平铺优先级链（语义含糊） |
| D6 | attach 落为最高优先级 Scope 谓词 + session_links 留痕 | MCP stdio 无会话身份，强行做"本次会话私有关联"必串台 | MVP 直接做一等关联实体（归属不了） |
| D7 | 摘要三层：summary_rule 免费 / user_summary 手动 / summary_ai 后置 | 用户口述需求落位；confirmed 即有摘要可看，HANDOFF.md 零成本组装 | 全部 Phase 4（交接文档无原料） |
| D8 | HOP 独立中立命名 + MIT 规格开放 | 协议要长出产品之外才能穿越平台窗口 | 沿用 .sessiongraph（绑死单一产品，第三方无动力读） |
| D9 | 导出默认脱敏 + quarantine 隔离导入 + sha256 完整性 | 交接包是外发面与注入面，v1/v2 零防护 | 信任用户自觉（一次泄露毁掉团队版叙事） |
| D10 | 出处块 100% 强制 | "自信的错误记忆"比失忆更毁信任 | 尽力而为（信任不可再生） |
| D11 | 工期重估为 1+5 周，Phase 0 门槛制 | v2.1 前压范围未重估账本；假装 3 周做完必然烂尾 | 维持 2-3 周口径（自欺） |
| D12 | 原则 4：源文件是事实源，库可 rebuild | 把状态机 bug 从"正确性问题"降级为"时效问题" | 库为事实源（判定错=数据坏） |

------

*本方针之后，任何新想法先对照第四章十条原则与第十七章决策日志；要推翻某条决策，先在评审中登记新决策编号，再改本文。*
