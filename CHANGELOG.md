# Changelog

所有显著变更将记录在此文件中。
格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [0.5.1] - 2026-09-18

### 修复
- **测试套件污染真实注册表**：dist 冒烟测试以生产环境子进程跑真实 `srelay init`，而 init 的登记（0.5.0 新增）会把项目根写进全局注册表——实测三次全量测试留下三条 Temp 垃圾条目。修复：测试子进程统一以 `SRELAY_REGISTRY_DIR` 重定向到临时目录（读侧剪枝本就会剔除已消失路径，现在从源头不写）
- serve 根解析诊断补一行：deferred 模式下把 roots 回报数/有效数落到 stderr（本机验证 roots 链路时发现排障缺现场）

## [0.5.0] - 2026-09-18

### 新增
- **serve 根解析信号链（design-serve-resolve，0.5.0）**：环境变量 → cwd 向上探测 → **MCP roots 协议**（自动问客户端"工作区在哪"；仅当客户端声明 roots 能力才发请求，避免超时挂起）→ **全局项目注册表**（`~/.sessionrelay-registry/projects.json`，恰好一个存活守护时自动选中）。新信号只插在原有"找不到项目即退出"的失败路径上——现有 env / cwd 行为零改动（回归用例钉死）
- **解析失败不再 exit(1)**：MCP 连接照常建立、16 工具照常列出，工具调用返回 `unresolved_project` 指导载荷（各信号下场 tried + 候选项目列表 + howTo）。红线不变：候选多个时绝不静默猜项目（串库比连不上更糟），AI 带 `project` 参数选一次、本连接记住、可随时切换
- 全部 16 个工具新增可选 `project` 参数（项目根绝对路径），用于未解析 / 多项目场景的显式选择与连接内切换
- 全局项目注册表：`srelay init` 登记、守护每 10 分钟心跳、serve 任何成功解析也登记（目录名刻意避开 `~/.sessionrelay`——findRelayRoot 向上探测的就是该名字，语义目录 `~/.sessionrelay-semantic` 同款规避）；测试用 `SRELAY_REGISTRY_DIR` 重定向
- `srelay doctor` 新增"项目注册表"检查项：预先回答"无配置时 serve 会自动选中谁"

### 修复
- **Qoder 连 MCP 报 `MCP_STDIO_PROCESS_EXITED_BEFORE_READY · exit 1`**（用户实报，Qoder 侧 AI 交叉诊断、我方源码核实）：根因是 Qoder 启动 MCP 子进程不把 cwd 设为项目根，serve 找不到 `.sessionrelay` 起手退出且 GUI 客户端不透传 stderr。现按上述信号链 + deferred 模式根治；README（中/英）与 user-guide 接入文档同步
- `SRELAY_PROJECT_ROOT` 指向打不开的库：从未捕获异常堆栈改为干净 stderr 报错 + exit 1（退出时机与非零码不变）
- R3 测试抓出并修复：客户端真实能力在 MCP initialize 握手完成后才可查，connect 返回后立即读恒为 undefined——生产上 roots 会永远被判"不支持"

### 测试
- 新增 serve 根解析回归 9 例（R1/R2 钉死 env/cwd 旧行为、R3 roots 自动选中、R4 注册表单存活自动选中、R5 多候选指导+选择+记住+切换、R6 零候选指导、R7 注册表损坏降级、R1b 坏库干净报错、R9 显式切换），含"仓库根自带 .sessionrelay（dogfood）导致仓库内 cwd 全部误命中"的环境预检；全量 222 例

## [0.4.5] - 2026-09-13

### 修复
- **assistant 消息整批丢失（用户实报，另一 AI 交叉诊断确认）**：ZCode 先写 message 行、正文 part 流式后到；守护同步恰逢窗口期读到"无正文"行时跳过该行、游标却照常越过——正文落库后永久失扫。实测某会话 2167 条 assistant 全部丢失（user 完好：user 消息原子写入不踩竞态）。修复：宽限期（10 分钟）内游标停在空正文行之前，下轮重扫追回（seq_num 唯一键幂等）；过宽限的空行不拖死游标
- **历史缺口自愈**：schema v5 迁移自动清空 zcode 源游标，升级后首次 sync 全量重扫，丢失的 assistant 消息自动补回（已捕获的不重复）；claude-code 源不受影响（JSONL 行内原子写入无此竞态）

### 测试
- 新增竞态回归 4 例（R1 跳过不越界/追回、R2 幂等、R3 宽限防停滞、R4 全周期）+ v5 迁移 1 例，破坏性验证通过（回退修复 R1 即红）

## [0.4.4] - 2026-09-07

