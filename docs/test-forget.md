# `srelay forget` 测试用例集 · v3（三轮迭代定稿，实现完成后按此执行）

> 依据：design-forget v4。断言只钉可观察行为（CLI 退出码/输出/DB 状态/文件系统），不钉内部实现。
> 执行标记：【FTS-EXP】= 需在集成环境复验 FTS 同步；【EXP-VERIFIED】= 语法/行为已在 better-sqlite3 实测。
> 自动化分层：A/B/C/D/F/G → vitest（test/forget/）；E → vitest 双连接并发用例；H → 性能冒烟可选。

## A. 功能正路径（冒烟级）

| ID | 前置 | 步骤 | 断言 |
|---|---|---|---|
| A1 | 已 init 项目，1 条 auto 会话 S1（12 msg + 1 决策 + 2 链接）+ 1 条 note N1 | `srelay forget S1前缀`（无 --yes） | 退出码 0；输出预览（标题/来源/条数/决策数/双向链接对方列表/会话年龄/imported 标记）；**DB 无任何删除发生**（sessions 计数不变） |
| A2 | 同 A1 | `srelay forget S1前缀 --yes` | 退出码 0；sessions/messages/session_links 各少对应行；messages_fts 与 sessions_fts integrity-check 通过【FTS-EXP】 |
| A3 | 同 A1 | `srelay forget N1 --yes`（note） | note 行删除；**forget_tombstones 无行**（note 的 source_file='mcp:save_note' 非真实文件路径——判定条件必须是"真实文件存在且可被 adapter discover"，不是字符串非空，v2 修订断言依据）；ignore 文件**无** session: 规则追加 |
| A4 | 同 A2 | `srelay forget --history` | 退出码 0；输出含 1 条 mode=session 记录，sessions_affected=1，messages_affected=12 |
| A5 | 同 A3 | `srelay forget --history --json` | 合法 JSON，字段与 §3.4 schema 一致 |

## B. 删除后全链路检索不命中（核心验收）

| ID | 前置 | 步骤 | 断言 |
|---|---|---|---|
| B1 | 删除 S1（A2 完成） | `srelay search <S1独有关键词>` | 命中数 0（messages_fts + sessions_fts 双路） |
| B2 | 同 B1 | MCP `search_sessions` 同关键词 | count=0，无残留 provenance 指向 S1 |
| B2b | 同 B1 | FTS `integrity-check` 命令（【EXP-VERIFIED】语法可用） | 执行不抛错 = FTS 索引与内容表无幽灵行（v2 新增：防 search 双路都查不到但索引已烂的静默损坏） |
| B3 | 同 B1 | MCP `get_session_detail S1完整id` | 返回 not-found 语义（非 crash、非空对象） |
| B4 | 同 B1 | MCP `get_decisions` | 不含 S1 的决策文本 |
| B5 | 同 B1 | MCP `get_linked_sessions <对方id>` | A→B、B→A 双向都不再返回 S1 |
| B6 | 同 B1 | MCP `get_stats` / `srelay status --json` | 会话/消息计数与删除一致，无负数无悬挂；**不断言 dbSizeMB**（SQLite 删除不回缩文件，需 VACUUM，断言体积会误报——v2 修订） |
| B7 | 同 B1 | `srelay show S1完整id` | not-found 语义 |
| B8 | 删 note N1 | `srelay search <N1标签/关键词>` | 0 命中（含 tags 检索路径） |
| B9 | S1 是唯一提及文件 X 的会话，删 S1 | MCP `get_file_history X` | count=0——**v2 翻转**：该工具走 searchSessions JOIN sessions（server.ts:210-214），构造上天然过滤已删会话，此用例把"构造安全"钉成回归基线；同时证伪 v4 设计文档里"可能返回零会话文件"的担忧（那条盲区记录据此关闭） |

## C. 防复活对抗（本特性生死线，每挡板单测）

