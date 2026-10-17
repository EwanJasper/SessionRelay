#!/usr/bin/env node
// srelay 入口（技术方案 T15：懒加载保启动预算）
import path from 'node:path';
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
  .option('--global', '全局守护：一个进程看管项目注册表里的全部项目（动态收编新项目）')
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
  .command('maintain')
  .description('维护（默认只读、默认不删文件）：FTS 空间回收 / 孤儿备份清理 / 守护断线核算')
  .option('--fts', '按阈值回收 FTS 索引垃圾（文件/内容 > 2 倍才动手）')
  .option('--force', '配 --fts：无视阈值强制回收')
  .option('--apply', '真正写入（默认强制干跑；没有 --apply 绝不写库、绝不删文件）')
  .option('--dry-run', '保险起见再声一次干跑（与默认行为相同）')
  .option('--reap', '列出孤儿备份/临时文件候选（默认只列不删）')
  .option('--reap-apply', '旧别名（等价于 --reap --apply；保留兼容）')
  .option('--age-days <n>', '配 --reap：超过多少天才清（默认 30 天）', '30')
  .option('--guard', '核算 guard.log 里 instances=0 的持续时长 + 补采判定')
  .option('--alarm-min <n>', '配 --guard：超过多少分钟算断线（默认 5）', '5')
  .option('--append', '配 --guard：把断线结论追加进各项目 guard.log')
  .option('--json', '机器格式')
  .action(async (opts) => {
    const { pc } = await import('../cli/ui.js');
    const { registryCandidates } = await import('../shared/registry.js');
    const { dbFile } = await import('../shared/paths.js');
    let roots: string[] = [];
    try { roots = registryCandidates().map((c) => c.root); } catch { roots = []; }
    if (roots.length === 0) {
      try { const { requireRoot } = await import('../cli/ui.js'); roots = [requireRoot()]; }
      catch { console.error(pc.red('没有已登记项目，也没有可识别的项目根：先在项目里跑 srelay init')); process.exit(2); }
    }
    const out: Record<string, unknown> = { roots };
    const mb = (b: number) => (b / 1048576).toFixed(1) + ' MB';

    if (opts.fts) {
      const { maintainFts, measureFtsSpace, wasteRatio, shouldReclaim } = await import('../core/maintain/fts.js');
      const Database = (await import('better-sqlite3')).default;
      // [安全闸门] 没显式 --apply 一律当干跑：即使将来手滑，也不会再"以为在副本上、实际动了真库"。
      const applyFts = opts.apply === true && opts.dryRun !== true;
      const rows: unknown[] = [];
      for (const root of roots) {
        const f = dbFile(root);
        try {
          const db = new Database(f, !applyFts ? { readonly: true, fileMustExist: true } : { fileMustExist: true });
          try {
            db.pragma('busy_timeout = 5000');
            const st = measureFtsSpace(db as never, f);
            const withForce = { force: opts.force === true };
            if (!applyFts) {
              const would = shouldReclaim(st, withForce);
              rows.push({ root, beforeBytes: st.fileBytes, contentBytes: st.contentBytes, ratio: Number(wasteRatio(st).toFixed(2)), wouldReclaim: would });
              if (!opts.json) console.log((would ? pc.yellow('●') : pc.dim('○')) + ' ' + root + '  ' + mb(st.fileBytes) + '（内容 ' + mb(st.contentBytes) + '，' + wasteRatio(st).toFixed(2) + ' 倍）' + (would ? ' ⇒ 会回收（干跑；要真写库加 --apply）' : ' ⇒ 体积正常，不动'));
            } else {
              const r = maintainFts(db as never, f, withForce);
              rows.push({ root, beforeBytes: r.beforeBytes, afterBytes: r.afterBytes, reclaimed: r.reclaimed, rebuilt: r.rebuilt, skipped: r.skippedReason ?? null });
              if (!opts.json) {
                if (r.reclaimed > 0 || r.rebuilt) console.log(pc.green('✓') + ' ' + root + '  ' + mb(r.beforeBytes) + ' → ' + mb(r.afterBytes) + ' · 回收 ' + mb(r.reclaimed));
                else console.log(pc.dim('·') + ' ' + root + '  ' + mb(r.beforeBytes) + ' · 未回收：' + (r.skippedReason ?? '原因未知'));
              }
            }
          } finally { db.close(); }
        } catch (e) {
          rows.push({ root, error: String((e as Error).message) });
          if (!opts.json) console.log(pc.red('✗') + ' ' + root + '  失败：' + (e as Error).message);
        }
      }
      out.fts = rows;
    }

    if (opts.reap || opts.reapApply) {
      const { reapProjectTmpFiles } = await import('../core/maintain/reap.js');
      const minAgeDays = Number(opts.ageDays ?? 30);
      // 同一条闸门：只有 --apply（或旧别名 --reap-apply）才真删。
      const apply = (opts.apply === true || opts.reapApply === true) && opts.dryRun !== true;
      const rows: unknown[] = [];
      for (const root of roots) {
        const r = reapProjectTmpFiles(root, { enabled: apply, dryRun: !apply, minAgeDays });
        rows.push(r);
        if (opts.json) continue;
        const mark = r.deleted.length ? pc.green('✓') : r.candidates.length ? pc.yellow('●') : pc.dim('○');
        console.log(mark + ' ' + root + '  扫描 ' + r.scanned + ' 文件 · 候选 ' + r.candidates.length + ' · 已删 ' + r.deleted.length
          + ' · 主库 ' + (r.health.ok ? '健康（' + r.health.detail + '）' : '未过：' + r.health.detail));
        for (const c of r.candidates) {
          const done = r.deleted.some((d) => d.file === c.file);
          console.log('    ' + (done ? '已删 ' : '保留 ') + c.name + '  ' + mb(c.bytes) + ' · ' + c.ageDays + ' 天 · 规则 ' + c.rule);
        }
        if (!apply && r.candidates.length) console.log(pc.dim('    （默认不删：加 --apply 才真删；删前再验主库健康并写 reap.log）'));
        if (apply && r.journalFile) console.log(pc.dim('    审计日志：' + r.journalFile));
      }
      out.reap = rows;
    }

    if (opts.guard) {
      const { analyzeProjectGuard, formatGapAlert } = await import('../core/maintain/guard-log.js');
      const alarmMinutes = Number(opts.alarmMin ?? 5);
      const rows: unknown[] = [];
      for (const root of roots) {
        try {
          const rep = analyzeProjectGuard(root, { alarmMinutes, append: opts.append === true });
          rows.push({ root, file: rep.file, exists: rep.exists, gaps: rep.analysis.gaps.map((g) => ({ start: g.startMs, end: g.endMs, minutes: g.minutes, alarm: g.alarm })), appended: rep.appended.length });
          if (opts.json) continue;
          if (!rep.exists) { console.log(pc.dim('○') + ' ' + root + '  没有 guard.log'); continue; }
          if (rep.analysis.gaps.length === 0) { console.log(pc.green('✓') + ' ' + root + '  无 instances=0 断线记录'); continue; }
          for (const b of rep.backfill) console.log((b.gap.alarm ? pc.yellow('●') : pc.dim('·')) + ' ' + root + '  ' + formatGapAlert(b.gap, b.messages, Date.now()));
          if (rep.appended.length) console.log(pc.dim('    已追加进 guard.log：' + rep.appended.length + ' 行'));
        } catch (e) {
          rows.push({ root, error: String((e as Error).message) });
          if (!opts.json) console.log(pc.red('✗') + ' ' + root + '  断线核算失败：' + (e as Error).message);
        }
      }
      out.guard = rows;
    }

    if (!opts.fts && !opts.reap && !opts.reapApply && !opts.guard) {
      console.log(pc.yellow('未指定动作') + '：用 --fts / --reap / --guard 之一。例：srelay maintain --fts（干跑）/ srelay maintain --fts --apply（真写库）');
      process.exit(2);
    }
    if (opts.json) console.log(JSON.stringify(out, null, 2));
  });

