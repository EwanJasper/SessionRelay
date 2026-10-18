# 地图层（Map Layer）：mellos-mapping 本土化 · 契约冻结（2026-10-18）

> 一句话：把 mellos-mapping v0.28.0 的**结构纪律**搬进 SessionRelay（CLI + 库 + 文件），**不用 MCP**、不加新依赖、不新增进程；由守护的既有 sync 路径全自动投影到看板（`progress.md`）与依赖图（`.sessionrelay/board/board.mmd`）。
> 本文是施工用的**契约**：接口签名冻结，后续任务照此实现，不再各自发明。

## 0. 为什么（现状事实，都是量出来的）

| 事实 | 出处 |
|---|---|
| 看板"依赖图"实测 **0 条边**（27 个色块，`-->` 一条没有） | `D:/agent1super/.sessionrelay/board/board.mmd` |
| 出边规则靠"依赖列文本包含另一行前 6 字"，带路径/>40 字直接跳过（踩过假边） | `src/cli/kanban.ts` renderMermaid 注释 |
| 简报「计划/下一步」唯一来源是 progress.md，实测**只捕获 3.3%（5763 条未捕获）** | kanban.ts 头部 / dsh-plugin/index.js:311 |
| 自动区已挂在**守护路径**上（`capture/sync.ts` → `syncKanbanAuto`），此前"只挂 CLI"导致自动从没自动过 | `src/capture/sync.ts:184-191` |
| 看板三条纪律：绝不覆盖人写文件 / 只用可观测量 / 格式必须可解析（状态列 ✅🔄⛔⬜ 开头） | kanban.ts 头部 |
| `npm run build` 会 **`rm -rf dist`**；部署要把 dist 镜像到 5 类副本；守护不重启=跑旧代码 | tsup.config.ts / tools/_mirror_dist.mjs |

mellos-mapping 的核心是"**账本不是法官**"：它只拒绝结构损坏（层带 rank、边只能严格向下 ⇒ 天生无环、id 唯一、状态闭合词表），不裁判流程；可信度靠**证据**与**源码指纹**，而不是靠人自觉。

## 1. 位置与文件布局

落地树：`D:/dsh插件  记忆/core/SessionRelay`（`/d/sessionrelay-eco` 是镜像，不作为写入目标）。

```
src/map/
  domain/types.ts        类型 + 不变式判据 + id/rank/status 校验（纯）
  domain/ops.ts          declare/update/remove 的纯操作（草稿 → 校验 → 新草稿）
  domain/context.ts      context.summary/next + sources 校验
  store/format.ts        序列化/解析（严格读：类型不对即拒，绝不静默丢字段）
  store/atomic.ts        原子保存：temp + rename + Windows EPERM/EBUSY 退避重试
  store/lock.ts          单文件独占锁：openSync(wx) + 僵尸兜底（不移植 mellos 的 N-API）
  store/page.ts          页的读写、列表、revision（= 规范化内容 sha256）
  store/apply.ts         applyPatch：1–100 条 op，草稿→校验最终图→一次落盘
  semantics/validate.ts  未知字段/控制字符/超长拒绝
  semantics/vocabulary.ts 状态 → 看板 emoji 投影表（唯一一份）
  bridge.ts              地图 → 看板行 / Mermaid（只读；绝不改地图）
  stale.ts               sources sha256 对账 + 缓存
  patch.ts               patch 的 zod schema（CLI 与库共用）
  index.ts               对外出口
  NOTICE-mellos.md       MIT 归属声明（v0.28.0 / GuangminJu）
```

## 2. 数据契约

存 `<root>/.sessionrelay/map/<page>.json`（默认页文件 `map.json`；`map.dir` 可配）。页 id 语法 `^[a-z0-9][a-z0-9-]{0,63}$`。

