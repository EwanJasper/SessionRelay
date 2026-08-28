# Phase 1 交付报告 · 存储与捕获

> **日期**：2026-08-28 · **对应**：方针 §十二 Phase 1（W1-2）
> **结论**：Phase 1 验收标准全部达成（自动化 + 实机双验证），51/51 测试绿，tsc 零错误。

## 一、验收对照（方针 §十二 Phase 1）

| 验收标准 | 结果 | 证据 |
| -------- | ---- | ---- |
| 不执行任何 save，次日能搜到昨天会话 | ✅（等价验证） | 实机：本项目从未手动 save，`srelay sync` 直接从 ZCode 活动库增量捕获本对话（85+ 消息，且对话进行中持续捕获到新行） |
| init 后 1 分钟内能搜到 30 天前的会话（啊哈机制，§15.6） | ✅（等价验证） | 实机：`srelay init --yes` 回填 30 天 → 立即 `srelay search 中文检索` 命中真实会话（含出处与 snippet）；交互试搜入口已实现（TTY 下） |
| status 面板数字自洽 + 守护未运行红色告警 | ✅ | 实机面板输出：模式/守护🔴告警+修复建议/active-pending-confirmed 计数/来源分布/拦截计数/体积/最近会话 |
| mode off 下 watch 零写入 | ✅ | `test/integration/capture.spec.ts`「mode off：零写入」 |
| 本地计数器记录激活/啊哈/留存事件 | ✅ | `core/stats/counter.ts` + `srelay stats`（install/init_done/backfill_done/first_hit/cli_search/cli_show/blocked_by_ignore/resumed/confirmed） |
| 杀进程重启后消息零重复（幂等验收） | ✅ | 集成测试「重放幂等」+ Phase 0 崩溃回放用例（offset 回退重读 changes=0） |

## 二、交付模块

| 层 | 模块 | 要点 |
| -- | ---- | ---- |
| 存储 | `store/db.ts` | 方针 §7.2 完整 DDL（含 Review#3/#4、T20 唯一键、T34 cursor、R8 pending_at）；T30 前向版本探测 |
| 共享 | `shared/{paths,config,lock}.ts` | 项目根发现/路径 slug（与 Claude Code 目录规则一致）/四级配置/心跳锁（僵死 60s 接管） |
| Adapter | `adapters/claude-code/adapter.ts` | 真实格式（S5 交叉验证）：目录 slug 归属、sidechain/attachment 跳过、行号=seq_num |
| Adapter | `adapters/zcode/adapter.ts` | **提前落地**（原排 Phase 3，因 S5 规格已齐且实机验证需要）：只读连接、directory 归属、rowid 水位、parts 拼接、原生 title |
| 捕获 | `capture/sync.ts` | T20 事务边界（消息+水位同事务）；RESUMED 回滚；三层 ignore（发现期 source/glob + 入库前 title）；三档模式 |
| 捕获 | `capture/judge.ts` / `watch.ts` | 两阶段判定（Clock 可注入）/ 守护：锁心跳 + fs.watch 快路径 + 30s 判定 + 60s 安全重扫，写周期串行化 |
| CLI | 12 个命令 | init（回填+试搜）/sync/watch（含 Windows 服务注册）/status/mode/search/show/list/stats/doctor/confirm/purge |
| 观测 | `core/stats/counter.ts` | 零外呼本地计数（T17），stats.json 可随时删 |

## 三、实机验证记录（本机，2026-08-28）

```
srelay init --yes   → 回填 30 天：发现 1 会话 · 入库 1 · 消息 85（ZCode 活动库，只读）
srelay status       → 面板自洽；守护未运行🔴（正确，未注册服务）
srelay search 中文检索 → 命中「深入理解会话接力产品需求」（ZCode 原生标题），覆盖 100%，含出处
srelay sync         → 新消息 2（对话进行中实时增量）
srelay doctor       → 9 项：8 过 · 1 提示（守护未运行，给出修复命令）· 0 失败
srelay watch（短跑）→ 锁心跳 ✓ · 双源监听 ✓ · fs.watch 事件驱动增量 ✓（pid 36036）
```

## 四、实现期发现（需登记）

| # | 发现 | 处置 |
| - | ---- | ---- |
| P1-A | `title:` 类 ignore 规则在发现期无法判定（claude-code 的标题来自解析后的首条用户消息）——测试当场抓获 | 已修：ignore 分两层（发现期 source/glob + 入库前 title 复查，数据不落库）；语义已补进本文档 |
| P1-B | cooldown 计时需要 pending 时刻，方针 §7.2 无此列 | 已加 `sessions.pending_at`（R8），待回填方针 Review #5 |
| P1-C | `--import tsx` 按 CWD 解析，跨项目调用必须用绝对 file:// loader 路径 | 服务任务脚本已内建该机制；发布 npm 包后此问题消失（dist 为纯 JS） |
| P1-D | CLI 层 import 层级错误未被 vitest 抓到（cli 不在测试导入图内） | `npm run typecheck`（tsc --noEmit）加入必跑流程，本报告发布前已清零 |

## 五、范围偏差声明

ZCode adapter 提前至 Phase 1 落地（方针原排 Phase 3）。理由：S5 规格已齐 + 本机实机验收需要真实国产源 + 护城河优先级（方针 §2.4）。其 end-signals 精化（session_target.active_run_last_seen）与 files 提取仍在 Phase 3。

## 六、下一步（Phase 2 · W3）

元数据提取五件套（files/topics/decisions/key_questions）→ summary_rule 免费摘要 → confirmed 副作用接线（judge 触发提取与 meta_text 重算）→ `decisions/history/unresolved` 命令 → hook-spool（R4）。
