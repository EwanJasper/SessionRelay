# 自动归档策略 — 设计提案（D26 候选 · 待评审）

> **日期**：2026-10-11
> **状态**：**已实现并部署（10-11 凌晨）**。四项开放问题已由用户拍板（见 §6 每条的 ✓）。按方针 §18 规矩：新想法先对照第十一章原则与第十八章决策日志；若采纳，先登记 D26 再修订方针与本文。
> **触发事实**（本地实测，非想象）：
> - 09-21 记忆库涨到 **229MB**，当时结论是"`srelay archive` 是官方给的正规手段，但没人记得跑"（srelay 记忆 session 3086914cb95ac891）；
> - 10-10 实测五库共 **187MB**，其中 **56MB 是 freelist 空洞**（小说项目 70%、music player 40%），VACUUM 可回收但无任何自动化；
> - 10-10 实测 `runArchive` 全仓库**唯一调用方是 CLI**（`src/cli/archive.ts`），守护链路（watch/judge/sync）一行都不碰归档。
> **前提**：归档引擎本体已建成（privacy-and-lifecycle-design.md v1.0 定稿 + `src/capture/archive.ts` + `srelay archive` CLI + deep.spec.ts 20+ 回归）。本提案**只补调度与维度，不重设计归档本身**。

---

## 1. 问题定义

| 困境 | 现状 |
|---|---|
| 库体积只进不出 | archive 全手动；风险登记册 #14 却判"库体积增长"🟢（"SQLite 百万级无压力"）——与 229MB 实测事故正面冲突 |
| freelist 空洞无人回收 | 删除/归档后空页累积，需 VACUUM；无任何调用方 |
| workflow 子代理会话无限索窗口 | music player 库 64%、mc整合包库 77% 是 workflow origin 会话；archive 条件（days/size/source/sessions）没有 origin 维度，无法分窗 |

## 2. 提案内容（D26 本体）

### 2.1 config.json 增 `archive` 节（方针 §8.6 schema 扩展）

```json
"archive": {
  "hotDays": 30,
  "workflowDays": 7,
  "maxMb": 150,
  "checkEveryMin": 60
}
```

- `hotDays`：普通会话热窗口（默认 30，与 init 回填 30 天/啊哈机制对齐）；
- `workflowDays`：`origin=workflow` 会话短窗口（子代理会话只在父任务还热时有用）；
- `maxMb`：单库体积封顶，超出按 `last_event_at` 最旧优先蒸发；
- `checkEveryMin`：守护检查节奏（默认 60 分钟一次，低频）。

### 2.2 守护定期执行（复用现有引擎）

- judge tick（30s）里挂一个低频检查：到点先 `runArchive(dryRun)` 做预算，超阈值才真执行——**dry-run 预算制**，不超不写；
- 执行即现有 `runArchive`：保护规则（active/imported/note/保留标签）、批间释放锁、复活、rebuild 交互、cleanup_log 审计**全部复用**，`triggered_by` 记 `'auto'`；
- 与 `forget` 的边界不变：**自动的只有 archive（降级），never forget/hard（抹除永远显式人工）**。

### 2.3 origin 维度

- `ArchiveCriteria` 增 `origin` 字段；workflow 会话按 `workflowDays`，其余按 `hotDays`，两次预算合成一次执行。

### 2.4 体积保养（VACUUM）

- 归档执行后 freelist 必然增长。取其一（开放问题 2）：
  - a) 一次性 `VACUUM` 开启 `auto_vacuum=INCREMENTAL`，之后守护每次归档后 `PRAGMA incremental_vacuum`；
  - b) 守护每月一次完整 `VACUUM`（WAL 下短暂阻塞写，放低峰）。

## 3. 与检索降噪的分界（建议另立 D27）

本提案只管**生命周期**。workflow 会话默认不进**检索**（Scope 五维谓词加 origin 维度）是检索层决策，两者机制不同、风险不同，**分开登记、分开评审**，不打包。

## 4. 原则合规检查（方针第四章）

| 原则 | 合规性 |
|---|---|
| 2 记忆完整收录、检索由人划定 | 归档保留骨架（决策/话题/摘要/标题），存根仍可搜；正文在源文件，rebuild --force 可恢复 ✓ |
| 4 源文件是唯一事实源 | 归档/蒸发均不碰源文件；恢复路径不变 ✓ |
| 11 / §15.5 零外呼 | 纯本地执行，无遥测 ✓ |
| 风险登记册 #14 | 需同步从 🟢 修订为 🟡 并附 229MB/187MB 实测数据（本提案的立论基础） |

## 5. 不做什么

1. 不自动 `forget` / `archive --hard`（删除永远显式人工，forget 设计 §1 边界不可动）；
2. 不删/不改任何 agent 源会话文件（原则 4）；
3. 不做跨库全局归档（各项目独立，scope 边界）；
4. 不引入新存储层（归档终点就是源文件，不建第二库）。

## 6. 开放问题（交用户裁决）

1. ✓ **已拍板**：默认启用、`hot_days=60`——给"init 回填 30 天"的啊哈机制留余量，避免回填的历史被过快蒸发；
2. ✓ **已拍板**：增量式（首跑 auto_vacuum NONE→INCREMENTAL + VACUUM，此后归档后 incremental_vacuum）
3. ✓ **已拍板**：`workflow_days=7`；
4. ✓ **已拍板**：`check_every_min=60`（串行进写链，与 judge tick 无竞争）。

## 7. 测试计划

- **复用**：deep.spec.ts 既有的 20+ 归档回归（保护/复活/rebuild/hard/审计）全部必须继续全绿；
- **新增**：守护定期触发（mock 时钟）、origin 分窗、maxMb 封顶、dry-run 预算制不误执行、auto 模式的 cleanup_log.triggered_by='auto'；
- **性能**：归档批次对 sync 的阻塞时长基准（批量+锁释放的既有设计需实测验证）。

---

*本提案不修改任何代码与配置；采纳后按方针流程登记 D26，再排期实现。*
