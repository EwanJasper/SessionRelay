// lesson harvest 的 CLI 薄壳（1021：判据全部在内核 core/extract/lesson-harvest.ts）
//
// 铁律：「外挂脚本降级为内核 API 的薄壳」—— 本文件只做**参数解析 + 打印**，
// 不写任何判据。上一版这里是判据的实现方（recentMessages / 去重 / 写库 / 回读核对），
// 于是生命周期想跑采集时只能去 spawn 它，判据就分成两份（CLI 参数 vs 内核默认值）。
import { pc } from './ui.js';
import { harvestLessons, type HarvestReport } from '../core/extract/lesson-harvest.js';

type DbLike = { prepare: (s: string) => { all: (...a: unknown[]) => unknown[]; get?: (...a: unknown[]) => unknown } };

/** 把内核报告渲染成人能读的两行；任何"落库后不是 draft"都判失败（不静默）。 */
export function printHarvestReport(rep: HarvestReport, dry: boolean): void {
  console.log('扫了 ' + rep.scanned + ' 条消息，刨出 ' + rep.found + ' 条候选，其中新的 ' + rep.fresh + ' 条');
  if (dry) {
    for (const c of rep.samples.slice(0, 20)) console.log('  · [' + c.level + '] ' + c.text);
    console.log(pc.dim('（--dry 只是看看，没写库）'));
    return;
  }
  if (rep.notDraft.length > 0) {
    // 这已经不是"少写了几条"，而是**写入语义被别处改了**。吼出来并判失败。
    console.error(pc.red('✗ 有 ' + rep.notDraft.length + ' 条落库后不是 draft：' + rep.notDraft.slice(0, 5).join('，')));
    console.error(pc.red('  采集只允许产草稿。请检查 store/global.ts 的 addLesson 默认值或写入路径是否被改动。'));
    process.exitCode = 1;
    return;
  }
  console.log(pc.green('✓ 写入 ' + rep.written + ' 条【草稿】') + pc.dim('（已回读核对 status=draft；draft 不进注入层，复核后才生效）'));
}

export async function runHarvest(
  gdb: DbLike,
  pdb: DbLike,
  workspaceId: string,
  opts: { days: number; dry?: boolean; json?: boolean },
): Promise<void> {
  // domain 从项目配置自动取（与生命周期同源：shared/workspace 的 resolveDomain）
  const { resolveDomain } = await import('../shared/workspace.js');
  const rep = harvestLessons(gdb as never, pdb as never, workspaceId, {
    days: opts.days, dry: opts.dry, domain: resolveDomain(process.cwd()),
  });
  if (opts.json) {
    console.log(JSON.stringify({ scanned: rep.scanned, found: rep.found, fresh: rep.fresh, written: rep.written, items: rep.samples.map((c) => c.text) }, null, 2));
    return;
  }
  printHarvestReport(rep, opts.dry === true);
}
