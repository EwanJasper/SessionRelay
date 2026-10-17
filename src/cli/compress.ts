// srelay compress —— L3 模型压缩（用生成模型把旧条目合成上级条目）
//
// 边界（docs/1018-夜-模型压缩与语义档-建设方案.md §2，**改代码前先回读**）：
//   原文永不删 / 只在生命周期阶段跑 / 掉召回整批回滚 / 可审计可回滚 / 抽不出证据就丢弃 / 默认关 + 有配额
//
// 为什么给一条 CLI：门禁（跑基准比 hit@1）需要**人工在两轮之间**做，
// 而生命周期里没法跑基准。CLI 是"先量再接"这条铁律的落点：
//   srelay compress --dry-run   # 看它会合并什么（不调模型、不写库）
//   srelay compress --apply     # 真跑（写审计，原文快照进 compress_detail）
//   srelay compress --logs      # 看历史合并
//   srelay compress --rollback <id>  # 整批回滚
import { loadConfig } from '../shared/config.js';
import { dbFile, findRelayRoot } from '../shared/paths.js';
import { openExisting } from '../store/db.js';
import { compressPolicyOf, compressBlockedBy, openAiCompatProvider } from '../core/compact/model.js';
import { compressProject, listCompressLogs, compressDetailOf, quotaUsed } from '../core/compact/model-apply.js';
import { pc, die } from './ui.js';

export interface CompressFlags {
  dryRun?: boolean;
  apply?: boolean;
  /** 1020 · P1：把合并结果写回 sessions.decisions（压缩不掉召回）。
   *  **必须配 --apply**；会改数据，门禁是「先跑基准记 hit@1，跑完再比」。 */
  writeBack?: boolean;
  logs?: boolean;
  rollback?: string;
  json?: boolean;
}

export async function cmdCompress(f: CompressFlags): Promise<void> {
  const root = findRelayRoot(process.cwd());
  if (!root) die('未找到 .sessionrelay（本项目尚未初始化）', '在项目根目录运行 srelay init');
  const cfg = loadConfig(root);
  const p = compressPolicyOf(cfg as never);
  const db = openExisting(dbFile(root));
  try {
    // ── 看历史合并 ──
    if (f.logs) {
      const logs = listCompressLogs(db, 20);
      if (logs.length === 0) { console.log(pc.dim('还没有任何 L3 合并记录。')); return; }
      console.log(pc.cyan('L3 合并审计（最近 ' + logs.length + ' 次）'));
      for (const l of logs) {
        console.log('  #' + l.id + '  ' + l.created_at + '  ' + l.scope + '  ' + l.status
          + '  簇 ' + l.clusters_seen + '→合并 ' + l.clusters_merged
          + '  条目 ' + l.items_in + '→' + l.items_out + '  丢弃 ' + l.discarded
          + '  调用 ' + l.calls + '  (' + l.model + ')');
      }
      console.log(pc.dim('  回滚：srelay compress --rollback <id>（原文快照在 compress_detail.originals）'));
      return;
    }

    // ── 回滚 ──
    if (f.rollback !== undefined) {
      const id = Number(f.rollback);
      const details = compressDetailOf(db, id);
      if (details.length === 0) { console.log(pc.yellow('compress_log#' + id + ' 没有明细（id 不存在或没有合并）')); return; }
      console.log(pc.cyan('回滚 compress_log#' + id + '：' + details.length + ' 条合并'));
      for (const d of details) {
        console.log(pc.dim('  · ' + String(d.merged_text).slice(0, 60)));
        const orig = JSON.parse(String(d.originals)) as Array<{ id: string; text: string; at?: string }>;
        console.log(pc.dim('    原文 ' + orig.length + ' 条：' + orig.map((x) => String(x.text).slice(0, 24)).join(' | ')));
      }
      // ⚠️ 这里只做**审计导出**，不直接改库：写回原文属于"有损阶段的反向操作"，
      // 必须由调用方（人）确认后再执行 —— 自动回滚会把"后来又新产生的合并"一起抹掉。
      console.log(pc.yellow('  （本次只列出回滚依据，没有改库。要真回滚请用 --rollback-apply，见下条 TODO 登记）'));
      return;
    }

    // ── 状态 / dry-run / apply ──
    const blocked = compressBlockedBy(p);
    const used = quotaUsed(db, 'project');
    console.log(pc.cyan('L3 模型压缩'));
    console.log('  开关      ' + (p.enabled ? pc.green('已启用') : pc.dim('未启用（默认关）')));
    console.log('  模型      ' + (p.model || pc.yellow('（没配）')) + '  via ' + p.provider);
    console.log('  端点      ' + (p.endpoint || pc.yellow('（没配）')));
    console.log('  配额      本轮上限 ' + p.maxCallsPerRound + ' · 每小时 ' + p.maxCallsPerHour + '（本小时已用 ' + used + '，落库计数）');
    console.log('  分簇      重叠阈值 ' + p.topicOverlap + ' · 最小簇 ' + p.minCluster + ' 条 · 只压 ' + p.minAgeDays + ' 天前');
    console.log('  范围      ' + (p.projects ? '项目库 decisions' : '') + (p.projects && p.lessons ? ' + ' : '') + (p.lessons ? '全局库 lessons' : ''));
    if (blocked) { console.log(pc.yellow('  → 现在不能跑：' + blocked)); if (!f.apply && !f.dryRun) return; }

    const apply = f.apply === true;
    if (!apply && !f.dryRun) { console.log(pc.dim('\n  加 --dry-run 看它会合并什么；加 --apply 真跑（写审计）。')); return; }
    const provider = blocked ? undefined : openAiCompatProvider(p);
    if (!provider && apply) { console.log(pc.yellow('  没有可用的模型提供方，apply 中止（不留半开状态）')); return; }
    if (f.writeBack && !apply) { console.log(pc.yellow('  --write-back 必须配 --apply（dry-run 不写任何东西）')); return; }
    const r = await compressProject(db, cfg.identity.project_id ?? root, p, {
      apply, writeBack: f.writeBack === true, provider, log: (s) => console.log(pc.dim('  ' + s)),
    });
    console.log('');
    if (r.blocked) { console.log(pc.yellow('  未执行：' + r.blocked)); return; }
    console.log(pc.green('✓') + ' 候选 ' + r.itemsIn + ' 条 → ' + r.clustersSeen + ' 簇 → 合并 ' + r.itemsOut + ' 条'
      + '（丢弃 ' + r.discarded + ' 条：抽不出证据）· 调用 ' + r.calls + ' 次'
      + (r.logId ? ' · 审计 #' + r.logId : ''));
    if (f.json) console.log(JSON.stringify({ ...r, policy: { model: p.model, provider: p.provider } }, null, 2));
  } finally { db.close(); }
}
