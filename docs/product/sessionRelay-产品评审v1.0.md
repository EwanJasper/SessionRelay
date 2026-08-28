# SessionGraph — 评审讨论纪要与演进方向（v2.1 Draft）
> **基线**:sessionRelay-产品v2.0.md  
> **性质**:本文整理自一次完整的产品评审对话，覆盖四个议题——**竞争格局校准、会话结束判定机制、存储范式演进、查询侧 Scope 系统**  
> **读者对象**:产品负责人、核心开发者
>
> ⚠️ **重要声明**:v2.0 中"跨 agent 本地记忆目前零竞品"的判断经核查**不成立**，相关表述需要修正。详见第二章。
---
## 目录
1. [总体评估结论](#一总体评估结论)
2. [竞争格局完整梳理](#二竞争格局完整梳理)
3. [关键技术专题一:会话结束判定](#三关键技术专题一会话结束判定)
4. [核心范式演进:被动捕获 + 定向检索](#四核心范式演进被动捕获--定向检索)
5. [Scope 系统设计规范(新增)](#五scope-系统设计规范新增)
6. [数据库 Schema 变更清单](#六数据库-schema-变更清单)
7. [更新后的开发计划](#七更新后的开发计划)
8. [修订后的风险表](#八修订后的风险表)
9. [对外叙事重构](#九对外叙事重构)
10. [下一步行动清单](#十下一步行动清单)
---
## 一、总体评估结论
### 1.1 综合判断
| 维度           | v2.0 判断 | 本轮校准                                |
| -------------- | --------- | --------------------------------------- |
| 市场需求真实性 | ⭐⭐⭐⭐⭐     | ✅ 维持不变(pain point 真实)             |
| 差异化         | ⭐⭐⭐⭐⭐     | 🔻 **下调至 ⭐⭐⭐½**,赛道远比预期拥挤      |
| 技术可行性     | ⭐⭐⭐⭐⭐     | ✅ 维持不变                              |
| 竞争压力       | ⭐⭐⭐       | 🔻 **下调至 ⭐⭐**(威胁更大)               |
| 商业化空间     | ⭐⭐⭐⭐      | ✅ 维持不变                              |
| **综合**       | ⭐⭐⭐⭐½     | **⭐⭐⭐⭐ · 值得做,但要快,且必须重新卡位** |
### 1.2 三条主线共识
1. **痛点真实、技术栈合理**:MCP 作为统一入口 + SQLite FTS5 本地优先的方向已被市场验证
2. **"零竞品"叙事不成立**:至少 6–8 个同方向项目活跃,其中 ai-memory 与 Memorix 重叠度极高
3. **范式需要演进**:v2.0 的"显式 save"应升级为 **"全量被动捕获 + Scope 定向检索"**,这是解决冷启动与反人性摩擦的正确路径
---
## 二、竞争格局完整梳理
### 2.1 竞品全景表(截至评审时点)
| 工具                       | 形态              | 星数量级 | 与 SG 重叠度   | 核心差异                                                     |
| -------------------------- | ----------------- | -------- | -------------- | ------------------------------------------------------------ |
| **claude-mem**             | Claude Code 插件  | ~62k     | ⭐⭐⭐⭐ 中高      | 仅 Claude;全自动 hook 注入;有 plugin marketplace 分发优势    |
| **Mem0**                   | 独立 SDK/MCP      | ~60k     | ⭐⭐⭐ 中         | 双 store(向量+图谱);偏应用开发者而非 IDE 用户群              |
| **Supermemory**            | 托管 API + 客户端 | ~29k     | ⭐⭐⭐ 中         | 闭源云优先;Memory & Context Engine 叙事                      |
| **ai-memory**(Fabio Akita) | Rust CLI 记忆框架 | ~2.7k    | ⭐⭐⭐⭐⭐ **极高** | 同样跨供应商+MCP+SQLite FTS5;"编译成 Markdown wiki"交接机制与 SG 撞车 |
| **agentmemory**(rohitg00)  | MCP+REST          | -        | ⭐⭐⭐⭐ 高        | CLAUDE.md 可搜索版定位;BM25+向量+图混合检索                  |
| **Memorix**                | MCP 协议          | -        | ⭐⭐⭐⭐⭐ **极高** | 号称支持 7 个 Agent;Workspace 同步;Dashboard;中文社区活跃    |
| **omem**                   | Rust+TS 双端      | -        | ⭐⭐⭐⭐ 高        | 项目/global/private 三级隔离;明确的 Space 团队共享           |
| **Memori**                 | 记忆引擎          | -        | ⭐⭐⭐ 中         | LoCoMo 81.95%;LLM 无关,偏底层引擎                            |
| **Aegis Memory**           | Postgres+pgvector | -        | ⭐⭐⭐ 中         | cross-agent handoff;LangGraph/CrewAI 用户群                  |
### 2.2 关键观察
1. **"跨 Agent"已不再是稀缺卖点** —— Memorix、ai-memory、agentmemory、omem 均以此为主要特征之一
2. **"本地+免费"已卷起来** —— 多个开源项目同时打这两张牌
3. **真正仍属稀缺的两件事**:
   - 把 **"人→人"的结构化交接完整做到"人+AI→人+AI"**(v2.0 Phase 3.5 的 export/import,只有 ai-memory 的 Markdown wiki 最接近)
   - **国产 Agent(Zcode/DSH/通义灵码/iFlyCode)的一手 JSONL 解析 adapter** —— 海外项目基本不碰
### 2.3 战略含义
- 差异化重定位:「唯一同时做齐 **显式隐私控制 + 国产 Agent 适配 + 结构化团队交接** 三件事的项目」
- 国产 Agent Adapter 是最现实的护城河候选
---
## 三、关键技术专题一:会话结束判定
### 3.1 问题本质
任何单点检测都不可靠,原因有三:
- `Stop`/turn 结束 ≠ 会话结束,之后用户很可能接着发 prompt
- **JSONL append-only**,同一文件可跨数天;`--resume` 会复活旧文件并继续追加
- 不同 Agent 语义不一致,有的根本不暴露 lifecycle hook
行业教训参考:claude-mem 曾因 Stop 钩子死循环踩坑;PostHog Session Replay 在"触发式录制"模式上反复摇摆后,仍然回加了 in-memory buffer 以保留事件前的上下文头。
### 3.2 六种检测手段对比
| 手段                          | 信号源               | 准确率 | 实时性     | 主要缺陷                     |
| ----------------------------- | -------------------- | ------ | ---------- | ---------------------------- |
| Agent 生命周期钩子            | `Stop`/`SessionEnd`  | 高     | 实时       | stop≠收尾;per-agent 适配成本 |
| 进程 exit code / TTY 断开     | shell 子进程退出状态 | 高     | 实时       | resume 会复活                |
| **JSONL mtime 不变 + 冷却期** | fs.watch/inotify     | 中     | 冷却期决定 | resume 导致误判              |
| PID 存活监听                  | `/proc/<pid>`        | 中高   | 秒级       | 重启即失效                   |
| 静默超时                      | 无新消息 N 分钟      | 低-中  | 长         | 误伤长 tool run              |
| 显式确认                      | 用户输入             | 最高   | 交互成本   | 反自动化                     |
### 3.3 推荐落地架构
**原则:分层叠加,Adapter 封装复杂度,主程序只看统一事件流**
#### Adapter 层统一接口
```typescript
interface SessionEndSignal {
  onSessionEndSignal(): SignalCapability;
  // 每个 Adapter 自己声明它最可信的结束信号是什么
}
```
- Claude Code → `SessionEnd` hook 为主,mtime 兜底
- Aider → git commit 边界
- Zcode/DSH 未适配期 → mtime heuristic only
- Cursor 等 IDE 类 → host lifecycle events
#### 两阶段提交(核心设计)
```
捕获(写入即 active,零过滤)
  ↓ 侦测到 mtime 不变 ≥ IDLE_THRESHOLD 且 PID 不存活
  ↓ 转 pending_end(生成元数据但不固化)
  ↓ 再静默 COOLDOWN_PERIOD(如 6h)无变化
转 confirmed_end(纳入 FTS 主索引 + 提取 decisions/topics)
若 resume 发生(JSONL 行数增长):
  → 立即回滚到 active,清掉旧 summary,重新计算
```
#### 数据面安全网
> **即便判错了也不丢数据**。原始 JSONL 永久保留,`pending_end` 只是缓存优化而非正确性问题。宁可多存噪声,不能漏存真正重要的讨论。
### 3.4 MVP 实施要点
- `pending → confirmed` 只需在 sessions 表加一个 `state` 字段,几乎零改动
- `IDLE_THRESHOLD`(如 10 min)与 `COOLDOWN_PERIOD`(如 6 h)作为项目级配置入 `.sessiongraph/config.json`
- 钩子层面引入事件队列,worker 异步处理(参照 claude-mem 模式),避免 IO 卡住 Agent 主流程
- 绝不在 MCP Server 层做结束判定,MCP 只消费来自钩子层的 save 事件
---
## 四、核心范式演进:被动捕获 + 定向检索
### 4.1 范式迁移总览
| 维度         | v1/v2.0 显式 save | 中间提议("启动时挑") | **本轮确立的目标范式**         |
| ------------ | ----------------- | -------------------- | ------------------------------ |
| 存储         | 🔴 反人性,冷启动差 | ✅ 自动积累           | ✅ **自动监听所有会话**         |
| 查询         | 每次手动传 filter | 🟡 从零挑选易疲劳     | ✅ **一次性 Scope 契约**        |
| 冷启动       | 🔴 空 DB 即"没用"  | ✅ 好                 | ✅ 好                           |
| Token 经济学 | 低消耗            | ⚠️ 若全量预载会爆     | ✅ 无预载,零压力                |
| 发现悖论     | -                 | 🔴 用户不知挑什么     | ✅ 由相关性排序替代手选         |
| 隐私         | 存前可选          | -                    | `.sessiongraphignore` 负向排除 |
### 4.2 一句话产品哲学(建议写入 README 首屏)
> **Memory is always complete. Retrieval is always yours to shape.**  
> 记忆始终完整收录;检索边界由你划定 —— 内存不该猜你想看什么,该由你来画地图。
> 这条叙事既是跟 claude-mem"全自动扫描"的最正面区分,也避免了回到"反人性的主动存储"。
### 4.3 目标状态下的工作流
```bash
# ══ 存储侧(零交互,后台运行)══
sessiongraph watch --auto-capture     # 默认监听项目全部 agent 会话源
                                      # .sessiongraphignore 决定排除项
# ══ 查询侧(开新 AI 会话时一次性表达边界)══
sessiongraph scope set --topic auth --since 7d
sessiongraph scope add --tag architecture-decision
sessiongraph scope show / reset / pick(TUI)
# ══ Agent 侧(MCP 透明感知当前 scope)══
search_sessions({query:"..."})        # 自动命中 scope WHERE 子句
get_session_detail({session_id,...})  # 细节正文按需拉取
set_scope({mode:'full'})              # 收得太紧时的逃生口
```
---
## 五、Scope 系统设计规范(新增)
### 5.1 定位澄清:Scope ≠ 权限控制
| 系统                                                      | 回答的问题            | 技术位置            |
| --------------------------------------------------------- | --------------------- | ------------------- |
| **Scope**                                                 | 本次会话 AI 该看哪里? | 相关性裁剪,可被覆盖 |
| **Privacy(.sessiongraphignore / exclude-tag)**            | 哪些数据不该进库?     | 硬边界,不可绕过     |
| ⚠️ 二者职责绝不可混淆,否则 Team 版做权限管理时会整段重构。 |                       |                     |
### 5.2 三个关键设计问题(Q&A)
#### Q1:"本次 AI 会话"这个身份由谁定义?
MCP stdio 协议层面无会话 ID,CLI 是多进程短生命周期,同一目录可能有多个 agent 并发。三种归属:
| 归属方式             | 成本 | 适用                           |
| -------------------- | ---- | ------------------------------ |
| project + cwd        | 最低 | MVP 首发                       |
| **git branch(推荐)** | 低   | 同项目多分支隔离场景的首发主力 |
| parent process PID   | 中   | Phase 4 精确场景               |
#### Q2:Scope 应该用什么形式表达?
❌ **不用具体 session-id 白名单作为主力**,两个致命伤:
- **发现悖论**:用户不知道该挑什么,不然也不需要检索工具了
- **漏挑即失忆**:忘掉的会话往往才是真正重要的
✅ **用元数据谓词替代 ID 白名单**:
```bash
--topic auth --since 7d          # 这周聊过认证的所有
--tag arch-decision              # 所有标记过决策的
--file src/db/*                  # 涉及数据库层的
--source zcode                   # 来自特定 agent
--interactive                    # last-mile 精修手段
```
五维谓词(topic/tag/file/time/source)的组合即可覆盖绝大多数场景。
#### Q3:Scope 通过什么形式下达?
采用**三档并存**,各司其职:
| 档位  | 名称                     | 触发时机                                                     | 特性                                                  |
| ----- | ------------------------ | ------------------------------------------------------------ | ----------------------------------------------------- |
| **A** | silent auto-scope        | 每次启动,隐性                                                | cwd + git branch + 当前 diff files + 最近 N 天,零交互 |
| **B** | **CLI scope.json(主力)** | `scope set/add/reset` 写入 `.sessiongraph/scope.json`,本项目共享 | 类似 `.gitignore` 的显式范围契约                      |
| **C** | TUI `scope pick`         | 仅 fallback                                                  | 列出候选 space 勾选;**绝不自动弹出**                  |
### 5.3 MCP 协议层的实现取舍
| 实现                                                         | 作用位置          | 优点              | 缺点                                   |
| ------------------------------------------------------------ | ----------------- | ----------------- | -------------------------------------- |
| 每个 Tool 增加 `scope` 参数                                  | Server 签名       | 侵入最小,标准做法 | Agent 未必主动填,需 system prompt 引导 |
| **Server 读 scope.json 作默认 filter**                       | Server + 项目目录 | Agent 零训练成本  | 不能 per-AI-session 区分               |
| 增加 `set_scope` Tool                                        | Server 动态       | 最灵活            | AI 可能自己把自己视野改窄导致返工      |
| **推荐组合**:B 为主 + A 兜底 + C(`set_scope`)留给 power-user。 |                   |                   |                                        |
| **优先级链**:`显式 scope.json > 调用时 scope 参数 > auto-scope > 全库` |                   |                   |                                        |
### 5.4 已知坑与对策
| #    | 坑                                                      | 对策                                                         |
| ---- | ------------------------------------------------------- | ------------------------------------------------------------ |
| 1    | scope 收太紧,Agent 变笨看不到两周前关键决策             | FTS5 命中数 < 阈值时返回 hint:`N 条匹配于当前 scope,共 M 条可用,可用 set_scope({mode:'full'})放宽` |
| 2    | 国产 agent 无法提供 cwd/git 信息                        | Adapter 定义各自最强的身份信号,拿不到就 fallthrough 下一层   |
| 3    | scope 覆盖了 pending_end 的活跃会话,resume 后变化未反映 | scope 存**谓词表达式**而非 id 快照,查询时动态展开            |
| 4    | 跟权限控制心智混淆                                      | 在文档首屏区分"Scope=相关性" vs ".ignore=隐私",UI 上不做同层入口 |
---
## 六、数据库 Schema 变更清单
在 v2.0 基础上,**新增**以下字段与表:
```sql
-- ═══════════════════════════════════════
-- ① sessions 表增加 state(两阶段提交)
-- ═══════════════════════════════════════
ALTER TABLE sessions ADD COLUMN state TEXT NOT NULL DEFAULT 'active';
-- 'active' | 'pending_end' | 'confirmed'
CREATE INDEX idx_sessions_state ON sessions(state);
-- ═══════════════════════════════════════
-- ② sessions 表增加分支身份(scope 精细化所需)
-- ═══════════════════════════════════════
ALTER TABLE sessions ADD COLUMN git_branch TEXT;
-- ═══════════════════════════════════════
-- ③ Scope 日志表(便于审计 Team 版复用)
-- ═══════════════════════════════════════
CREATE TABLE scope_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,         -- 'set'|'add'|'reset'
  predicate TEXT NOT NULL,      -- 谓词表达式 JSON
  issued_by TEXT,
  created_at DATETIME NOT NULL
);
```
`.sessiongraph/scope.json` 示例:
```json
{
  "version": "1.0",
  "mode": "predicate",
  "filters": {
    "topics": ["auth"],
    "tags": ["architecture-decision"],
    "files": ["src/auth/*"],
    "since": "-7d",
    "sources": null
  },
  "issued_at": "2026-08-27T16:00:00+08:00",
  "expires_in_hours": null
}
```
`.sessiongraphignore` 格式沿用 gitignore 语法匹配 files_mentioned/topics/tags。
---
## 七、更新后的开发计划
在 v2.0 Phase 1–3.5 基础上做三点调整:存储侧 auto-capture 前移至 Phase 1,Hook-based 结束判定贯穿全程,Scope 系统作为独立交付物进入 Phase 3.5。
| Phase             | 内容调整                                                     | 相比 v2.0                    |
| ----------------- | ------------------------------------------------------------ | ---------------------------- |
| **Phase 1**(W1-2) | Core Store + Search + **Auto-capture watch 默认开启**;`.sessiongraphignore`;sessions.state 三态落地;Claude Code JSONL Adapter 完整解析 | 🆕 Auto-capture 替代人工 save |
| **Phase 2**(W3)   | 元数据提取(不变)+ **Session End Signal 分层判定模块**(各 Adapter 声明) | ➕ 新增                       |
| **Phase 3**(W4)   | MCP Server + 多 Agent Adapter + **Scope 系统:B 档 CLI + A 档 auto-scope 兜底**;MCP tools 全部接入 scope filter | ➕ 新增 scope 子系统          |
| **Phase 3.5**(W5) | Export/Import/Team Transfer(不变)+ **C 档 TUI `scope pick`** + 导出时尊重 scope | ➕ 新增 C 档                  |
| **Phase 4**(W6+)  | 原增强项 + **git branch-level scoping** + **parent-PID 归属** + Adapter 生命周期信号库扩展 | ➕ 新增                       |
| **新增验证标准**: |                                                              |                              |
- Phase 1:`sessiongraph status` 显示 auto-capture 已捕获 N 条,pending K 条,confirmed M 条;不执行任何 save 也能搜到昨天刚聊过的东西
- Phase 3:在 scoped 语境下提问,Agent 不再回溯无关话题;命中不足时能看到"可用 set_scope 放宽"提示
- Phase 3.5:export 默认遵循当前 scope(可通过 --all 覆盖)
---
## 八、修订后的风险表
在 v2.0 风险表基础上,**新增**以下条目:
| 风险                                  | 影响             | 应对                                                      |
| ------------------------------------- | ---------------- | --------------------------------------------------------- |
| auto-capture 引发的隐私焦虑           | 用户不敢开       | `status` 透明度面板 + ignore 语法 + pending 撤销一键清除  |
| scope 收太紧 Agent 变笨               | 低质量回答       | FTS5 命中阈值 hint + set_scope full 逃生口                |
| Resume 破坏 pending→confirmed 推断    | 元数据错乱       | 谓词驱动展开 + 每次入库前对比 content_hash                |
| "零竞品"叙事被同行戳穿                | 舆论危机         | **立即删掉该表述**,改为新的差异化措辞(见 §九)             |
| Claude Code 官方后续内置记忆功能      | 第三方工具边缘化 | 真正护城河转向:**国产 Agent 适配深度 + 团队交接协议标准** |
| Session 身份歧义(同窗口多 Agent 并发) | Scope 串台       | MVP 仅按 project+cwd;Phase 4 引入 branch/PID              |
---
## 九、对外叙事重构
### 9.1 删除的表达
- ❌"品类空白,'跨 agent 本地记忆'目前零竞品"
- ❌ 评分卡中的差异化五星自评
### 9.2 新叙事主角
**主张三条线的交集,不主张单一线**:
> "**我们是唯一同时做齐这三件事的项目:**
> 1️⃣ 全量被动捕获,零打扰
> 2️⃣ 国产 Agent(Zcode/DSH/通义灵码)一手 Adapter
> 3️⃣ 结构化团队交接包(.sessiongraph),AI 直接拥有上下文"
### 9.3 两句可以直接用的品牌文案
- *"Memory is always complete. Retrieval is always yours to shape."*
- *"你和 AI 聊了 3 天的方案,不应该随关窗消失;它属于项目,属于下一个接手的人。"*(v2.0 保留句)
### 9.4 关键行动节奏
1. **快**:竞品间重叠度高,胜负手在于谁先把国产 Agent 适配做扎实
2. **盯三个对手**:claude-mem 是否扩展多 agent、ai-memory Markdown 交接是否标准化成协议、Memorix 是否冲英文社区
3. **推协议**:争取让 `.sessiongraph` 包成为事实标准,让其他工具愿意读这个格式 —— 一旦外部生态愿意读你的格式,护城河就从代码变成协议本身
---
## 十、下一步行动清单
**规格层面(P0,本周)**
- [ ] 更新 README,删除"零竞品"表述,替换 §9.2 新叙事
- [ ] 将本文 §5(Scope)、§3(结束判定)、§4(范式演进)合并进 PRD 主体,升级为 v2.1
- [ ] 修改第 9 章 MCP Tools 表格:每 Tool 增加 `scope-aware?` 列
**技术验证(P1,Phase 1 前)**
- [ ] Prototype:auto-capture watcher + Claude Code JSONL tailing
- [ ] Prototype:sessions.state 两阶段提交的状态机与 resume 回滚逻辑
- [ ] Spike:MCP stdio 无状态下如何把 `scope.json` 注入 filter(预计一次 `_get_scoped_where()` 辅助函数搞定)
**对外动作(P1,与开发并行)**
- [ ] 调研并逆向 Zcode/DSH 的 JSONL 结构,产出首份国内 Agent Adapter 规格草案
- [ ] 撰写博文:《我在 5 个 AI 编程工具之间共享记忆》,突出国产 Agent 适配角度
- [ ] GitHub repo topics/tags 预置:claude-code,zcode,dsh,mcp-server,session-memory,cross-agent
---
*本文档为演进中的活文档,每次评审后请在头部打上 `Review #N` 与日期。*