program
  .command('forget [id]')
  .description('彻底遗忘：整条会话（含决策）从本库消失、永不复活。省空间用 archive，彻底消失才用它')
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
  .command('semantic')
  .description('语义检索（可选，实测无召回提升且检索慢一倍，默认关；纯字面匹配已够用）')
  .option('--enable', '启用：安装依赖（用户缓存目录）+ 模型就绪 + 存量回填')
  .option('--disable', '停用（向量数据保留，检索立即回退纯字面匹配）')
  .option('--status', '状态（默认）')
  .option('--test <query>', '对比模式：FTS-only vs 融合命中')
  .option('--backfill', '只补嵌存量会话（已启用时用；不改开关、不装依赖）')
  .option('--reembed', '把已有向量作废重算（换了嵌入口径后必须走它，否则旧向量会一直骗人）')
  .action(async (f) => { const { cmdSemantic } = await import('../cli/semantic.js'); await cmdSemantic(f); });

program
  .command('compress')
  .description('模型压缩：把旧决策合成上级条目。默认关、原文永不删、可审计可回滚')
  .option('--dry-run', '看它会合并什么（不调模型、不写库）')
  .option('--apply', '真跑：调模型 + 写审计（原文快照进 compress_detail）')
  .option('--write-back', '配 --apply：把合并结果写回数据（原文只加 compressed_into 标记，不删不改；简报跳过、检索照旧）')
  .option('--logs', '看历史合并记录')
  .option('--rollback <id>', '列出某次合并的回滚依据（不改库）')
  .option('--json', '机器格式')
  .action(async (f) => { const { cmdCompress } = await import('../cli/compress.js'); await cmdCompress(f); });

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
  .option('--global', '跨项目联邦检索（只读；默认只查本项目）')
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
  .option('--kind <k>', 'decision=只看拍板采用 / negative=只看被否掉的路（ADR-001）')
  .option('--limit <n>', '默认 20')
  .option('--json')
  .action(async (opts) => {
    const { cmdDecisions } = await import('../cli/meta.js');
    await cmdDecisions({ ...opts, limit: opts.limit ? Number(opts.limit) : undefined });
  });