```json
{
  "version": 1,
  "title": "看板适配改造",
  "layers": [{ "id": "core", "name": "地图内核", "rank": 0 }],
  "groups": [{ "id": "store", "label": "存储", "layer": "core" }],
  "lanes":   [{ "id": "agent", "label": "agent" }],
  "nodes": [{
    "id": "map-store", "label": "地图存储", "layer": "core", "status": "doing",
    "evidence": "单测 12/12 通过", "detail": "atomic + lock",
    "group": "store", "lane": "agent",
    "sources": [{ "path": "src/map/store/atomic.ts", "sha256": "…" }]
  }],
  "edges": [{ "from": "map-ops", "to": "map-types", "label": "uses" }],
  "context": { "summary": "…", "next": "…", "updated": "2026-10-18T04:41:00+08:00" }
}
```

**不变式（违反即拒，错误码 REFUSED）**
1. id 唯一（节点与分组**共用**一个命名空间）；符合 id 语法。
2. 每个节点必须属于一个**已存在**的层。
3. 边 `from → to` 表示 "from 使用 to"，要求 `rank(layer(from)) > rank(layer(to))`；**同层边拒绝** ⇒ 图天生无环。
4. group 必须存在且与其成员同层；node.group / node.lane 引用的对象必须存在。
5. status ∈ `todo | doing | blocked | done | regressed`。
6. rank 为 `0..99` 的整数；文本字段拒绝控制字符、超长（label ≤120，detail/evidence ≤2000，summary/next ≤2000）。
7. 未知字段一律拒绝（不静默丢弃——写回会毁掉手改的文件）。

## 3. 冻结接口（照此实现，改动需 Lead 同意）

```ts
// ── domain/types.ts ──
export type MapStatus = 'todo' | 'doing' | 'blocked' | 'done' | 'regressed';
export interface MapLayer { id: string; name: string; rank: number }
export interface MapGroup { id: string; label: string; layer: string }
export interface MapLane  { id: string; label: string }
export interface SourceRef { path: string; sha256?: string }
export interface MapNode {
  id: string; label: string; layer: string; status: MapStatus;
  evidence?: string; detail?: string; group?: string; lane?: string; sources?: SourceRef[];
}
export interface MapEdge { from: string; to: string; label?: string }
export interface MapContext { summary?: string; next?: string; updated?: string }
export interface MapPage {
  id: string; title: string; kind?: string;
  layers: MapLayer[]; groups: MapGroup[]; lanes: MapLane[];
  nodes: MapNode[]; edges: MapEdge[]; context?: MapContext;
}

// ── 统一返回（绝不抛到调用方；看板路径尤其不许抛）──
export type MapErrorCode =
  | 'NOT_FOUND' | 'INVALID_STORE' | 'REFUSED' | 'CONFLICT' | 'BUSY'
  | 'LOCK_UNAVAILABLE' | 'INVALID_ARGUMENT' | 'SAVE_FAILED';
export interface MapError { code: MapErrorCode; message: string; hint?: string; details?: unknown }
export type Res<T> = { ok: true; value: T } | { ok: false; error: MapError };

// ── store/page.ts ──
export function mapDirOf(root: string): string;                       // <root>/.sessionrelay/map
export function readPage(root: string, page?: string): Res<{ page: MapPage; revision: string; path: string }>;
export function listPages(root: string): Res<Array<{ id: string; title: string; revision: string; nodes: number; edges: number }>>;
export function initMap(root: string, title: string): Res<{ path: string }>;   // 已存在 → CONFLICT，绝不覆盖

// ── store/apply.ts ──
export interface MapPatch {
  page?: string;                              // 省略 = 默认页
  expectedRevision?: string | 'absent';       // 'absent' = 文件必须不存在；省略 = 只串行化不校验
  operations: Array<{ op: 'declare' | 'update' | 'remove'; data: unknown }>;  // 1..100
}
export function applyPatch(root: string, patch: MapPatch): Res<{ revision: string; applied: number; page: MapPage }>;

// ── stale.ts ──
export interface ChangesReport {
  page: string;
  nodes: Array<{ id: string; label: string; state: 'unchanged' | 'changed' | 'unknown';
                 changed: string[]; unknown: string[]; consumers: string[] }>;
}
export function checkSources(root: string, page?: string, ids?: string[]): Res<ChangesReport>;

// ── bridge.ts（只读；上游切换用）──
export interface KanbanProjection { rows: string[][]; note: string }   // rows 为 4 格数组：[任务, 状态, 模块, 明细]
export function mapKanbanRows(root: string, opts?: { page?: string; maxRows?: number }): KanbanProjection;
export function renderMapMermaid(root: string, humanRows: string[][], opts?: { page?: string }): Res<string>;
```

