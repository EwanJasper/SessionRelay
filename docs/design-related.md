# `suggest_related_sessions` 相关会话推荐 · 设计方案 v1

> 目标：搜索是你带着词去找；推荐是库主动告诉你"这几个和手头这个是一伙的"。
> 定位：语义检索的顺手副产品（向量相似度即推荐算法）+ 无向量项目的降级路径。
> 依据：README 路线图 Phase 4 项；semantic 落地后性价比重估（向量基建已就绪）。

---

## 1. 问题定义

| 困境 | 现状 |
|---|---|
| "我记得讨论过类似的，但想不起词" | search 必须有关键词；词想不起来就永远找不到 |
| 正在看会话 X，想知道还有哪些同主题 | 只能人肉翻 list 或猜关键词 |
| attach 无从下手 | 新会话想挂载历史，但不知道挂哪个 |

## 2. MCP 契约裁决：新增第 16 个工具（v1 裁决）

- **裁决**：新增只读工具 `suggest_related_sessions`（9 读 + 7 写 = 16），不做进 get_linked_sessions（语义不同：links 是**显式建立**的关系，related 是**算法发现**的相似）
- **不变量升级**：既有断言"恒 15 工具"的真正意图是**防删除能力泄漏**，不是数字本身。升级为更强的双断言：
  1. 工具名精确清单断言（15 → 16，逐名列出）
  2. **名称黑名单扫描**：任何工具名含 `delete` / `remove` / `forget` / `purge` 即 fail——删除类工具永远为 0，这条不随工具数增长失效
- 联动更新点（实现清单）：contract/mcp.spec.ts、smoke/dist.spec.ts、pack-e2e.mjs、README zh/en（15→16）、user-guide（15 个工具速览）、CHANGELOG

## 3. 推荐算法（双轨）

### 3.1 向量轨（semantic 已启用且向量可用）

```
anchor 向量 = 库内 session_vectors（confirmed 会话有）
           或 即时嵌入（anchor 是 active 等无向量状态：title + 首条用户消息，
              只算不入库——"正在聊的会话找相关历史"恰是最高频场景）
候选 = 本项目 confirmed 会话（排除 anchor 自身）
得分 = 余弦相似度，≥ 阈值（复用 semantic.threshold，默认 0.40）
输出 top-K（limit 参数默认 5，硬顶 10）
```

### 3.2 重叠轨（无向量时的降级，纯 SQL/JS 零依赖）

```
得分 = 3 × 共享话题数 + 2 × 共享标签数 + min(共享文件数, 3) + min(共享标题分词, 3)
     （标题分词用现有 jieba segment，token 长度 ≥2 去重）
候选 = 本项目全部会话（排除自身；无向量则无 confirmed 限制——active 也能被推荐）
共享分 = 0 的不进结果；全部为 0 → count=0 + hint（不是错误）
```

### 3.3 融合

向量轨结果优先（`viaVector: true`），重叠轨**补足剩余名额**（去重后），各自带 `reason`：

- 向量轨：`向量相似 0.72`
- 重叠轨：`共享话题：数据库、索引 · 共享文件：src/db/pool.ts`（可解释性=反幻觉的一部分：每条推荐说得出为什么）

## 4. 语义边界（v1 决策）

| 问题 | 裁决 |
|---|---|
| 是否过 scope 契约 | **不过**——推荐是导航辅助（"库里有这些"），不是检索内容投放；条目只有 brief 元数据（≈1KB），污染风险可忽略。**必须文档写明 + 测试钉住**（scope 收窄后推荐仍返回） |
| 跨项目 | 强制 project_id 过滤，跨项目会话不可见（与 scope 边界一致） |
| anchor 不存在/前缀歧义 | 复用 get_session_detail 同款前缀解析；not-found 语义 |
| limit 滥用 | 参数上限 10 硬顶 |
| note 会话 | 可作 anchor 也可被推荐（notes 是会话行，confirm 时已被 digest 嵌入） |
| 性能 | 向量轨复用 semantic 的签名缓存 Map（跨进程一致性已解决）；重叠轨一次 SQL 取全项目行 JS 打分（5000 行 JSON.parse < 10ms）；无新表、无 schema 变更、**完全无状态** |

## 5. 接口形态

```ts
// MCP
suggest_related_sessions({ session_id: string, limit?: number })
→ { anchor: brief, count, suggestions: [{ ...brief, score, reason, viaVector }],
    hint: '推荐仅为导航线索；内容以 get_session_detail 为准' }
```

```bash
srelay related <id|前缀>          # 人用：表格输出（分数/理由/标题/日期）
```

