# 会话接力 SessionRelay — 产品与技术指导方针

> **版本**：v3.1（Master Guideline）
> **日期**：2026-08-28
> **性质**：本文档是本产品**唯一有效的指导方针**，吸收并取代 v1.0、v2.0 产品文档、v2.1 评审纪要及 v3.0 方针的全部有效结论。旧文档降级为历史档案，与本文冲突之处一律以本文为准。
> **产品名**：会话接力（SessionRelay）。SessionGraph / sessiongraph 命名即日退役。
> **资源假设**（Review #2 起显式声明，兵力变化须先修订本节）：**solo 开发，每周可投入 15-20 小时。** 由此推导：12 个月内不建设任何收费能力；B 端能力整体冻结（§15.1、D17/D18）。

**修订记录**

| Review | 日期 | 版本 | 内容 |
| ------ | ---- | ---- | ---- |
| #1 | 2026-08-28 | v3.0 | 定稿：吸收三轮文档遗产，修复全部已知缺陷，决策 D1-D12 |
| #2 | 2026-08-28 | v3.1 | 经营侧评审：新增第十五章"增长与经营"与原则 11；新增决策 D13-D18；修订 §2/§3/§5/§8/§10.6/§12/§13/§14；非目标增补 B 端冻结 |
| #3 | 2026-08-28 | v3.1 | 架构评审联动回填：消息幂等键（T20）与 origin_project（T21）入 §7.2，导入归化规则入 §10.5，守护服务化入 Phase 1，新增风险 #16；新增 D19/D20 |
| #4 | 2026-08-28 | v3.1 | Phase 0 Spike 回填：S1-S4 门槛全过（42/42）；§7.2 sessions_fts 补 INSERT/DELETE 触发器（F1，Spike 抓获：原稿缺触发器则 meta 模式检索 C6 失败）；S5 ZCode 格式逆向完成（主存储为 SQLite，规格见 `sessionrelay/docs/adapters/zcode-format.md`，水位泛化 cursor 由技术方案 T34 承接） |
| #5 | 2026-08-28 | v3.1 | Phase 1/2 实现回填：R8（sessions.pending_at，cooldown 计时需要）；ignore 两层判定语义入 §6.2；ZCode adapter 提前至 Phase 1 落地（偏差登记，Phase 3 仅余 end-signals 精化与 files 提取）；Phase 1/2 验收均已在实机达成（报告 `sessionrelay/docs/phase1-report.md`、`phase2-report.md`） |
| #6 | 2026-08-28 | v3.1 | Phase 3 实现回填：MCP 8 工具 + Scope A/B 档实机达成（报告 `phase3-report.md`）；§6.5 的 attach 偏差登记——session_links 一等关联推迟至 Phase 4（需会话身份），MVP 以 sessionIds 谓词 + scope_log 留痕等价落地（P3-A） |
| #7 | 2026-08-28 | v3.1 | **MVP 收官（Phase 0→3.5 全部完成）**：HOP 交接包落地（报告 `phase35-report.md`，81/81 测试）——导出/导入/归化/默认脱敏/隔离导入/release/HANDOFF.md 署名全部实机验证；实机发现登记：子目录 CLI 向上发现父根（P35-A，README 提示）、files 单段斜杠误报（P35-B，Phase 4）、自导回导产生后缀副本（P35-C，合并规则正确行为）。下一站 Phase 4（`--ai`/会话身份/协议推广/npm 发布/对外发布战役一） |
| #9 | 2026-08-28 | v3.1 | 实机使用驱动的设计迭代：上下文安全护栏（D22：默认 20 条 × 1000 字 × 50KB 硬顶——防 AI 上下文爆炸）；role 过滤（T39：堵 agent 绕过 MCP 直查 SQLite 的逃逸出口）；文件内容不入库（"为什么"归会话，"是什么"归 git）；会话级存储 vs 碎片存储的差异化叙事写入 README 与设计笔记（`docs/design-notes-mcp-context-safety.md`） |

------

## 目录