## 4. CLI 契约（`srelay map …`）

| 命令 | 说明 |
|---|---|
| `map init [--title <t>] [--json]` | 建空地图；已存在 → CONFLICT（绝不覆盖） |
| `map read [--page p] [--resource pages\|map\|nodes\|edges\|layers\|changes] [--id <id>] [--status <s>] [--limit n] [--cursor c] [--fields a,b] [--json]` | 只读；默认人类可读，`--json` 输出结构化 |
| `map apply --file <patch.json\|-> [--json]` | **主写入口**，语义见 §3 applyPatch |
| `map declare --file <json\|->` / `map update …` / `map remove …` | 单操作糖（内部走 apply） |
| `map check [--page p] [--json]` | sources 对账：changed/unchanged/unknown + 受影响消费者 |
| `map export [--mmd\|--md\|--d2] [--out <path>] [--to <仓库内路径>]` | 出图/快照 |
| `map import --from progress.md [--page p]` | 现有看板行 → 单层地图初稿（一次性迁移入口；已存在地图则拒绝） |

退出码：三分法见 §4.1（0 成功 / 1 改输入 / 2 可重试）。stderr 一行「错误码：说明（建议动作）」，`--json` 给 `{ok,error:{code,message,hint}}`。

## 4.1 patch 的 data 形状（冻结 · T1/T2 照此实现）

每条操作的 `data` 就是**一个页面片段**，键取自 `{title, kind, context, layers, groups, lanes, nodes, edges, laneOrder}`：

- **declare**：要新建的对象；**已存在的 id 一律拒绝**（REFUSED）。同批内可以先声明边再声明端点，由最终图校验兜底。
- **update**：按 id 定位后改字段。**边的身份 = from+to**（没有独立 edge id）；边补丁可带 `{from,to,label?,newFrom?,newTo?}`；`null` 清除可选字段（label/detail/evidence/group/lane）；`context` 与 `sources` 是**整体替换**；泳道顺序用 `laneOrder`（必须包含全部泳道各一次）。
- **remove**：只给身份选择器 `{nodes:[{id}], groups:[{id}], lanes:[{id}], layers:[{id}], edges:[{from,to}]}`；删层/组不静默搬移成员（有成员即 REFUSED）。
- 未知键、控制字符、超长 → REFUSED（§2 不变式 6/7）。
- 上限 100 条操作；全部操作在草稿上顺序执行 → 校验**最终图** → 一次落盘（拒绝时文件字节不变）。

**`map import --from progress.md` 的初稿形状**：单层 `{id:"plan", name:"计划（自 progress.md 导入）", rank:0}`；每行 → 节点 `{id:"n<行序>", label:行名原文, layer:"plan", status:✅→done / 🔄→doing / ⛔→blocked / ⬜→todo, detail:明细列}`；**不生成任何边**（依赖列是人话，不猜）。地图已存在 → REFUSED（绝不覆盖）。

**export / import 语义**：`map export --mmd|--md|--d2 [--out <path>]` 出图或文本（默认 stdout）；`map export --json --to <仓库内相对路径>` 写地图 JSON **快照**（供提交进仓库）；`map import --from <file.json>` 从快照恢复（目标已存在 → REFUSED）。

**退出码**：0 成功；**1** = {NOT_FOUND, INVALID_ARGUMENT, REFUSED, CONFLICT, INVALID_STORE}；**2** = {BUSY, LOCK_UNAVAILABLE, SAVE_FAILED}（可重试，值得重跑）。

**init 默认标题**：`map init` 省略 `--title` 时取**项目根目录名**（`initMap(root, title)` 的 title 仍必填，由 CLI 兜默认）。

## 4.2 补充裁定（冻结 · T2/T3 照此实现）

