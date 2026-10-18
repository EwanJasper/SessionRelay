# srelay map · 地图层使用手册

> 面向**使用者与 agent**。命令面以 `docs/design/design-map-layer.md` §4 / §4.1（**冻结契约**）为准；本文是它的操作手册，**不发明任何命令、任何字段**。两边若有出入，**以契约为准**。
>
> 一句话：地图是一张**活的、分层的依赖图**（层／分组／泳道／节点／边 ＋ 证据 ＋ `context` 接力棒），存成项目里一个 JSON 文件，由守护自动投影进看板 `progress.md` 与 `board.mmd`。
>
> **地图是账本，不是法官**：工具只拒绝**结构损坏**（层带 rank、边只能严格向下所以天生无环、id 唯一、状态闭合词表、未知字段拒绝）；*什么时候声明、什么时候开工、什么时候算完成*，是纪律——见 `skills/map/SKILL.md`。

---

## 0. 一分钟：落在哪、谁在看

| 项 | 值 |
|---|---|
| 地图文件 | `<root>/.sessionrelay/map/<page>.json`（默认页 `map.json`；目录可用 `map.dir` 配置） |
| 页 id 语法 | `^[a-z0-9][a-z0-9-]{0,63}$` |
| revision | 规范化内容的 sha256（每次成功写入都是新 revision） |
| 谁投影 | 守护的**既有** sync 路径（`capture/sync.ts` → `syncKanbanAuto`）：不新增进程、不新增调用点、不新增网络 |
| 投到哪 | `progress.md` 的 `auto:map` 行 ＋ `board.mmd` 的层带 subgraph 与**真边** |
| 怎么让改动被看见 | **写进地图就够了**：下一轮 sync 自动进看板。本仓库没有「打开面板」这一步 |
| 开销预算 | 无变化时 < 20ms（哈希缓存 `.sessionrelay/map/.hash-cache.json`） |

---

## 1. 五步上手（可直接抄）

```bash
# ① 开工：这项目有地图吗？有就恢复，没有才建
srelay map read --resource pages

# ② 建一张空地图（已存在 → CONFLICT，绝不覆盖）
srelay map init --title "看板适配改造"

# ③ 声明设计（幽灵图：全部 todo，代码还不存在）
srelay map apply --file declare.json

# ④ 施工中点亮 + 写证据
srelay map update --file doing.json

# ⑤ 源码对账 → 出图 / 存档快照
srelay map check --page map
srelay map export --mmd --out board.map.mmd
srelay map export --json --to docs/map-snapshot.json
```

---

## 2. 命令总览（契约 §4 原文）

| 命令 | 说明 |
|---|---|
| `map init [--title <t>] [--json]` | 建空地图；已存在 → CONFLICT（绝不覆盖）。省略 `--title` 时取**项目根目录名** |
| `map read [--page p] [--resource pages\|map\|nodes\|edges\|layers\|changes] [--id <id>] [--status <s>] [--limit n] [--cursor c] [--fields a,b] [--json]` | 只读；默认人类可读，`--json` 输出结构化 |
| `map apply --file <patch.json\|-> [--json]` | **主写入口**（1–100 条操作，一次落盘） |
| `map declare --file <json\|->` / `map update …` / `map remove …` | 单操作糖（内部走 apply） |
| `map check [--page p] [--json]` | sources 对账：changed／unchanged／unknown ＋ 受影响消费者 |
| `map export [--mmd\|--md\|--d2] [--out <path>] [--to <仓库内路径>]` | 出图 / 快照 |
| `map import --from progress.md [--page p]` | 现有看板行 → 单层地图初稿（一次性迁移入口；已存在地图则拒绝） |

`--file -` / `--from -` 表示**从 stdin 读**，例：`cat patch.json | srelay map apply --file -`。

---

## 3. 动词详解

### 3.1 `map init`

建一张空地图（有 `version`、`title`，层／组／泳道／节点／边都是空数组）。

