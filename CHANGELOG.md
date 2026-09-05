# Changelog

所有显著变更将记录在此文件中。
格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [0.3.1] - 2026-09-05

### 修复
- **npm 包体积事故（发版审核抓出）**：`dist/` 中累积了历次构建的孤儿 chunk（tsup 只清理它认识的文件，模块改名后旧 hash 文件静默残留），0.3.0 及更早版本的包携带了最多 94 个死代码文件。`build` 脚本现先清空 `dist/` 再构建——0.3.1 包 142 → 46 文件（99.5KB）。功能无影响（孤儿文件无人引用），但请从 0.3.1 起使用

## [0.3.0] - 2026-09-05

### 新增
- **语义检索（可选，`srelay semantic`）**：换一种说法也能命中——"登录"↔"认证"、"很卡"↔"性能"这类换词查询不再落空
  - 实测依据：12 个真实感技术会话语料上，同义查询 miss 率 33% → **0%**（12/12），字面命中不劣化（5/5）
  - 本地 CPU 推理（bge-small-zh-v1.5，Q8 约 35MB），零云端依赖；依赖与模型装在用户缓存目录 `~/.sessionrelay-semantic`，npm 包体积不变
  - `srelay semantic enable` 一条命令：自动装依赖（国内走 npmmirror）+ 模型就绪（`HF_ENDPOINT=https://hf-mirror.com`）+ 存量回填；`disable` / `status` / `test "查询"` 对比 FTS 与融合效果
  - **融合原则：字面优先、语义补充**——FTS 命中永不被替换，语义命中以 `viaSemantic` 标注追加在后（top-5 限量 + 余弦阈值 0.4 可调）
  - 检索性能：5000 会话级全量余弦 2.6ms/查询（暴力扫描，无 ANN 依赖）；嵌入约 20ms/条，守护每周期限量补嵌不抢 CPU
  - 未启用时行为与 0.2.5 完全一致（可选参数注入，MCP 恒 15 工具）；schema v3→v4 自动迁移（`session_vectors` 表，启用前恒空）
- 生命周期联动：resume 回滚/归档时删向量（正文变了语义即过期），forget 的 CASCADE 自动清向量，换模型自动全量重嵌
- `srelay doctor` 新增语义检查项；`srelay status` 面板新增语义状态行

### 修复
- digest 正文拼接改为 SQLite 端限量截断（前 30 条 × 200 字）——大会话不再全量拼接
- 嵌入失败的目标自动跳过并计数（防毒丸阻塞队列），进程重启后自动重试；enable 回填循环加双轮零产出退出保护

## [0.2.5] - 2026-09-03

### 新增
- **遗忘权 `srelay forget`**：删除权交还给人——整条会话（含决策）从本库彻底消失，AI/MCP 保持零删除能力（工具恒 15 个）
  - 两阶段确认：无 `--yes` 仅预览（年龄/移除/保留/双向链接对方/imported 警示），`--yes` 单事务执行
  - **双防复活闸**：`.sessionrelayignore` 新增 `session:<source>/<sid>` 精确规则（主防线，跨 rebuild 存活）+ 墓碑表（次级防线）——原始文件还在磁盘，但本库永不重新收录
  - 前缀歧义防护：多命中时列出候选表格拒绝执行，绝不静默猜一个
  - 乐观锁：预览到执行之间数据变化（如守护新捕消息）→ 重统计 diff 拒绝执行
  - `--all` 整库重置：守护运行中拒绝 + `--confirm <projectId>` 逐字确认 + `forgot-at-<ts>.txt` 库外摘要
  - `--history` / `--history --verbose`：遗忘审计永久可查
- schema v3：`forget_tombstones` / `forget_log` / `forget_detail`（旧库打开自动迁移，降级打开明确报错）

### 变更
- `save_note` 返回话术补充"可由用户以 srelay forget 移除"；`archive --hard` 帮助引导 forget（防复活缺口明示）
- README 新增「遗忘权」小节（含 archive 与 forget 选型口诀）
- `srelay save` 命中遗忘闸时给出非静默提示（曾被 forget 的会话不会被静默吞掉）

### 测试
- 新增 `test/forget/` 43 用例（按三轮迭代的测试用例集 v3）：功能/检索不命中/误用防护/并发乐观锁/整库重置，以及**防复活对抗**——用真实源文件（JSONL 字节游标 + SQLite rowid 游标双源型）验证删后增量 sync、rebuild、手动 save 三条路径均不复活

## [0.2.4] - 2026-09-01