| ID | 前置 | 步骤 | 断言 |
|---|---|---|---|
| C1 | 删 auto 会话 S1（ignore 规则已自动追加） | 手动触发增量 sync（模拟文件 mtime 变化） | S1 不复活；result.blocked 计数 +1（blocked_by_ignore）；墓碑表无新增命中需要（被 ignore 短路） |
| C2 | 删 S1；**手动清空 .sessionrelayignore** | 触发 sync | S1 不复活（墓碑挡住）；blocked 计数 +1 |
| C3 | 删 S1 | `srelay rebuild --force` | 重建后 S1 不存在；重建库 ignore 文件原样保留；墓碑表为空（新库）但 **C4 兜底成立** |
| C4 | 同 C3 完成的新库；清空 ignore | 触发 sync | S1 **复活**（两道闸都拆了——**这是预期行为**：用户明确拆掉双闸=撤回遗忘，须在文档标注）；如判定为不应复活则实现必须加第三闸，回到设计 |
| C5 | 删 auto 会话 S1 | 向 S1 源**按其游标类型**追加新内容：JSONL 源（claude-code/codex/qoder）追加合法消息行；SQLite 源（zcode）向其源库 INSERT 新消息行（rowid 水位后移）→ sync | 新内容不入库（session: 规则按 source+sid 拦整个会话）；**两种源型都要测**——游标语义不同（字节偏移 vs rowid），v2 修订：v1 只写了"追加字节"对 zcode 源不可执行 |
| C6 | 删 S1 后 captureSessions 注入入口（构造 S1 的 DiscoveredSession 直传入参） | 调用 captureSessions | 不复活（manual 入口同样命中 ignore+墓碑） |
| C7 | 删 S1 后用户 `srelay save`（manual 主动重存同一会话） | save → captureSessions | **被 ignore 拦截，重存失败**——这是预期行为（遗忘是明确决定，人工重存也应先清 ignore 规则），输出须提示"被 ignore 规则拦截（session:）"而非静默 0（v3 新增：场景串联时发现的双向语义，须实现确认提示文案） |

## D. 确认与误用防护

| ID | 前置 | 步骤 | 断言 |
|---|---|---|---|
| D1 | ≥2 个会话 id 共享前缀（如 a3f8…/a3f9…） | `srelay forget a3f --yes` | 退出码非 0；**两个都不删**；输出表格化候选列表（id/标题/日期/来源/条数） |
| D2 | 前缀唯一命中 | `srelay forget <唯一前缀> --yes` | 正常预览→删除流程 |
| D3 | 完整 id | `srelay forget <完整32位id> --yes` | 直接预览（无歧义检查开销） |
| D4 | 不存在的 id | `srelay forget deadbeef --yes` | 退出码非 0；not-found 语义；DB 无变化 |
| D5 | 守护运行中 | `srelay forget --all` | 直接拒绝（isDaemonAlive 拦截），库文件不变 |
| D6 | 守护已停 | `srelay forget --all`（无 --confirm） | 拒绝执行，提示需要 --confirm <projectId> |
| D7 | 同 D6 | `srelay forget --all --confirm 错误的项目id` | 拒绝；逐字匹配失败 |
| D8 | 同 D6 | `srelay forget --all --confirm <正确projectId>` | 库三连删（sqlite/-wal/-shm）+ 空库重建 + ignore 文件保留 + forgot-at-<ts>.txt 生成 |
| D9 | 同 D8 | 检查 .sessionrelay/ | forget_log 随库删除，但 forgot 摘要文件存在且含时间戳 |
| D10 | 同 D8 | `srelay status`（新库） | 空库状态正常输出，无 crash |
| D11 | 同 D8 | 检查 stats.json | 行为二选一且与实现一致（v2 提交设计裁决）：随 --all 清空，或保留（纯事件计数无内容泄漏，可接受）；测试钉住"实现做了什么"且文档写明，不允许含糊 |
| D12 | 导出过 .hop 后 forget 其中一条会话 | 再次 export | 新包不含被删会话；manifest.session_count 与包内实际一致；旧 transfer_log 行被 CASCADE 清走不阻塞新导出（export.ts 无 NOT FOUND 崩溃路径——前置验证过 buildExportData 按现库行构建） |

## E. 并发与一致性

| ID | 前置 | 步骤 | 断言 |
|---|---|---|---|
| E1 | 预览 S1 后、--yes 前，守护向 S1 追加 2 条消息 | `srelay forget S1 --yes` | 执行时重统计 diff 命中（12→14）→ **拒绝执行**，提示重跑预览；S1 仍完整 |
| E2 | 同 E1 场景但消息数未变 | `--yes` | 正常执行 |
| E3 | 预览后 S1 被另一个 forget 先删了 | `--yes` | not-found 语义，无部分删除残留 |
| E4 | forget 执行中（事务内）并发 `srelay status` | 双连接同时 | status 读旧快照或等待 ≤5s（busy_timeout=5000），无脏读崩溃；**此用例 vitest 内双 better-sqlite3 连接实现，不开子进程**（v2 修订：双进程在 Windows CI 不稳定） |
| E5 | 预览后、--yes 前，**另一 CLI 进程删除了同一会话** | `--yes` | not-found 语义，无部分删除残留（与 E3 同语义不同路径：E3 用 DB 直改模拟，E5 用真实双 CLI——二选一进自动化，另一个手动执行一轮） |