```bash
srelay map init --title "看板适配改造"          # 人类可读
srelay map init --title "地图层" --json         # {"ok":true,"value":{"path":"…"}}
```

- **已存在 → CONFLICT**（退出码 1）。绝不覆盖：想重建就先想清楚是不是真想覆盖一张有人在读的图。
- 省略 `--title` → 默认标题 = **项目根目录名**（库接口 `initMap(root,title)` 的 title 仍必填，由 CLI 兜默认）。
- 命名页：`--page <p>` 可以在别处指定页；页 id 必须符合 `^[a-z0-9][a-z0-9-]{0,63}$`。
- **不 `init` 也能建页**：目标页文件不存在时，`map apply` **只靠一条 `declare` 就能建页**，`title` 缺省 = **页 id**（默认页即 `"map"`）。`init` 的价值是**显式**且"已存在就拒"；新开一张命名页时直接 declare 也可以（配 `expectedRevision: "absent"` 就是"要求文件必须不存在"）。

### 3.2 `map read`（唯一只读面）

```bash
srelay map read                                   # 默认页全貌（人类可读）
srelay map read --resource pages                  # 有哪些页：id/标题/revision/节点数/边数
srelay map read --resource map --json             # 当前页完整结构（层/组/泳道/节点/边/context）
srelay map read --resource nodes                  # 节点列表
srelay map read --resource nodes --status doing   # 只看现在真正在跑的
srelay map read --resource nodes --id map-store   # 单节点（按 id，不按 label）
srelay map read --resource edges                  # 边列表（from → to，表示 from 使用 to）
srelay map read --resource layers                 # 层带（rank 0 = 最底层）
srelay map read --resource changes                # sources 对账视图（与 map check 同源）
srelay map read --resource nodes --limit 20 --cursor "<上次返回的 cursor>"
srelay map read --resource nodes --fields id,label,status
```

| 选项 | 作用 |
|---|---|
| `--page p` | 指定页（不填 = 默认页） |
| `--resource` | `pages` ／ `map` ／ `nodes` ／ `edges` ／ `layers` ／ `changes` |
| `--id` | 按 **id** 取单个对象（label 是显示名，会改；id 是边的锚） |
| `--status` | 状态过滤：`todo`／`doing`／`blocked`／`done`／`regressed` |
| `--limit` | 每页条数：**默认 30，上限 100**（长图别一次全读） |
| `--cursor` | **不透明游标**（内含 offset ＋ 发号时的 revision）：接着上次往下读 |
| `--fields a,b` | 字段裁剪（省 token 用）：**只作用于 list 类 resource**（`nodes`／`edges`／`layers`／`pages`） |
| `--json` | 结构化输出：成功 `{"ok":true,"value":…}`，失败 `{"ok":false,"error":{…}}` |

**开场第一件事就是它**：`read --resource pages` 决定"这是新图还是续作"，**别靠"探默认文件在不在"**——所有工作都在命名页上时，默认页可能压根不存在。

**分页与投影（契约 §4.2）**：

- `--limit`：**默认 30、上限 100**。
- `--cursor` 是**不透明游标**（内含 offset ＋ **发号时的 revision**）——**原样回传**，别自己拼一个数字。
  - 两次读之间**图变了 → `CONFLICT`**（提示你重新从头读：游标背后的图已经不是同一张了）；
  - 游标**格式非法 → `INVALID_ARGUMENT`**。
- `--fields a,b` **只作用于 list 类 resource**（`nodes`／`edges`／`layers`／`pages`）；**identity 与边的两端字段永远保留**——裁掉它们，读回来的东西就没法引用了。

### 3.3 `map apply`（主写入口）

一次读—改—写：1–100 条操作在**草稿**上顺序执行 → 校验**最终图** → 一次落盘；**拒绝时文件字节不变**。

```bash
srelay map apply --file patch.json
srelay map apply --file - < patch.json
cat patch.json | srelay map apply --file - --json
```

顶层形状：

