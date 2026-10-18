# DSH 会话源适配器 — 设计文档 v1.0

> **日期**：2026-10-11
> **状态**：已实现并部署（10-11 凌晨；灰度=mc整合包；测试 235+9 全绿）
> **依据**：10-11 凌晨 DSH 存储格式全面逆向（实测 1445 文件 / 1.3GB / 三代格式）+ 方针原则 2/4、D24 适配器注册表、§6.1 Adapter 信号声明

---

## 1. 问题定义

DSH（DeepSeek Harness）是本机三大 AI 工具之一，其会话不进记忆库（无适配器）。DSH **更新频繁**（内核 alpha/稳定版交替、插件周更），适配器必须把"格式漂移导致断捕"的修复成本压到最低。

实测存储（全部一手验证）：

- 位置：`~/.dsh/sessions/<路径slug>/session-<uuid>/session.v4.jsonl.zstd`
- 体量：1445 文件 / 1.3GB；最大单文件 15MB 压缩；中位 518KB
- 容器：**zstd 多帧流 + 逐帧 NDJSON**——每帧独立可解（实测 8638 帧逐帧解码零失败）
- 行模型：单调 `seq` + 类型化事件（user/message、assistant/message、tool/call、compaction/* 等 30+ 种）
- 三代格式同树共存：无版本号(version 0)、v3、v4——容器跨内核 0.1.7→0.2.0 稳定
- 写入方：`@deepseek-ai/dsh-session-projection`（内核 0.1.7→0.2.1-alpha 三代同一架构组件）
- 钩子：`dsh-hooks-claude-code/codex` 官方包存在（0.1.7 起）；插件可 `ctx.on("session/event")` 订阅与会话流同源的事件（dsh-client-auto-continue 实证）

## 2. 范围

**做**：内置适配器 `src/adapters/dsh/`（discover/readNew/watchRoots/healthCheck），注册进 registry；灰度接入一个项目的 `capture.sources`。
**不做**：DSH 侧钩子插件（后置可选）；`detectCompaction`（DSH 存储是 append-only，压缩是显式事件流、历史不丢——无 ZCode 式物理删问题）；`changeProbe`（文件型源走 mtime+size 签名已足够）；v0/v3 的 schema 差异细分（容器兼容，行级未知类型跳过）。

## 3. 关键决策（ADR 摘要）

| # | 决策 | 理由 | 被否方案 |
|---|---|---|---|
| A1 | 内置适配器（fork 源码）而非 custom 通道文件 | 可进测试体系、可上游（方针三大支柱之一就是"国产 Agent 一手 Adapter"，DSH 在路线图）；custom 通道留给用户例试验 | custom `dsh.js`（在仓库外、不可测、难上游） |
| A2 | 项目归属 = 路径 slug 正向编码 | 会话头 `cwd` 是权威但需逐文件解压（1445 文件/周期不可接受）；slug 目录分组是 DSH 自己的归属机制。编码规则经 5 组真实数据验证 | 反向解码 slug（'-' 还原歧义：真实目录名含 '-' 时必错） |
| A3 | 消息映射 = 仅 user/assistant 的 text 部分 | 与 claude-code 适配器 `extractText` 同范式；reasoning/tool 噪声不进检索 | 全事件入库（workflow 碎片教训） |
| A4 | 游标 = 会话内 seq（每次全帧重解，仅 mtime/size 变更的文件会走到 readNew）；seq 直接做 seqNum | 逐帧独立可解 + seq 单调 → **截断尾帧完成后自然补收**（实现期发现：字节偏移游标在尾帧补完后会落在帧中间，真帧起点在偏移之前——要么丢帧要么回溯复杂；seq 过滤天然自愈）；实测 15MB 全帧解码 <100ms，且水位线先行跳过未变更文件 | 被否：字节偏移游标（截断帧完成后偏移错位，见左）；每周期全量解压所有文件（水位线已解决成本） |
| A5 | 尾帧容错：解码失败即停在最后完整帧 | DSH 追加中可能写到帧一半；下次周期从游标重试即可，绝不吞半帧 | 忽略尾部不完整字节继续（会错位） |
| A6 | Node ≥24 才启用（原生 `zlib.zstdDecompressSync`）；否则 healthCheck 报告、discover 返回空 | 零新依赖；本机 24.19 实测可用。engines 保持 >=22（其他源不受影响） | 引入 zstd npm 包（供应链面扩大，违反克制原则） |
| A7 | `originHint: 'workflow'` = 头部 `delegationDepth > 0` | 与 fork 的 workflow 决策排除机制对齐（子代理碎片不淹没项目决策） | 不标注（碎片入检索） |

## 4. 技术规格

### 4.1 slug 编码（正向，经验证）

`E:\music player → --E-music~0020player--`；`E:\mc整合包 → --E-mc~6574~5408~5305--`。规则：`':'` 删除；`'\'`、`'/'` → `'-'`；空格 → `~0020`；非 ASCII → `~` + 4 位大写十六进制（UTF-16 码元）；其余 ASCII 原样；两端各包 `'--'` 定界。**测试夹具固化 5 组真实 (路径, slug) 对。**

### 4.2 discover(projectRoot)

1. `groupDir = sessionsDir + dshSlug(projectRoot)`；不存在 → `[]`。
2. 扫 `session-<uuid>/` 子目录的 `*.zstd`（三种文件名模式全收）。
3. 每文件 stat 出 sizeBytes/mtimeMs；`sourceSessionId` = 目录名里的 uuid（不解压）。
4. `originHint`：头帧 `delegationDepth > 0` → `'workflow'`。头帧解码按 `(mtimeMs,sizeBytes)` 缓存（进程内 Map，同 zcode discoverCache 范式）——稳态零解压。
5. `title` 留空（捕获层按首条用户消息派生，方针 §7.1）。

### 4.3 readNew(ds, cursor)

1. cursor = `{ lastSeq: number }`（DSH 原生事件 seq；首读 0）。
2. **全帧重解**（水位线先行：mtime/size 未变的文件进不到这里）——逐帧 `zstdDecompressSync`，截断尾帧解码失败即跳过（完成后下周期按 seq 自然补收，零丢失）。
3. 行映射：`user/message` → `{role:'user', content: data.content[].text 拼接}`；`assistant/message` → `{role:'assistant', content: data.message.content[].text 拼接}`（reasoning 等非 text 部件跳过）；其余类型跳过；`seqNum = seq`；`createdAt = new ISO(time)`；坏行计 `badLines`。
4. seq 过滤（≤ cursor.lastSeq 的跳过——兼做截断重读的行级去重）；返回新游标 = 最大已入库 seq。
5. **设计权衡（实现期修订，覆盖 A4 初稿）**：字节偏移游标在"截断尾帧后来补完"场景下会落在帧中间丢真帧起点；seq 游标以每次变更文件的全帧重解为代价（实测 <100ms）换来零丢帧与自愈。

### 4.4 watchRoots / healthCheck

- `watchRoots` → `[sessionsDir]`（fs.watch 递归监听，追加即触发周期）。
- `healthCheck`：目录不存在 → "未安装/未使用 DSH（可忽略）"；`zlib.zstdDecompressSync` 非 function → "Node ≥24 需要原生 zstd 支持"；slug 组不存在 → null（健康：该项目无 DSH 会话）。

## 5. 测试计划（test/fork/dsh-adapter.spec.ts）

1. slug 编码：5 组真实 (路径, slug) 对 + 中文/空格/大小写边界；
2. discover：夹具树（tmp 会话库，zstdCompressSync 造帧）→ 正确返回 uuid/时间/originHint；
3. readNew 增量：首读全量 → 二读空 → 追加新帧只读新帧；
4. 尾帧截断容错：追加半帧不崩、游标不前进；
5. 映射：assistant 的 reasoning 部件不入 content、tool 事件跳过、badLines 计数；
6. healthCheck 三态（目录无 / Node 无 zstd / 健康）。

## 6. 边界

- **Always**：只读 DSH 文件；坏行/未知类型计数跳过；游标只前进；保护规则（active/imported）沿用主流程。
- **Ask first**：给 DSH 写任何东西（本设计为零写入）；接入超过一个项目（灰度纪律）。
- **Never**：修改 DSH 源文件；把 reasoning/工具噪声当消息入库；自动 forget。

## 7. 成功标准

1. 测试全绿（typecheck + 既有 226+ 新增 ≥8 断言组）；
2. 灰度项目（mc整合包）`capture.sources` 增 `"dsh"` 后：守护一个周期内 discover 到该项目全部 DSH 会话并入库，`srelay search` 能命中 DSH 会话正文（带出处 `source=dsh`）；
3. 守护稳态 CPU 增量 ≤2% 单核（活跃写入时短暂升高可接受）；
4. DSH 继续正常使用 24h，无相互干扰（零写入验证）。