## F. 边界与特殊对象

| ID | 前置 | 步骤 | 断言 |
|---|---|---|---|
| F1 | imported 会话（.hop 导入） | `srelay forget <imp前缀>` | 预览含 imported 警示（删除后无法 rebuild 恢复）；删除后 forget_tombstones **无行**（无本地源文件） |
| F2 | 7 字符短前缀（sessionIdOf 截断长度） | 查询 | 正常解析（不因 id 长度假设出错） |
| F3 | note id 前缀（note-xxxx） | `srelay forget note-xxxx --yes` | 识别为 note 类型，走 A3 断言 |
| F4 | state=active 的 auto 会话 | 删除 | 允许（forget 不受两阶段状态机约束——删除权在人不参与状态协商）；deletePending 式限制**不适用** |
| F5 | 同一会话 id 删除两次 | 第二次 `--yes` | 第二次 not-found，不产生第二条 forget_log |
| F6 | 删除后被 CASCADE 的 transfer_log 行 | 查 transfer_log | 关联行消失（FK CASCADE），export 历史完整性文档已声明 |

## G. 兼容性/回归

| ID | 步骤 | 断言 |
|---|---|---|
| G1 | v0.2.4 老库升级打开 | user_version 2→3 迁移自动完成；老功能回归（search/show/export 正常） |
| G1b | **降级**：新库（v3）被老版本 srelay 打开 | 明确报错"数据库由更新版本的 srelay 创建…请升级"（db.ts:156-159 现行行为），无半迁移状态（v2 新增——迁移用例只测升级不测降级是常规遗漏） |
| G2 | MCP 客户端 tools/list | **恒 15 工具**——新增任何删除类工具即 fail（防 AI 删除能力泄漏） |
| G3 | `srelay save`（manual origin 注入） | 行为不变（save 路径的 ignore 检查已有，session: 规则同样生效） |
| G4 | pack-e2e 加 forget 步骤 | 真实安装路径：init→save→forget→握手→15 工具 |
| G5 | `--help` 输出 | forget 描述含与 archive 的区分口诀；`--all` 提示 --confirm 要求 |
| G6 | save_note 返回文案 | 含"可由用户以 srelay forget 移除"（评审 P2 话术联动） |
| G7 | archive --hard --help | 含"若需防止源文件再次被收录，用 srelay forget"引导 |

## H. 浅层非功能

| ID | 步骤 | 断言 |
|---|---|---|
| H1 | 删除 1000 msg 会话 | 执行 <2s（单事务 + CASCADE）【EXP-VERIFIED】1000 行事务插入实测 3ms，删除同量级 |
| H2 | 墓碑表 5000 行时 sync | discover 循环无 per-session 点查（性能回归：Set 载入）；周期耗时不劣化（开放点 4：CI 噪声大，降级为本地手动项——v3 定） |
| H3 | `srelay forget --history` 100 条审计 | 输出 <1s，紧凑表默认 |

## I. 前置构造规格（执行者必读）

| fixture | 规格 | 复用 |
|---|---|---|
| auto 会话（功能/检索断言） | 直插 DB：insertSession/insertMessage + 手动维护 message_count（契约测试既有手法） | test/contract/mcp.spec.ts beforeAll |
| auto 会话（复活对抗专用） | **必须造真实源文件**：JSONL 源造 .jsonl 追加行；zcode 源造 sqlite 源库 INSERT 行——直插 DB 的会话无源文件，sync 根本不会发现它，复活对抗无从谈起（v3 补：v1/v2 未区分，照抄会写出假绿用例） | 造文件工具函数进 test/helpers |
| DiscoveredSession 注入 | `{source, sourceSessionId, sourceFile, title?, createdAt?, updatedAt?, sizeBytes, mtimeMs}`（types.ts:59-68） | C6/C7 |
| 链接对 | 两条会话 + session_links 直插（PK 三列：session_id/linked_session_id/kind） | |
| imported 会话 | insertImportedSession（无真实 source_file） | rebuild.ts 搬迁先例 |
| FTS 校验 | `INSERT INTO messages_fts(messages_fts, rowid, search_text) VALUES ('integrity-check', 0, '')`【EXP-VERIFIED】 | B2b |
| 大会话 | 事务循环 insert | H1 |