```json
{
  "page": "map",
  "expectedRevision": "3f9c…或 'absent'（可省略）",
  "operations": [
    { "op": "declare", "data": { /* 页面片段 */ } },
    { "op": "update",  "data": { /* 页面片段 */ } },
    { "op": "remove",  "data": { /* 身份选择器 */ } }
  ]
}
```

- `page` 省略 = 默认页。
- `expectedRevision`：省略 = **只串行化、不校验**（适合不在意并发的批量写入）；`'absent'` = 文件必须**不存在**；给字符串 = 必须等于当前 revision，否则 CONFLICT。**多人／多会话并行写时给上它。**
- `operations` 的 **1..100** 条上限。

### 3.4 `declare` / `update` / `remove`（单操作糖）

单操作场景的省事写法，内部走 apply。`--file` 传的是**一条操作的 `data` 片段本身**（= `operations[0].data` 的内容）：

```bash
srelay map declare --file declare.json     # 新建（已存在 id → REFUSED）
srelay map update --file doing.json       # 改字段
srelay map remove  --file drop.json        # 删对象
srelay map declare --file - < node.json
```

`drop.json`（只给身份选择器）：

```json
{ "edges": [{ "from": "map-cli", "to": "map-store" }], "nodes": [{ "id": "map-cli" }] }
```

需要**一次原子提交多步改动**（例：点亮节点 + 挂源码指纹 + 刷 `context.next`）时，用 `apply` 而不是连续跑三次糖。

### 3.5 `map check`（源码对账）

对每个节点声明的 `sources[].sha256` 与盘上文件比对，**顺带给出受影响的消费者**（谁用了这个节点）：

```bash
srelay map check
srelay map check --page map --json
```

报告形状（`ChangesReport`）：

```json
{
  "page": "map",
  "nodes": [
    { "id": "map-store", "label": "地图存储", "state": "changed",
      "changed": ["src/map/store/apply.ts"], "unknown": [],
      "consumers": ["map-cli"] }
  ]
}
```

| state | 意思 |
|---|---|
| `unchanged` | 声明的源码指纹与盘上一致 |
| `changed` | 源码变了 → 看板会把这个 `done` 节点显示成 **⛔ 待复验** |
| `unknown` | 算不出来：文件缺失、单文件 > 8MiB、**项目外路径** |

### 3.6 `map export`（出图 / 快照）

```bash
srelay map export --mmd                 # Mermaid 文本（默认 stdout）
srelay map export --mmd --out board.map.mmd
srelay map export --md                  # Markdown 文本
srelay map export --d2                  # D2 文本（例：d2 --theme 200 in.d2 out.svg）
srelay map export --json --to docs/map-snapshot.json   # 地图 JSON 快照（供提交进仓库）
```

- `--mmd|--md|--d2` 出图/文本，配 `--out <path>` 落文件，否则 stdout。
- `--json --to <仓库内相对路径>` 写的是**地图 JSON 快照**（可提交、可 review、可 `import` 回来）。
- **`--to` 必须与 `--json` 同用**，否则 `INVALID_ARGUMENT`——`--to` 只服务于"把 JSON 快照写进仓库"这一件事。
- 只读，不改地图。

### 3.7 `map import`（迁移 / 恢复）

```bash
srelay map import --from progress.md               # 看板行 → 单层初稿（一次性迁移入口）
srelay map import --from progress.md --page plan    # 落到命名页
srelay map import --from docs/map-snapshot.json     # 从快照恢复
```

`--from progress.md` 生成的初稿形状（契约冻结）：

- 单层：`{ "id": "plan", "name": "计划（自 progress.md 导入）", "rank": 0 }`；
- 每行 → 节点 `{ "id": "n<行序>", "label": <行名原文>, "layer": "plan", "status": <映射>, "detail": <明细列> }`；
- 状态映射：`✅→done`、`🔄→doing`、`⛔→blocked`、`⬜→todo`；
- **不生成任何边**（依赖列是人话，不猜）。

`--from <file.json>` 从快照恢复。**目标页已存在 → REFUSED**：import 绝不覆盖。