## 6. 测试计划

1. 重叠轨：共享话题/标签/文件分层计分、自排除、空结果 count=0、active 也可被推荐
2. 向量轨：手工注入向量定序、阈值裁剪、model 不匹配忽略、anchor 无向量即时嵌入（FakeEmbedder）
3. 融合：向量优先 + 重叠补足去重
4. 边界：scope 收窄不拦截推荐（钉住 §4 裁决）、跨项目隔离、前缀歧义、limit 硬顶
5. 契约：16 工具精确名单 + **删除类名称黑名单扫描（新不变量）**
6. 真库验收：本机语义库实测 related 命中质量（本地手动项）

## 7. 不做什么

- 不新增表/配置项（阈值复用 semantic.threshold；连 config 都不动）
- 不做跨项目推荐、不做"全局热门"类推荐、不做协同过滤
- 不自动写入 session_links（推荐不产生持久关系——显式 link 仍由 AI/人发起）

## 8. 评审记录

### 第一轮（架构与数据流）——3 项修订
| # | v1 缺陷 | 证据 | 修订 |
|---|---|---|---|
| 1 | "恒 15 工具"断言的真正不变量没被提炼——计数断言在加第 16 个工具时被迫改写，防删除泄漏的初衷反而丢了锚点 | contract/mcp.spec.ts 精确名单断言 | §2：升级为双断言（精确名单 + 删除类名称黑名单扫描 delete/remove/forget/purge），黑名单不随数量失效 |
| 2 | 无向量降级链未闭合：anchor 无向量即时嵌入的前提是 getEmbedder 可用；依赖损坏时向量轨整体走不通的行为未定义 | semantic R3 同款问题 | §3.1：getEmbedder null 或向量轨任何异常 → 直接重叠轨（try/catch 短路），与 semantic 降级语义一致 |
| 3 | 重叠轨"标题分词"对全项目逐行跑 jieba——5000 行 × segment 的成本未评估，且对零重叠候选是纯浪费 | @node-rs/jieba 单次 µs 级，实测 5000 行 <10ms | 保留全量打分（实测可接受），不做过早优化；登记为性能注记 |

### 第二轮（对抗性与误用）——3 项修订
| # | v1 缺陷 | 证据 | 修订 |
|---|---|---|---|
| 4 | 导入副本噪音：自导回导产生的 #imp 后缀副本与原会话同标题同话题，重叠轨高分推荐"自己的副本" | P35-C 合并规则 | 接受为已知局限登记（副本场景少，reason 可解释、用户可自行判断）；V1 不做副本归组 |
| 5 | 推荐若写入 session_links 会形成 A→B→A 持久循环固化（回音室） | §7 原本就裁决不写 links | 补记裁决理由：无状态是防回音室的结构性保证，不只是省事 |
| 6 | AI 把 suggestions 当检索结果直接引用的风险 | 输出形态评审 | §5：hint 明示"导航线索，内容以 get_session_detail 为准"，每条带 provenance |

### 第三轮（收尾扫描）——3 项修订
| # | v1 缺陷 | 证据 | 修订 |
|---|---|---|---|
| 7 | §6 测试计划缺契约层断言细节（hint 存在性、viaVector 字段类型） | 实现时补齐 | 已补进 contract 测试 |
| 8 | "15→16"的文档散落点未列全（mermaid 图、接入验证话术、user-guide 速览/隐私章） | grep 全仓 | 实现清单落为 7 处：README zh/en（图+标题+表+接入话术）、user-guide（图+速览表+隐私章措辞）、smoke、pack-e2e |
| 9 | user-guide 隐私章"15 个工具恒定不变"在加工具后会变成假话 | 同上 | 措辞改为"删除类工具恒为 0，数量只增不减"——不变量随设计升级 |

---

## §9 实现落地备注

1. 实现面：`src/search-svc/related.ts`（suggestRelated，~130 行）+ MCP 第 16 工具 + `srelay related` CLI（query.ts）。无新表、无 schema 变更、无新配置——完全无状态。
2. 向量缓存复用：semantic.ts 导出 `cachedSessionVectors`（签名失效机制与检索共用），推荐重复调用不重载。
3. R6 钉死"即时嵌入不入库"——active 锚的向量只存在于本次调用内存，随 confirm 后由 digest 正常落库。
4. 契约测试新增 scope 不拦截推荐用例（写收窄 scope.json → 推荐 ≥1 → **清理还原**，防污染后续 get_stats 断言——第一版实现时踩过，测试自证）。