- **单操作糖的 `--file` 装的就是"页面片段本身"**（等价于 `operations[0].data`），不是 `{op,data}` 信封。允许 `-` 从 stdin 读。
- **`read --resource changes` 与 `map check` 同源同结构**（都调 `checkSources`）；`check` 额外负责退出码与人类可读摘要。
- **分页与投影**：`--limit` 默认 30、上限 100；`--cursor` 是**不透明游标**（内含 offset + 发号时的 revision），图在两次读之间变了 → `CONFLICT`（提示重新从头读），游标本身格式非法 → `INVALID_ARGUMENT`；`--fields` 只作用于 list 类 resource（nodes/edges/layers/pages），**identity 与边的两端字段永远保留**。
- **`--to` 必须与 `--json` 同用**，否则 `INVALID_ARGUMENT`（`--to` 只用于"把 JSON 快照写进仓库"）。
- **没有"删页"动词**（与"绝不覆盖人写内容"同一条纪律）：页的建立由 `apply` 的 declare 完成，页的删除是**用户手动删文件**；工具不会替你删。
- **`apply` 可以用 declare 建页**（与上游 mmap_declare 一致）：页文件不存在时按声明创建，**title 缺省 = 页 id**（默认页 id 为 `map`）；`expectedRevision:"absent"` 要求文件必须不存在。

## 4.3 内核语义裁定（Lead 终审 · 已按此实现）

1. **declare 带标量（title/kind/context）= 设置**，不是"已存在即拒"（"拒绝已存在的 id"只约束有 id 的对象）；因此**一条 declare 片段就能建页**，`expectedRevision:"absent"` 才有意义。页文件不存在时 title 缺省 = 页 id（默认页 = `map`）。
2. 页文件**扁平**：`<root>/.sessionrelay/map/<page>.json`（无子目录）；`.hash-cache.json` 与 `<page>.json.lock` 同目录共存，`listPages` 按 id 语法过滤。
3. **删"有成员的"层/组/泳道一律 REFUSED**（不静默搬移成员；泳道同理）。
4. **目标不存在 → `NOT_FOUND`**（update/remove 找不到节点/边/层/组/泳道；hint 提示"要新建用 declare"）；**已存在的 id 再 declare、以及不变式违反 → `REFUSED`**。两者都是退出码 1，但**语义必须分开**：东西不在就是不在，不是"被拒"。
5. `laneOrder` 按**应用本片段之后**的泳道集合判定（不是整批之后）。
6. 必填字段给 `null` → REFUSED；**空串允许**（只拒控制字符/超长）。看板投影里 **evidence trim 后为空 = "无证据"**。
7. rank **不要求层间唯一**（只要求 0..99 整数）；同 rank 两层之间不能建边（严格向下），无环性不受影响。
8. 控制字符：**放行 tab/换行，拒绝 CR** —— CR 会让同一逻辑内容在 Windows/Linux 算出不同 sha256，制造 expectedRevision 假冲突。
9. 规范化序列化：层按 (rank,id)、组/节点按 id、边按 (from,to) 排序；**泳道保持声明顺序**；groups/lanes 为空则不写键，layers/nodes/edges 恒写。手改缩进/键序 → revision 不变。
10. `listPages` 遇坏页**整体失败并指名文件**（不静默少报）；"地图错误不许拖挂看板"由 bridge 负责兜住。

## 5. 看板投影（bridge，唯一投影规则）

状态 → 状态列字形（`semantics/vocabulary.ts`，**唯一一份**）：

| 地图 status | 看板字形 | 明细列补充 |
|---|---|---|
| `todo` | `⬜ 待办` | — |
| `doing` | `🔄 进行中` | evidence 有则附 |
| `blocked` | `⛔ 阻塞` | — |
| `done` | `✅ 完成`；**无 evidence** 时附「无证据」 | — |
| `regressed` | `⛔ 回归` | 「已做过又坏了」 |
| `done` + 任一 source 哈希不符 | `⛔ 待复验` | 「⚠ 源码已变：<文件名>」 |

