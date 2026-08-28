# Phase 3.5 交付报告 · HOP 交接（MVP 收官）

> **日期**：2026-08-28 · **对应**：方针 §十二 Phase 3.5（W5）
> **结论**：验收标准达成（81/81 测试 + 实机真实交接演示），MVP（Phase 0→3.5）全部完成。

## 一、验收对照

| 验收标准 | 结果 | 证据 |
| -------- | ---- | ---- |
| 张三导出 → 小王导入 → 能答"数据库为什么选 PG" | ✅ | `test/integration/hop.spec.ts`：跨项目导入后，`search('PostgreSQL 数据库')` 命中、`get_decisions` 可见、溯源字段完整（imported_from=张三、origin_project） |
| HANDOFF.md 免解释可读（含署名） | ✅（双验证） | 测试断言 + **实机**：本对话导出的真实 HANDOFF.md（决策表/涉及文件/页脚署名俱全，见 `.tmp-acceptance/HANDOFF.md`） |
| 注入密钥的会话导出被脱敏并出具报告 | ✅ | postgres 连接串与 AKIA key 均替换为 `[已脱敏:*]`，包内全文无明文；`redaction-report.txt` 列出模式与命中数 |

## 二、交付模块

| 模块 | 内容 |
| ---- | ---- |
| `relay/hop.ts` | hop/1.0 容器：pack（逐文件 sha256 入 manifest + trust 声明）/ unpack（zip-slip 防护 + 全量完整性校验，任一不符整体拒绝） |
| `relay/redact.ts` | 5 类模式：AWS key / 私钥块 / Bearer / 密码赋值 / 数据库连接串；默认开启 |
| `relay/export.ts` | 选集默认尊重 scope（--all 覆盖）+ --topic/--tag/--source/--since/--exclude-tag/--decisions-only；title/正文/决策/问题全字段脱敏；transfer_log + stats |
| `relay/import.ts` | 归化（T21：project_id 重写 + origin_project 溯源）；往返规则（同身份同 fingerprint 跳过 / 不同则后缀保留双方）；quarantine 隔离导入（摘要可检索、正文暂存）；release 放行 |
| `relay/handoff-md.ts` | HANDOFF.md（决策表/文件/未决/逐会话摘要/页脚署名 T19）+ timeline.md，零 LLM |
| CLI | `export` / `import [--from --quarantine --release]` / `team status|log` |

## 三、实机演示（2026-08-28）

```
srelay export --all → 本对话（103 消息）打包为 myapp-handoff.hop
HANDOFF.md 预览    → 决策表含真实评审结论（"改为 1 周 Spike + 5 周主线"等）
srelay import      → 归化入库、search 立即可查（详见下方 P35-A 说明）
```

## 四、实机发现（登记）

| # | 发现 | 处置 |
| - | ---- | ---- |
| P35-A | **子目录内 CLI 会向上发现父项目根**（按设计，技术方案 §3.4/paths）：把"接收方项目"建在已初始化项目的子目录里时，import 落回父库。跨项目导入已由测试夹具（显式 root，PROJ_A→PROJ_B/PROJ_C）充分验证；实机复现需在**工作目录之外**建接收项目（需授权，未执行）。README 应写明"接收方在自己的项目根执行 import" | 文档提示 |
| P35-B | files 提取存在单段斜杠误报（`/DSH`、`/v2.0` 来自行内"Zcode/DSH"字样被当成绝对路径） | 过滤规则（最小段数/上下文词黑名单）列 Phase 4 |
| P35-C | 把自己导出的包导回自己项目会生成后缀副本（合并规则的正确行为，同身份但指纹路径不同） | README 提示：import 用于接收他人包；自查用 search 即可 |

误导入的后缀副本已从主库清除（`origin='imported'` 全删，主库恢复 1 条原生会话）。

## 五、MVP 总账（Phase 0 → 3.5）

| 阶段 | 交付 | 测试 |
| ---- | ---- | ---- |
| P0 Spike | 中文检索/状态机/Scope/简历回放/ZCode 格式逆向 | 42 例 |
| P1 存储捕获 | 完整 DDL、双源 adapter、sync/judge/watch、12 命令 CLI、服务注册 | 51 例 |
| P2 结构化 | 提取五件套、summary_rule、confirmed 副作用、decisions/history/unresolved、hook-spool | 63 例 |
| P3 MCP+Scope | 8 工具（stdio 契约测试）、A/B 档、attach/detach | 74 例 |
| P3.5 接力 | HOP 导出/导入/脱敏/隔离/署名、HANDOFF.md、team | **81 例** |

`npm test` 81/81 绿 · `npm run typecheck` 零错误 · 每阶段实机验收通过。

## 六、下一步（Phase 4 候选，按方针 §12）

`--ai` LLM 摘要/提取增强 · branch/PID 会话归属 + `get_linked_sessions`（P3-A 补账）· ZCode end-signals 精化（P3-B）· 工具参数文件提取（P3-C）· files 过滤（P35-B）· HOP 规格独立成文 `spec/hop-1.0.md` + 推广（§15.8 BD）· npm 发布（消除 tsx loader 依赖，P1-C）· GitHub 仓库初始化与对外发布（战役一：掘金/知乎首发）。
