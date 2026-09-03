#!/usr/bin/env node
// srelay 入口（技术方案 T15：懒加载保启动预算）
import { Command } from 'commander';
import pkg from '../../package.json' with { type: 'json' };
const VERSION: string = pkg.version;

const program = new Command();
program
  .name('srelay')
  .description('会话接力 SessionRelay — 属于项目、不属于任何厂商的本地记忆层')
  .version(VERSION);

program
  .command('init')
  .description('初始化项目并回填最近 30 天会话（啊哈机制）')
  .option('--backfill <window>', '30d | 90d | none', '30d')
  .option('--sources <ids>', '逗号分隔：claude-code,zcode,codex,qoder（缺省=交互选择或全选已安装的）')
  .option('--yes', '跳过交互试搜')
  .option('--install-service', '初始化后注册守护服务')
  .action(async (opts) => { const { cmdInit } = await import('../cli/init.js'); await cmdInit(opts); });

program
  .command('sync')
  .description('一次性增量捕获 + 判定')
  .option('--backfill <window>', 'Nd | all')
  .option('--json')
  .action(async (opts) => { const { cmdSync } = await import('../cli/sync.js'); await cmdSync(opts); });

program
  .command('watch')
  .description('守护捕获（前台运行；--install-service 注册系统服务）')
  .option('--foreground', '前台运行（服务调用路径）')
  .option('--install-service', '注册守护服务（Windows 计划任务）')
  .option('--uninstall', '卸载守护服务')
  .option('--status', '查看守护与服务状态')
  .action(async (opts) => { const { cmdWatch } = await import('../cli/watch.js'); await cmdWatch(opts); });

program
  .command('save [id]')
  .description('手动存储会话（与自动捕获并存；off 模式下的唯一入口）')
  .option('--recent <window>', '如 7d')
  .option('--interactive', '交互勾选')
  .option('--tag <tags>', '逗号分隔标签')
  .option('--summary <text>', '手动摘要（用户权威层）')
  .option('--source <s>')
  .option('--json')
  .action(async (id: string | undefined, f) => { const { cmdSave } = await import('../cli/save.js'); await cmdSave({ ...f, id }); });

program
  .command('rebuild')
  .description('从源文件全量重建索引（imported 保留，旧库存为 .bak）')
  .option('--force', '跳过确认/越过守护检查')
  .action(async (f) => { const { cmdRebuild } = await import('../cli/maint.js'); await cmdRebuild(f); });

program
  .command('forget [id]')
  .description('彻底遗忘：整条会话（含决策）从本库消失，永不复活（空间老化用 archive，彻底消失用 forget）')
  .option('--session <id>', '限定捕获会话（防误删笔记）')
  .option('--note <id>', '限定笔记')
  .option('--all', '整库重置（需 --confirm <projectId>，守护运行中拒绝）')
  .option('--confirm <projectId>', '--all 的逐字确认（本项目 id）')
  .option('--yes', '执行（无 --yes 仅预览）')
  .option('--history', '查看遗忘审计')
  .option('--verbose', '审计展开明细')
  .option('--json', '机器格式')
  .action(async (id: string | undefined, f) => { const { cmdForget } = await import('../cli/forget.js'); await cmdForget(f, id); });

program
  .command('status')
  .description('透明度面板：模式/守护/计数/拦截/体积')
  .option('--json')
  .action(async (f) => { const { cmdStatus } = await import('../cli/status.js'); await cmdStatus(f); });

program
  .command('mode <full|meta|off>')
  .description('切换捕获模式')
  .action(async (mode) => { const { cmdMode } = await import('../cli/misc.js'); await cmdMode(mode); });

program
  .command('search <query...>')
  .description('中文全文搜索（组合过滤）')
  .option('--topic <t>')
  .option('--tag <t>')
  .option('--source <s>')
  .option('--since <date>')
  .option('--until <date>')
  .option('--limit <n>', '默认 10')
  .option('--json', '机器格式')
  .action(async (q: string[], flags) => {
    const { cmdSearch } = await import('../cli/query.js');
    await cmdSearch(q.join(' '), { ...flags, limit: flags.limit ? Number(flags.limit) : undefined });
  });

program
  .command('show <sessionIdPrefix>')
  .description('查看会话详情（消息片段）')
  .option('--range <a:b>', '消息序号范围')
  .option('--json')
  .action(async (id, opts) => { const { cmdShow } = await import('../cli/query.js'); await cmdShow(id, opts); });

program
  .command('list')
  .description('列出会话')
  .option('--source <s>')
  .option('--state <st>')
  .option('--limit <n>', '默认 20')
  .option('--json')
  .action(async (opts) => {
    const { cmdList } = await import('../cli/query.js');
    await cmdList({ ...opts, limit: opts.limit ? Number(opts.limit) : undefined });
  });

program
  .command('stats')
  .description('本地匿名计数器')
  .option('--report', '生成自愿提交的匿名报告')
  .option('--reset', '清零')
  .option('--json')
  .action(async (opts) => { const { cmdStats } = await import('../cli/misc.js'); await cmdStats(opts); });

program
  .command('doctor')
  .description('环境自检与修复建议')
  .action(async () => { const { cmdDoctor } = await import('../cli/doctor.js'); await cmdDoctor(); });

program
  .command('serve')
  .description('启动 MCP Server（stdio，供 AI agent 调用）')
  .action(async () => { const { runServe } = await import('../mcp/server.js'); await runServe(); });