---

## 4. patch JSON 完全指南（契约 §4.1）

每条操作的 `data` 就是**一个页面片段**，允许的键只有这九个：
`title` ／ `kind` ／ `context` ／ `layers` ／ `groups` ／ `lanes` ／ `nodes` ／ `edges` ／ `laneOrder`。
**多一个键就 REFUSED**（未知字段一律拒绝，绝不静默丢弃——写回会毁掉手改过的文件）。

### 4.1 `declare`：只声明缺的东西

```json
{
  "op": "declare",
  "data": {
    "title": "看板适配改造",
    "layers": [
      { "id": "base",  "name": "基础类型", "rank": 0 },
      { "id": "core",  "name": "地图内核", "rank": 1 },
      { "id": "iface", "name": "接口面",   "rank": 2 }
    ],
    "groups": [{ "id": "store", "label": "存储", "layer": "core" }],
    "lanes": [{ "id": "agent", "label": "agent" }],
    "nodes": [
      { "id": "map-types", "label": "类型与不变式", "layer": "base",  "status": "todo",
        "detail": "7 条不变式 + id/rank/status 校验（纯函数，零 IO）" },
      { "id": "map-store", "label": "地图存储", "layer": "core", "status": "todo",
        "group": "store", "lane": "agent",
        "detail": "严格解析 + temp→rename 原子保存 + 单文件独占锁" },
      { "id": "map-cli", "label": "srelay map CLI", "layer": "iface", "status": "todo",
        "detail": "九个动作；退出码 0/1/2；stderr 一行错误码" }
    ],
    "edges": [
      { "from": "map-store", "to": "map-types", "label": "uses" },
      { "from": "map-cli",   "to": "map-store", "label": "uses" }
    ],
    "context": { "summary": "地图层施工", "next": "先做 map-types 的不变式校验" }
  }
}
```

要诀：

- **已存在的 id 一律拒绝**（REFUSED，**不幂等、不跳过**）——发布前先核对盘上的图，**只声明缺失的结构**。
- 同批可以**先声明边、后声明端点**：校验只认**最终图**。
- 节点**不写 `status` 就默认 `todo`**：整张幽灵设计就是一份可以被否决的"打算做成什么样"。
- `rank`：`0..99` 整数，**0 = 最底层**。

### 4.2 `update`：按 id 改字段

```json
{
  "op": "update",
  "data": {
    "nodes": [
      { "id": "map-store", "status": "done",
        "evidence": "npx vitest run test/fork/map-store.spec.ts → 14 passed",
        "sources": [
          { "path": "src/map/store/apply.ts",
            "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" }
        ] },
      { "id": "map-cli", "status": "doing", "detail": "九个动作；退出码 0/1/2；stderr 一行错误码" }
    ],
    "edges": [{ "from": "map-cli", "to": "map-store", "label": "calls" }],
    "context": { "summary": "地图层施工：内核已验", "next": "接着做 map-cli 的退出码" }
  }
}
```

要诀：

- **边的身份 = `from+to`**，没有独立 edge id。边补丁可带 `{from,to,label?,newFrom?,newTo?}`——`newFrom/newTo` 用来**改端点**（等于"挪一条边"）。
- 清空**可选**字段写 **`null`**：边的 `label`；节点的 `detail`／`evidence`／`group`／`lane`／`sources`；页的 `kind`／`context`。**必填字段给 `null` 会被拒**（`title`、`name`、`layer`、`status`、节点的 `label`/`layer`、组/泳道的 `label`、边的 `from`/`to`）。
- 空字符串**本身合法**（契约只拒控制字符与超长）——但"清空"一律用 `null`，别写空串，语义才清楚。
- `context` 与 `sources` 是**整体替换**（不是逐项合并）：想保留已有的 sources 就把它们一起写全，写 `null` 就是清空。
- 泳道顺序用 `laneOrder`：它必须是**"应用本片段之后"**页面上**全部泳道 id 各一次**——缺一个、重复、或出现不存在的泳道 id → REFUSED。所以它得和"声明这些泳道"的片段写在一起。
- 节点换 `layer` 时，注意它所属的 `group` 得和它**在同一层**（否则 REFUSED）。