program
  .command('brief')
  .description('开场简报一次取全：决策 + 未决 + 计数 + 最近在动的文件（客户端只付一次子进程；口径与 decisions/unresolved 两条老命令逐条一致）')
  .option('--limit <n>', '决策与未决各自最多取回多少条，默认 200')
  .option('--days <n>', '「最近在动」的窗口天数，默认 7')
  .option('--top <n>', '「最近在动」最多列几个文件，默认 3')
  .option('--json')
  .action(async (opts) => {
    const { cmdBrief } = await import('../cli/brief.js');
    await cmdBrief({
      limit: opts.limit ? Number(opts.limit) : undefined,
      days: opts.days ? Number(opts.days) : undefined,
      top: opts.top ? Number(opts.top) : undefined,
      json: opts.json,
    });
  });

program
  .command('bench-extract')
  .description('抽取快照与零标注 Diff 门禁：--save 存基线、--diff latest 看改规则后谁被剔除/谁被新增')
  .option('--root <dir>', '项目根（默认当前目录）')
  .option('--save <file>', '快照写到指定文件（默认 .sessionrelay/bench/<版本>-<时间>.json）')
  .option('--diff <file>', '与基线快照对比（latest = 最近一次快照）')
  .option('--limit <n>', '逐条列出上限，默认 40')
  .option('--json')
  .action(async (opts) => {
    const { cmdBenchExtract } = await import('../cli/bench.js');
    await cmdBenchExtract({ ...opts, limit: opts.limit ? Number(opts.limit) : undefined });
  });

program
  .command('lifecycle')
  .description('记忆生命周期（内核原生）：体检→自愈→采集→重算→经验→去重→清洗→老化→分发')
  .option('--status', '只看各阶段状态（不跑）')
  .option('--once', '只跑一轮（默认行为，写出来是为了可读）')
  .option('--loop <sec>', '常驻：每 N 秒一轮（0 = 只跑一轮）')
  .option('--only <ids>', '只跑这些阶段（逗号分隔：guard,repair,capture,extract,harvest,consolidate,compact,cleanup,tags,aging,distribute）')
  .option('--light', '只跑轻阶段（宿主内 worker 用，不阻塞 UI）')
  .option('--force', '无视各阶段节奏，强制全跑')
  .option('--json', '机器格式')
  .action(async (opts) => {
    const { runLifecycle, lifecycleStatus } = await import('../core/lifecycle/runner.js');
    const only = typeof opts.only === 'string' && opts.only
      ? String(opts.only).split(',').map((s: string) => s.trim()).filter(Boolean) as never[]
      : undefined;
    if (opts.status) {
      const st = lifecycleStatus();
      if (opts.json) { console.log(JSON.stringify(st, null, 2)); return; }
      console.log('生命周期状态：已跑 ' + st.rounds + ' 轮' + (st.lastAt ? ' · 最近 ' + st.lastAt : ''));
      for (const [id, s] of Object.entries(st.stages)) {
        const v = s as { ok: boolean; note: string; at: string } | undefined;
        if (!v) continue;
        console.log('  ' + (v.ok ? '✅' : '🔴') + ' ' + id + '：' + String(v.note).slice(0, 90) + '（' + v.at.slice(11, 19) + '）');
      }
      return;
    }
    const loop = opts.loop != null ? Math.max(0, Number(opts.loop)) : 0;
    const once = async () => {
      const r = await runLifecycle({ only, force: !!opts.force, lightOnly: !!opts.light, log: opts.json ? () => {} : (l: string) => console.log(l) });
      if (opts.json) console.log(JSON.stringify(r, null, 2));
      // 有阶段失败时用退出码表达（守护/CI 能抓到），但**不中断**下一轮
      return r.stages.some((s) => !s.ok && !s.skipped);
    };
    if (!loop) { if (await once()) process.exitCode = 1; return; }
    for (;;) {
      await once();
      await new Promise((r) => setTimeout(r, loop * 1000));
    }
  });