## J. 执行清单（开发完成后按此验收）

| 步骤 | 内容 | 通过标准 |
|---|---|---|
| 1 | 自动化：`npx vitest run test/forget/`（A/B/D/F/G + C1/C2/C3/C6/C7 + E1-E4） | 0 fail |
| 2 | 手动（Windows 本机）：E5 双 CLI 竞态 + H2 墓碑压测 + `npm run e2e:pack`（G4） | 0 意外 |
| 3 | 三平台 CI push（ubuntu/windows/macos 自动跑步骤 1 可自动化部分） | 全绿 |
| 4 | 验收门：步骤 1-3 全过 **且** 契约测试"恒 15 工具"断言绿 | 才可发版 |

C4/C5 的执行取决于开放点 1 的裁决（允许复活=按预期行为断言；不允许=实现加第三闸后必测）。

## 待裁决的开放点（需设计/用户确认，随 v3 定稿提交）

1. C4 双闸拆除后允许复活——按"文档标注的预期行为"编写，需一句话确认
2. F4 active 直接删（倾向）vs 先 confirm
3. B6 status 口径、D11 stats.json 去留——倾向不加/保留，需确认
4. ~~H2 CI 噪声~~ → v3 已定：降级为本地手动项
5. （v3）C7 人工重存被拦截的提示文案——实现时确认措辞

## 迭代记录

### 第一轮（自查：断言可执行性）——4 项修订
| # | v1 缺陷 | 证据 | 修订 |
|---|---|---|---|
| 1 | B6 断言 status 体积——SQLite 删除不回缩（无 VACUUM），体积不变会误判 fail | status.ts:59 输出 dbSizeMB | B6 明确不断言体积 |
| 2 | A3 判定依据含糊（"无原始文件"）——note 的 source_file 是字符串 'mcp:save_note' 非空 | createNoteSession | 断言依据改为"真实文件存在且可被 discover" |
| 3 | 缺 FTS 幽灵行防线用例——search 双路 0 命中但索引静默损坏查不出 | 无 integrity-check 用例 | 新增 B2b【EXP-VERIFIED】 |
| 4 | E4 双进程并发在 Windows CI 不稳定（子进程 spawn + 文件锁时序） | E4 原描述 | 改为双连接实现；补 E5 双 CLI 路径手动执行 |

### 第二轮（覆盖矩阵扫描）——5 项修订
| # | 缺口 | 证据 | 修订 |
|---|---|---|---|
| 5 | 迁移用例只测升级不测降级 | db.ts:156 降级拒绝路径无覆盖 | 新增 G1b |
| 6 | C5 "追加字节"对 zcode 源不可执行——rowid 水位不认字节 | zcode/index.ts:53 cur={rowid} | C5 按源型分叉：JSONL 追加行 / SQLite INSERT |
| 7 | 删后再次 export 的行为未覆盖（包一致性 + transfer_log CASCADE 不阻塞） | export.ts buildExportData 按现库构建 | 新增 D12 |
| 8 | B 系漏了 get_file_history——且 v4 设计文档"零会话文件盲区"判断与代码不符 | server.ts:210 走 searchSessions JOIN sessions | 新增 B9 钉死安全行为；关闭设计文档该盲区记录 |
| 9 | --all 后 stats.json 去留未定 | counter.ts statsFile 独立于库文件 | 新增 D11（钉实现+文档写明，不猜） |

### 第三轮（执行者走查）——3 项修订
| # | 缺口 | 证据 | 修订 |
|---|---|---|---|
| 10 | C 系复活对抗用"直插 DB 会话"测不了——无源文件则 sync 根本发现不了它，写出来是假绿 | contract fixture 手法 + adapter.discover 语义 | 新增 §I：复活对抗必须造真实源文件，与功能断言的直插手法分离 |
| 11 | 场景串联漏路径：删后用户 `srelay save` 主动重存同一会话——ignore 会拦住人工操作，双向语义未定义 | save→captureSessions→sync.ts:117 ignore 检查 | 新增 C7（预期拦截+必须提示，禁止静默 0） |
| 12 | 前置构造规格散落各用例（DiscoveredSession 字段、FTS 校验语法、 fixture 手法），执行者要反查代码 | types.ts:59 / 【EXP-VERIFIED】 | 集中为 §I 构造规格表 + §J 验收动线（四步门禁） |
