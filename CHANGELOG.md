# Changelog

所有显著变更将记录在此文件中。
格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本遵循 [SemVer](https://semver.org/lang/zh-CN/)。

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
