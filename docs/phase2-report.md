# Phase 2 交付报告 · 结构化与结束判定

> **日期**：2026-08-28 · **对应**：方针 §十二 Phase 2（W3）
> **结论**：验收标准全部达成（自动化 63/63 + 本机真实会话验证），tsc 零错误。

## 一、验收对照

| 验收标准 | 结果 | 证据 |
| -------- | ---- | ---- |
| resume 一次旧会话后状态与摘要正确重算 | ✅ | `test/integration/confirm.spec.ts`：confirmed（摘要含旧决策"Session"）→ 追加新决策 → rollback（摘要清除、state=active）→ 再 confirm → 决策列表同时含旧（Session）与新（JWT），摘要基于全量消息重算 |
| 决策列表含出处 | ✅（双验证） | 自动化：`listDecisions` 返回 sessionId+seq+msgAt；实机：`srelay decisions` 每条带 日期/来源/标题/msg# + 可执行 `srelay show <id> --range n:n` |

## 二、交付模块

| 模块 | 内容 |
| ---- | ---- |
| `core/extract/extract.ts` | 五件套：files（路径正则+反斜杠归一+上限20）/ topics（TF+停用词+用户双倍权重）/ decisions（动词+句式双正则，去重上限10）/ key_questions（用户问句+未决启发式：尾部30%或含待定词）/ code_changes（围栏块计数）；`summaryRule` 免费摘要 |
| `store/db.ts` 扩展 | `confirmSession` 统一入口（judge 与 `srelay confirm` 同路）：提取 → 五列 JSON 落库 → summary_rule → meta_text 重算（话题+决策入索引）；`listDecisions` / `listUnresolved` 查询 |
| `capture/judge.ts` | confirmed 步骤切换到 confirmSession（副作用接线） |
| `capture/hook-spool.ts` | R4 落地：`srelay hook session-end --id <sid>` 写 spool → watch 周期消费 → active 会话立即转 pending（跳过 idle 等待）；坏文件自清理 |
| CLI | `decisions [--topic --source --limit]` / `unresolved` / `history <file>`（复用搜索引擎按文件路径短语检索） |

## 三、实机验证（本会话，2026-08-28）

```
srelay sync                 → 新消息 15（对话实时增长中）
srelay confirm f532c4d3…    → 提取：10 决策 · 8 话题 · 摘要生成
srelay decisions            → 真实决策 + 出处块（msg#4/7/8 可回跳）
srelay unresolved           → 空（本对话问题均已回答——启发式无误报）
srelay history sessionRelay-技术方案v1.1.md → 命中本会话，片段含该文件名
```

## 四、质量观察（诚实记录）

规则提取精度符合方针预期（60-70%，风险 #2"FTS 兜底"设计）：实机决策中混入了用户引用句（"选择存储哪些会话，默认监听…"是被引用的需求原文而非决策）；topics 含少量英文虚词（if/phase 已在停用词边缘）。**任何一条决策都带出处可回跳原文核验**——D10 出处契约正是对这种不精度的结构性补偿。改进路径：Phase 4 `--ai` 提取增强，不在本期。

## 五、已知简化（登记）

- topics 无跨会话 IDF（TF+停用词替代）——千级会话内效果可用，万级再评估
- unresolved 为启发式（尾部 30% 提问或含"还没/待定"类词）
- history 依赖文件路径在对话中以标识符形态出现（被 import/反引号包裹的最准）

## 六、下一步（Phase 3 · W4）

MCP Server（`srelay serve` + 8 tools，全部 scope-aware + 出处强制）· Scope A/B 档全量（scope.json CLI + auto-scope）+ 热更新 · `attach/detach` · Zcode end-signals 精化 · 契约测试（stdio 真握手）。
