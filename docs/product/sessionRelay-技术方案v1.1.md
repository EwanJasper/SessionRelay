# 会话接力 SessionRelay — 技术方案 v1.1

> ⚠️ 本文档为当前有效版本。
>
> **版本**：v1.1（Technical Design）
> **日期**：2026-08-28
> **上游**：本文以 `sessionRelay-指导方针v3.1.md`（含 Review #1-#3）为纲，是其技术实现层的设计定案。方针 D1-D20 决策、§十二阶段计划、§十四验收用例（C1-C6）在本文中全部有对应落点，冲突时以方针为准并回写修订。
> **技术决策登记**：T1-T31（§十六），与方针 D 系列编号互不混淆。
> **维护方式**：活文档。实现中发现偏差，先改本文（登记 T 编号），重大偏差回写方针。

**修订记录**

| 版本 | 日期 | 内容 |
| ---- | ---- | ---- |
| v1.0 | 2026-08-28 | 初版：架构/目录/模式/流程/搜索/性能/测试/安全定案，T1-T16 |
| v1.1 | 2026-08-28 | 架构评审修订：修复 S1-S4（消息幂等与事务边界、HOP 导入归化、守护生命周期、状态迁移单点化）；A1-A8 容量与一致性隐患；B 级工程细节；回填方针 Review #2 的 T17-T19。新增 T20-T31 |
| 活文档更新 | 2026-08-28 | Phase 0 Spike 回填：S1-S5 全过（42/42 测试）；F1 已回填方针 Review #4；F2-F6 与 S5 发现（水位 cursor 泛化）并入正文；新增 T34-T37（详见 `sessionrelay/docs/spike-report-p0.md`） |
| 活文档更新 | 2026-08-28 | Phase 1/2 回填：ZCode adapter 提前落地（§3.1 契约 3 已注）；hook-spool 按 R4 落地（`capture/hook-spool.ts` + `srelay hook` 隐藏命令）；confirmed 统一入口 `confirmSession`（judge 与 CLI 同路，提取+摘要+meta_text 重算）；P1-C（`--import tsx` 需绝对 file:// loader，服务任务脚本已内建）；P1-D（`tsc --noEmit` 设为必跑红线，实现在 `package.json scripts.typecheck`）；R8/P1-A 已回填方针 Review #5。实机验收报告 `sessionrelay/docs/phase1-report.md` / `phase2-report.md`，63/63 测试绿 |
| 活文档更新 | 2026-08-28 | Phase 3 回填：MCP 8 工具落地（`mcp/server.ts`，scope-aware + 出处 + hint + T28 热更新），契约测试为真实 stdio 握手；Scope A/B 档与 CLI/MCP 装配差异（CLI 不吃 A 档）写入 §3.4 语义；attach 落地为 sessionIds 谓词 + scope_log，**session_links 一等关联推迟至 Phase 4**（P3-A：需会话身份）；ZCode active_run_last_seen 辅助信号与 tool-parts 文件提取列 Phase 4（P3-B/P3-C）。报告 `docs/phase3-report.md`，74/74 绿 |
| 活文档更新 | 2026-08-28 | **Phase 3.5 收官**：HOP 全链路落地（`relay/{hop,redact,export,import,handoff-md}.ts` + `team` 命令），81/81 绿。实机发现：P35-A 子目录 CLI 向上发现父项目根（按 §3.4 设计，README 需写明接收方在项目根执行 import）；P35-B files 提取单段斜杠误报（`/DSH` 等，Phase 4 过滤）；P35-C 自导回导产生后缀副本（合并规则正确行为）。报告 `docs/phase35-report.md` |

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
15. [Schema 增量修订（对方针）](#十五schema-增量修订对方针)
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
   零 IO，可单测）         │  tokenize/  scope-eval/  stats/│
                        └──────────────┬──────────────┘
                                       ↓ 被实现
                        ┌─────────────────────────────┐
   基础设施（端口实现）    │  store/(SQLite)  adapters/(各Agent源) │
                        │  shared/(config/log/lock/fs)        │
                        └─────────────────────────────┘
```

### 1.2 运行时拓扑：一守护 + 两类短进程 + 守护的守护

```
┌─ 常驻（系统服务或手动）───────────────────────────────────────┐
│ srelay watch 守护进程（唯一常驻写者 + 唯一状态迁移者，持 lock）   │
│  fs.watch ─→ Debounce(500ms) ─→ EventQueue ─→ Worker(批处理)  │
│  Hook spool 消费（.sessionrelay/events/，Claude Code 钩子写入） │
│  判定 tick（30s）：idle→pending_end→confirmed，resume 回滚      │
│  ▲ 由系统服务管理器拉起（install-service），崩溃自动重启          │
└──────────────────────┬──────────────────────────────────────┘
                       │ WAL：读不阻塞写，写不阻塞读
      ┌────────────────┴────────────────┐
      │ srelay <cmd>  （短进程：读为主，  │  srelay serve （MCP 长进程：
      │  save/scope/mode 短暂取写锁）     │  只读 + set_scope 短暂写）
      └─────────────────────────────────┘
  守护缺席检测（T22）：任何 CLI 调用检查 lock 心跳 →
  守护未运行 → status 红色告警 + 提示 srelay sync 一次性兜底
```

三条硬约束（评审 S3/S4 的架构化）：

1. **单写者**：watch 是唯一常驻写者；CLI/serve 的写操作以短暂排它锁完成（锁文件带心跳，僵死 60s 自动接管）。
2. **状态迁移单点**：任何会话状态迁移（active/pending_end/confirmed/RESUMED）**只发生在 watch 进程内**；CLI 与 MCP 永不触发状态迁移（方针"绝不在 MCP 层判定"的工程化）。
3. **守护的守护**：auto-capture 的产品承诺依赖 watch 常驻，常驻本身由系统服务保障——`srelay watch --install-service` 注册（Windows 计划任务 / macOS launchd / Linux systemd user unit），init 向导默认推荐注册；不注册则 CLI 检测告警 + `sync` 兜底。

### 1.3 技术栈定案（对应方针 §十一）

| 层 | 选型 | 备注 |
| -- | ---- | ---- |
| 语言/运行时 | TypeScript 5.x（ESM-only），Node ≥ 18 | T1 |
| 存储 | better-sqlite3（同步 API） | 同步简化事务边界；单写者下无阻塞问题；win32-x64 有预编译（本机 Windows 优先） |
| 分词 | @node-rs/jieba（napi 预编译），bigram 为降级实现 | 同一 `Tokenizer` 接口，策略可换；v2 为类 API：`Jieba.withDict(dict)`，dict 来自 `@node-rs/jieba/dict` 子模块（F2） |
| CLI | Commander.js + picocolors + cli-table3 | 轻量，无 TUI 框架 |
| 交互 | @inquirer/prompts（checkbox/search） | scope pick、save/export --interactive |
| MCP | @modelcontextprotocol/sdk（stdio） | |
| 压缩包 | fflate（zip 读写，纯 JS） | HOP 容器 |
| 日志 | pino（文件输出） | 内容零泄漏，见 §十一 |
| 服务注册 | 各 OS 原生机制（schtasks / launchd / systemctl --user） | T22，零第三方依赖 |
| 构建/测试 | tsup、vitest、tsx、eslint、prettier | 原生模块必须 external（§十二） |

------

## 二、仓库目录结构

```
sessionrelay/
├── package.json                 # name: sessionrelay, bin: { srelay, sessionrelay }
├── package-lock.json            # 提交入库（供应链可重现，T32 要求）
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
│   │   │                        # doctor/rebuild/scope/attach/detach/export/import/team/
│   │   │                        # stats/serve/hook(隐藏)
│   │   ├── options.ts           # 公共 flag 定义（--json/--debug/--limit...）
│   │   └── ui/                  # render.ts(输出格式) tables.ts theme.ts prompts.ts hints.ts
│   ├── core/                    # ── 纯逻辑，禁止 import IO ──
│   │   ├── model/               # UnifiedSession/UnifiedMessage/Provenance 等值对象
│   │   ├── state/               # machine.ts 状态机（Clock/EventSource 可注入）+
│   │   │                        # serializer.ts 每会话串行链（T23）
│   │   ├── tokenize/            # tokenizer.ts(接口) jieba.ts bigram.ts normalize.ts
│   │   ├── extract/             # files/topics/decisions/questions/codes/summary-rule.ts
│   │   ├── search/              # engine.ts(编排) query-lang.ts rank.ts merge.ts snippet.ts
│   │   ├── scope/               # predicate.ts(解析) evaluator.ts(编译为SQL) auto.ts hint.ts
│   │   ├── stats/               # counter.ts 本地匿名计数器（T17，仅事件名计数）
│   │   └── relay-model/         # HOP manifest/条目的纯数据结构与校验
│   ├── adapters/                # ── 端口实现：各 Agent 源 ──
│   │   ├── base.ts              # SessionSource 接口 + 抽象基类（含 seq_num 确定性契约）
│   │   ├── registry.ts          # 注册表 + custom 加载器（.sessionrelay/adapters/*.js）
│   │   ├── claude-code/         # discover/tail/parse/end-signals
│   │   ├── zcode/  dsh/(stub)  custom/
│   ├── capture/                 # watcher.ts debouncer.ts tailer.ts(完整行规则) queue.ts
│   │                            # worker.ts(事务边界) judge.ts(判定tick) sync.ts(孤儿清理)
│   │                            # save.ts hook-spool.ts ignore.ts service-install.ts(T22)
│   ├── store/
│   │   ├── db.ts                # 连接管理（WAL/外键/预编译缓存/版本探测 T30）
│   │   ├── migrate.ts + migrations/   # M1..Mn（user_version 驱动）
│   │   └── repo/                # sessions.ts messages.ts(幂等写入) sources.ts links.ts
│   │                            # scope-log.ts transfer-log.ts（SQL 不出此层）
│   ├── search-svc/              # SearchService 门面（组合 core.search+scope+repo+provenance）
│   ├── relay/                   # export/ import(归化 T21)/ handoff-md.ts(页脚署名 T19)
│   │   └── hop/                 # pack.ts(写zip) unpack.ts(读zip,防zip-slip) manifest.ts
│   │   └── redact/              # engine.ts patterns.ts report.ts
│   │   └── quarantine.ts merge.ts
│   ├── mcp/
│   │   ├── server.ts            # stdio 生命周期 + 错误封装
│   │   ├── context.ts           # cwd→项目解析、scope 装配(热更新 T28)、调用级写锁
│   │   └── tools/               # 一工具一文件，JSON Schema 与实现同处
│   ├── privacy/                 # ignore-parser.ts（gitignore 语法子集）modes.ts
│   └── shared/                  # config.ts(四级合并) errors.ts log.ts lock.ts(心跳)
│                                # hash.ts paths.ts(统一'/'分隔) time.ts ids.ts
└── test/
    ├── unit/                    # 镜像 src 结构
    ├── integration/             # 临时项目 fixture + 假 adapter 全链路
    ├── contract/                # MCP 工具 JSON-RPC 契约
    ├── e2e/                     # resume 重放 / HOP 往返 / 脱敏 / 崩溃恢复 / 并发写 / 守护告警
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
- **custom 通道**：`.sessionrelay/adapters/*.js` 按同一接口动态加载，新 Agent 无需发版（方针风险 #11 的缓解）。custom adapter 是用户机器上的**用户自有代码**，风险自担；但 **HOP 导入永远不执行任意 JS**（包内只有数据，见 §十一安全红线）。

**两条 Adapter 契约（评审 T20/T29）**：

1. **seq_num 确定性契约**：`RawMessage.seq_num` 必须由源文件确定性推导（缺省 = 源文件行号；一个会话跨多文件的 agent 须合成单调序，如 `fileIndex×10^7 + lineNo`）。同一行被重放（崩溃恢复、offset 回退）必须得到**相同的 seq_num**——这是消息幂等去重键 `(session_id, seq_num)` 成立的前提。非消息行导致的序号空洞是合法的（排序不受影响）。
2. **文件身份契约**：会话文件可能被 agent 归档/改名，**身份永远是 `(source, source_session_id)`**（库侧 `ux_sessions_src` 唯一索引兜底去重）；`source_files` 中的孤儿记录（路径消失但身份仍在）由 sync 的过期清理标记 `deleted`，不算错误。
3. **水位契约（S5/T34）**：增量水位不是文件型源专属——SQLite 型源（ZCode）无"文件追加"语义，用 `(sequence, id)` 复合游标；`tail(fromByte)` 泛化为 `tail(fromCursor)`，`source_files` 的 byte_offset 相应泛化为 `cursor TEXT`（§十五 R1 修订）。SQLite 源必须以 `readonly` 连接读取（ZCode 格式详见 `docs/adapters/zcode-format.md`）。

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

- `RESUMED` 判定：tail 时发现已 confirmed/pending 会话有新行，或源文件头 hash 变化；文件被整体改写（行数回退/头 hash 变）时按"重写"处理——删除该会话消息后重摄取。
- Clock 与事件源均为构造注入 → 单测用 fake timers 驱动，不真等 10 分钟（§十）。
- **串行化约束（T23）**：所有会话级状态迁移经过 `serializer.ts` 的每会话 Promise 链（`Map<sessionId, Promise>`）——判定 tick 与 worker 对同一会话的交错写在此处被物理排除；且判定 tick 与 worker 必须同进程同事件循环（§1.2 约束 2 的实现机制）。

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

**ignore 的排除编译（T37，Spike F5）**：ignore 谓词以 negate 模式编译为 `NOT (f1 OR f2 …)`——命中任一维度即整体排除。若按包含语义编译，被 ignore 的会话反而通过隐私过滤（Spike 首轮测试当场抓获）。

**热更新（T28）**：serve 与 CLI 每次装配时 `stat` 一次 scope.json，mtime 变化即重编译（编译结果按 mtime 缓存）——用户 `scope set` 后 MCP 下一次调用立即生效，无需重启。

### 3.5 SearchService（门面，CLI 与 MCP 共用）

```typescript
interface SearchRequest { query: string; filters?: Filters; scopeOverride?: ScopePredicate; limit?: number; offset?: number; }
interface SearchHit {
  sessionId: string; source: SourceId; createdAt: string; state: SessionState;
  score: number; snippet: string;               // 高亮片段
  provenance: ProvenanceBlock;                  // 强制（方针 D10），schema 层校验非空
}
```

无命中返回 `{ hits: [], hint: 'not-found' | 'scope-too-narrow(M/N)' }`，绝不静默空猜。分页 MVP 用 offset（A4，cursor 列 Phase 4）。

### 3.6 脱敏引擎（relay/redact）

```typescript
interface Redactor { scan(text: string): RedactionHit[]; apply(text: string, hits): { text, report }; }
// patterns.ts：AKIA/AKSK、-----BEGIN.*PRIVATE KEY-----、Bearer、常见密码赋值、连接串
// 默认导出开（方针 D9）；--no-redact 显式关；report 写入包内 summary/redaction-report.txt
```

### 3.7 守护生命周期（capture/service-install，T22）

| OS | 机制 | 命令 |
| -- | ---- | ---- |
| Windows | 计划任务（schtasks，用户登录时启动） | `srelay watch --install-service` |
| macOS | launchd LaunchAgent（~/Library/LaunchAgents） | 同上 |
| Linux | systemd user unit + loginctl enable-linger | 同上 |

- `--uninstall` 卸载；`--status` 查看注册状态；init 向导最后一步**默认推荐注册**（一键回车即装）。
- 不注册的用户：CLI 每次执行检测 lock 心跳，守护缺席 → status 红色告警 + 提示 `srelay sync` 一次性兜底（数据不丢，只是判定延迟）。

### 3.8 本地匿名计数器（core/stats，T17）

```typescript
type StatsEvent = 'install' | 'init_done' | 'backfill_done' | 'first_hit' | 'weekly_ref'
                | 'cli_search' | 'cli_show' | 'mcp_search' | 'mcp_detail'
                | 'export_pkg' | 'import_pkg';
interface StatsCounter {
  increment(event: StatsEvent): void;            // 仅事件名计数，无任何参数/内容/路径
  snapshot(): Record<StatsEvent, number>;
}
```

- 落盘 `.sessionrelay/stats.json`（可随时删，不影响任何功能）；`srelay stats --show/--report/--reset` 查看/生成自愿报告/清零（方针 §15.5）。

------

## 四、设计模式应用

| 模式 | 落点 | 为什么 | 被否的替代 |
| ---- | ---- | ---- | ---- |
| **适配器** | `adapters/*` 对各 Agent 源 | 源格式差异隔离在一处，新增源零侵入核心 | 到处 if source==（散弹式修改） |
| **策略** | Tokenizer / EndSignal / Redactor | 三者都有"可替换算法"且需运行时选择（jieba↔bigram） | 硬编码单一实现 |
| **状态机** | `core/state` | 会话生命周期迁移是正确性核心，必须表驱动可穷举测试 | 散落 if-else（resume 回滚必漏） |
| **串行执行器**（Actor 变体） | `core/state/serializer.ts` 每会话 Promise 链 | 物理排除判定 tick 与 worker 对同一会话的交错写（T23） | 分布式锁（单进程内杀鸡用牛刀） |
| **仓储** | `store/repo/*` | SQL 不出数据层，核心域零 SQL 依赖，便于内存库单测 | ORM（T9：明确不用） |
| **事件队列/观察者** | `capture/queue+worker` | fs.watch 高频事件去抖批处理，hook 与 watch 两源统一 | 直写 DB（IO 卡守护进程） |
| **管道** | 捕获链：tail→parse→tokenize→extract→persist | 各段可独立测速与短路（坏行只废一行） | 大函数揉一起 |
| **门面** | SearchService | 组合 FTS+过滤+scope+排序+出处，CLI/MCP 一份实现 | 两入口各写一套（双轨漂移） |
| **注册表/插件** | adapters/registry + custom/*.js | 新 Agent 热加载（方针风险 #11） | 编译期静态枚举 |
| **模板方法** | adapters/base 抽象类 | discover 通用骨架复用，子类只填差异 | 每个adapter复制粘贴 |
| **规格模式** | scope/predicate→SQL 编译 | 谓词组合与交集语义以编译期类型保证 | 拼字符串 WHERE（注入+语义错） |
| **构造注入（无框架 DI）** | 全部服务 | 可测性；不引 inversify（重量不匹配） | DI 容器/单例全局 DB 句柄 |

**克制条款**：模式够用即停——上表每一种都有当前就存在的落点，禁止"为了模式而模式"（如 MVP 不引入事件溯源、CQRS、微内核）。反模式禁令不变：全局可变 config、跨进程共享连接、日志打印消息正文、核心域 import IO。

------

## 五、关键流程

### 5.1 捕获与 resume 回滚（含事务边界与幂等，T20/T23/T29）

```
fs.watch 事件 ─→ Debounce(500ms/文件) ─→ EventQueue
worker（每 2s 冲刷一批，每文件一个事务）:
  1 stat 文件 → 读 source_files.byte_offset
  2 tail(fromByte)：只消费以 \n 结尾的完整行；末尾残行留待下轮（防坏行计数污染）
  3 parseLine（坏行计数跳过）→ 新行 seq_num = 源确定性序号（§3.1 契约）
  4 ── 事务开始 ──
    INSERT OR IGNORE INTO messages(..., session_id, seq_num, ...)   -- 幂等：去重键(session_id,seq_num)
    若该会话 state ∈ {pending_end, confirmed} 且本批有新行 → 标记待发 RESUMED
    UPDATE source_files SET byte_offset/file_hash/line_count/last_seen   -- 与消息同事务推进
    ── 事务提交 ──（崩溃点任意：要么都生效，要么都不生效；即便 offset 丢失回退重读，
                    相同 seq_num 被 OR IGNORE 去重——双保险）
  5 事务提交后，经 per-session 串行链派发 RESUMED（清 summary_rule → active）

判定 tick（watch 内每 30s，Clock 可注入，与 worker 同进程同事件循环）:
  active      且 last_event_at 距今 > idle_threshold_min 且 EndSignal 成立 → pending_end
  pending_end 且 距 pending 时刻 > cooldown_hours 且无新行                → confirmed
              confirmed 副作用（经同一串行链）：extract 五类元数据 + summary_rule
              + 拼 meta_text + sessions_fts 更新
  文件重写检测（行数回退/头 hash 变）→ 该会话消息删除后重摄取

sync 孤儿清理（T29）：
  全量扫描时，source_files 中 last_seen 超 30 天且文件不存在 → deleted=1
  （文件被 agent 归档改名属正常：会话身份在 sessions 表，不受影响）
  ignore 命中的文件/会话 → 事件丢弃并计入 status 拦截数
```

### 5.2 检索（CLI/MCP 同路）

```
query → normalize(NFC/小写) → tokenizer.segment → token[]
    → 引号段保留为 phrase；默认 token 间 AND；token 数 >16 截断并提示
scope 装配：每次调用 stat scope.json（mtime 缓存，热更新 T28）
    → scope.json ∩ 调用参数 ∩ auto-scope（cwd+branch+近N天） → evaluator.compile → WHERE 片段
两路检索（各取 LIMIT×3 参与合并，T27）：
  A) messages_fts MATCH ? JOIN sessions(过滤列+scope片段)
  B) sessions_fts MATCH ?（meta 命中：meta 模式会话/元数据匹配）
应用层合并去重（session 级，A 优先）→ rank → 取 LIMIT/OFFSET → snippet 高亮
    → 逐条附 provenance
hits < min_hits_hint(3) → 附 hint（"N 条命中当前 scope，全库另有 M 条，可 set_scope full 放宽"）
--debug 下输出耗时分解：分词/FTS×2/合并/格式化（性能归因）
```

### 5.3 HOP 导出 / 导入（含归化，T21）

```
导出：选集（默认=当前 scope，--all 覆盖；--topic/--tag/--since/--exclude-tag/--interactive 交）
  → 逐会话装配（消息+元数据+provenance）→ redact（默认开）→ summary_rule 组装 HANDOFF.md/timeline
    （HANDOFF.md 页脚固定署名，T19，方针 §10.6）
  → manifest 含逐文件 sha256 + trust 声明 → fflate 打包 .hop → transfer_log

导入：unpack（路径穿越防护：条目必须落在临时目录内）
  → 全量校验 sha256（任一不符整体拒绝）→ manifest.format==='hop/1.0'
  → 归化（T21）：每个会话 project_id 重写为当前项目，原值存 origin_project
    （否则按项目过滤的检索永远查不到导入会话——方针 Review #3/D19）
  → quarantine?  是：包暂存 .sessionrelay/quarantine/，仅入库会话行+元数据+摘要
                  release <id> 时二次导入该会话消息
                否：按合并规则入库（同 (source,source_session_id) 且 hash 同→跳过；
                    不同→保留双方，新者后缀+imported_from）→ origin='imported' → transfer_log
```

### 5.4 MCP 调用上下文

```
stdio 连接建立 → context: cwd 解析项目根（向上找 .sessionrelay/ 或 .git/）
每次工具调用：stat scope.json（热更新）→ 装配 scope（B∩A）→ SearchService
    → 结果强制 provenance → JSON-RPC 返回
set_scope：短暂写锁改 scope.json + scope_log；mode:'full' 只清 A/B/C，不清 ignore
（MCP 永不触发会话状态迁移——§1.2 约束 2）
```

### 5.5 守护生命周期（T22）

```
install-service：写入 OS 服务定义 → 启动 → status 显示 ● running(服务)
崩溃：服务管理器自动拉起（指数退避）；lock 心跳防双实例
卸载：--uninstall 停止并删除定义
守护缺席（用户未注册服务）：任何 CLI 调用检查 lock 心跳 →
    红色告警"auto-capture 未运行，最近会话可能未捕获" + 建议（注册服务 / srelay sync 兜底）
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
- **单字 CJK 索引规则（T35，Spike F3）**："按月"等非词典组合会被切成单字，短语查询（C5）依赖单字在 token 流中的**位置连续性**——索引侧保留单字；非引号查询侧丢弃单字（无区分度）；引号短语保留完整 token 序列。
- **AND→OR 兜底（T36，Spike F4）**：会话级 AND 零命中时回退 OR 并按覆盖度排序（coverage<1 可识别降级）——满足"认证方案"命中"用 JWT 做认证"这类部分关键词的真实查询（C2 实测验证）。
- 备忘（F6）：jieba 会把中文标点（，。）切为独立 token 入索引，无害但膨胀；Phase 1 可在 normalize 阶段过滤。
- 查询保护：token 数 > 16 截断并提示；单 token 为单 CJK 字符 → 走 sessions_fts 元数据面并提示加长。
- **超长消息策略（T26）**：单条消息 content > 512KB → 截断存储并在该行标记 `truncated`（messages 表复用 search_text 前缀约定）；search_text **全量分词不截断**（jieba 切 1MB 为毫秒级，截断只会丢检索能力）。

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
| project | `s.project_id = ?`（当前项目；导入会话已归化，T21） |

千级会话规模直接执行；万级以上再评估倒排优化（方针 §7.3，非本期）。

### 6.4 合并、分页与快照（T27）

- 两路（messages_fts / sessions_fts）各取 `LIMIT×3` 进入应用层合并；session 级去重，A 路优先；排序后裁剪到请求的 LIMIT/OFFSET——保证同一查询结果确定性。
- 分页：MVP 用 offset（CLI `--limit/--offset`、MCP `limit/offset` 参数）；cursor 翻页列 Phase 4。
- snippet：命中 token 首现位置前后各 ~40 字符窗口，`<mark>` 着色（TTY 时 ANSI 高亮，--json 时给 offset 数组）。
- C1-C6 验收用例（方针 §14.1）固化为 `test/unit/core/tokenize/cases.spec.ts` 与 `test/integration/search.spec.ts`，CI 全绿是 Phase 1 合并门槛。

------

## 七、数据层与迁移

### 7.1 迁移框架

- `PRAGMA user_version` 驱动；`migrations/M1.ts...` 每个导出 `{ version, up(db) }`，事务内执行并记录到 `_migrations` 表。
- 启动时 `store/db.ts` 自动向前迁移；**只向前，不回滚**（回滚=删库 rebuild，原则 4 兜底）。
- **前向版本探测（T30）**：启动时若 `user_version` 高于当前二进制支持的迁移上限 → 拒绝启动并提示"数据库由更新版本的 srelay 创建，请升级 srelay"——杜绝旧代码写坏新库。

### 7.2 本方案对方针 Schema 的增量

方针 §7.2 已含 Review #3 的两处增补（`origin_project` 列、`ux_messages_session_seq` 唯一索引）；本方案进一步需要的加法见 §十五（byte_offset / bad_lines / suspect / quarantine 目录 / hook 命令），全部为加法。

### 7.3 连接与 pragma

```
journal_mode=WAL; foreign_keys=ON; synchronous=NORMAL; busy_timeout=5000;
cache_size=-20000(20MB); mmap_size=128MB; temp_store=MEMORY;
每 N 次批量写后 PRAGMA optimize；导出/重建后 ANALYZE。
```

- 所有语句经 db.prepare 缓存（仓储内 Map）。
- 路径统一：入库路径一律 `/` 分隔的相对项目根形式（Windows 优先但存储可移植）。

### 7.4 rebuild 的 FTS 重建（T31）

外部内容表的 FTS 索引在批量重灌后必须显式重建：

```sql
INSERT INTO messages_fts(messages_fts) VALUES('rebuild');
INSERT INTO sessions_fts(sessions_fts) VALUES('rebuild');
```

`srelay rebuild` 的固定收尾步骤；漏掉会出现"数据在但搜不到"的静默故障。

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

### 8.3 首跑引导（`srelay init` 向导，T18）

```
1) 扫描本机已装 Agent 源 → 列表勾选（默认全选）
2) 询问捕获模式：full(推荐) / meta / off —— 每项配一句话隐私说明
3) 生成 .sessionrelay/config.json + .sessionrelayignore 模板
4) 立即回填最近 30 天会话（--backfill 90d 加深 / none 跳过；进度条：发现 N/入库 M/分词中…）
5) 推荐注册守护服务（--install-service，回车即装；拒绝则说明 sync 兜底，T22）
6) 啊哈收尾：邀请用户输入一个还记得的关键词试搜 → 命中展示结果+出处块
   （方针 §15.6：价值感知提前到第 1 分钟；30 天无会话则退化为示例引导）
```

### 8.4 status 透明度面板（隐私焦虑主防线 + 守护健康度，T22/T33）

```
会话接力 · my-app                          mode: full ● watching
─────────────────────────────────────────────────────
守护    ● running (服务, pid 1234) │ 队列 0 │ worker lag 0.4s
        （未注册/未运行时：🔴 auto-capture 未运行，最近会话可能未捕获
          → srelay watch --install-service 或 srelay sync）
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

Node 版本 / FTS5 可用 / jieba 加载 / 各源目录可达 / config 合法 / `PRAGMA integrity_check` / 锁僵死检测 / **守护服务注册状态与心跳（T22）** / 磁盘余量 / 迁移状态。每项输出 ✅/⚠️/❌ + 修复命令；`--dump` 打包诊断 bundle（**不含任何消息正文**）。

### 8.8 MCP 注册（README 直接可抄）

```json
{ "mcpServers": { "sessionrelay": { "command": "srelay", "args": ["serve"] } } }
```

### 8.9 友好度红线（验收项）

- 任何命令 `--help` 自解释，示例可复制即用；
- 空库首次 search/status 给引导而非沉默；
- 破坏性操作（purge/rebuild/import 覆盖）必须二次确认并列出影响面；
- 中文 UI 文案与中文检索同为第一等公民（**Windows 控制台强制 UTF-8 输出处理**，chcp 适配，乱码即 P0 bug）。

------

## 九、性能设计

### 9.1 性能预算（超标即修，进 CI 可选门禁；T24 修正口径）

| 指标 | 预算 | 场景 |
| ---- | ---- | ---- |
| CLI 冷启动到输出 | < 200ms | bin 懒加载；重模块（jieba/MCP/TUI）按需 import |
| 搜索 p95 | < 50ms | 10k 会话 / 100k 消息，warm cache |
| 搜索 p95（大库） | < 150ms | 50k 会话 / 500k 消息 |
| watch 事件→入库 | < 2s | 含去抖窗口 |
| 确认链（元数据+摘要+索引） | < 5s / 会话（1000 消息） | worker 内 |
| **回填 30 天（≤500 会话）** | **< 60s** | init 向导内，带进度条（T24） |
| **全量首灌 1 万会话** | **< 10min** | `sync --all`；单线程顺序（进度可断点续传）；worker_threads 并行分词为后备优化，预算超标才启用（T24） |
| 导出 1000 会话 | < 5s | |
| 导入校验（sha256） | > 200MB/s | 流式 hash |
| watch 守护常驻内存 | < 150MB | |
| 守护空闲 CPU | ~0 | 事件驱动，无轮询（fs.watch 不可靠源的 mtime 轮询除外，30s/次；Linux 无递归 fs.watch，目录级监听明确走轮询兜底） |

> v1.0 曾写"10k 会话全量 < 60s"——按 jieba 单线程 1-10MB/s 吞吐推演不成立，已修正口径并保留并行分纹作为超标应对（T24）。

### 9.2 手段清单

- 增量 tail 按 `byte_offset`，只分词新字节（旧消息 token 永不重算）；
- 批量事务（每文件一事务，消息与 offset 同事务）+ 预编译语句 + `busy_timeout`；
- WAL + `synchronous=NORMAL`（守护是唯一常驻写者，掉电最坏丢一个 flush 批次，rebuild 可恢复）；
- confirmed 才做重活（元数据提取/meta_text/主索引），active 阶段只存消息——把成本从交互热路径挪走；
- `ANALYZE` 仅在 bulk 操作后执行，避免写放大；bulk 后显式 FTS `rebuild`（§7.4）；
- 搜索只取 `rowid+score` 先排序后回表取 snippet（延迟取正文）；两路 LIMIT×3 上限保护合并成本（T27）；
- 二进制依赖全部走预编译（better-sqlite3、@node-rs/jieba），Windows 零 node-gyp。

### 9.3 基准设施

`scripts/gen-corpus.ts` 合成中文语料（可控规模/词表/时间分布）→ `scripts/bench.ts`（tinybench）输出报告并对照 §9.1 预算；`test/perf/` 为可选 CI 门禁（nightly 跑，PR 不阻塞，回归 > 30% 告警）。

------

## 十、测试与质量保障

### 10.1 金字塔与覆盖目标

| 层 | 内容 | 覆盖 |
| -- | ---- | ---- |
| 单元 | 状态机迁移表逐条、**per-session 串行链交错防护**、分词（C1-C6 + 属性测试）、过滤编译、排序与合并确定性、脱敏模式、scope 交集、ignore 语法、HOP manifest 校验、merge 规则、**归化重写（T21）** | core/ 与 relay/redact ≥ 90% |
| 集成 | 临时项目 + 假 adapter：watch→queue→worker→DB 全链路；**同文件重复冲刷断言零重复（幂等回归）**；迁移序列；rebuild 幂等（含 FTS rebuild） | ≥ 75% 总体 |
| 契约 | MCP stdio 真实握手：8 工具 schema、响应必含 provenance 字段、set_scope 交集语义、**scope.json 改动下一次调用即生效（热更新）** | 100% 工具 |
| E2E | ① resume 重放 ② HOP 往返（export→import--merge→export，除时间戳外逐文件 hash 稳定；**导入会话可被检索命中**）③ 真实 Claude Code JSONL fixture 捕获 ④ 密钥注入→导出被脱敏 ⑤ quarantine 导入→release 前后可见性 ⑥ **崩溃恢复：worker 批处理中途 SIGKILL → 重启 → 断言消息零重复、offset 一致（T20 验收）** ⑦ **并发写：watch 运行中并发执行 save/scope/mode，断言无 SQLITE_BUSY 泄漏与数据完好** ⑧ **守护缺席：删除 lock 后任意 CLI 命令出现红色告警** ⑨ Windows 中文输出不乱码 | 全绿为发布门槛 |
| 性能 | §9.3 | 可选门禁 |

### 10.2 关键可测性设计（架构即测试性）

- 状态机注入 Clock/EventSource → fake timers，不真等 6 小时冷却；
- `ignore-parser`、`redact`、`tokenizer`、`serializer` 全部纯函数/纯内存结构；
- repo 层可注入内存 SQLite（`:memory:` + 同迁移）；
- 假 adapter（`test/fixtures/fake-source`）可编程吐行，模拟任意 agent 行为（含重复行、残行、坏行、重命名归档）。

### 10.3 CI（GitHub Actions）

矩阵：`[ubuntu, windows, macos] × [node 18, 20, 22]`；步骤：lint → typecheck → unit → integration → contract → e2e → coverage（阈值不符即红）→ **npm audit（high 以上失败）**。Windows 是一等平台（本机开发环境即 Windows + Git Bash）。

### 10.4 追溯矩阵（方针验收 → 测试）

| 方针验收 | 自动化落点 |
| -------- | ---------- |
| C1-C6 中文用例 | `tokenize/cases.spec.ts` + `integration/search.spec.ts` |
| resume 回滚正确 | `e2e/resume-replay.spec.ts` |
| 出处 100% | contract 断言 + SearchHit 类型非空校验 |
| 脱敏默认开 | `e2e/redact.spec.ts` |
| mode off 零写入 | `integration/modes.spec.ts` |
| 导入即可检索（D19） | `e2e/hop-roundtrip.spec.ts` 断言导入会话出现在 search 结果 |
| 幂等（T20） | `integration/idempotent-flush.spec.ts` + `e2e/crash-recovery.spec.ts` |
| 守护告警（T22） | `e2e/daemon-absent.spec.ts` |
| scope 串台已知局限 | `integration/scope-concurrent.spec.ts` 标记 skip-bug-P4（显式登记而非装作没有） |

------

## 十一、可靠性、可观测性与安全

### 11.1 错误分类与韧性

- 错误树：`SRelayError{ CaptureError, ParseError(含 badLines 计数), StateConflict, StoreError, RelayError{IntegrityError, ZipSlipError}, ScopeError, ConfigError }`。
- 韧性原则：**坏一行废一行，坏一文件废一文件，守护进程永不因单点崩**；错误计数进 status/doctor；ParseError 超 50% 行的文件自动标记 `suspect` 并在 doctor 提示（格式漂移预警，方针风险 #11）。
- 守护崩溃由系统服务管理器拉起（T22）；拉起风暴用指数退避防抖。

### 11.2 日志与观测（内容零泄漏红线）

- pino → `.sessionrelay/logs/srelay.log`（滚动 5×2MB）；`--debug` 镜像 stderr。
- **info 级只允许：ids、计数、hash、耗时、路径**；消息正文/摘要永不入日志（隐私原则的工程化）。
- **守护健康度进 status（T33）**：事件队列深度、worker lag（最近一批冲刷延迟）、错误计数——积压 >1000 或 lag >30s 时 status 黄色警示，doctor 给出原因排查路径。
- `--debug` 下 search 输出耗时分解（分词/FTS×2/合并/格式化），性能归因不靠猜。

### 11.3 安全要点

- **零外呼**：依赖白名单审查，运行时无任何网络请求（HOP 传输靠用户自己的渠道）；本地计数器零外呼（T17），CI 加依赖外呼检查脚本兜底。
- **HOP 零代码执行**：包内只有数据（JSON/MD），导入路径不解析、不执行任何脚本；custom adapter 只来自用户本机目录，HOP 永远不携带 adapter——写进安全模型，防止将来手滑。
- zip-slip：解包条目 `resolve` 后必须仍在目标目录内，否则 `ZipSlipError` 整体拒绝。
- sha256 完整性：导出逐文件计算入 manifest，导入逐文件校验。
- 归化后导入会话同样过 ignore 编译片段（防"绕过查询直取数据包"）。
- 锁：`.sessionrelay/lock`（pid+心跳），僵死 60s 自动接管，接管记录入日志。
- 供应链：package-lock.json 提交入库；npm audit 进 CI（§10.3）；发布走 npm provenance。

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
- **构建红线（T32）**：better-sqlite3 与 @node-rs/jieba 是原生模块，tsup 配置必须 `external`（或 no-bundle 直发），**绝不可打进 bundle**——打进必崩且报错极隐蔽。
- 分发：npm 包 `sessionrelay`，`npx sessionrelay@latest` 可零安装试用；独立二进制（Node SEA）列 Phase 4。
- 版本：semver；CLI `--json` 契约与 HOP `hop/1.0` 均为公共契约，破坏性变更必须 major + 迁移说明；DB 版本前向探测（T30）保证新旧二进制不写坏同一库。

------

## 十三、里程碑映射（方针 §十二 → 模块）

| Phase | 交付模块 | 退出测试（对应 §10.4） |
| ----- | -------- | ---------------------- |
| P0 W0 | `core/tokenize`(S1) `adapters/claude-code`(S2) `core/state`+`serializer`(S3) `core/scope`(S4) `docs/adapters/zcode-format.md`(S5) | ✅ 全部达成（2026-08-28）：C1-C6 绿 / resume+崩溃幂等回放绿 / `_scoped_where` 绿 / ZCode 格式草案产出（报告 `docs/spike-report-p0.md`，42/42） |
| P1 W1-2 | `store(+M1+M2)` `capture/{watcher,queue,worker,sync,save,ignore,service-install}` `privacy` `core/stats` `cli/{init(回填+试搜),watch(--install-service),sync,save,status,mode,stats,search,show,list,doctor}` | 零干预捕获率>90%、mode off 零写入、status 自洽+守护告警、中文门槛、**崩溃恢复绿（幂等验收）**、init 啊哈 ≤1 分钟 |
| P2 W3 | `core/extract` `capture/judge` `hook-spool` `cli/{decisions,history,unresolved,confirm,purge}` `core/provenance` | resume 重放绿、决策带出处 |
| P3 W4 | `mcp/*` `scope A/B 档全量(含热更新)` `attach` `adapters/zcode` | 契约测试绿（含 scope 热更新）、scoped 不串台（P4 已知项显式登记）、双 agent 同库 |
| P3.5 W5 | `relay/*` `hop/*` `redact/*` `quarantine` `handoff-md(署名)` `cli/{export,import(归化),team}` `scope C 档` | HOP 往返 hash 稳定、**导入即可检索**、脱敏报告、HANDOFF 可读（含署名）、quarantine 生效 |
| P4 W6+ | `--ai` 摘要、branch/PID 归属 + `get_linked_sessions`、语义可选、cursor 分页、并行分词（如预算超标）、SEA 二进制、HOP 推广 | 视反馈 |

------

## 十四、技术非目标

不做（做了违反本方案）：ORM/DI 框架；Electron/Web 面板；插件市场（custom adapter 目录已够）；守护进程内嵌 LLM 调用；分布式/多机同步；修改源会话文件；把 `--json` 契约做成"随便改"；Windows 之外平台降级为二等公民；事件溯源/CQRS 等重抽象（§四克制条款）。

------

## 十五、Schema 增量修订（对方针）

| # | 增量 | 理由 | 状态 |
| - | ---- | ---- | ---- |
| R1 | `source_files` 增加通用水位列 `cursor TEXT`（文件型源=字节偏移数字；SQLite 型源=JSON 序号游标） | 增量读取依据（§5.1/§3.1 契约 3），避免全量重读重分词；S5 发现 ZCode 为库型源，byte_offset 必须泛化（T34） | 迁移 M2（Spike 修订） |
| R2 | `source_files.bad_lines / suspect INTEGER DEFAULT 0` | 格式漂移预警检测手段（方针风险 #11） | 迁移 M2 |
| R3 | quarantine 以**目录约定**实现（`.sessionrelay/quarantine/`） | release 即对暂存包局部重导入，避免双写状态 | — |
| R4 | 隐藏命令 `srelay hook <event> --id <sid>`（写 `.sessionrelay/events/` spool） | Claude Code SessionEnd hook 落地的最低成本通道 | — |
| R5 | `sessions.origin_project TEXT` | HOP 导入归化后保留导出方项目身份（溯源） | **已随方针 Review #3 回填 §7.2** |
| R6 | `UNIQUE INDEX ux_messages_session_seq ON messages(session_id, seq_num)` | 消息幂等去重键（崩溃恢复/重放去重，T20） | **已随方针 Review #3 回填 §7.2** |
| R7 | seq_num 确定性契约（adapter 层约定，见 §3.1） | R6 成立的前提：同一行重放必须得到相同 seq_num | 纯技术约定，无需改方针 |

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
| **T17** | **本地匿名计数器 `core/stats` + `srelay stats` 命令**（回填方针 Review #2） | 零外呼红线下的漏斗观测（方针 §15.5/D15）；仅事件名计数 | 后台遥测（砸本地优先招牌）；不观测（盲飞） |
| **T18** | **init 向导：默认回填 30 天 + 关键词试搜**（回填方针 Review #2） | 啊哈时刻提前到第 1 分钟（方针 §15.6/D16） | 等待自然积累 |
| **T19** | **HANDOFF.md 页脚固定署名**（回填方针 Review #2） | 商业化唯一验证点 + K 因子观测载体（方针 §15.7/D17） | 无署名（放弃免费渠道） |
| **T20** | **消息幂等：去重键 (session_id, seq_num) + INSERT OR IGNORE + 消息与 offset 同事务 + tailer 只消费完整行**（S1） | 崩溃在 INSERT 与 offset 推进之间会重放产生重复消息，无任何检测手段；三层防线缺一不可 | 只靠同事务（其他重放路径无兜底）；只靠唯一索引（不修根因） |
| **T21** | **HOP 导入归化：project_id 重写为当前项目，原值存 origin_project**（S2） | project_id 是检索过滤键；不归化则导入会话在一切检索路径不可见，交接验收直接失败 | 保留原 project_id（功能失效）；跨项目全局检索（违反项目级隔离） |
| **T22** | **守护服务化：--install-service（schtasks/launchd/systemd）+ init 默认推荐 + 守护缺席 CLI 告警 + sync 兜底**（S3） | "被动捕获默认开启"不能建立在用户记得手动跑进程上——可用性需要"守护的守护" | 仅前台 watch（承诺落空） |
| **T23** | **状态迁移单点化：迁移只发生在 watch 进程 + per-session Promise 链串行化**（S4） | 判定 tick 与 worker 对同一会话交错写会产生"confirmed 但摘要已清"类中间态 | 跨进程分布式锁（单进程内过度设计） |
| **T24** | **性能预算口径修正：回填 30 天 <60s；全量 1 万会话 <10min；并行分词仅作超标应对** | jieba 单线程 1-10MB/s，v1.0 的"10k<60s"推演不成立 | 硬凑旧预算（自欺） |
| **T25** | **超长消息：content>512KB 截断标记；search_text 全量分词** | 内存与索引膨胀防护；截断 search_text 只会丢检索能力 | 全量存 content（1MB 级消息常态化膨胀） |
| **T26** | 查询保护：token>16 截断提示；单 CJK 字符走元数据面 | FTS 表达式爆炸与无效查询防护 | 放任超长/单字查询 |
| **T27** | **搜索合并确定性：两路各取 LIMIT×3，应用层合并；MVP offset 分页** | 双索引合并排序结果必须确定；cursor 进 Phase 4 | 两路各自 LIMIT 直接拼（结果不稳定） |
| **T28** | **scope.json 热更新：每次调用 stat + mtime 缓存** | 用户 scope set 后 MCP 下一次调用立即生效，否则"改了没反应"直接摧毁信任 | 重启 serve 生效（体验断裂） |
| **T29** | **文件身份契约：身份=(source,source_session_id)；孤儿 source_files 由 last_seen 过期清理** | agent 归档/改名会话文件是常态，按路径认身份必重复 | 按路径做身份（重复捕获） |
| **T30** | **DB 前向版本探测：user_version 超出支持即拒启** | 旧二进制写新库=静默损坏 | 允许打开（数据损坏风险） |
| **T31** | **rebuild 收尾显式执行 FTS 'rebuild' 命令** | 外部内容表批量重灌后索引不重建="数据在但搜不到"的静默故障 | 依赖触发器逐行重建（慢且易漏） |
| **T32** | **原生模块构建 external 红线 + lockfile 入库 + npm audit 进 CI** | better-sqlite3/jieba 打进 bundle 必崩且隐蔽；供应链可重现 | 打包单文件（崩溃）；不锁版本（不可重现） |
| **T33** | **守护健康度进 status：队列深度/worker lag/错误计数，超阈值黄牌** | 守护自身故障用户无感知=静默断档 | 只在 doctor 深处可见（发现太晚） |
| **T34** | **增量水位泛化：byte_offset → 通用 cursor（文件型=字节偏移；SQLite 型=(sequence,id) JSON 游标）**（S5） | ZCode 主存储是 SQLite，无"文件追加"语义；泛化后同一 tail 抽象覆盖文件型与库型源 | 为 ZCode 单开一套增量机制（抽象分裂，adapter 爆炸） |
| **T35** | **单字 CJK 入索引；非引号查询丢弃单字；引号短语保留完整序列**（Spike F3） | "按月"非词典词切成单字，短语查询依赖位置连续性；查询侧单字无区分度 | 两边统一丢单字（短语失效，C5 挂）；两边统一保留（AND 噪声大） |
| **T36** | **会话级 AND 零命中 → OR 兜底，按覆盖度排序（coverage 可识别降级）**（Spike F4） | "认证方案"查"用 JWT 做认证"的会话在严格 AND 下落空；兜底召回真实查询 | 硬 AND（真实查询落空）；纯 OR（精度崩） |
| **T37** | **ignore 谓词按排除语义编译：NOT (f1 OR f2 …)**（Spike F5） | 按包含语义编译会让被 ignore 的会话反而通过隐私过滤 | 复用包含编译（隐私边界失效，首轮测试当场抓获） |

------

*实现即对照：每个 PR 描述引用本文章节号与方针 D/T 编号；发现设计不可行，先改文档再改代码。本文 v1.1 已完成架构评审修复（S1-S4）与 Review #2 回填，达到"可开工"状态——下一步是 Spike，不是继续写文档。*