### 4.3 `remove`：只给身份选择器

```json
{
  "op": "remove",
  "data": {
    "edges": [{ "from": "map-cli", "to": "map-store" }],
    "nodes": [{ "id": "map-cli" }]
  }
}
```

五类身份选择器都在这儿：`nodes:[{id}]` ／ `groups:[{id}]` ／ `lanes:[{id}]` ／ `layers:[{id}]` ／ `edges:[{from,to}]`。

选择器**必须是对象**（`{"id":"map-cli"}` ／ `{"from":"a","to":"b"}`）：写裸字符串或塞多余键 → REFUSED；**选择器找不到目标也 → REFUSED**。

**删层／删组／删泳道都不会静默搬走成员**：层里还有节点、组里还有成员、泳道里还住着节点 → REFUSED。上面那份示例里 `iface` 层还住着 `map-cli`、`store` 组里还住着 `map-store`，所以删它们之前都得先搬空。

**删节点会级联删掉它的边**：同一批里就**别**再写那条边的选择器了——那时它已经不存在，会吃到"找不到目标"的 REFUSED。

### 4.4 一份完整的 patch（多操作、带乐观并发）

```json
{
  "page": "map",
  "expectedRevision": "b7d1c0…",
  "operations": [
    { "op": "update", "data": { "nodes": [{ "id": "map-cli", "status": "doing" }] } },
    { "op": "declare", "data": {
        "nodes": [{ "id": "map-vocab", "label": "状态词表", "layer": "base",
                    "status": "todo", "detail": "状态→看板字形的唯一一份映射" }]
    } },
    { "op": "update", "data": {
        "nodes": [{ "id": "map-vocab", "status": "done", "evidence": "vitest: 6 passed" }],
        "edges": [{ "from": "map-store", "to": "map-vocab", "label": "uses" }]
    } },
    { "op": "update", "data": {
        "context": { "summary": "地图层：内核 + 词表已验",
                     "next": "做 srelay map CLI（退出码 0/1/2）" } } }
  ]
}
```

```bash
srelay map apply --file patch.json
# CONFLICT → srelay map read --json 取新 revision，改回这份 patch 再重试
```

### 4.5 会被拒的东西（一次说清）

| 拒绝项 | 判据 |
|---|---|
| 同层边 | 边 `from → to` 要求 `rank(layer(from)) > rank(layer(to))` **严格大于** ⇒ 图天生无环 |
| id 重复 | 节点与分组**共用**一个命名空间 |
| 悬空引用 | 节点必须属于已存在的层；`group/lane` 引用的对象必须存在；组的成员必须和组同层 |
| 状态词 | 只认 `todo \| doing \| blocked \| done \| regressed` |
| rank | 只能是 `0..99` 的整数 |
| 文本 | 拒绝控制字符；`label ≤ 120`，`detail/evidence ≤ 2000`，`summary/next ≤ 2000` |
| 未知字段 | 一律拒绝（含 `data` 里任何不在九键白名单里的键） |
| declare 已存在 | 已存在的 id 一律拒（**不幂等、不跳过**） |
| 必填字段给 null | `title/name/layer/status/from/to/label` 这类必填项给 `null` |
| remove 目标不存在 | 选择器找不到对象（含"同一批里删了两遍"） |
| remove 有成员 | 删层／组／**泳道**时里面还有东西（不静默搬移） |
| laneOrder 不合法 | 缺项／重复／含未知泳道 id |
| 信封不合法 | `op` 不是三选一、操作数不在 1..100、page id 违反语法 → **INVALID_ARGUMENT**（不是 REFUSED） |

---

## 5. 地图文件长什么样（契约 §2）

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

**⚠ 这是只读参考，不是让你手改的模板。** 文件是严格解析的，**所有写入走 `srelay map`**：

