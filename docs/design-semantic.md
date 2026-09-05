# `srelay semantic` 语义检索设计方案 · v4（三轮评审定稿，实现依据）

> 目标：让"换一种说法"的查询也能命中——AI 检索时换词、用户用自然语言问，都不再错过历史会话。
> 硬约束（用户拍板）：**不影响升级、不影响旧功能**——未启用时行为与 0.2.5 逐字节等价。
> 演进：v1 起草 → 三轮评审（10 项修订）→ v4。评审记录见 §8。

---

## 0. 立项依据：miss 率实验（scripts/semantic-miss-experiment.ts，2026-09-03 实测）

12 个真实感技术会话语料 × 17 组查询（5 对照 + 12 同义）：

| 组 | 命中 | 说明 |
|---|---|---|
| 对照组（原词查询） | **5/5** | 字面检索本身正常，排除假阴性 |
| 同义组（语义等价、换词） | **8/12（miss 33%）** | 「认证失败如何排查」找不到「登录/token」会话；「敏感信息泄露」找不到「硬编码密码」会话 |

两个致命发现：
1. **miss 本身**：三分之一强的换词查询完全落空；
2. **错配更糟**：「数据库压力大了怎么办」错误命中了「接口延迟」和「密钥泄漏」会话——AI 调用方拿到错误命中会**信以为真**，比空结果危害更大。

结论：MCP 检索工具的主要调用方是 AI，AI 换词比人更凶（把用户口语转述成术语）。检索命中率是记忆层产品的第一信任线。

## 1. 问题定义

| 困境 | 现状 |
|---|---|
| 同义/近义 miss | jieba+FTS5 字面匹配，「登录↔认证」「卡↔性能」「上线↔发布」互不可见 |
| AI 换词检索 miss | AI 把「很卡」转述成「性能劣化」→ 工具空手而归 → AI 弃用工具 |
| 错配 | 字面偶合（"数据库"）命中无关会话，AI 误信 |
| 长尾口语 | 「转圈」「撑不住」「跑三天被杀」——分词正确但词表不重叠 |

## 2. 目标与非目标

**目标**
1. 同义查询命中：验收标准 = miss 实验的同义 12 组，命中率从 8/12 提升到 **≥11/12（≥92%）**，对照组不劣化
2. 完全 opt-in：`srelay semantic enable` 前零行为变化、零下载、零新依赖生效
3. 本地优先：嵌入推理在本机 CPU，模型文件显式下载，默认无网络行为
4. 不破坏契约：MCP 恒 15 工具、`search_sessions` 返回 schema 仅**新增可选字段**

**非目标（明确不做）**
- 云端嵌入 API（违反零外呼承诺）
- ANN 索引 / sqlite-vec（量级不需要，见 §3.4 证明；引入原生扩展 = 升级面爆炸）
- 消息级向量（首版会话级；见 §3.3 答辩）
- 拼音/模糊音检索（方针 §5 非目标，维持）
- 自动开启（永远显式 opt-in）

## 3. 架构设计

### 3.1 选型裁决

| 决策点 | 裁决 | 理由 |
|---|---|---|
| 模型 | **BAAI/bge-small-zh-v1.5**（ONNX Q8，约 35MB，384 维） | 中文检索小模型事实标准；Q8 量化 CPU 单条嵌入 ~10-30ms |
| 推理 | **@huggingface/transformers（transformers.js v3，onnxruntime-node 后端）** | 纯 npm、无手写原生绑定；Node 22 原生支持 |
| 索引 | **无索引，内存暴力余弦** | 5,000 会话 × 384 维 × 4B = **7.7MB 内存，全量点积 <5ms**；1 万会话内无感。个人项目量级下 ANN 是伪需求 |
| 依赖形态 | **不进 package.json**。`semantic enable` 时动态安装到用户级缓存目录 `~/.sessionrelay/semantic/node_modules`；安装失败（离线）降级为一行指引 | 主包体积保持 124KB；升级路径零变化；onnxruntime 二进制不进主包 |

### 3.2 数据流总览

