# Phase 3 交付报告 · MCP + Scope

> **日期**：2026-08-28 · **对应**：方针 §十二 Phase 3（W4）
> **结论**：验收标准达成（契约测试 74/74 全绿 + 本机真实库冒烟），tsc 零错误。

## 一、验收对照

| 验收标准 | 结果 | 证据 |
| -------- | ---- | ---- |
| scoped 语境下提问不再回溯无关话题 | ✅ | 契约测试：B 档 topics 过滤下，无关话题查询 0 命中（交集只收窄）；A 档 auto-scope 裁剪窗口外老会话 |
| 命中不足时出现放宽提示 | ✅ | 契约测试：`hint` 字段含 `set_scope` 指引（阈值 config.search.min_hits_hint=3） |
| Claude Code 与 ZCode 查到同一份记忆 | ✅（结构上） | 双源同库自 Phase 1（本机 ZCode 实捕 + claude-code 契约测试同库检索）；serve 对任何 agent 一视同仁 |

## 二、交付模块

| 模块 | 内容 |
| ---- | ---- |
| `mcp/server.ts` | **8 个工具**：search_sessions / get_session_detail / list_sessions / get_decisions / get_file_history / get_unresolved / get_stats / set_scope。检索类全部 scope-aware + 逐条出处块（含 msg 序号）+ 命中不足 hint；scope.json 每次调用热更新（T28）；永不触发状态迁移（§1.2 约束 2） |
| `core/scope/{scopeFile,assemble}.ts` | B 档 scope.json（set/add/reset/show + merge）+ 装配器：CLI=B∩call，MCP=B∩call∩A（auto_days=30 可配）；full 逃生口解除 A/B/C |
| `cli/scope.ts` | `srelay scope set/add/reset/show` + **`attach <ids…>` / `detach`**（挂载=最高优先级 sessionIds 谓词 + scope_log 留痕） |
| CLI 检索接契约 | `search`/`list` 走同一装配器（B 档对 CLI 生效；CLI 不吃 A 档——人自己管时间窗，已注明） |
| 引擎增强 | SearchHit 增加 `seq`（最佳命中消息序号）→ 出处块 msg# |
| 契约测试 | `test/contract/mcp.spec.ts`：**真实 stdio 握手**（MCP Client 起 serve 子进程）：8 工具注册 / 出处 / A 档裁剪 / B 档交集 / set_scope full 热恢复 / detail 前缀解析 / decisions 出处 / stats |

## 三、实机冒烟（本项目真实库，2026-08-28）

```
get_stats        → 1 会话(confirmed) · zcode · 0.35MB
search_sessions("指导方针 决策") → 「深入理解会话接力产品需求」 出处 msg#18
get_decisions    → 10 条，首条带 sessionId + msg#4
```

Agent 注册方式（README 已含）：`{"mcpServers":{"sessionrelay":{"command":"srelay","args":["serve"]}}}`（开发期用 `node --import <tsx loader> srelay.ts serve`）。

## 四、偏差与登记

| # | 偏差 | 理由与去向 |
| - | ---- | ---- |
| P3-A | attach 未写 `session_links`（方针 §6.5 MVP 部分） | 一等关联需要"当前会话身份"（branch/PID，Phase 4）；已落地等价语义（sessionIds 谓词 + scope_log 留痕），Phase 4 补 links 与 `get_linked_sessions` |
| P3-B | ZCode end-signals 精化未接 `session_target.active_run_last_seen` | `time_updated` 静默信号已自 Phase 1 接线并工作；辅助信号（任务型会话更准）列 Phase 4 |
| P3-C | 工具调用参数中的文件路径未入 files_mentioned（tool parts 的 input.file） | 现提取基于正文路径（够用）；工具参数提取列 Phase 4 增强 |

## 五、测试规模

74/74（新增 11：契约 8 + scope-cli 4 - 重叠），`npm test` 全绿；`npm run typecheck` 零错误。

## 六、下一步（Phase 3.5 · W5 · 接力）

HOP 交接包 export/import（含 sha256 完整性 + 默认脱敏 + 归化 T21）· HANDOFF.md 自动生成（页脚署名 T19）· quarantine 隔离导入 · `team status/log` · export 尊重 scope（`--all` 覆盖）· scope C 档 TUI pick。