- 严格读：类型不对、未知字段一律拒绝（写回会毁掉手改过的文件）；
- 每次写都过 `expectedRevision`，手改会让所有人在下一次写时吃 CONFLICT；
- 原子保存与单文件锁是并发安全的边界，**绕过它 = 制造别人看不见的丢写**。

---

## 6. 状态词表与看板投影对照（契约 §5，唯一一份映射）

| 地图 `status` | 看板状态列字形 | 明细列补充 |
|---|---|---|
| `todo` | `⬜ 待办` | — |
| `doing` | `🔄 进行中` | evidence 有则附 |
| `blocked` | `⛔ 阻塞` | — |
| `done` | `✅ 完成`；**无 evidence** 时附「无证据」 | — |
| `regressed` | `⛔ 回归` | 「已做过又坏了」 |
| `done` ＋ 任一 source 哈希不符 | `⛔ 待复验` | 「⚠ 源码已变：<文件名>」 |

投影规则（记住四条就够用）：

1. **模块列固定 `auto:map`**；**投影不改地图里的 status**——打回只发生在展示层。
2. **行序**：① `context.next`（若在）排最上面 → ② 节点按 `(doing, blocked, regressed, todo, done)` 再按 id 稳定排序；上限 `maxRows`（默认 12，可配 `map.rows_max`），超出时最后一行写「…还有 N 项」。
3. **`progress.md` 合成**：一次读-改-写里删掉所有模块列 ∈ `{auto:map, auto:todos}` 的行，再按 **人写行 → auto:map → auto:todos** 插回；与 ZCode 待办同内容去重时 **map 优先**。**人写行逐字不动。**
4. **`board.mmd`**：有地图时节点按层带分 subgraph（rank 高的画在上方），边**直接取 `edges`（真边）**；只重写文件头带 `%% generated by srelay kanban graph` 的图，人写的图不碰。

**推论（很重要）**：想让下一场会话一眼看见什么，**就写进地图的 `context.next` 与节点状态**，而不是去手改 `progress.md`。

---

## 7. 错误码与退出码（契约 §4 / §4.1）

**退出码**：`0` 成功 ｜ `1` = {`NOT_FOUND, INVALID_ARGUMENT, REFUSED, CONFLICT, INVALID_STORE`}（**不是重试能解决的**）｜ `2` = {`BUSY, LOCK_UNAVAILABLE, SAVE_FAILED`}（**可重试，值得重跑**）。

| 错误码 | 退出码 | 什么时候出现 | 怎么办 |
|---|---|---|---|
| `NOT_FOUND` | 1 | 页不存在；`--page` 指了没建过的页 | `map read --resource pages` 看有哪些页；或 `map init` |
| `INVALID_ARGUMENT` | 1 | CLI 用法不对（缺 `--file`、resource 名不认识、limit 非数字…）；**patch 信封不成形**（`op` 不是三选一、操作数不在 1..100、page id 违反语法）；**游标格式非法**；**`--to` 没配 `--json`** | 看 `--help` 与本文 §2／§3。**REFUSED = 图的结构不对；INVALID_ARGUMENT = 请求本身就不成形** |
| `INVALID_STORE` | 1 | 地图文件读不进来（JSON 坏、`version` 不认识） | **别手改**；有快照就 `map import --from <file.json>` |
| `REFUSED` | 1 | 结构被拒：见 §4.5 清单 | 按 message/hint 改 patch；先 `map read` 对一遍盘上的图 |
| `CONFLICT` | 1 | `expectedRevision` 不符（别人先写了）；init/import 目标已存在；**游标过期**（两次读之间图变了 → 从头重读） | `map read` 取最新 revision，把改动改写到新版本上重试 |
| `BUSY` | 2 | 另一个写者持锁 | **等一会儿重跑**（守护或别的会话正在写） |
| `LOCK_UNAVAILABLE` | 2 | 锁文件建不起来（权限／僵尸锁／只读盘） | 可重试；仍失败查目录权限 |
| `SAVE_FAILED` | 2 | 落盘失败（rename 撞车、磁盘满） | 可重试；**文件字节不变**，重试不会写坏 |