### 测试
- 新增发布产物冒烟套件：直接测试 `dist/srelay.js`（用户实际运行的文件），覆盖 `--version`/`init`/MCP 握手，断言版本与 `package.json` 一致（运行时无变更）
- 新增 `npm run e2e:pack`：npm pack → 全新目录真实安装 → bin → init/status → MCP 握手的端到端验证
- CI 三平台（ubuntu/windows/macos）挂载 pack-e2e，并修正 test/build 顺序使产物冒烟真正生效

## [0.2.3] - 2026-08-31

### 修复
- MCP 握手 `serverInfo.version` 与 `srelay --version` 改为读取 `package.json`（此前硬编码 `0.1.0` / `0.2.0`，与实际版本脱节，误导排障）
- `srelay doctor` 的 Node 版本检查从 ≥18 对齐为 ≥22（与 engines 声明一致；better-sqlite3 / jieba 预编译按新 ABI 分发，旧版 Node 会以难排查的方式失败）

## [0.2.2] - 2026-08-31

### 文档
- README 新增 4 张架构/流程图：架构总览（全景）、记忆生命周期（状态机）、HOP 交接时序图、守护进程对比（timeline）
- README 修正过时信息：五源适配现状、125 测试数、路线图清理（移除已完成项）
- 文档区精简为用户视角 5 条；设计决策文档入口移至 CONTRIBUTING
- 过程性内部资料（阶段报告 P0-P3.5、第三方存储格式逆向笔记）移出公开仓库（本地保留）

## [0.2.1] - 2026-08-30

### 变更
- npm 包精简：813 → 39 文件（1.3MB → 79KB），移除内部文档与 sourcemap

## [0.2.0] - 2026-08-29

### 新增
- **归档机制**（`srelay archive`）：按时间/体积归档旧会话，保留决策骨架释放 99.4% 空间；硬删除模式；归档审计日志（`--history --verbose`）
- **MCP 写域 7 工具**（总计 15 工具）：`annotate_session` / `save_note` / `export_handoff` / `import_handoff` / `release_quarantine` / `link_sessions` / `get_linked_sessions`
- **关键往返提取**：confirmed 时自动提取"用户提问+AI 结论对"（`include_exchanges`），归档后推导过程的中间粒度
- **五源适配**：新增 Codex + Qoder + Trae（部分）适配器，加上原有 Claude Code / ZCode 共五源
- **适配器注册表**：统一 `SessionSourceAdapter` 接口 + `.sessionrelay/adapters/*.js` custom 通道，加新 agent 零改核心
- **init 源选择**：检测已安装 AI 工具，交互勾选或 `--sources` 参数指定
- **守护懒启动**：任何 CLI 命令或 MCP serve 发现守护不在 → 自动后台拉起
- **`watch --install-service`**：Windows 注册表 Run 键（无需管理员）
- **MCP 上下文安全护栏**：get_session_detail 默认 20 条 × 1000 字 + 50KB 硬顶 + estimated_tokens + 省 token 路径引导
- **`srelay doctor` 扩展至 14 项检查**（含五源可达性/归档表/custom 适配器）
- **comaction 摘要捕获**：ZCode 压缩时 AI 生成的摘要存为 system 消息（不丢推导过程）
- **`srelay export --format markdown|summary`**：HANDOFF.md 直出

### 修复
- full 模式和 save_note 维护 message_count
- HOP 导入归化（project_id 重写，原值存 origin_project）
- ignore 谓词按排除语义编译（NOT OR）
- sessions_fts 补 INSERT/DELETE 触发器（meta 模式检索修复）
- rebuild 后状态从事实推导（超冷却期直接 confirm）
- 守护三项泄漏（合并去抖/连接缓存/重复 watcher）

### 变更
- **自动捕获与手动 save 并存**（D2）：mode off 时 save 是唯一入口
- **Scope 交集语义**（D5）：只能互相收窄，`set_scope({mode:'full'})` 逃生口
- **出处块 100% 强制**（D10）：所有检索结果携带来源标注
- **命名统一**：SessionGraph → 会话接力 / SessionRelay（D1）
- 包名改为 `@ewanjasper/sessionrelay`
- 移除 `purge` 命令（归档替代）

## [0.1.0] - 2026-08-28

### 新增
- 首个公开发布：MVP Phase 0-3.5 全量交付
- 双源适配（Claude Code JSONL + ZCode SQLite）
- 中文检索（jieba + FTS5，C1-C6 验收用例）
- MCP Server 8 个只读工具（stdio，契约测试真握手）
- Scope 检索边界（A/B/C 三档 + 交集语义）
- HOP 交接包协议（hop/1.0，sha256 完整性 + 默认脱敏 + 隔离导入）
- 三档隐私模式 + .sessionrelayignore 硬边界
- 两阶段会话结束判定（active → pending → confirmed）+ resume 自动回滚