```
写入侧（确认时定型，正文不再变）:
  confirmSession() ──标记──> sessions.confirmed
  守护/CLI 周期 digest ──补嵌──> session_vectors（每周期限量 N=20，CPU 友好）
  rollbackSession()（resume 回滚）──> DELETE 向量（正文将变）
  runArchive()（正文删除）  ──> DELETE 向量（语义已过期，标题/话题仍可 FTS 命中）
  forget DELETE sessions    ──> FK ON DELETE CASCADE（向量随行消失，无残留）

读取侧（检索融合）:
  searchSessions(q)
    ├─ 路径 A（现状不动）：FTS5 双索引 → 命中集 A（排序不变）
    ├─ 路径 B（新增）：语义开启 && 向量库非空 && q 非空
    │    → 全量余弦 top-K（cos ≥ τ 默认 0.40，config 可调）
    │    → Scope/A 档 WHERE 同样过滤（先 SQL 筛候选 id 再算分）
    │    → 命中集 B，仅保留 B−A（FTS 已命中的不重复计）
    └─ 融合输出：A 在前（字面精确优先）+ B−A 追加，B 项标注 viaSemantic: true
```

**融合原则：字面命中永远优先，语义只做补充发现**——阈值内才出现、排序在 FTS 之后、绝不替换或抑制 FTS 结果。这保证"对照组不劣化"在构造上成立。

**生命周期语义（R9）**：嵌入只发生在 confirmed 之后——**记忆层服务的是"过去的会话"**；active 会话的正文还在增长（嵌了就过期），且当下会话本就在上下文里，不是记忆层场景。digest 候选 = `state='confirmed' AND (无向量行 OR model 不匹配)`——imported 会话（直插 confirmed）天然覆盖。

**多进程缓存一致性（R1，一轮评审）**：向量集合在进程内 `Map<sessionId, Float32Array>` 缓存，但嵌入发生在守护进程、检索发生在 MCP serve 进程——缓存必须失效检测：每次查询前比对库签名 `SELECT COUNT(*), MAX(embedded_at) FROM session_vectors WHERE model=?`，签名变化才重载（签名查询 <1ms，重载仅在有新向量时）。

**运行时降级（R3，二轮评审）**：`enabled=true` 但 transformers.js 不可解析 / 模型文件损坏 / 推理抛错 → 路径 B try/catch 短路为纯 FTS，`semantic status` 与检索 warnings 各提示一次——语义是增强不是依赖，损坏不拖垮检索。

### 3.3 嵌入输入与粒度答辩

- 输入 = `title + '\n' + 正文前 1200 字符`，**嵌入后 L2 归一化再入库**（R2：bge 余弦阈值的分母必须稳定，0.40 才有跨会话可比性）；查询侧同样归一化
- **输入与查询双侧截断到 512 token**（R6：防超长粘贴打爆编码器）
- **粒度=会话级**：检索目标是"找到会话"（返回值本来就是会话级 hit + snippet），标题+首段已携带主题信号；找到会话后消息定位继续走 FTS（snippet 机制不变）
- 已知局限（诚实登记）：超长会话尾部主题稀释——首版接受，若实测命中率不达标，后备方案是"标题+首条用户消息+keyExchanges 拼接"（提取器已有，零新成本）

### 3.3.1 融合参数（写死，R4）

| 参数 | 值 | 说明 |
|---|---|---|
| τ（余弦阈值） | 默认 0.40，config 可调 | 真模型实验后可修订，仅改默认值不动接口 |
| K（top-K） | **5，写死** | 语义错配与字面错配同理存在（实验已见字面错配）——限量是防线之一 |
| 排序 | FTS 命中（原序）→ 语义补充（按 cos 降序） | viaSemantic 标注，AI/用户可辨识来源 |

### 3.4 存储设计（schema v3 → v4）

```sql
CREATE TABLE session_vectors (
  session_id  TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  model       TEXT NOT NULL,        -- 'bge-small-zh-v1.5'（换模型=全部重嵌）
  dim         INTEGER NOT NULL,     -- 384
  vec         BLOB NOT NULL,        -- Float32Array, little-endian
  embedded_at TEXT NOT NULL
);
```

- `user_version` 3→4：纯建表迁移，`createDb`/`openExisting` 照既有模式；**未 enable 时表永远为空**——升级零影响的构造性保证
- FK ON DELETE CASCADE 是与 forget 的联动关键（0.2.5 的 DELETE 直接连带清向量，forget 代码零改动）
- **model 列是向量版本键（R5）**：换模型 = 旧向量视为不存在——查询时 `WHERE model = 当前模型`，digest 候选包含 `model 不匹配` 的行（覆盖重嵌），杜绝跨维度混算
- 配置存 config.json（非库内）：`semantic: { enabled, model, threshold }`——库与配置解耦，`forget --all`（重建空库）不影响语义开关

### 3.5 CLI（`srelay semantic`）