输出格式：

- **stderr 一行**：`错误码：说明（建议动作）`。
- `--json` 失败：`{"ok":false,"error":{"code":"REFUSED","message":"…","hint":"…"}}`；成功：`{"ok":true,"value":…}`。

**给脚本的判据**：`0` 继续；`2` 退避重试；`1` 停下改输入（重跑没用）。
**地图从不拖挂看板**：任何地图错误都不会影响看板与捕获——桥接层返回空行 + note，守护路径 try/catch 兜住。

---

## 8. 典型工作流

### 8.1 开工：先读地图，再动手（★ 最重要的一条）

```bash
srelay map read --resource pages        # 有哪些页（新努力 vs 续作）
srelay map read --resource map --json   # 结构全貌
srelay map read --resource nodes --status doing   # 现在在跑什么
```

新会话、压缩之后，**都不是新努力**：先恢复匹配的那张页，用返回的 **id**（不是 label）。真没有地图、而这活又够格（多模块／分层／约一小时以上）才 `init`。

### 8.2 只声明缺失的结构

把"打算做成什么样"一次性声明出来：层带（rank 0 最底）、节点、边，全部 `todo`。**已经存在的 id 不要再声明一次**——重复声明会被拒，也把"新设计"和"旧事实"搅在一起。

```bash
srelay map apply --file declare.json
```

### 8.3 自底向上点亮 + 写证据

```bash
# 动手前先切 doing
srelay map update --file - <<'JSON'
{ "nodes": [{ "id": "map-types", "status": "doing" }] }
JSON

# 验证真过了，才切 done，并把"过的是什么"写进 evidence
srelay map update --file - <<'JSON'
{ "nodes": [{
  "id": "map-types", "status": "done",
  "evidence": "npx vitest run test/fork/map-domain.spec.ts → 21 passed",
  "sources": [{ "path": "src/map/domain/types.ts", "sha256": "<实测值>" }]
}] }
JSON
```

- **没证据就没有 `done`**（看板会给无证据的 done 挂上「无证据」）。
- `sources[].sha256` **只在实测验证后**记录；后面用 `map check` 对账。
- 同层互不依赖的兄弟节点**一起 `doing` 是如实报告**，不是违纪。
- 后续工作弄坏了某个 done：**先**切 `regressed`（坏在哪写进 `evidence`），**再**修；然后逐个走所有直接/传递使用它的节点，默认一并 `regressed`，想保持绿必须给出理由。

### 8.4 保持 `context.next` 最新（接力棒）

```bash
srelay map update --file - <<'JSON'
{ "context": { "summary": "地图层：内核 + CLI 已验，桥接在做",
               "next": "跑 npx vitest run test/fork/kanban-map.spec.ts 验证真边" } }
JSON
```

`context.next` 会**排在看板第一行**；它过期 = 下一个会话读到的第一步是错的。每完成一个里程碑刷一次。

### 8.5 收尾：对账 → 存档 →（可选）清理

```bash
srelay map check --page map                       # 源码指纹还对得上吗
srelay map export --mmd --out board.map.mmd        # 出图进仓库
srelay map export --json --to docs/map-snapshot.json   # 快照存档
srelay map read --resource pages                   # 哪张页已经完工
srelay map remove --file - <<'JSON'
{ "nodes": [{ "id": "n7" }] }                      # 清掉空壳节点/临时边
JSON
```

**没有"删页"动词**（与"绝不覆盖人写内容"同一条纪律）：**页的建立**由 `apply` 的 `declare` 完成，**页的删除是用户手动删文件**（`.sessionrelay/map/<page>.json`）——**工具不会替你删，我们也不替用户删**。收尾时你能做的是：用 `remove` 把临时节点／空壳边清干净、用 `export --json --to` 把快照存进仓库，然后把"这张页是否退场"**交给用户决定**；绝不动一张可能还有人正在读的页。

