# Phase 0 Spike 报告

> **日期**：2026-08-28
> **环境**：Windows (win32-x64) · Node v22.18.0 · better-sqlite3 12.11.1（预编译，零 node-gyp）· @node-rs/jieba 2.0.2 · vitest 3.2.7
> **结论**：S1-S5 五个门槛 Spike **全部通过**（S1-S4 共 42/42 测试绿；S5 ZCode 格式逆向完成），Phase 1 可以开工。

## 一、门槛判定（方针 §十二 Phase 0）

| Spike | 门槛标准 | 结果 | 证据 |
| ----- | -------- | ---- | ---- |
| S1 中文检索 | 方针 §14.1 用例 C1-C6 全绿 | ✅ **通过** | `test/integration/search.spec.ts`（C1-C6 + 项目隔离 + OR 兜底 + 出处 snippet 共 9 例）；`test/unit/tokenize/cases.spec.ts` 9 例 |
| S2 tailing + resume | 能实时捕获 + 正确触发一次回滚 | ✅ **通过** | `test/integration/tail-resume.spec.ts`：Windows fs.watch 递归监听 627ms 收到事件；confirmed 会话追加 5 行 → RESUMED 回滚 active、摘要清除；崩溃回放 15 行重插 **changes=0**（T20 幂等验证） |
| S3 状态机 | 状态转换全路径单测通过 | ✅ **通过** | `test/unit/state/machine.spec.ts`：21 种 (state × event) 组合全部确定（17 条合法/幂等规则 + 4 个非法组合显式拒绝），含 confirmed 不被 tick 抖动降级 |
| S4 Scope 注入 | `_scoped_where()` 交集语义一次搞定 | ✅ **通过** | `test/unit/scope/evaluator.spec.ts`：B ∩ call 只能收窄、mode:full 丢弃裁剪但 ignore 不可解除、:memory: 库端到端过滤正确 |
| S5 ZCode 格式逆向 | 产出首份国产 Agent Adapter 规格草案 | ✅ **通过**（2026-08-28，经用户授权只读分析本机数据） | `docs/adapters/zcode-format.md`：主存储为 SQLite（session/message/part 三表，实测 236 会话）；`session.directory` 直供项目归属（身份信号强于 Claude Code）；`message.sequence` 天然满足幂等键契约；**增量水位须从 byte_offset 泛化为 cursor（→T34）**；rollout JSONL 为模型遥测，不作捕获源 |

## 二、Spike 发现（需回填文档）

以下 6 条是本轮"假设变事实"过程中发现的设计缺口/修正，按治理规则回填：

| # | 发现 | 影响 | 回填目标 |
| - | ---- | ---- | -------- |
| F1 | **方针 §7.2 的 sessions_fts 只定义了 UPDATE 触发器**——INSERT 时 meta_text 不会被索引，C6（meta 模式检索）直接失败。Spike 已补 INSERT/DELETE 触发器 | P0 门槛级 | 方针 Review #4 + 技术方案 §7.2 |
| F2 | @node-rs/jieba v2 为类 API：`Jieba.withDict(dict)`，dict 从 `@node-rs/jieba/dict` 子模块导入（文档示例即此用法） | 实现细节 | 技术方案 §1.3 |
| F3 | **单字 CJK 必须入索引**："按月"不是词典词（切为 按\|月），C5 短语查询依赖单字在 token 流中的位置连续性。修正规则：索引侧保留单字；非引号查询侧丢弃单字（区分度）；引号短语保留完整序列 | 分词管线规则 | 技术方案 §6.1 |
| F4 | **AND 零命中 → OR 兜底**：C2 类真实查询（"认证方案"查"用 JWT 做认证"的会话）在严格 AND 下落空；引擎在会话级 AND 为空时回退 OR，按覆盖度排序（coverage<1 可识别） | 检索行为决策 | 技术方案 §6.1（新增"兜底排序"小节） |
| F5 | **ignore 谓词必须按排除语义编译**：`NOT (f1 OR f2 ...)`。按包含语义编译时敏感会话反而通过过滤（首轮测试当场抓获） | 正确性 | 技术方案 §3.4（CompileOptions.negate） |
| F6 | jieba 会把中文标点（，。）切为独立 token 入索引——无害但膨胀索引；Phase 1 可在 normalize 阶段过滤 CJK 标点 | 索引体积微优化 | 技术方案 §6.1 备忘 |

## 三、代码地图（Phase 1 直接复用）

```
sessionrelay/
├── src/
│   ├── core/tokenize/tokenizer.ts    # S1：分词管线（normalize/segment/parseQuery/unitExpr）
│   ├── core/state/machine.ts         # S3：表驱动状态机（transition + 17 规则）
│   ├── core/scope/evaluator.ts       # S4：谓词编译 + intersect + buildScopeFilter(_scoped_where)
│   ├── adapters/claude-code/tailer.ts # S2：完整行 tailer + rewrite/growth 检测
│   ├── adapters/claude-code/watcher.ts # S2：fs.watch 递归 + 轮询兜底 + 去抖
│   ├── store/db.ts                   # 方针 §7.2 DDL 可执行子集（含 F1 修复）
│   └── search-svc/engine.ts          # S1：双索引面 + 会话级覆盖度 + OR 兜底 + meta 合并
└── test/                             # 42 例，`npm test` / `npm run s1..s4` 分组运行
```

## 四、下一步

1. ~~S5~~ ✅ 已完成（2026-08-28，授权后只读分析）：`docs/adapters/zcode-format.md` 产出，含 cursor 泛化发现（→T34）；
2. ~~回填 F1-F6~~ ✅ 已完成：方针 Review #4（F1 触发器）+ 技术方案 T34-T37（F2-F6 与水位泛化）；
3. 进入 Phase 1：watch 守护（含 install-service）+ init 向导（回填 30 天）+ 中文搜索 CLI 化。