1. [产品身份与命名](#一产品身份与命名)
2. [定位与战略](#二定位与战略)
3. [用户与场景](#三用户与场景)
4. [产品原则（十一条）](#四产品原则十一条)
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
15. [增长与经营（Review #2 新增）](#十五增长与经营review-2-新增)
16. [非目标](#十六非目标)
17. [与旧文档的关系](#十七与旧文档的关系)
18. [决策日志](#十八决策日志)

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

### 2.6 主战场与叙事分线（Review #2 新增，详见 §15.2）

**国内个人开发者是主战场（primary），海外是声望放大器（amplifier）。** 两线叙事不同：国内讲"会话接力 + 记忆不出本机"，海外讲 "neutral cross-agent memory layer + open HOP protocol"。国内获客，海外立牌。

------

## 三、用户与场景

### 3.1 用户画像

| 画像 | 描述 | 核心诉求 | 定位 |
| ---- | ---- | -------- | ---- |
| 重度多工具开发者（自己就是一号用户） | 同时用 Claude Code / ZCode / DSH，日均多会话 | 跨时间、跨工具不失忆 | **主画像（primary）** |
| 交接者 | 项目转手、轮岗、离职 | 聊过 3 天的方案不消失 | 高价值场景画像 |
| 接手者 / 新人 | 刚接手项目 | AI 直接知道历史决策，不用问人 | 传播受益画像（K 因子载体） |
| 敏感项目开发者 | 公司代码、隐私顾虑 | 我能证明它没录 / 没外传 | 信任验证画像 |

### 3.2 七个核心场景

1. **跨时间**：新会话问"上周讨论的方案是什么来着？"——搜得到。
2. **跨工具**：上午在 Claude Code 定的数据库方案，下午 ZCode 直接基于它写代码。
3. **跨人**：`srelay export` → 同事 `import`，他的 AI 立刻拥有全部上下文。
4. **新人入职**：不问任何人，AI 能回答"数据库为什么选 PG""JWT 刷新策略定了没"。
5. **指定关联**：开新会话前 `srelay attach <id1,id2>`，本次工作只挂载这几次历史讨论。
6. **敏感项目**：`mode off` 下只有手动 save 的会话入库；`mode meta` 只存元数据不存正文。
7. **项目复盘**：`decisions` / `unresolved` 一览全部技术决策与悬而未决的问题。

------

## 四、产品原则（十一条）

所有设计与实现争议，回到这十一条裁决：

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
11. **增长内建于产品，经营克制于资源**（Review #2 新增）：每次交接都是一次增长机会（交接包署名即渠道）；运行时零外呼是产品红线（遥测=本地计数+自愿提交，§15.5）；商业化冻结 12 个月（D17），B 端冻结至兵力变化（D18）。

------

## 五、功能全景

### 5.1 功能地图（8 + 4）

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

**四个横切机制：**

| 机制 | 职责 |
| ---- | ---- |
| 出处与可信（Provenance） | 所有查询结果强制携带来源标注，防"自信的错误记忆"（§6.7） |
| 隐私系统 | 捕获模式 × ignore × 导出脱敏，三层防线（§6.2） |
| 增量同步与重建 | hash 对比增量捕获；`rebuild` 全量重建（原则 4） |
| 经营观测（Review #2 新增） | 本地匿名计数器 + 自愿报告，服务北极星与增长漏斗（§15.4/15.5） |

### 5.2 范式定案

| 维度 | v1/v2.0（旧） | **v3.x（本方针）** |
| ---- | ------------- | ------------------ |
| 存储 | 显式 save，反人性，冷启动差 | **auto-capture 默认开启；显式 save 并存保留**（补录、敏感项目、关掉自动后的唯一入口） |
| 查询 | 每次手动传 filter | 一次性 Scope 契约 + 调用时收窄 |
| 冷启动 | 空 DB 即"没用" | 装完即自动积累，**init 回填 30 天，第一分钟可搜到上月讨论**（§15.6，Review #2 强化） |
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

**ignore 两层判定（Review #5，实现发现 P1-A）**：`source:` 与裸 glob 在**发现期**拦截（零读取成本）；`title:` 在解析出标题后、**入库前**拦截——两种情况下数据均不落库，硬边界语义不变。
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
- 验收用例（进 Phase 1 门槛，见 §14）：`"索引"`命中含"建索引"的会话；`"认证方案"`命中"用 JWT 做认证"；中英混合"JWT 过期"可查。

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
  origin_project?: string;       // Review #3/T21：导出方原项目（导入归化后溯源用）
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
  pending_at        TEXT,            -- R8（Review #5）：cooldown 计时需要 pending 时刻
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
    origin_project    TEXT,   -- Review #3/T21：导出方原项目（HOP 导入归化后溯源）

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
-- Review #3/T20：幂等去重键（崩溃重放去重 + 排序二合一；seq_num=确定性源序号，契约见技术方案 §3.1）
CREATE UNIQUE INDEX ux_messages_session_seq ON messages(session_id, seq_num);

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
-- Review #4/F1（Spike 抓获）：外部内容表必须在 INSERT/UPDATE/DELETE 三处维护索引；
-- 原稿仅有 UPDATE 触发器，INSERT 时 meta_text 不入索引，meta 模式检索（C6）直接失败
CREATE TRIGGER sessions_fts_ai AFTER INSERT ON sessions BEGIN
    INSERT INTO sessions_fts(rowid, meta_text) VALUES (new.rowid, new.meta_text);
END;
CREATE TRIGGER sessions_fts_au AFTER UPDATE OF meta_text ON sessions BEGIN
    INSERT INTO sessions_fts(sessions_fts, rowid, meta_text)
        VALUES ('delete', old.rowid, old.meta_text);
    INSERT INTO sessions_fts(rowid, meta_text) VALUES (new.rowid, new.meta_text);
END;
CREATE TRIGGER sessions_fts_ad AFTER DELETE ON sessions BEGIN
    INSERT INTO sessions_fts(sessions_fts, rowid, meta_text)
        VALUES ('delete', old.rowid, old.meta_text);
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

-- ═══════════ 导入/导出日志 ══════════
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
- **Review #2 增补**：本地经营计数器不入 SQLite，独立存 `.sessionrelay/stats.json`（可随时删，删了不影响任何功能；见 §15.5）。

------

## 八、CLI 命令规范

命令名 `srelay`。分组列出（`[]` 可选，`<>` 必填）：

### 8.1 捕获与状态

```bash
srelay init [--backfill 30d|90d|none]   # 初始化向导；默认回填最近 30 天（啊哈机制，§15.6）
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
srelay stats [--show|--report|--reset]   # 本地匿名计数器：查看/生成自愿报告/清零（§15.5）
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

**写域工具与边界（Review #8/D21）**：MCP 除 8 个读工具外新增 7 个写域工具——注释（标签/摘要）、结论笔记（source=note，可溯源）、会话关联（link/get_linked，双向）、交接包导入导出（import 默认隔离，比 CLI 更保守）。**边界不变**：会话状态迁移（confirm/purge/judge）仍专属 watch/CLI；写域均为"内容不可变的旁路写入"；隐私 ignore 对写域同样生效。

注：`get_linked_sessions` 已随 Review #8 落地（P3-A 提前完成）；branch/PID 级"当前会话身份"仍在 Phase 4。

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
- **导入归化（Review #3/D19）**：import 时 `project_id` 一律**重写为当前项目**，原值存 `origin_project`——project_id 是一切检索的过滤键，保留导出方 ID 则导入会话在所有检索路径中不可见，交接验收直接失败。

### 10.6 HANDOFF.md 生成规则

由 `summary_rule` 免费组装（零 LLM）：关键决策表（日期/决策/原因/来源 agent）→ 涉及文件（含讨论次数）→ 未解决问题 → 时间线 → 逐会话摘要。人类可直接阅读，不需要解释。

**页脚固定署名（Review #2 新增，商业化唯一验证点，§15.7）**：

> `由会话接力 SessionRelay 生成 · github.com/<org>/sessionrelay · 让 AI 的记忆属于项目`

默认存在、不可配置关闭（开源的诚实：fork 可改源码移除，但默认传播）。它是零成本的获取渠道，也是 K 因子的观测载体——读到交接文档的人就是潜在用户。

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
  旁路：.sessionrelay/stats.json 本地匿名计数器（零外呼，§15.5）
```

并发说明：`watch` 守护进程是唯一常驻写者；CLI 短命令以短暂写锁操作（save/scope/mode），SQLite WAL 支撑读写并发，另加 `.sessionrelay/lock` 防双守护。

技术栈定案：TypeScript (Node.js) · SQLite (better-sqlite3) · FTS5 + @node-rs/jieba · Commander.js · MCP SDK (stdio) · fs.watch。零云依赖、零 LLM 依赖（`--ai` 除外）、零运行时网络外呼（§15.5）。

------

## 十二、开发计划（重估版）

> v2.1 把 auto-capture、状态机、Scope 全部前压却未重估工期，"2-3 周 MVP" 已不现实。本计划按 **1 周 Spike + 5 周主线** 重估，砍不掉的就不许假装砍得掉。
> Review #2 增补：init 回填 30 天与本地计数器进入 Phase 1；对外/经营动作单列并行轨道（§12.6）。

### Phase 0 · Spike 与调研（W0，3-5 天）—— 门槛制，不过不进

| 任务 | 退出标准 |
| ---- | -------- |
| S1 中文检索 spike（jieba + FTS5） | §14 中文验收用例全绿 |
| S2 Claude Code JSONL tailing + resume 行为 | 能实时捕获 + 正确触发一次回滚 |
| S3 状态机原型（含回滚） | 状态转换全路径单测通过 |
| S4 MCP scope 注入 spike | `_scoped_where()` 一次搞定交集语义 |
| S5 本机 ZCode 会话格式逆向（本机即装即用） | 产出首份国产 Agent Adapter 规格草案 |

### Phase 1 · 存储与捕获（W1-2）

内容：DDL 落地 · `init`（**含默认回填 30 天，§15.6**）/`watch/sync/save/status/mode/stats/doctor` · **`watch --install-service` 守护服务化（Review #3/D20）** · ignore · 三档模式 · 基础 `search/show/list`（中文用例达标）。
**验收**：不执行任何 save，次日能搜到昨天会话；**init 后 1 分钟内能搜到 30 天前的会话（啊哈机制）**；`status` 面板数字自洽且**守护未运行时红色告警**；`mode off` 下 watch 零写入；本地计数器开始记录激活/啊哈/留存事件；**杀进程重启后消息零重复（幂等验收）**。

### Phase 2 · 结构化与结束判定（W3）

内容：五类元数据提取 · summary_rule · 两阶段判定 + resume 回滚 + 事件队列 · `decisions/history/unresolved` · 出处块字段。
**验收**：resume 一次旧会话后状态与摘要正确重算；决策列表含出处。

### Phase 3 · MCP + Scope + 多源（W4）

内容：`serve` + 8 tools · Scope A/B 档（scope.json + auto-scope）+ 交集语义 + 命中 hint · `attach/detach` · Zcode adapter end-signals 精化与 files 提取（最小读取面已提前至 Phase 1，Review #5 登记）。
**验收**：scoped 语境下提问不再回溯无关话题；命中不足出现放宽提示；Claude Code 与 ZCode 查到同一份记忆。

### Phase 3.5 · 接力（W5）

内容：HOP export/import · HANDOFF.md（**含页脚署名**）· 脱敏 + 隔离导入 · scope C 档 TUI · `team status/log` · export 尊重 scope。
**验收**：张三导出 → 小王导入 → 小王的 AI 能答"数据库为什么选 PG"；HANDOFF.md 免解释可读（含署名）；注入密钥的会话导出被脱敏并出具报告。

### Phase 4 · 增强（W6+，视反馈）

`--ai` LLM 摘要 · branch/PID 会话归属 + `get_linked_sessions` · 语义检索（可选本地嵌入） · 更多国产 adapter · **HOP 规格推广**（§15.8 BD 动作）。

### §12.6 对外与经营动作（并行轨道，Review #2 新增）

与开发并行的固定节奏，不占开发周，单件 ≤ 半天：

| 时点 | 动作 |
| ---- | ---- |
| W2 末（战役一） | 掘金/知乎首发：《你和 AI 聊了 3 天的方案，不该随关窗消失》（啊哈机制 + status 透明面板演示） |
| W5 末（战役二） | 博文《我在 5 个 AI 编程工具之间共享记忆》+ 新人入职案例（交接场景，K 因子主战场） |
| 常设·渠道 | GitHub 英文 README + HOP 英文规格（声望线）；Gitee 镜像、掘金/知乎/公众号、国产 agent 用户社区（获客线） |
| 常设·BD | 向 ZCode/DSH 官方提兼容 issue（附 adapter 草案）；争取进入官方 MCP/插件推荐列表；每月向 ai-memory/Memorix 提一次 HOP 互读提案 |
| 常设·复盘 | 每周 30 分钟对照 §15.4 漏斗；每月竞品扫描（§2.3 三个对手） |

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
| 15 | 经营不及预期（啊哈率/留存/K 因子低于漏斗目标） | 🟡（Review #2 新增） | init 回填 + 每周漏斗复盘 + 内容战役节奏（§15.4/15.9）；连续 4 周不达触发定位复盘而非硬加功能 |
| 16 | 守护未常驻 → auto-capture 断档，"零打扰捕获"承诺落空 | 🟡（Review #3 新增） | `watch --install-service` 系统服务化（Win 计划任务/launchd/systemd）+ init 默认推荐注册 + 守护缺席 CLI 红色告警 + `sync` 一次性兜底（D20） |

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

### 14.2 产品质量度量

| 指标 | 定义 | 目标 |
| ---- | ---- | ---- |
| 无干预捕获率 | auto 捕获会话数 / 源目录会话总数 | W2 后 > 90% |
| 检索转化率 | search 后 3 次内发生 show / get_session_detail 的比例 | > 30% |
| 出处覆盖率 | 携带完整出处块的结果 / 全部结果 | 100%（硬性） |
| 交接有效性 | 导入后 24h 内新用户 AI 引用导入记忆作答的次数 | 每包 ≥ 1 |
| 状态机正确性 | resume 回滚用例通过率 | 100%（回归必测） |

### 14.3 经营度量（Review #2 新增）

北极星指标、增长漏斗与观测方式见 **§十五**（质量度量回答"产品做得好不好"，经营度量回答"用户有没有得到价值、业务有没有在生长"，两套不可互相替代）。

------

## 十五、增长与经营（Review #2 新增）

> 本章回答四个此前悬空的问题：给谁先用（主战场）、怎么被知道（漏斗与战役）、第一分钟怎么让他惊讶（啊哈机制）、怎么活下来（商业化立场）。全部结论受头部资源假设约束。

### 15.1 资源假设与经营红线

- 兵力：**1 人（solo），每周 15-20 小时**。
- 红线一：**12 个月内不建设任何收费能力**（D17）——不建账号体系、不建付费墙、不建授权码。
- 红线二：**B 端能力整体冻结**（D18）——销售、私有化交付、权限管理、云同步，全部不做，直至兵力 ≥ 2 全职。
- 每周固定动作：30 分钟漏斗复盘（对照 §15.4）；每月竞品扫描 + HOP 推广（≤ 半天）。
- 兵力变化时：先修订本节与 D17/D18，再动计划——**不许资源没变而范围先变**。

### 15.2 主战场：国内优先，海外为声望放大器

| 线 | 目标人群 | 叙事 | 渠道 |
| -- | -------- | ---- | ---- |
| **国内（primary）** | 个人开发者，多 agent 重度用户 | "会话接力 + 记忆不出本机 + 国产工具全适配" | 掘金、知乎、公众号、B 站录屏、Gitee 镜像、国产 agent 用户社区 |
| 海外（amplifier） | 开源社区与协议潜在采纳者 | "neutral cross-agent memory layer + open HOP protocol" | GitHub README（英文）、HackerNews/Reddit 发布、向同类项目提互读提案 |

判断依据：中文检索是一等公民（原则 9）、国产 adapter 是护城河（§2.2）——技术与主战场一致；海外 stars 换不来国内用户，但换得来"被引用"与协议信誉。**两线叙事不同，投入比约 8:2。**

### 15.3 北极星指标

> **周有效引用数**：一周内，AI 基于接力记忆成功支撑用户问答的次数（MCP `search_sessions` 命中且随后 `get_session_detail` 深入的会话数 + CLI search→show 转化数）。

- 为什么是它：记忆被用起来才叫记忆。捕获 10 万条而无人查询 = 零价值；它同时校准产品侧（检索质量）与场景侧（AI 真的在引用）。
- 为什么不是 stars / 下载量：那是虚荣指标，只进 §15.4 漏斗的"获取"段做过程观测。
- 观测口径（本地、零外呼，§15.5）：计数器记录事件，`srelay stats --show` 本地查看，`--report` 生成匿名报告自愿提交。

### 15.4 增长漏斗（AARRR）与目标

| 阶段 | 定义 | W8 目标 | 观测方式 |
| ---- | ---- | ------- | -------- |
| 获取 | npm/Gitee 安装 | 累计 500 安装 | npm 周下载量（公开）、Gitee stars——无需遥测 |
| 激活 | init 完成 + 回填成功 | 安装数 × 40% | 本地计数器（自愿报告汇总） |
| **啊哈** | **首次检索命中历史会话（≤ 第 1 天）** | 激活数 × 60% | 本地计数器 |
| 留存 | 周有效引用 ≥ 1 | 激活数 × 30%（W4 起） | 本地计数器 |
| 传播 | 导出的包被他人导入（K 因子） | K ≥ 0.3（导入者中 30% 新装 srelay） | 诚实处理：零外呼下无法自动回传，依赖 GitHub 入门 issue 模板（"你是通过交接包来的吗"）+ 社区问卷 + 署名页脚带来的仓库访问来源，接受低精度 |
| 收入 | —— | **12 个月内不设目标**（D17） | —— |

目标性质：solo 兵力下的**方向标而非军令状**；连续 4 周偏离 → 触发 §13 风险 15 的定位复盘。

### 15.5 遥测决策：零外呼不变，本地计数 + 自愿提交

隐私优先（"记忆不出本机"是国内叙事核心卖点）与漏斗观测的矛盾，解法定案：

- **运行时零网络外呼是产品红线**（技术方案 T11 保持不变）；
- 观测 = `.sessionrelay/stats.json` 本地匿名计数器，**只记事件计数**（init 完成/首次命中/周引用等），永不记录内容、路径、项目名、用户名；
- `srelay stats --show` 全量可审计、`--reset` 一键清零——与 status 面板同一透明哲学；
- `srelay stats --report` 生成匿名摘要文本，用户自愿贴到官方 GitHub Discussion 固定帖；
- 被动公开信号（npm 下载量、Gitee/GitHub stars）作为获取段的无遥测观测。

### 15.6 啊哈时刻设计：init 回填 30 天

- **啊哈定义**：用户第一次"搜到上个月的讨论"。自然演变下这要等 2-4 周，激活窗口早就关了。
- **机制**：`srelay init` 向导第 4-5 步改为：
  1. 立即回填最近 **30 天**历史会话（`--backfill 90d` 可加深，`--backfill none` 可跳过）；
  2. 引导用户输入一个**还记得的关键词**做一次真实试搜；
  3. 命中 → 展示结果 + 出处块（这就是产品价值的第一次演示）。
- 效果：价值感知从"第 30 天"提前到"第 1 分钟"，成本≈0（sync 能力本就存在）。
- 兜底：30 天内无会话的新项目（少数），向导退化为"演示库"引导或提示在旧项目上体验，绝不留白屏。

### 15.7 商业化立场：冻结 12 个月，只留一个验证点

- **不做**：付费版、Pro 功能、账号、云同步、企业授权——全部冻结至 2027-08（D17）。
- **唯一验证点**：HANDOFF.md 页脚署名（§10.6）。它同时服务三件事：零成本获客渠道、K 因子观测载体、品牌心智（"这份交接文档是会话接力生成的"）。
- **假设登记（只观察、不建设）**：若未来做 B 端，国内现实切口是"**数据不出内网 + 私有化部署**"（合规红利），不是云同步/权限的海外 SaaS 打法。触发条件（三条全满足才立项）：兵力 ≥ 2 全职；周有效引用数连续 4 周 ≥ 200；出现 ≥ 3 个主动询问企业版的真实用户。
- 个人开源可持续性：GitHub Sponsors 链接入 README（不弹窗、不强推）。

### 15.8 低成本 BD 动作（每项 ≤ 半天，进 §12.6 并行轨道）

1. 向 ZCode / DSH 官方仓库提兼容性 issue：附 adapter 草案与本机格式逆向笔记（S5 产出），建立开发者关系；
2. 争取进入国产 agent 官方 MCP / 插件推荐列表；
3. HOP 规格英文化，每月向 ai-memory / Memorix 提交一次格式互读提案（协议采纳是买不来只能磨出来的）。

### 15.9 经营节奏（战役制）

- **战役一（W1-4）"上线即啊哈"**：Phase 0-2 完成 + 掘金/知乎首发（啊哈机制 + 透明面板为主角）。
- **战役二（W5-8）"交接即传播"**：Phase 3.5 + 《我在 5 个 AI 编程工具之间共享记忆》+ 新人入职案例。
- **常设**：每周漏斗复盘 30 分钟；每月竞品扫描 + HOP 提案 + K 因子人工回访。

------

## 十六、非目标

以下明确不做，防止范围蔓延（做了就是违反本方针）：

1. 向量数据库 / 语义检索（Phase 4 可选本地嵌入除外）
2. 知识图谱（元数据标签天然可升级，但不是现在）
3. 云同步、多端（HOP 文件传递已覆盖交接场景）
4. 权限管理系统（Team 版课题，免费版只有隐私边界）
5. MVP 阶段任何 LLM 依赖（`--ai` 全部后置 Phase 4）
6. 拼音 / 模糊音检索
7. GUI / Web 面板（CLI + TUI 为界）
8. 修改任何 agent 的源会话文件（只读事实源）
9. **B 端能力（销售 / 私有化交付 / 权限 / 企业授权）——整体冻结至兵力 ≥ 2 全职**（Review #2 新增，D18）
10. **任何形式的运行时网络外呼 / 后台遥测上传**（Review #2 新增，遥测=本地计数+自愿提交，D15）

------

## 十七、与旧文档的关系

| 文档 | 处置 |
| ------ | ---- |
| `sessionRelay-产品.md`（v1.0） | 归档。显式 save 范式被本方针 §6.2 取代；"零竞品"等表述作废 |
| `sessionRelay-产品v2.0.md` | 归档。团队交接章节并入第十章（HOP）；Schema 全部由 §7.2 取代（含两处修复）；商业化章节由 §15.7 立场取代 |
| `sessionRelay-产品评审v1.0.md`（v2.1 draft） | 归档。其 §3 结束判定、§4 范式、§5 Scope 已吸收进 §6；其"下一步行动清单"由 v3.0 全部执行完毕 |
| `sessionRelay-指导方针v3.0.md` | 归档（Review #1 产物）。v3.1 在其上完成经营侧评审：新增第十五章、原则 11、D13-D18 |
| `sessionRelay-技术方案v1.1.md` | 技术实现层设计，与本方针配套生效（v1.1 已完成架构评审修复 S1-S4、A1-A8 与 Review #2 回填 T17-T19，决策至 T33）；v1.0 已归档 |

------

## 十八、决策日志

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
| **D13** | **主战场：国内个人开发者 primary，海外声望 amplifier，投入 8:2**（Review #2） | 技术一等公民（中文/国产 adapter）与主战场一致；海外 stars 换引用不换用户 | 双线并重（solo 兵力摊薄，激活两头都做不起来） |
| **D14** | **北极星 = 周有效引用数**（Review #2） | 记忆被用起来才是价值；同时校准检索质量与 AI 引用真实性 | 安装量/stars（虚荣指标，只做过程观测） |
| **D15** | **遥测 = 本地匿名计数器 + 自愿提交，运行时零外呼红线不变**（Review #2） | 隐私卖点与漏斗观测兼得；透明哲学一以贯之 | 默认开的后台遥测（砸"记忆不出本机"招牌）；完全不观测（盲飞） |
| **D16** | **啊哈机制 = init 默认回填 30 天 + 引导试搜**（Review #2） | 价值感知从第 30 天提前到第 1 分钟，成本≈0；激活窗口不等自然积累 | 等待 auto-capture 自然攒数据（激活期早已流失） |
| **D17** | **商业化冻结 12 个月；唯一验证点 = HANDOFF.md 页脚署名**（Review #2） | solo 无销售体系；未验证假设上建设是最大浪费；署名同时服务获客与 K 因子观测 | 建团队版/Pro（把幻想当需求） |
| **D18** | **B 端整体冻结至 ≥2 全职；未来切口 = 数据不出内网 + 私有化**（Review #2） | 销售与私有化交付非 solo 可承载；国内合规才是真实 B 端切口 | 按云同步+权限的海外 SaaS 打法做（切口错位且无人力） |
| **D19** | **HOP 导入归化：project_id 重写为当前项目，原值存 origin_project**（Review #3） | project_id 是检索过滤键；保留导出方 ID 则导入会话在一切检索路径不可见，"导入即可检索"的交接验收直接失败 | 保留原 project_id（功能失效）；跨项目全局检索（违反项目级隔离原则） |
| **D21** | **MCP 写域准入：允许注释/笔记/关联/导入导出（内容不可变旁路写入），禁止状态迁移；agent 发起的导入默认隔离**（Review #8） | AI 侧闭环（写入结论、交接、关联）与安全（状态机单点、防注入）兼得 | 开放完整写权（状态迁移越权）；MCP 导入不隔离（注入面扩大） |
| **D22** | **上下文安全护栏：get_session_detail 默认最多 20 条 × 1000 字，硬顶 50KB；要更多需显式传参**（Review #9） | AI agent 不自觉控制返回量（一个 230 条会话最坏 920KB 可吃掉 25% 上下文窗口）；默认安全 + hint 引导翻页优于信任 AI 自觉 | 不加护栏（上下文爆炸）；硬限制不可调（需要全文时无法获取） |
| **D23** | **会话级存储是反幻觉的架构基础：存储粒度决定 AI 看到什么、能否溯源**（Review #9） | 碎片式存储（claude-mem）导致上下文污染 + 压缩失真 + 无法溯源 → 幻觉；会话级存储 + 出处强制 + 原文可回跳 = 结构性抑制 | 碎片/摘要式存储（信息丢失不可逆）；注入式上下文（push 而非 pull） |
| **D20** | **守护服务化：watch --install-service 注册系统服务，init 默认推荐注册；守护缺席时 CLI 红色告警 + sync 兜底**（Review #3） | "被动捕获默认开启"的承诺依赖守护常驻，不能建立在用户记得手动跑进程上——可用性需要"守护的守护" | 只提供前台 watch（承诺落空，啊哈时刻崩塌） |

------

*本方针之后，任何新想法先对照第四章十一条原则与第十八章决策日志；要推翻某条决策，先在评审中登记新决策编号，再改本文。*