program
  .command('map')
  .description('地图层（.sessionrelay/map/*.json）：read=读图 | apply=原子改图（1..100 条操作，一次落盘）| declare/update/remove=单操作糖 | check=源码指纹对账 | export=出图/快照 | import=从 progress.md 或快照导入 | init=建空图')
  .argument('[action]', 'read（默认）', 'read')
  .option('--root <dir>', '项目根（默认当前目录）')
  .option('--page <slug>', '页 id（默认页 = map）')
  .option('--resource <kind>', 'pages | map | nodes | edges | layers | changes')
  .option('--id <id>', '按 id 精确查')
  .option('--ids <list>', '按多个 id 查（逗号分隔）')
  .option('--status <s>', 'todo | doing | blocked | done | regressed')
  .option('--limit <n>', '分页上限（默认 30，最大 100）')
  .option('--cursor <c>', '不透明游标（把上次返回的原样传回；图变了会 CONFLICT）')
  .option('--fields <list>', '只保留这些字段（identity 与边两端永远保留）')
  .option('--file <path>', 'patch / 片段的来源（- = stdin）')
  .option('--expected-revision <rev>', '期望的页 revision（不符 → CONFLICT；"absent" = 文件必须不存在）')
  .option('--title <t>', 'init 的标题（默认项目目录名）')
  .option('--from <path>', 'import 的来源：progress.md 或地图快照 .json')
  .option('--mmd', 'export：Mermaid 源码')
  .option('--md', 'export：Markdown')
  .option('--d2', 'export：D2 源码（装了 d2 二进制可一键导出 SVG/PNG）')
  .option('--out <path>', 'export：写到这个文件（默认 stdout）')
  .option('--to <path>', 'export：把 JSON 快照写进仓库内路径（必须配 --json）')
  .option('--fail-on-changed', 'check：发现源码漂移时退出码 1（默认只报告）')
  .option('--json', '机器格式')
  .action(async (action: string, opts) => {
    const { cmdMap } = await import('../cli/map.js');
    // 退出码由 cmdMap 自己落到 process.exitCode（0 / 1 改输入 / 2 可重试）；
    // 这里只把 commander 解析出的旗标原样透传——两边的拼写以 MapCliFlags 为准，
    // 抄一份旗标表就一定会漂移（本仓库的老毛病）。
    await cmdMap(action, opts as never);
  });