```bash
srelay semantic enable    # ①检测/安装 transformers.js 到用户缓存目录 ②下载模型（支持 HF_ENDPOINT 镜像 env）
                          # ③ config.semantic.enabled=true ④ 触发存量 confirmed 会话回填（后台限量/周期）
srelay semantic status    # 开关/模型/向量数/待嵌 backlog/缓存目录/依赖可用性
srelay semantic disable   # enabled=false（向量数据保留；检索立即回退纯 FTS）
srelay semantic test "查询词"  # 对比模式：FTS 命中 vs 语义命中 vs 融合结果（透明度 + 调阈值工具）
```

嵌入 digest 挂进现有 watch 周期与 `srelay sync` 尾部（复用守护心跳语义，无新进程）。

### 3.6 模型获取与离线

- 下载缓存走 transformers.js 默认（`~/.cache/huggingface`）；国内网络经 `HF_ENDPOINT=https://hf-mirror.com`（enable 输出里写明）
- 下载失败 = enable 失败并回滚 enabled（不留半开状态）；已下载后离线可用（纯本地推理）
- 实现期验证点：transformers.js v3 对 HF_ENDPOINT 的尊重方式（若仅认 `env.remoteHost` 则由 CLI 注入）

### 3.7 并发与性能

- 嵌入：单线程串行、每周期限量（默认 20 条/周期 ≈ 守护每 30s 最多 ~600ms CPU）——不与用户争抢
- 检索：向量集合在进程内 `Map<sessionId, Float32Array>` 惰性载入（首次查询载入 + 嵌入后失效重载）；MCP serve 常驻进程天然缓存
- 乐观策略：向量缺失（未回填完）时该会话只少一路召回，不报错不阻塞——回填进度通过 `semantic status` 透明

## 4. 兼容性与文档联动

- **未 enable**：`semanticCtx == null` 短路路径 B → 与 0.2.5 行为等价；171 既有测试仅 schema 版本断言需更新（`G1: =3` → `>=3`；`G1b` 模拟未来版本 4→5——这是测试对齐新版本号，不是行为破坏）
- **enable 后**：新增命中是纯增量（B−A 追加），不删不改 FTS 结果
- MCP：15 工具清单不动；`search_sessions` 响应**新增可选字段** `viaSemantic`（与既有 `viaMeta` 同构）
- `.hop` 导出：不含向量（模型相关、体积大；对端 opt-in 后自行重嵌）
- rebuild：新库无向量 → 周期 digest 自动回填（正确性不依赖向量存在）
- README：核心能力新增「语义检索（可选）」小节 + `semantic enable` 一步指引
- **doctor（R7）**：新增条件检查项——semantic 未开启时显示"未启用（可选）"；开启后检查依赖可解析性/模型文件/向量数/backlog
- **status（R8）**：主面板加一行语义状态（开/关 + 向量数/backlog）

## 5. 测试计划

1. **单元（CI 零模型）**：FakeEmbedder（确定性伪向量：同一文本同向量、相似文本向量相近——手工构造或 hash 扰动）注入融合层；测阈值裁剪/B−A 去重/Scope 过滤/排序保证（A 序不变）
2. **生命周期集成**：confirm→出现向量；resume→删除；archive→删除；forget→CASCADE；rebuild→回填；模型字段不匹配（model 列）→ 视为待嵌
3. **升级**：v3 库开 v4 表自动建；未 enable 行为等价（旧断言组全绿）；G1b 降级拒绝
4. **契约**：15 工具恒定；响应新增字段向后兼容（旧断言不破）
5. **真模型验收（本地手动，非 CI）**：miss 实验 17 查询重跑——同义组 ≥11/12，对照组 5/5 不劣化；结果回填本文件 §0
6. **性能冒烟**：5,000 会话伪向量全量余弦 <50ms

## 6. 不做什么

- 云端 API / 自动开启 / AN N 索引 / 消息级向量 / 拼音模糊音 / 向量进 .hop / 多模型并存管理

## 7. 开放问题（评审后定或用户裁决）

1. 阈值 τ 默认值（0.40 起步，真模型实验后定稿；config 可调是否足够？）
2. enable 时自动 `npm install` 到用户缓存目录——可接受度 vs 纯指引（倾向：自动+失败降级指引）
3. bge-small-zh（35MB）vs bge-base-zh（~110MB，精度+3-5 个点）——默认 small，是否提供 `semantic model set`？
4. embedding 输入是否并入 topics/tags（当前裁决：并入 title+正文即可，topics 已在 FTS meta 路）

## 8. 审查记录

