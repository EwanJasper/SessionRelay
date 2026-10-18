# MIT 归属声明 · mellos-mapping

`src/map/`（SessionRelay 地图层）的结构纪律与数据模型**派生自 mellos-mapping**，上游以 MIT 许可发布。
按 MIT 条款，其**版权声明与许可原文**随本模块保留如下；再分发本模块或其派生部分时，必须一并保留这段声明与许可文本。

| 项 | 值 |
|---|---|
| 上游项目 | mellos-mapping |
| 派生所用版本 | **v0.28.0** |
| 作者 | **GuangminJu** |
| 仓库 | <https://github.com/GuangminJu/mellos-mapping> |
| 许可 | MIT |
| 上游技能原文 | `skills/mellos-mapping/SKILL.md`（v0.28.0） |
| 上游许可原文 | 仓库根 `LICENSE` |

## 版权声明（上游原文，逐字保留）

> Copyright (c) 2026 Mellos

## 许可原文（上游 `LICENSE` 全文，逐字保留）

```text
MIT License

Copyright (c) 2026 Mellos

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 派生范围（本模块取了什么）

- **数据模型**：层（layer，带 rank，rank 0 最底层）／分组（group）／泳道（lane）／节点（node）／边（edge）／页（page）。
- **不变式纪律**：id 唯一、节点必须属于已存在的层、边只能严格向下（`rank(from) > rank(to)`，同层边拒绝 ⇒ 图天生无环）、状态闭合词表、未知字段一律拒绝。
- **操作语义**：declare（只声明缺失结构）／update（局部改，`null` 清可选字段）／remove；`expectedRevision` 乐观并发，不符即 CONFLICT。
- **可信度模型**：`done` 必须有 evidence；`sources[].sha256` 只在**实测验证后**记录；源码变了就把 `done` 打回 `待复验`。
- **context 接力棒**：`context.summary` / `context.next` 是写给下一个会话的入口。
- **工作纪律**：`skills/map/SKILL.md` 由上游技能原文（v0.28.0，`skills/mellos-mapping/SKILL.md`）**本土化**而来——保留纪律，替换掉 MCP 与面板部分。

## 未派生（明确不做，见 `docs/design/design-map-layer.md` §9）

MCP server 与 MCP 工具注册；mellos 的终端分屏面板、桌面 Markdown 面板与交互式 web viewer；preview 导出管线；omp / pi 扩展；N-API 原生依赖；任何新的运行时依赖或常驻进程。

## 本地实现与上游的差异（同名不同物的地方）

- **接口形态**：上游是八个 MCP 工具（`mmap_declare` / `mmap_update` / `mmap_remove` / `mmap_view` / `mmap_setup` / `mmap_open` / `mmap_read` / `mmap_batch`）；本模块是 **`srelay map` CLI + 库**，不注册任何 MCP 工具。
- **存储位置**：上游 `.mellos/map.json`；本模块 `<root>/.sessionrelay/map/<page>.json`。
- **锁**：上游用 N-API 原生锁；本模块用 `openSync(wx)` 单文件独占锁 + 僵尸兜底（不引入原生依赖）。
- **展示面**：上游靠面板/查看器；本模块靠**守护既有 sync 路径**把地图投影进看板 `progress.md`（`auto:map` 行）与 `board.mmd`（真边 + 层带 subgraph）。
- **文档种类**：上游的 `architecture`/`dataflow`/`behavior-tree`/`sequence` 渲染种类**未移植**，本模块以 `dev`（活的进度账本）为准。

## 本仓库的许可

SessionRelay 本体同以 **MIT** 发布（见仓库根 `LICENSE`）。派生文件继续受 MIT 约束；上游作者 GuangminJu 与 mellos-mapping 项目名仅用于**署名与出处说明**，不表示上游对本模块的背书。