### 修复
- **npm 页面 License 显示 "Proprietary"**：package.json 缺 license 字段（npm 缺省行为），而 LICENSE 文件实为 MIT——显式声明，npm 页面现已正确显示

### 文档
- README（中/英）头部新增 shields.io 徽章行：CI 实时状态 / npm 版本 / 月下载量（实时）+ Node ≥22 / MCP 16 工具 / 三平台 / 语义检索可选 / MIT

## [0.4.3] - 2026-09-07

### 修复（内存评估驱动）
- **watch --status / doctor 不再全量读日志**：此前 readFileSync 整文件进堆再取尾部，大日志=内存尖峰；现 readLogTail 只 seek 读尾部（实测 5MB 日志堆增量 0.01MB）
- **轮转周期化**：此前仅守护启动时轮转，开机到关机不重启则持续堆积（实测本机增速约 60KB/小时 ≈ 1.4MB/天）；现守护内每小时检查一次，文件稳定在 1.1MB 峰值→截断保留尾部 100KB

## [0.4.2] - 2026-09-07

### 新增
- **守护日志落盘与可诊断性**（0.4.1 静默启动的补全——用户反馈："下次报错我可能都看不到了"）：
  - 三平台服务化运行输出统一落 `.sessionrelay/watch.log`（cmd 重定向 / launchd StandardOut-ErrorPath / systemd append）
  - 日志自轮转：超 1MB 启动时截断保留尾部 100KB，不自转就会慢慢吃盘
  - `srelay watch --status` 直接展示日志尾部；`srelay doctor` 在"服务已注册但守护未运行 + 日志含错误"时提示疑似异常退出
- 原则落定：静默启动换来的不是"没有信号"，而是"信号换了个地方"——平时零打扰，出错必有处可查

## [0.4.1] - 2026-09-07

### 修复
- **Windows 开机守护脚本失效（用户实报）**：服务注册此前把带 hash 的 chunk 文件名写死进启动脚本，srelay 升级重建 dist 后旧 chunk 消失，开机即报 `Cannot find module`。现解析稳定入口 `dist/srelay.js`，并在安装时预检入口存在性
- **开机闪黑框**：注册表 Run 键现指向 wscript 静默启动器（.vbs 隐藏窗口运行）——登录不再弹出 cmd 窗口
- **Windows 用户需重装一次服务**：`srelay watch --uninstall && srelay watch --install-service`

## [0.4.0] - 2026-09-06

### 新增
- **相关会话推荐 `suggest_related_sessions`（MCP 第 16 个工具）+ `srelay related <id>`**：搜索是你带着词去找，推荐是库主动告诉你"这几个和手头这个是一伙的"——记不清关键词时以会话为锚找线索
  - 双轨：语义向量相似（semantic 已启用时，active 锚即时嵌入不入库）+ 话题/标签/文件重叠打分（未启用语义时的降级），融合输出且每条带**可解释理由**（`向量相似 0.72` / `共享话题：数据库`）
  - 完全无状态：无新表无新配置；推荐不写入 session_links（防 A→B→A 回音室固化）
  - 导航辅助定位：不过 scope 契约（条目仅 brief 元数据）；输出明示"内容以 get_session_detail 为准"
  - 真模型验收 4/4（top1 合理性）；小语料下 bge 短文本 cos 挤在 0.6-0.7 的 tail 噪音如实登记于设计文档 §9
- **MCP 契约不变量升级**："恒 15 工具"（现为 16）的真正意图是删除类工具永远为 0——契约测试新增**名称黑名单扫描**（工具名含 delete/remove/forget/purge 即 fail），比计数更强且不随工具数增长失效
- **守护服务注册覆盖三平台**：`srelay watch --install-service` 此前仅 Windows（注册表 Run 键），现新增 macOS（launchd LaunchAgent）与 Linux（systemd user unit，附带 linger 尝试）——三平台同为"登录自启动"，卸载/状态对称（`--uninstall` / `--status`）
  - CI 验证策略：macOS runner 真装真卸（已注册→卸载→文件移除断言），Linux 因 runner 用户 systemd 不可靠只做内容断言，欢迎实机反馈
  - 行为对齐：不做崩溃自动重启（KeepAlive/Restart 关闭）——守护自带 30s 周期与懒启动兜底
- **产物断言脚本（`npm run check:artifacts`，已挂 CI 与 prepublishOnly）**：MCP 工具名在文档全覆盖、无旧工具计数残留、CHANGELOG 顶部版本与 package.json 一致——固化发版审核两轮事故（文档静默漏改 / 包体积膨胀）的防线

### 变更
- 服务注册实现收敛到 `cli/service.ts`（Windows 原逻辑不变），`watch.ts` 只保留守护入口

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