### 8.6 从老看板迁移（一次性）

```bash
srelay map import --from progress.md --page plan   # 现有看板行 → 单层初稿（无任何边）
srelay map read --page plan --resource nodes       # 检视
# 然后按真实分层补层带与边：declare 新层 + update 节点归属 + declare 真边
```

### 8.7 给 agent 的最小抄本

```text
开场     : srelay map read --resource pages         （有图就续作，别重建）
声明     : srelay map apply --file patch.json       （只声明缺的；新节点一律 todo）
开工     : update status=doing
完工     : update status=done + evidence=<实测结果> + sources.sha256=<实测值>
回归     : 先 update status=regressed（写清坏在哪），再修，再逐个复验
接力     : update context.summary/next              （next 会排到看板第一行）
对账     : srelay map check
红线     : 绝不手改 .sessionrelay/map/*.json；绝不改 progress.md 的人写行
出错     : 退出码 1 → 改输入；退出码 2 → 退避重试
```

---

## 9. 常见坑（FAQ）

**Q：我手改 JSON 不是更快吗？**
A：不是。严格读会拒未知字段与错类型；revision 一变，所有人的下一次写都吃 CONFLICT；原子保存与锁的意义正是防"看不见的丢写"。**所有写入走 `srelay map`。**

**Q：两个东西明明互相依赖，为什么画不出边？**
A：边只能**严格向下**（`rank(from) > rank(to)`，同层也拒）。互相依赖要么说明其中一个其实更低层，要么它们本就是**一个节点**。改结构，别硬连。

**Q：边能不能连着画两条反的？**
A：不能，同层/反向都拒——这正是**图天生无环**的来源。状态机不在能力范围内，如实说做不到。

**Q：每次写都要带 `expectedRevision` 吗？**
A：单人单会话可以省略（只串行化）。**多会话/守护可能同时在写时给上它**；吃 CONFLICT 就重读、改写、重试。

**Q：`map check` 说 `unknown` 是什么意思？**
A：算不出指纹：文件不在、单文件 > 8MiB、或**项目外路径**。这不是"坏了"，是"没依据"——别拿它当证据。

**Q：`done` 会不会自己变红？**
A：会，但**只在展示层**：源码变了 → 看板显示「⛔ 待复验」；**地图里的 status 不动**（账本不是法官）。要不要打回 `regressed` 由你判断。

**Q：地图坏了会把看板/守护搞崩吗？**
A：不会。桥接只读，任何错误都降级成"空行 + note"，守护路径 try/catch 兜住。

**Q：地图会拖慢 sync 吗？**
A：无变化时 < 20ms（哈希缓存）。缓存文件是 `.sessionrelay/map/.hash-cache.json`。

**Q：一个项目几张页？**
A：**一个努力 = 一张页**（`--page`）。真正独立的努力另开页，**别混页、别覆盖一张完工的图**。

**Q：我的 `progress.md` 手写行会被地图覆盖吗？**
A：不会。合成只删/插模块列为 `auto:map` 与 `auto:todos` 的行，**人写行逐字不动**。

---

## 10. 出处对照（要改文档先改契约）

| 本文内容 | 契约出处 |
|---|---|
| 命令与选项、`--json`／stderr 格式 | `docs/design/design-map-layer.md` §4 |
| patch 的 `data` 形状、import 初稿形状、export/import 语义、退出码、init 默认标题 | 同文 §4.1 |
| 文件布局与 7 条不变式 | 同文 §1／§2 |
| 状态词表与看板投影、行序、progress.md 合成、board.mmd | 同文 §5 |
| 自动投影的挂载点与开销预算 | 同文 §6 |
| 纪律（何时开地图、先恢复、证据才配 ✅、如实报告） | `skills/map/SKILL.md`（本土化自 mellos-mapping v0.28.0；归属见 `src/map/NOTICE-mellos.md`） |