### 第一轮（架构与数据流）——3 项修订
| # | v1 缺陷 | 证据 | v4 修订 |
|---|---|---|---|
| 1 | 向量 Map 进程内缓存 vs 守护进程并发写入——serve 检索到过期向量（staleness） | 多进程架构（serve/守护/sync 三进程共库） | §3.2 R1：COUNT+MAX(embedded_at) 签名失效，变化才重载 |
| 2 | 嵌入未定 L2 归一化——余弦阈值 0.40 的分母随模型输出漂移，阈值失去跨会话可比性 | bge 系列规范用法 | §3.3 R2：入库与查询双侧归一化 |
| 3 | digest 候选未覆盖 imported（不走 confirmSession，直插 confirmed） | insertImportedSession state='confirmed' | §3.2 R9：候选=confirmed 且无向量行（状态判定，非钩子判定）；active 不嵌的语义写明 |

### 第二轮（对抗性与误用）——4 项修订
| # | v1 缺陷 | 证据 | v4 修订 |
|---|---|---|---|
| 4 | enabled=true 但依赖损坏/模型文件被删 → 检索路径崩溃 | 用户可随意删 ~/.sessionrelay/semantic | §3.2 R3：运行时 try/catch 短路降级 FTS + 提示 |
| 5 | 语义错配无限量防线（字面错配实验已见：'数据库压力'误中密钥会话） | 实验 §0 | §3.3.1 R4：top-K=5 写死 |
| 6 | 换模型后旧维度向量与新维度混算 → 余弦无意义 | dim 列存在但无消费规则 | §3.4 R5：model 列为版本键，查询过滤 + digest 覆盖重嵌 |
| 7 | 超长粘贴（10KB）打爆编码器或拖慢单查询 | bge max_seq 512 | §3.3 R6：双侧截断 |

### 第三轮（收尾扫描）——3 项修订
| # | v1 缺陷 | 证据 | v4 修订 |
|---|---|---|---|
| 8 | doctor/status 不感知语义，故障不可发现 | doctor.ts 14 项清单 | R7：doctor 条件项；R8：status 一行 |
| 9 | enable 时自动 npm install 在 Windows 的 .cmd spawn 会 EINVAL | pack-e2e 既有教训（Node ≥22.12 CVE 防护） | 实现注意点：spawn npm 必须 shell:true（R10） |
| 10 | CI 若触发模型下载则断网即红 | transformers.js 惰性下载 | §5 已定：CI 全 FakeEmbedder 零模型；真模型验收为本地手动项并回填 §0 |
---

## §9 实现落地备注（实现完成后回填；正文 v4 保持原样，以下为代码事实）

1. **§0 验收结果（2026-09-05 实测，bge-small-zh-v1.5 Q8）**：对照组 5/5 不劣化；同义组 **12/12**（纯字面 8/12，miss 率 33%→0%），余弦分数区间 0.4-0.75，阈值 0.4 有效过滤。回填脚本 `scripts/semantic-realmodel-verify.ts`（复用 §0 同语料同查询，可复跑）。
2. **§3.1 缓存目录名修正（实现期抓到的真 bug）**：`~/.sessionrelay/semantic` 会在用户家目录创建 `.sessionrelay` 目录——findRelayRoot 向上探测同名即把**用户主目录误判为已初始化项目**，污染所有子目录 init。已改为 `~/.sessionrelay-semantic`（绝不与项目标记目录重名，代码注释钉死此教训）。
3. **transformers.js v3 两处实测行为**：pipeline 返回 Tensor（`.data` 取扁平向量，非嵌套数组）；`normalized:true` 选项未生效（分数呈点积量级）→ 按 R2 在 embed() 内强制 L2 归一化。bge-small-zh 维度 512（384 是英文版）。
4. **依赖安装实测**：`npm i --prefix ~/.sessionrelay-semantic @huggingface/transformers@3` 走 npmmirror 14s 装完（含 onnxruntime-node 二进制）；模型经 `HF_ENDPOINT=https://hf-mirror.com` 首次下载约 5s、后续缓存命中 0.3s 加载；嵌入均速 ~20ms/条（CPU）。
5. **top-K 与 limit 的关系**：语义 top-5 在 engine 内追加于 FTS 命中之后，最终统一 `slice(limit)`——FTS 满额时语义被截属预期（语义价值在 FTS 稀结果场景）。
6. **归档会话的 digest 语义**：软归档删向量后，会话仍为 confirmed 且无向量 → digest 会以纯标题重嵌（标题向量，无害且与 FTS meta 路一致）。