program
  .command('recompute')
  .description('手动触发提取规则重算（doctor 提示"或手动触发"时用这个；守护默认 6 小时才跑一批）')
  .option('--batch <n>', '每批会话数，默认 50')
  .option('--search-text', '同时按当前清洗规则刷新消息的 search_text（派生列，规则变了会陈旧）')
  .option('--apply', '真正写库（默认强制干跑；没有 --apply 一律不写）')
  .option('--dry-run', '保险起见再声一次干跑（与默认行为相同）')
  .option('--audit', '只读审计：列出提取版本高于当前版本的行（回滚/重算前评估用），不写库')
  .option('--json', '机器格式')
  .action(async (opts) => {
    const { requireRoot, openRelayDb, pc } = await import('../cli/ui.js');
    const { recomputeExtractions, EXTRACT_VERSION } = await import('../capture/recompute.js');
    const { searchTextOf } = await import('../store/db.js');
    // ⚠️ 必须调 loadConfig：分词器是进程级单例，只由 loadConfig 里的 applyTokenizer 设置。
    // 漏掉它（红队 1014 F3 实测），--search-text 会按模块默认的 jieba 重写整个索引，
    // 而同一项目的 search 按配置的 bigram 产查询词元——索引/查询词元不一致，
    // 正是 tokenizer.ts 开头自称"中文检索最大的隐性 bug 源"的那件事，静默发生。
    const { loadConfig } = await import('../shared/config.js');
    const root = requireRoot();
    loadConfig(root);
    // [1021 R2] --audit：只读打开（不跑 createDb 迁移，不写任何东西），
    //   列出 extracted_version > 当前版本的行 + 重置 SQL（只打印，由人执行）。
    if (opts.audit) {
      const { dbFile } = await import('../shared/paths.js');
      const Database = (await import('better-sqlite3')).default;
      const { auditAheadExtractVersions } = await import('../capture/recompute.js');
      const adb = new Database(dbFile(root), { readonly: true, fileMustExist: true });
      try {
        const a = auditAheadExtractVersions(adb as never);
        if (opts.json) { console.log(JSON.stringify(a, null, 2)); return; }
        console.log('当前提取规则版本 v' + a.currentVersion + '；超前版本 v' + a.aheadVersion);
        console.log('超前行：' + a.totalSessions + ' 场会话 · 涉及决策 ' + a.totalDecisions + ' 条');
        for (const p of a.byProject) console.log('  ' + p.projectId + '  ' + p.sessions + ' 场 / ' + p.decisions + ' 条决策');
        console.log(pc.yellow('重置语句（只打印，不执行；确认后手工跑）：'));
        console.log('  ' + a.resetSql);
        return;
      } finally { adb.close(); }
    }
    // [1021 R2] 与 maintain 同一纪律：**默认干跑**，只有显式 --apply 才写。
    const apply = opts.apply === true && opts.dryRun !== true;
    if (!apply) {
      const { dbFile } = await import('../shared/paths.js');
      const Database = (await import('better-sqlite3')).default;
      const { recomputeDryRun } = await import('../capture/recompute.js');
      const ddb = new Database(dbFile(root), { readonly: true, fileMustExist: true });
      try {
        const s = recomputeDryRun(ddb as never);
        if (opts.json) { console.log(JSON.stringify(s, null, 2)); return; }
        console.log(pc.yellow('干跑（默认；要真跑加 --apply）') + '：会重算 ' + s.sessions + ' 场会话；归档存量决策会删 ' + s.archived.wouldRemove + ' 条');
        for (const x of s.archived.samples.slice(0, 10)) console.log('  - [' + x.sessionId + '] ' + x.text);
        if (s.archived.skipped.length) console.log(pc.yellow('  隔离写入失败被跳过（未删、下轮重试）：' + s.archived.skipped.length + ' 场'));
        return;
      } finally { ddb.close(); }
    }
    const db = openRelayDb(root);
    try {
      const batch = opts.batch ? Math.max(1, Number(opts.batch)) : 50;
      // 一路跑到跟上版本：守护是 6 小时一批，576 会话的库要 72 小时——等不起。
      // recomputeExtractions 幂等，连续调用只是把同一个调用重复跑完。
      let total = 0, guard = 0, failed = 0;
      for (;;) {
        const r = recomputeExtractions(db, batch, { apply: true });
        total += r.recomputed;
        failed += r.failed;
        if (r.recomputed === 0 && r.remaining === 0) break;
        if (++guard > 2000) { console.error(pc.red('超过 2000 批，中止（应有异常）')); process.exitCode = 1; break; }
      }
      // [v17] 提取抛异常会被逐会话 catch 掉并打版本戳（避免每周期对同一个坏会话无限重试）——
      // 那意味着**系统性 bug 也会伪装成"重算成功"**：本轮实测一个漏传参数的 UPDATE 让全库 557 个
      // 会话"重算"完却什么都没变。所以这里必须把 failed 显式说出来，别让它在静默里过关。
      if (failed > 0) {
        console.error(pc.yellow(`⚠️  有 ${failed} 个会话提取抛异常（已打版本戳跳过，它们的派生列没更新）`));
      }
      // [fork 1014] search_text 是消息插入时写的派生列，recompute 本来不碰它——
      // 于是清洗规则改了（如 v8 剥无标签注入）之后， topics 干净了而索引照样脏。
      // 实测该盲区让 4361 条消息的样板文字占掉 D:\agent1super 全部 search_text 的 18.7%。
      let refreshed = 0;
      if (opts.searchText) {
        const rows = db.prepare('SELECT id, content FROM messages').all() as Array<{ id: number; content: string }>;
        const upd = db.prepare('UPDATE messages SET search_text = ? WHERE id = ?');
        db.exec('BEGIN');
        try {
          for (const m of rows) { upd.run(searchTextOf(String(m.content ?? '')), m.id); refreshed++; }
          db.exec('COMMIT');
        } catch (e) { db.exec('ROLLBACK'); throw e; }
        db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')");
      }
      if (opts.json) {
        console.log(JSON.stringify({ version: EXTRACT_VERSION, recomputed: total, searchTextRefreshed: refreshed }, null, 2));
        return;
      }
      if (total === 0 && refreshed === 0) {
        console.log(pc.dim(`已是最新提取规则 v${EXTRACT_VERSION}，无需重算${opts.searchText ? '（也未指定 --search-text）' : ''}`));
        return;
      }
      if (total > 0) console.log(`✅ 重算 ${total} 个会话到提取规则 v${EXTRACT_VERSION}`);
      if (refreshed > 0) console.log(`✅ 刷新 ${refreshed} 条消息的 search_text，FTS 索引已重建`);
    } finally {
      db.close();
    }
  });

