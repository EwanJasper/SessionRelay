# 会话接力 SessionRelay — 技术方案 v1.0

> ⚠️ **已归档（2026-08-28）**：本文已被 `sessionRelay-技术方案v1.1.md`（架构评审修订版）取代，仅作历史档案保留。

> **版本**：v1.0（Technical Design）
> **日期**：2026-08-28
> **上游**：本文以 `sessionRelay-指导方针v3.0.md` 为纲，是其技术实现层的设计定案。方针 D1-D12 决策、§十二阶段计划、§十四验收用例（C1-C6）在本文中全部有对应落点，冲突时以方针为准并回写修订。
> **技术决策登记**：本文新增技术层决策 T1-T16（§十六），与方针 D 系列编号互不混淆。
> **维护方式**：活文档。实现中发现偏差，先改本文（登记 T 编号），重大偏差回写方针。

------

## 目录

1. [总体架构](#一总体架构)
2. [仓库目录结构](#二仓库目录结构)
3. [模块设计与关键接口](#三模块设计与关键接口)
4. [设计模式应用](#四设计模式应用)
5. [关键流程](#五关键流程)
6. [搜索子系统详设](#六搜索子系统详设)
7. [数据层与迁移](#七数据层与迁移)
8. [呈现方式与使用友好度](#八呈现方式与使用友好度)
9. [性能设计](#九性能设计)
10. [测试与质量保障](#十测试与质量保障)
11. [可靠性、可观测性与安全](#十一可靠性可观测性与安全)
12. [依赖、构建与分发](#十二依赖构建与分发)
13. [里程碑映射](#十三里程碑映射)
14. [技术非目标](#十四技术非目标)
15. [Schema 增量修订建议（回填方针）](#十五schema-增量修订建议回填方针)
16. [技术决策日志](#十六技术决策日志)

------

## 一、总体架构

### 1.1 架构风格：分层 + 六边形（端口/适配器）

核心域（core/）不依赖任何入口（CLI、MCP）与基础设施（SQLite、文件系统）的具体实现；CLI 与 MCP Server 只是同一组核心服务的**两个薄呈现层**——这保证"人类查"与"AI 查"永远返回同一份结果（含出处块），无双轨漂移。

```
                        ┌─────────────────────────────┐
   呈现层（可替换）       │  cli/   (srelay 命令+TUI)     │  mcp/ (srelay serve, stdio)
                        └──────────────┬──────────────┘
                                       ↓ 调用
                        ┌─────────────────────────────┐
   应用服务层            │  capture/   search/   relay/  │  scope/
                        │  (编排核心域，事务边界)         │
                        └──────────────┬──────────────┘
                                       ↓ 依赖
                        ┌─────────────────────────────┐
   核心域（纯逻辑，        │  model/  state/  extract/     │
   零 IO，可单测）         │  tokenize/  scope-eval/       │
                        └──────────────┬──────────────┘
                                       ↓ 被实现
                        ┌─────────────────────────────┐
   基础设施（端口实现）    │  store/(SQLite)  adapters/(各Agent源) │
                        │  shared/(config/log/lock/fs)        │
                        └─────────────────────────────┘
```

### 1.2 运行时拓扑：一守护 + 两类短进程

```
┌─ 常驻 ──────────────────────────────────────────────────────┐
│ srelay watch 守护进程（唯一常驻写者，持 .sessionrelay/lock）     │
│  fs.watch ─→ Debounce(500ms) ─→ EventQueue ─→ Worker(批处理)  │
│  Hook spool 消费（.sessionrelay/events/，Claude Code 钩子写入） │
│  判定 tick（30s）：idle→pending_end→confirmed，resume 回滚      │
└──────────────────────┬──────────────────────────────────────┘
                       │ WAL：读不阻塞写，写不阻塞读
      ┌────────────────┴────────────────┐
      │ srelay <cmd>  （短进程：读为主，  │  srelay serve （MCP 长进程：
      │  save/scope/mode 短暂取写锁）     │  只读 + set_scope 短暂写）
      └─────────────────────────────────┘
```

- **单写者原则**：watch 是唯一常驻写者；CLI/serve 的写操作（save、scope set、mode、set_scope、import）以短暂排它锁完成，锁文件带心跳时间戳（僵死 60s 自动接管，兼容 Windows 无 ps 的环境）。
- **优雅停机**：SIGINT/SIGTERM → 冲刷队列 → 释放锁 → 退出；daemon 崩溃不损数据（WAL + 源文件是事实源，方针原则 4）。

### 1.3 技术栈定案（对应方针 §十一）

| 层 | 选型 | 备注 |
| -- | ---- | ---- |
| 语言/运行时 | TypeScript 5.x（ESM-only），Node ≥ 18 | T1 |
| 存储 | better-sqlite3（同步 API） | 同步简化事务边界；单写者下无阻塞问题；win32-x64 有预编译（本机 Windows 优先） |
| 分词 | @node-rs/jieba（napi 预编译），bigram 为降级实现 | 同一 `Tokenizer` 接口，策略可换 |
| CLI | Commander.js + picocolors + cli-table3 | 轻量，无 TUI 框架 |
| 交互 | @inquirer/prompts（checkbox/search） | scope pick、save/export --interactive |
| MCP | @modelcontextprotocol/sdk（stdio） | |
| 压缩包 | fflate（zip 读写，纯 JS） | HOP 容器 |
| 日志 | pino（文件输出） | 内容零泄漏，见 §十一 |
| 构建/测试 | tsup、vitest、tsx、eslint、prettier | |

------

## 二、仓库目录结构

```
sessionrelay/
├── package.json                 # name: sessionrelay, bin: { srelay, sessionrelay }
├── tsconfig.json                # strict: true, ESM
├── vitest.config.ts / eslint.config.mjs / .github/workflows/ci.yml
├── README.md  LICENSE(MIT)
├── spec/
│   └── hop-1.0.md               # HOP 协议规格（独立中立文档，方针 D8）
├── docs/
│   ├── dev-guide.md             # 贡献者指南
│   └── adapters/                # 各 Agent 源格式逆向笔记（Phase 0 S5 产出）
│       └── zcode-format.md
├── scripts/
│   ├── bench.ts                 # 性能基准入口
│   └── gen-corpus.ts            # 合成中文语料生成器（测试/基准共用）
├── src/
│   ├── bin/
│   │   └── srelay.ts            # 薄入口：仅解析首参，动态 import 对应模块（保启动 <200ms）
│   ├── cli/
│   │   ├── commands/            # 一命令一文件：init/watch/sync/save/search/show/list/
│   │   │                        # decisions/history/unresolved/status/mode/confirm/purge/
│   │   │                        # doctor/rebuild/scope/attach/detach/export/import/team/serve/hook(隐藏)
│   │   ├── options.ts           # 公共 flag 定义（--json/--debug/--limit...）
│   │   └── ui/                  # render.ts(输出格式) tables.ts theme.ts prompts.ts hints.ts
│   ├── core/                    # ── 纯逻辑，禁止 import IO ──
│   │   ├── model/               # UnifiedSession/UnifiedMessage/Provenance 等值对象
│   │   ├── state/               # machine.ts 状态机（Clock/EventSource 可注入，供 fake timer 测试）
│   │   ├── tokenize/            # tokenizer.ts(接口) jieba.ts bigram.ts normalize.ts
│   │   ├── extract/             # files/topics/decisions/questions/codes/summary-rule.ts
│   │   ├── search/              # engine.ts(编排) query-lang.ts rank.ts snippet.ts
│   │   ├── scope/               # predicate.ts(解析) evaluator.ts(编译为SQL) auto.ts hint.ts
│   │   └── relay-model/         # HOP manifest/条目的纯数据结构与校验
│   ├── adapters/                # ── 端口实现：各 Agent 源 ──
│   │   ├── base.ts              # SessionSource 接口 + 抽象基类（模板方法）
│   │   ├── registry.ts          # 注册表 + custom 加载器（.sessionrelay/adapters/*.js）
│   │   ├── claude-code/         # discover/tail/parse/end-signals
│   │   ├── zcode/  dsh/(stub)  custom/
│   ├── capture/                 # watcher.ts debouncer.ts tailer.ts queue.ts worker.ts
│   │                            # sync.ts save.ts judge.ts(判定tick) hook-spool.ts ignore.ts
│   ├── store/
│   │   ├── db.ts                # 连接管理（WAL/外键/预编译缓存）
│   │   ├── migrate.ts + migrations/   # M1..Mn（user_version 驱动）
│   │   └── repo/                # sessions.ts messages.ts sources.ts links.ts
│   │                            # scope-log.ts transfer-log.ts（仓储模式，SQL 不出此层）
│   ├── search-svc/              # SearchService 门面（组合 core.search+scope+repo+provenance）
│   ├── relay/                   # export/ import/ handoff-md.ts merge.ts quarantine.ts
│   │   └── hop/                 # pack.ts(写zip) unpack.ts(读zip,防zip-slip) manifest.ts
│   │   └── redact/              # engine.ts patterns.ts report.ts
│   ├── mcp/
│   │   ├── server.ts            # stdio 生命周期 + 错误封装
│   │   ├── context.ts           # cwd→项目解析、scope 装配、调用级写锁
│   │   └── tools/               # 一工具一文件，JSON Schema 与实现同处
│   ├── privacy/                 # ignore-parser.ts（gitignore 语法子集）modes.ts
│   └── shared/                  # config.ts(四级合并) errors.ts log.ts lock.ts
│                                # hash.ts paths.ts(统一'/'分隔) time.ts ids.ts
└── test/
    ├── unit/                    # 镜像 src 结构
    ├── integration/             # 临时项目 fixture + 假 adapter 全链路
    ├── contract/                # MCP 工具 JSON-RPC 契约
    ├── e2e/                     # resume 重放 / HOP 往返 / 脱敏黄金用例
    ├── perf/                    # bench-search / bench-capture（可选门禁）
    └── fixtures/                # jsonl/ hop/ chinese-corpus/（gen-corpus 生成）
```

------

## 三、模块设计与关键接口

### 3.1 Adapter（会话源端口）

```typescript
// adapters/base.ts
interface SessionSource {
  readonly id: SourceId;                       // 'claude-code' | 'zcode' | ...
  discover(projectRoot: string): Promise<SourceFile[]>;   // 归属本项目的会话文件（按源内的 cwd/project 字段过滤）
  identity(file: SourceFile): SessionIdentity;            // source_session_id + git_branch（拿不到则 undefined，fallthrough）
  tail(file: SourceFile, fromByte: number): AsyncIterable<RawLine>;   // 增量读，绝不整文件载入
  parseLine(line: string, ctx: ParseCtx): RawMessage | null;          // 容错：坏行返回 null 并计数
  endSignals: EndSignal[];                    // 按可信度排序的结束信号声明（方针 §6.1）
}

// EndSignal = { kind: 'lifecycle-hook' | 'mtime-idle' | 'process-exit' | 'vcs-boundary', weight: number }
```

- 抽象基类提供模板方法：discover 通用扫描 → 子类只实现 `matchesProject()` 与 `parseLine()`。
- **custom 通道**：`.sessionrelay/adapters/*.js` 按同一接口动态加载，新 Agent 无需发版（方针风险 #11 的缓解）。

### 3.2 状态机（core/state）

```typescript
type SessionEvent = 'NEW_LINE' | 'IDLE_TIMEOUT' | 'END_SIGNAL' | 'COOLDOWN_ELAPSED'
                  | 'RESUMED' | 'MANUAL_CONFIRM' | 'PURGE';
// 迁移表（唯一事实，测试直接对照）：
// active      --IDLE_TIMEOUT/END_SIGNAL-->  pending_end
// pending_end --COOLDOWN_ELAPSED---------->  confirmed   (effect: 提取元数据+summary_rule+meta_text 入主索引)
// 任意非删除态 --RESUMED------------------->  active      (effect: 清 summary_rule/meta_text，标记待重算)
// 任意态      --MANUAL_CONFIRM------------>  confirmed
// pending_end --PURGE--------------------->  (删除该会话行)
```

- `RESUMED` 判定：tail 时发现已 confirmed/pending 会话有新行，或源文件头 hash 变化。
- Clock 与事件源均为构造注入 → 单测用 fake timers 驱动，不真等 10 分钟（§十）。

### 3.3 分词器（core/tokenize）

```typescript
interface Tokenizer { id: 'jieba' | 'bigram'; segment(text: string): string[]; }
```

**索引与查询必须走同一实现实例**（保证 token 一致性），由 SearchService 持有单例注入。

### 3.4 Scope 求值器（core/scope，规格模式）

```typescript
interface ScopePredicate { topics?: string[]; tags?: string[]; files?: string[];
                           sources?: string[]; since?: string; until?: string;
                           sessionIds?: string[]; mode?: 'predicate' | 'full'; }

interface ScopedWhere { sql: string; params: unknown[]; }   // 参数化 SQL 片段

// evaluator.compile(p): ScopePredicate -> ScopedWhere
// 交集语义（方针 D5）：多来源谓词编译后 AND 连接；ignore 恒为独立 AND 片段，任何档不可移除
```

优先级装配：`scope.json（B）∩ 调用参数 ∩ auto-scope（A）`；`attach` 写入的 `sessionIds` 谓词置于 B 档；`set_scope({mode:'full'})` 仅丢弃 A/B/C 裁剪，**ignore 片段永在**。

### 3.5 SearchService（门面，CLI 与 MCP 共用）

```typescript
interface SearchRequest { query: string; filters?: Filters; scopeOverride?: ScopePredicate; limit?: number; }
interface SearchHit {
  sessionId: string; source: SourceId; createdAt: string; state: SessionState;
  score: number; snippet: string;               // 高亮片段
  provenance: ProvenanceBlock;                  // 强制（方针 D10），schema 层校验非空
}
```

无命中返回 `{ hits: [], hint: 'not-found' | 'scope-too-narrow(M/N)' }`，绝不静默空猜。

### 3.6 脱敏引擎（relay/redact）

```typescript
interface Redactor { scan(text: string): RedactionHit[]; apply(text: string, hits): { text, report }; }
// patterns.ts：AKIA/AKSK、-----BEGIN.*PRIVATE KEY-----、Bearer、常见密码赋值、连接串
// 默认导出开（方针 D9）；--no-redact 显式关；report 写入包内 summary/redaction-report.txt
```

------

## 四、设计模式应用

| 模式 | 落点 | 为什么 | 被否的替代 |
| ---- | ---- | ---- | ---- |
| **适配器** | `adapters/*` 对各 Agent 源 | 源格式差异隔离在一处，新增源零侵入核心 | 到处 if source==（散弹式修改） |
| **策略** | Tokenizer / EndSignal / Redactor | 三者都有"可替换算法"且需运行时选择（jieba↔bigram） | 硬编码单一实现 |
| **状态机** | `core/state` | 会话生命周期迁移是正确性核心，必须表驱动可穷举测试 | 散落 if-else（resume 回滚必漏） |
| **仓储** | `store/repo/*` | SQL 不出数据层，核心域零 SQL 依赖，便于内存库单测 | ORM（T9：明确不用） |
| **事件队列/观察者** | `capture/queue+worker` | fs.watch 高频事件去抖批处理，hook 与 watch 两源统一 | 直写 DB（IO 卡守护进程） |
| **管道** | 捕获链：tail→parse→tokenize→extract→persist | 各段可独立测速与短路（坏行只废一行） | 大函数揉一起 |
| **门面** | SearchService | 组合 FTS+过滤+scope+排序+出处，CLI/MCP 一份实现 | 两入口各写一套（双轨漂移） |
| **注册表/插件** | adapters/registry + custom/*.js | 新 Agent 热加载（方针风险 #11） | 编译期静态枚举 |
| **模板方法** | adapters/base 抽象类 | discover 通用骨架复用，子类只填差异 | 每个adapter复制粘贴 |
| **规格模式** | scope/predicate→SQL 编译 | 谓词组合与交集语义以编译期类型保证 | 拼字符串 WHERE（注入+语义错） |
| **构造注入（无框架 DI）** | 全部服务 | 可测性；不引 inversify（重量不匹配） | DI 容器/单例全局 DB 句柄 |
| **反模式清单（明令禁止）** | —— | 全局可变 config、跨进程共享连接、日志打印消息正文、核心域 import IO | —— |

------

## 五、关键流程

### 5.1 捕获与 resume 回滚

```
fs.watch 事件 ─→ Debounce(500ms/文件) ─→ EventQueue
worker（每 2s 冲刷一批）:
  1 stat 文件 → 读 source_files.byte_offset
  2 tail(fromByte) 逐行 → parseLine（坏行计数跳过）
  3 新行 → tokenize → 批量 INSERT messages（单事务）+ 更新 sessions.last_event_at
  4 若该会话 state ∈ {pending_end, confirmed} 且有新行 → 发 RESUMED（回滚 active，清 summary_rule）
  5 更新 source_files(byte_offset, file_hash, line_count, last_seen)
  6 ignore 命中的文件/会话 → 事件丢弃并计入 status 拦截数

判定 tick（watch 内每 30s，Clock 可注入）:
  active      且 last_event_at 距今 > idle_threshold_min 且 EndSignal 成立 → pending_end
  pending_end 且 距 pending 时刻 > cooldown_hours 且无新行                → confirmed
              confirmed 副作用：extract 五类元数据 + summary_rule + 拼 meta_text + sessions_fts 更新
```

### 5.2 检索（CLI/MCP 同路）

```
query → normalize(NFC/小写) → tokenizer.segment → token[]
    → 引号段保留为 phrase；默认 token 间 AND
scope 装配：scope.json ∩ 调用参数 ∩ auto-scope（cwd+branch+近N天） → evaluator.compile → WHERE 片段
两路检索：
  A) messages_fts MATCH ? JOIN sessions(过滤列+scope片段)
  B) sessions_fts MATCH ?（meta 命中：meta 模式会话/元数据匹配）
合并去重（session 级，A 优先）→ rank → snippet 高亮 → 逐条附 provenance
hits < min_hits_hint(3) → 附 hint（"N 条命中当前 scope，全库另有 M 条，可 set_scope full 放宽"）
```

### 5.3 HOP 导出 / 导入

```
导出：选集（默认=当前 scope，--all 覆盖；--topic/--tag/--since/--exclude-tag/--interactive 交）
  → 逐会话装配（消息+元数据+provenance）→ redact（默认开）→ summary_rule 组装 HANDOFF.md/timeline
  → manifest 含逐文件 sha256 + trust 声明 → fflate 打包 .hop → transfer_log

导入：unpack（路径穿越防护：条目必须落在临时目录内）
  → 全量校验 sha256（任一不符整体拒绝）→ manifest.format==='hop/1.0'
  → quarantine?  是：包暂存 .sessionrelay/quarantine/，仅入库会话行+元数据+摘要
                  release <id> 时二次导入该会话消息
                否：按合并规则入库（同 (source,source_session_id) 且 hash 同→跳过；
                    不同→保留双方，新者后缀+imported_from）→ origin='imported' → transfer_log
```

### 5.4 MCP 调用上下文

```
stdio 连接建立 → context: cwd 解析项目根（向上找 .sessionrelay/ 或 .git/）
每次工具调用：装配 scope（B∩A）→ SearchService → 结果强制 provenance → JSON-RPC 返回
set_scope：短暂写锁改 scope.json + scope_log；mode:'full' 只清 A/B/C，不清 ignore
```

------

## 六、搜索子系统详设

### 6.1 分词管线（方针 §6.3 的实现细则）

```
写入: content → NFC + 全角转半角 + 连续空白折叠
      → CJK 连续段交给 jieba.cutForSearch；非 CJK 段按 [A-Za-z0-9_] 切分（保留 . / - 的标识符形态：src/db/query.ts 为单 token）
      → token[] 以空格连接写 messages.search_text
查询: 同管线；token 化后生成 FTS5 表达式：
      "索引 分区" → '索引 AND 分区'；引号内 → '"按月 分区"'（phrase）
```

- 大小写：入库与查询统一小写（标识符 token 保留原形态再小写一次入库，检索等价）。
- 降级策略：`config.search.tokenizer='bigram'` 时 CJK 段切二元组（零依赖，索引约 1.5-2×，不支持单字查询）；接口不变，仅换策略。
- 查询保护：token 数 > 16 截断并提示；单 token 为单 CJK 字符 → 走 sessions_fts 元数据面并提示加长。

### 6.2 排序公式

```
score = bm25(msg命中) × (1 + 0.3×recency) + 0.2×(state==confirmed) + 0.1×has_user_summary
recency = exp(-Δdays/30)
```

参数集中于 `config.search.rank`，基准测试（§九）校准后冻结默认值。

### 6.3 过滤编译

| 过滤 | 编译为 |
| ---- | ------ |
| topic/tag | `EXISTS (SELECT 1 FROM json_each(s.topics) WHERE json_each.value = ?)` |
| file | `EXISTS (... json_each(s.files_mentioned) WHERE value LIKE ? ESCAPE '\')`（前缀通配） |
| source/state | 等值列 |
| since/until | `s.created_at >= ? / <= ?` |
| sessionIds | `s.id IN (...)`（attach 档） |

千级会话规模直接执行；万级以上再评估倒排优化（方针 §7.3，非本期）。

### 6.4 快照与高亮

- snippet：命中 token 首现位置前后各 ~40 字符窗口，`<mark>` 着色（TTY 时 ANSI 高亮，--json 时给 offset 数组）。
- C1-C6 验收用例（方针 §14.1）固化为 `test/unit/core/tokenize/cases.spec.ts` 与 `test/integration/search.spec.ts`，CI 全绿是 Phase 1 合并门槛。

------

## 七、数据层与迁移

### 7.1 迁移框架

- `PRAGMA user_version` 驱动；`migrations/M1.ts...` 每个导出 `{ version, up(db) }`，事务内执行并记录到 `_migrations` 表。
- 启动时 `store/db.ts` 自动向前迁移；**只向前，不回滚**（回滚=删库 rebuild，原则 4 兜底）。

### 7.2 本方案对方针 Schema 的增量

见 §十五（byte_offset 列 + quarantine 目录约定 + 隐藏 `hook` 命令），全部为**加法**，不推翻方针 DDL，实现时回填方针 §7.2 修订记录。

### 7.3 连接与pragma

```
journal_mode=WAL; foreign_keys=ON; synchronous=NORMAL; busy_timeout=5000;
cache_size=-20000(20MB); mmap_size=128MB; temp_store=MEMORY;
每 N 次批量写后 PRAGMA optimize；导出/重建后 ANALYZE。
```

- 所有语句经 db.prepare 缓存（仓储内 Map）。
- 路径统一：入库路径一律 `/` 分隔的相对项目根形式（Windows 优先但存储可移植）。

------

## 八、呈现方式与使用友好度

### 8.1 输出三态

| 形态 | 触发 | 说明 |
| ---- | ---- | ---- |
| 人读（默认） | TTY | 表格/着色/截断；尊重 NO_COLOR、非 TTY 自动降级纯文本 |
| 机器 | `--json` | 全命令支持，稳定契约（v1 冻结字段名），供脚本/CI |
| 静默 | `--quiet` | 只输出结果主体（供管道） |

### 8.2 退出码约定

`0` 成功（含 0 命中）；`1` 运行错误；`2` 用法错误（Commander 默认）。0 命中打印"未找到 + 下一步提示"而非报错。

### 8.3 首跑引导（`srelay init` 向导）

```
1) 扫描本机已装 Agent 源 → 列表勾选（默认全选）
2) 询问捕获模式：full(推荐) / meta / off —— 每项配一句话隐私说明
3) 生成 .sessionrelay/config.json + .sessionrelayignore 模板
4) 立即执行首次 sync（显示进度条：发现 N 会话/入库 M/分词中…）
5) 尾屏提示：三条最常用命令 + 如何注册 MCP（给出对应 Agent 的配置片段）
```

### 8.4 status 透明度面板（隐私焦虑的主防线，方针 §6.2）

```
会话接力 · my-app                          mode: full ● watching
─────────────────────────────────────────────────────
会话    confirmed 128 │ pending 3 │ active 2 │ manual 12
来源    claude-code 96 │ zcode 32 │ dsh 12
拦截    ignore 规则命中 4 个会话（未入库）
体积    relay.sqlite 84 MB │ 可 rebuild（源文件完好率 100%）
最近    08-28 09:12 zcode 「讨论检索排序方案」 [confirmed]
─────────────────────────────────────────────────────
下一步  srelay search <关键词> · srelay export --interactive
```

### 8.5 检索结果呈现（出处块是视觉一等公民）

```
$ srelay search 认证方案
①  JWT 认证方案定了 RS256                     zcode · 08-26 · confirmed
    …讨论了用 JWT 做认证，签名算法选 RS256，因为微服务间…
    src/auth/jwt.ts · topics: auth, jwt · provenance: sess=a3f… msg#12
②  …
3 条命中（当前 scope）。--verbose 看完整出处；srelay show a3f… 看全文
```

### 8.6 错误信息模板

`<什么>失败：<原因>。<下一步动作>`。例：`初始化失败：FTS5 未编译进当前 SQLite。请运行 srelay doctor 查看修复建议，或改用 tokenizer=bigram。` 所有错误必须落到 `shared/errors.ts` 的类型树，禁止裸 throw 字符串。

### 8.7 doctor 自检清单

Node 版本 / FTS5 可用 / jieba 加载 / 各源目录可达 / config 合法 / `PRAGMA integrity_check` / 锁僵死检测 / 磁盘余量 / 迁移状态。每项输出 ✅/⚠️/❌ + 修复命令；`--dump` 打包诊断 bundle（**不含任何消息正文**）。

### 8.8 MCP 注册（README 直接可抄）

```json
{ "mcpServers": { "sessionrelay": { "command": "srelay", "args": ["serve"] } } }
```

### 8.9 友好度红线（验收项）

- 任何命令 `--help` 自解释，示例可复制即用；
- 空库首次 search/status 给引导而非沉默；
- 破坏性操作（purge/rebuild/import 覆盖）必须二次确认并列出影响面；
- 中文 UI 文案与中文检索同为第一等公民。

------

## 九、性能设计

### 9.1 性能预算（超标即修，进 CI 可选门禁）

| 指标 | 预算 | 场景 |
| ---- | ---- | ---- |
| CLI 冷启动到输出 | < 200ms | bin 懒加载；重模块（jieba/MCP/TUI）按需 import |
| 搜索 p95 | < 50ms | 10k 会话 / 100k 消息，warm cache |
| 搜索 p95（大库） | < 150ms | 50k 会话 / 500k 消息 |
| watch 事件→入库 | < 2s | 含去抖窗口 |
| 确认链（元数据+摘要+索引） | < 5s / 会话（1000 消息） | worker 内 |
| 首次全量 sync | 10k 会话 < 60s | 进度条；顺序处理，worker_threads 并行列为后备优化 |
| 导出 1000 会话 | < 5s | |
| 导入校验（sha256） | > 200MB/s | 流式 hash |
| watch 守护常驻内存 | < 150MB | |
| 守护空闲 CPU | ~0 | 事件驱动，无轮询（fs.watch 不可靠源的 mtime 轮询除外，30s/次） |

### 9.2 手段清单

- 增量 tail 按 `byte_offset`，只分词新字节（旧消息 token 永不重算）；
- 批量事务（每 flush 一事务）+ 预编译语句 + `busy_timeout`；
- WAL + `synchronous=NORMAL`（守护是唯一常驻写者，掉电最坏丢一个 flush 批次，rebuild 可恢复）；
- confirmed 才做重活（元数据提取/meta_text/主索引），active 阶段只存消息——把成本从交互热路径挪走；
- `ANALYZE` 仅在 bulk 操作后执行，避免写放大；
- 搜索只取 `rowid+score` 先排序后回表取 snippet（延迟取正文）；
- 二进制依赖全部走预编译（better-sqlite3、@node-rs/jieba），Windows 零 node-gyp。

### 9.3 基准设施

`scripts/gen-corpus.ts` 合成中文语料（可控规模/词表/时间分布）→ `scripts/bench.ts`（tinybench）输出报告并对照 §9.1 预算；`test/perf/` 为可选 CI 门禁（nightly 跑，PR 不阻塞，回归 > 30% 告警）。

------

## 十、测试与质量保障

### 10.1 金字塔与覆盖目标

| 层 | 内容 | 覆盖 |
| -- | ---- | ---- |
| 单元 | 状态机迁移表逐条、分词（C1-C6 + 属性测试）、过滤编译、排序、脱敏模式、scope 交集、ignore 语法、HOP manifest 校验、merge 规则 | core/ 与 relay/redact ≥ 90% |
| 集成 | 临时项目 + 假 adapter：watch→queue→worker→DB 全链路；迁移序列；rebuild 幂等 | ≥ 75% 总体 |
| 契约 | MCP stdio 真实握手：8 工具 schema、响应必含 provenance 字段、set_scope 交集语义 | 100% 工具 |
| E2E | ① resume 重放：脚本化时间线（写10行→触发idle→追加5行）断言回滚与摘要重算 ② HOP 往返：export→import--merge→export，除时间戳外逐文件 hash 稳定 ③ 真实 Claude Code JSONL fixture（匿名化）捕获 ④ 密钥注入→导出被脱敏且报告准确 ⑤ quarantine 导入→release 前后可见性 | 全绿为发布门槛 |
| 性能 | §9.3 | 可选门禁 |

### 10.2 关键可测性设计（架构即测试性）

- 状态机注入 Clock/EventSource → fake timers，不真等 6 小时冷却；
- `ignore-parser`、`redact`、`tokenizer` 全部纯函数；
- repo 层可注入内存 SQLite（`:memory:` + 同迁移）；
- 假 adapter（`test/fixtures/fake-source`）可编程吐行，模拟任意 agent 行为。

### 10.3 CI（GitHub Actions）

矩阵：`[ubuntu, windows, macos] × [node 18, 20, 22]`；步骤：lint → typecheck → unit → integration → contract → e2e → coverage（阈值不符即红）。Windows 是一等平台（本机开发环境即 Windows + Git Bash）。

### 10.4 追溯矩阵（方针验收 → 测试）

| 方针验收 | 自动化落点 |
| -------- | ---------- |
| C1-C6 中文用例 | `tokenize/cases.spec.ts` + `integration/search.spec.ts` |
| resume 回滚正确 | `e2e/resume-replay.spec.ts` |
| 出处 100% | contract 断言 + SearchHit 类型非空校验 |
| 脱敏默认开 | `e2e/redact.spec.ts` |
| mode off 零写入 | `integration/modes.spec.ts` |
| scope 串台已知局限 | `integration/scope-concurrent.spec.ts` 标记 skip-bug-P4（显式登记而非装作没有） |

------

## 十一、可靠性、可观测性与安全

### 11.1 错误分类与韧性

- 错误树：`SRelayError{ CaptureError, ParseError(含 badLines 计数), StateConflict, StoreError, RelayError{IntegrityError, ZipSlipError}, ScopeError, ConfigError }`。
- 韧性原则：**坏一行废一行，坏一文件废一文件，守护进程永不因单点崩**；错误计数进 status/doctor；ParseError 超 50% 行的文件自动标记 `suspect` 并在 doctor 提示（格式漂移预警，方针风险 #11）。

### 11.2 日志（内容零泄漏红线）

- pino → `.sessionrelay/logs/srelay.log`（滚动 5×2MB）；`--debug` 镜像 stderr。
- **info 级只允许：ids、计数、hash、耗时、路径**；消息正文/摘要永不入日志（隐私原则的工程化）。

### 11.3 安全要点

- **零外呼**：依赖白名单审查，运行时无任何网络请求（HOP 传输靠用户自己的渠道）；CI 加 `ci-info` 类检查脚本兜底。
- zip-slip：解包条目 `resolve` 后必须仍在目标目录内，否则 `ZipSlipError` 整体拒绝。
- sha256 完整性：导出逐文件计算入 manifest，导入逐文件校验。
- ignore 不可绕过：编译进所有查询路径的最外层 AND 片段，且 export/import 同样过 ignore（防"绕过查询直取数据包"）。
- 锁：`.sessionrelay/lock`（pid+心跳），僵死 60s 自动接管，接管记录入日志。

------

## 十二、依赖、构建与分发

| 依赖 | 用途 | 选型理由 |
| ---- | ---- | ---- |
| commander | CLI | 方针定案；成熟零惊喜 |
| better-sqlite3 | 存储 | 同步事务模型契合单写者；win 预编译 |
| @node-rs/jieba | 中文分词 | napi 预编译免 node-gyp（Windows 关键） |
| @modelcontextprotocol/sdk | MCP | 官方 SDK |
| fflate | zip | 纯 JS、流式、体积小 |
| @inquirer/prompts | 交互勾选 | 无 TUI 框架债务 |
| picocolors / cli-table3 | 呈现 | 轻 |
| pino | 日志 | 结构化、低开销 |

- dev：typescript(strict)、tsup（build 出单文件 ESM bin）、tsx、vitest(+coverage v8)、eslint+prettier、tinybench。
- 分发：npm 包 `sessionrelay`，`npx sessionrelay@latest` 可零安装试用；独立二进制（Node SEA）列 Phase 4。
- 版本：semver；CLI `--json` 契约与 HOP `hop/1.0` 均为公共契约，破坏性变更必须 major + 迁移说明。

------

## 十三、里程碑映射（方针 §十二 → 模块）

| Phase | 交付模块 | 退出测试（对应 §10.4） |
| ----- | -------- | ---------------------- |
| P0 W0 | `core/tokenize`(S1) `adapters/claude-code`(S2) `core/state`(S3) `core/scope`(S4) `docs/adapters/zcode-format.md`(S5) | C1-C6 绿 / resume 原型 / `_scoped_where` 原型 / Zcode 格格草案 |
| P1 W1-2 | `store(+M1)` `capture/{watcher,queue,worker,sync,save,ignore}` `privacy` `cli/{init,watch,sync,save,status,mode,search,show,list,doctor}` | 零干预捕获率>90%、mode off 零写入、status 自洽、中文门槛 |
| P2 W3 | `core/extract` `capture/judge` `hook-spool` `cli/{decisions,history,unresolved,confirm,purge}` `core/provenance` | resume 重放绿、决策带出处 |
| P3 W4 | `mcp/*` `scope A/B 档全量` `attach` `adapters/zcode` | 契约测试绿、scoped 不串台（P4 已知项显式登记）、双 agent 同库 |
| P3.5 W5 | `relay/*` `hop/*` `redact/*` `quarantine` `cli/{export,import,team}` `scope C 档` | HOP 往返 hash 稳定、脱敏报告、HANDOFF 可读、quarantine 生效 |
| P4 W6+ | `--ai` 摘要、branch/PID 归属 + `get_linked_sessions`、语义可选、SEA 二进制、HOP 推广 | 视反馈 |

------

## 十四、技术非目标

不做（做了违反本方案）：ORM/DI 框架；Electron/Web 面板；插件市场（custom adapter 目录已够）；守护进程内嵌 LLM 调用；分布式/多机同步；修改源会话文件；把 `--json` 契约做成"随便改"；Windows 之外平台降级为二等公民。

------

## 十五、Schema 增量修订建议（回填方针）

实现层发现方针 §7.2 需要以下**加法**（不推翻任何 D 决策）：

| # | 增量 | 理由 | 迁移 |
| - | ---- | ---- | ---- |
| R1 | `source_files` 增加 `byte_offset INTEGER NOT NULL DEFAULT 0` | 增量 tail 依据（§5.1），避免每次全文件重读重分词 | M2 |
| R2 | `source_files` 增加 `bad_lines INTEGER DEFAULT 0`、`suspect INTEGER DEFAULT 0` | 格式漂移预警（方针风险 #11 的检测手段） | M2 |
| R3 | quarantine 以**目录约定**实现（`.sessionrelay/quarantine/`），不加表 | release 即对暂存包局部重导入，避免双写状态 | — |
| R4 | 隐藏命令 `srelay hook <event> --id <sid>`（写 `.sessionrelay/events/` spool） | Claude Code SessionEnd hook 落地的最低成本通道 | — |

按方针维护规则：以上随实现 PR 回填方针 §7.2 并注明 `Review #2`。

------

## 十六、技术决策日志

| # | 决策 | 理由 | 被否替代 |
| - | ---- | ---- | ---- |
| T1 | ESM-only，Node ≥18 | MCP SDK 生态；放弃 CJS 双发包省一半维护 | 双格式发布 |
| T2 | better-sqlite3 同步 API | 单写者模型下同步=更简单事务边界；win 预编译 | node:sqlite(仍在实验)/异步驱动 |
| T3 | 分词索引/查询共用同一 Tokenizer 实例 | token 不一致是中文检索最大隐性 bug 源 | 两处各写 |
| T4 | CLI 与 MCP 共用 SearchService 门面 | 出处/排序/scope 单一实现，杜绝双轨漂移 | 各自实现 |
| T5 | 状态机表驱动 + Clock 注入 | 冷却期逻辑必须可测（不能真等 6h） | 时间散落各处 |
| T6 | Scope 编译为参数化 SQL 片段（规格模式） | 交集语义类型化保证 + 防注入 | 运行时拼 WHERE |
| T7 | 常驻单写者 + 短进程短暂写锁 + 心跳锁文件 | Windows 无可靠 ps；跨平台僵死检测 | 跨进程共享连接（禁止） |
| T8 | confirmed 才提取元数据/建主索引 | 成本离开交互热路径；active 会话本来就还可能变 | 每次追加都重提取 |
| T9 | 不用 ORM，仓储手写 SQL | FTS5 触发器/json_each 等特性 ORM 反而碍事 | Drizzle/Prisma |
| T10 | fflate 纯 JS zip | 免原生依赖；流式够快（§9.1） | adm-zip（停更）/原生 zip |
| T11 | 日志内容零泄漏（ids/计数/hash only） | 隐私原则的工程红线，日志是最易漏的出口 | debug 打全文 |
| T12 | doctor 而非文档排障 | 自检+修复建议把支持成本前置进产品 | README FAQ 长文 |
| T13 | Windows 为一等开发/CI 平台 | 本机即 Windows；国产 agent 用户主战场也在 win | 只在 mac/linux 开发 |
| T14 | `--json` 契约 v1 冻结 | 脚本化用户的信任基础 | 随便加字段 |
| T15 | 懒加载 bin 入口 | 200ms 启动预算的唯一可行解 | 全量 import |
| T16 | 性能测试 nightly 可选门禁 | PR 门禁会逼人优化基准而非产品；回归告警即可 | 每次 PR 强制 |

------

*实现即对照：每个 PR 描述引用本文章节号与方针 D/T 编号；发现设计不可行，先改文档再改代码。*