- 模块列固定 `auto:map`；**投影不改地图里的 status**（账本不是法官，打回只发生在展示层）。
- 行序：① `context.next`（若在）→ ② 节点按 (doing, blocked, regressed, todo, done) 再按 id 稳定排序；上限 `maxRows`（默认 12，可配 `map.rows_max`），超出时最后一行写「…还有 N 项」。
- **progress.md 合成**：`syncKanbanAuto` 在一次读-改-写里删除所有 `模块列 ∈ {auto:map, auto:todos}` 的行，再按 **人写行 → auto:map → auto:todos** 插入；与 ZCode 待办同内容去重时 **map 优先**。人写行逐字不动。
- **board.mmd**：有地图时，节点按层带分 subgraph（rank 高的画在上方），边直接取 `edges`（真边）；人写行照旧进 HUMAN 区；`auto:todos` 行进 AUTO 区。只重写"我们自己生成的图"（文件头含 `%% generated by srelay kanban graph`）。
- 任何地图错误都**不许影响看板/捕获**：返回空 rows + note，守护路径 try/catch 兜住。

## 6. 生命周期（全自动，零新增调用点）

`capture/sync.ts` 已经在每轮 sync 末尾调用 `syncKanbanAuto(root, cfg)`；地图投影**并入该函数内部**，因此：不新增调用点、不新增进程、不新增网络。
开销预算：无变化时 <20ms（哈希缓存 `.sessionrelay/map/.hash-cache.json` = path → {mtimeMs,size,sha256}；单文件 >8MiB 记 `unknown`；项目外路径 `unknown`）。

## 7. 测试与门禁

单测（vitest，真夹具，仿 `test/fork/kanban-auto.spec.ts`）：
- `test/fork/map-domain.spec.ts`：7 条不变式逐条反例（同层边、环、重 id、未知字段、控制字符、越界 rank、状态非法）
- `test/fork/map-store.spec.ts`：严格解析、原子保存（temp 清理/重试）、并发 BUSY、`expectedRevision` CONFLICT、拒绝时文件字节不变
- `test/fork/map-cli.spec.ts`：CLI 契约与退出码
- `test/fork/map-stale.spec.ts`：changed/unknown/缓存/8MiB 边界
- `test/fork/kanban-map.spec.ts`：e2e —— 人写行逐字保留、auto:map 正确、跑两次「无变化」、真实边出现

门禁：`npm run typecheck` → `npx vitest run test/fork/map-*.spec.ts test/fork/kanban-map.spec.ts` → `npm test` → `node scripts/check-artifacts.mjs`；部署：`npm run build` → `node tools/_mirror_dist.mjs --dry` → 真镜像 → `node tools/check-versions.mjs` → **重启守护** → `srelay doctor`。

## 8. 写区（并行施工，互不重叠）

| 任务 | 写区 |
|---|---|
| T1 内核 | `src/map/domain/**`、`src/map/store/**`、`src/map/semantics/**`、`src/map/patch.ts`、`src/map/index.ts`、`test/fork/map-{domain,store}.spec.ts` |
| T2 CLI | `src/cli/map.ts`、`test/fork/map-cli.spec.ts` |
| T3 桥接/失效 | `src/map/bridge.ts`、`src/map/stale.ts`、`test/fork/map-stale.spec.ts`、`test/fork/kanban-map.spec.ts` |
| T4 文档 | `docs/design/design-map-layer.md`（本文，Lead 冻结后只读）、`docs/map-cli.md`、`skills/map/SKILL.md`、`src/map/NOTICE-mellos.md` |
| Lead | `src/bin/srelay.ts`、`src/cli/kanban.ts`、`src/cli/doctor.ts`、构建/镜像/验收 |

**红线**：不得改别人的写区；不得跑 `npm run build`（会 rm -rf dist，Lead 串行执行）；不得动 `D:/mellos-mapping` 仓库；不得引入新依赖；不得让看板/守护路径抛异常。

## 9. 明确不做

MCP server / MCP 工具注册 / mellos 的终端面板与 web viewer / preview / omp·pi 扩展 / 新运行时依赖 / 改动 SessionRelay 现有采集·检索·经验·未决链路。