program
  .command('scope')
  .description('检索范围契约（B 档，CLI 与 MCP 共用）')
  .option('--set', '整体设置')
  .option('--add', '合并添加')
  .option('--reset', '重置为全库')
  .option('--show', '查看当前契约与变更日志', true)
  .option('--topic <t>', '逗号分隔')
  .option('--tag <t>')
  .option('--file <f>')
  .option('--source <s>')
  .option('--since <date>')
  .option('--until <date>')
  .option('--sessions <ids>', '会话 ID 前缀列表（attach 语义）')
  .option('--full', '逃生口：解除 A/B/C 裁剪（ignore 不受影响）')
  .option('--pick', 'TUI 勾选候选会话（C 档 fallback）')
  .action(async (f) => {
    const scope = await import('../cli/scope.js');
    if (f.set) return scope.cmdScopeSet(f);
    if (f.add) return scope.cmdScopeAdd(f);
    if (f.reset) return scope.cmdScopeReset();
    if (f.pick) return (await import('../cli/maint.js')).cmdScopePick();
    return scope.cmdScopeShow();
  });

program
  .command('attach <ids...>')
  .description('挂载指定会话（本次检索只看这些历史讨论）')
  .action(async (ids: string[]) => { const { cmdAttach } = await import('../cli/scope.js'); await cmdAttach(ids); });

program
  .command('detach')
  .description('解除挂载')
  .action(async () => { const { cmdDetach } = await import('../cli/scope.js'); await cmdDetach(); });

program
  .command('export')
  .description('导出 HOP 交接包（默认尊重当前 scope；含 HANDOFF.md 与脱敏）')
  .option('--output <file>', '输出路径')
  .option('--format <fmt>', 'hop（默认）| markdown | summary')
  .option('--all', '忽略 scope，导出全库')
  .option('--topic <t>')
  .option('--tag <t>')
  .option('--source <s>')
  .option('--since <date>')
  .option('--until <date>')
  .option('--exclude-tag <t>', '排除含此标签的会话')
  .option('--decisions-only', '只含决策与元数据，不含正文')
  .option('--no-redact', '关闭默认脱敏（不建议）')
  .action(async (f) => { const { cmdExport } = await import('../cli/relay.js'); await cmdExport(f); });

program
  .command('import <pkg>')
  .description('导入 HOP 交接包（sha256 校验 + 归化到当前项目）')
  .option('--from <name>', '标记来源人')
  .option('--quarantine', '隔离导入：只入元数据与摘要，正文待放行')
  .option('--release <idPrefix>', '放行隔离会话')
  .action(async (pkg: string, f) => { const { cmdImport } = await import('../cli/relay.js'); await cmdImport(pkg, f); });

program
  .command('team <status|log>')
  .description('团队：贡献者统计 / 导出导入日志')
  .action(async (sub: string) => { const { cmdTeam } = await import('../cli/relay.js'); await cmdTeam(sub); });

program
  .command('decisions')
  .description('列出所有已确认决策（含出处）')
  .option('--topic <t>')
  .option('--source <s>')
  .option('--limit <n>', '默认 20')
  .option('--json')
  .action(async (opts) => {
    const { cmdDecisions } = await import('../cli/meta.js');
    await cmdDecisions({ ...opts, limit: opts.limit ? Number(opts.limit) : undefined });
  });

program
  .command('unresolved')
  .description('列出未解决问题（启发式）')
  .option('--limit <n>', '默认 20')
  .option('--json')
  .action(async (opts) => {
    const { cmdUnresolved } = await import('../cli/meta.js');
    await cmdUnresolved({ limit: opts.limit ? Number(opts.limit) : undefined });
  });

program
  .command('history <filePath>')
  .description('某文件被哪些会话讨论过')
  .option('--json')
  .action(async (f: string, o) => { const { cmdHistory } = await import('../cli/meta.js'); await cmdHistory(f, o); });

program
  .command('hook <event>')
  .description('（内部）Agent 生命周期钩子入口：写 spool 事件')
  .option('--id <sessionId>', '源会话 ID')
  .action(async (event: string, opts: { id?: string }) => {
    if (!opts.id) { process.exit(2); }
    const { findRelayRoot } = await import('../shared/paths.js');
    const { writeHookEvent } = await import('../capture/hook-spool.js');
    const root = findRelayRoot(process.cwd());
    if (!root) process.exit(1);
    writeHookEvent(root, event, opts.id);
  });

program
  .command('confirm <sessionIdPrefix>')
  .description('手动强制会话为 confirmed（触发提取与摘要）')
  .action(async (id) => { const { cmdConfirm } = await import('../cli/misc.js'); await cmdConfirm(id); });

program
  .command('archive')
  .description('归档旧会话（保留决策骨架，释放正文空间）或查看归档历史')
  .option('--days <n>', '归档 N 天前的会话')
  .option('--before <date>', '归档指定日期前的')
  .option('--size <n>mb', 'DB 超过此值时归档')
  .option('--source <s>', '只归档此来源')
  .option('--sessions <ids>', '归档指定会话（逗号分隔）')
  .option('--hard', '硬删除（含决策，不可恢复）。注意：--hard 无防复活闸，源文件可能被 sync 重新收录；若需永不回来，用 srelay forget')
  .option('--dry-run', '只预览不执行')
  .option('--history', '查看归档历史')
  .option('--verbose', '历史详细模式')
  .option('--session <id>', '查看指定会话的归档记录')
  .option('--include-protected', '跳过保护规则')
  .option('--json')
  .action(async (f) => { const { cmdArchive } = await import('../cli/archive.js'); await cmdArchive(f); });

program.parseAsync(process.argv);