// pin/unpin 共用的置顶入口（实现在 store/db.ts：LIKE 预筛 + JSON.parse 改 pinned 写回）
async function cmdPinDecision(fragment: string, pinned: boolean, opts: { json?: boolean }): Promise<void> {
  const { requireRoot, openRelayDb, pc } = await import('../cli/ui.js');
  const { loadConfig } = await import('../shared/config.js');
  const { setDecisionPinned } = await import('../store/db.js');
  const root = requireRoot();
  const db = openRelayDb(root);
  try {
    const cfg = loadConfig(root);
    const n = setDecisionPinned(db, cfg.identity.project_id ?? root, fragment, pinned);
    if (opts.json) { console.log(JSON.stringify({ action: pinned ? 'pin' : 'unpin', fragment, updated: n }, null, 2)); return; }
    if (n === 0) { console.log(pc.dim(`没有找到含「${fragment}」的决策`)); return; }
    console.log(pinned
      ? `📌 置顶了 ${n} 条决策（含「${fragment}」）——简报优先显示，即使它时间很老`
      : `取消置顶 ${n} 条决策（含「${fragment}」）`);
  } finally {
    db.close();
  }
}

program
  .command('kanban')
  .description('看板（progress.md）：init = 起草初稿（绝不覆盖）；sync = 只刷新自动区（ZCode 真待办）；graph = 一键出图（Mermaid 依赖图，--html 附可离线打开的页面）')
  .argument('[action]', 'init（默认）', 'init')
  .option('--root <dir>', '项目根（默认当前目录）')
  .option('--html', 'graph 时同时生成 architecture.html（可离线打开）')
  .option('--d2', 'graph 时额外产出 board.d2（装了 d2 二进制可一键导出 SVG/PNG）')
  .option('--out <file>', 'graph 的输出路径（默认 <项目>/.sessionrelay/board/board.mmd）')
  .option('--json', '机器格式')
  .action(async (action: string, opts: { root?: string; json?: boolean; html?: boolean; d2?: boolean; out?: string }) => {
    const { requireRoot, openRelayDb, pc } = await import('../cli/ui.js');
    const { writeKanbanDraft, syncKanbanAuto, writeKanbanGraph } = await import('../cli/kanban.js');
    const { loadConfig } = await import('../shared/config.js');
    if (!['init', 'sync', 'graph'].includes(action)) { console.error(pc.red('未知动作：' + action + '（支持 init / sync / graph）')); process.exitCode = 1; return; }
    const root = opts.root ? path.resolve(String(opts.root)) : requireRoot();
    const cfg = loadConfig(root);
    let db: ReturnType<typeof openRelayDb> | null = null;
    try { db = openRelayDb(root); } catch { db = null; }   // 没库也能生成（只写占位行）
    try {
      if (action === 'graph') {
        const g = writeKanbanGraph(root, { html: opts.html, d2: opts.d2, out: opts.out ? String(opts.out) : undefined });
        if (opts.json) console.log(JSON.stringify({ ok: g.ok, reason: g.reason, nodes: g.nodes, htmlPath: g.htmlPath }, null, 2));
        else console.log((g.ok ? '✅ ' : '⏭  ') + g.reason + (g.ok ? `（${g.nodes} 个节点）` : ''));
        return;
      }
      if (action === 'sync') {
        // 只刷新「自动区」（模块列 = auto:todos）：来自 ZCode 的真待办，人写的行一个字节不动。
        const r = syncKanbanAuto(root, cfg);
        if (opts.json) console.log(JSON.stringify(r, null, 2));
        else console.log((r.ok ? '✅ ' : '⏭  ') + r.reason);
        return;
      }
      const r = writeKanbanDraft(root, db, cfg.identity.project_id ?? null);
      // 初稿写完立刻填自动区（ZCode 待办）——这样「计划/下一步」段开箱就有真内容。
      const auto = syncKanbanAuto(root, cfg);
      if (opts.json) console.log(JSON.stringify({ ...r, auto }, null, 2));
      else if (r.created) console.log(`✅ 已生成看板初稿：${r.path}（${r.rows} 行）\n   ${auto.reason}\n   此后由人维护；生成器只在文件不存在时写一次，绝不覆盖。`);
      else console.log(pc.dim(`⏭  ${r.reason}\n   ${auto.reason}\n   ${r.path}`));
    } finally { try { db?.close() } catch { /* 已关 */ } }
  });

program
  .command('pin <text>')
  .description('置顶决策：把文本含该片段的所有条目标为置顶（简报优先显示，即使时间很老）')
  .option('--json', '机器格式')
  .action(async (text: string, opts: { json?: boolean }) => { await cmdPinDecision(text, true, opts); });

program
  .command('unpin <text>')
  .description('取消置顶：把文本含该片段的所有条目恢复原状')
  .option('--json', '机器格式')
  .action(async (text: string, opts: { json?: boolean }) => { await cmdPinDecision(text, false, opts); });

program
  .command('unresolved')
  .description('列出未解决问题（启发式）')
  .option('--limit <n>', '默认 20')
  .option('--json')
  .action(async (opts) => {
    const { cmdUnresolved } = await import('../cli/meta.js');
    // [fork 0922] 原实现丢弃 opts.json（选项存在却没传）——unresolved --json 永远输出人话，
    // 依赖 JSON 的调用方（开场简报）被迫走文本兜底、丧失一切结构化过滤
    await cmdUnresolved({ limit: opts.limit ? Number(opts.limit) : undefined, json: opts.json });
  });

program
  .command('history <filePath>')
  .description('某文件被哪些会话讨论过')
  .option('--json')
  .action(async (f: string, o) => { const { cmdHistory } = await import('../cli/meta.js'); await cmdHistory(f, o); });

program
  .command('related <sessionIdPrefix>')
  .description('以会话为锚推荐相关历史会话（向量相似 / 话题文件重叠，算法发现）')
  .option('--limit <n>', '默认 5，上限 10')
  .option('--json')
  .action(async (id: string, opts) => { const { cmdRelated } = await import('../cli/query.js'); await cmdRelated(id, opts); });

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

program
  .command('lesson [sub] [text...]')
  .description('全局经验层：add / list / search / maintain / export（跨项目，独立于各项目记忆库）')
  .option('--since <days>', 'harvest 用：扫最近多少天（默认 14）')
  .option('--dry', 'harvest 用：只看不写')
  .option('--source <ref>', '出处（消息 id / 文件:行 / 会话 id）——给了它才配得上非 inferred 定级')
  .option('--quote <text>', '原文引用（可回指）')
  .option('--grade <g>', 'verified-tool | verified-user | verified-file | inferred（默认 inferred）')
  .option('--scope <s>', 'project（默认）| domain | global')
  .option('--domain <d>', '领域标签（scope=domain 必填）')
  .option('--workspace <w>', '工作区标识（默认取当前目录）')
  .option('--status <st>', 'draft | verified | retired')
  .option('--top <n>')
  .option('--json')
  .action(async (sub, text, f) => { const { cmdLesson } = await import('../cli/lesson.js'); await cmdLesson(sub, text ?? [], f); });
program.parseAsync(process.argv);
