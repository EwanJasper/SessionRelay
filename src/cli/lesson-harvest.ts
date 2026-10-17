// lesson harvest 的实现（从项目记忆里刨草稿；纯读项目库 + 写全局库）
import { pc } from './ui.js';
import { harvestCandidates } from '../core/extract/lesson-harvest.js';
import { addLesson, type AddInput } from '../store/global.js';

interface Msg { role: string; content: string; seqNum: number; sessionId: string }

interface DbLike {
  prepare: (s: string) => {
    all: (...a: unknown[]) => unknown[];
    /** 回读校验用（[1021 红队 #11]）：只靠写入参数判断"写进去的是什么"是不可靠的。 */
    get?: (...a: unknown[]) => unknown;
  };
}

function recentMessages(pdb: DbLike, days: number, cap: number): Msg[] {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const rows = pdb.prepare(
    'SELECT m.session_id AS sid, m.role AS role, m.content AS content, m.seq_num AS seq'
    + ' FROM messages m JOIN sessions s ON s.id = m.session_id'
    + ' WHERE m.created_at >= ? AND length(m.content) BETWEEN 20 AND 400'
    + ' ORDER BY m.created_at DESC LIMIT ?'
  ).all(since, cap) as Array<{ sid: string; role: string; content: string; seq: number }>;
  return rows.map((r) => ({ role: String(r.role), content: String(r.content), seqNum: Number(r.seq), sessionId: String(r.sid) }));
}

export async function runHarvest(
  gdb: DbLike,
  pdb: DbLike,
  workspaceId: string,
  opts: { days: number; dry?: boolean; json?: boolean },
): Promise<void> {
  const msgs = recentMessages(pdb, opts.days, 4000);
  const cands = harvestCandidates(msgs);
  const existing = new Set((gdb.prepare('SELECT text FROM lessons').all() as Array<{ text: string }>).map((r) => String(r.text)));
  const fresh = cands.filter((c) => !existing.has(c.text));
  if (opts.json) {
    console.log(JSON.stringify({ scanned: msgs.length, found: cands.length, fresh: fresh.length, items: fresh.slice(0, 20) }));
    return;
  }
  console.log('扫了 ' + msgs.length + ' 条消息（近 ' + opts.days + ' 天），刨出 ' + cands.length + ' 条候选，其中新的 ' + fresh.length + ' 条');
  if (opts.dry) {
    for (const c of fresh.slice(0, 20)) console.log('  · [' + c.level + '] ' + c.text);
    console.log(pc.dim('（--dry 只是看看，没写库）'));
    return;
  }
  let n = 0;
  const notDraft: string[] = [];
  for (const c of fresh) {
    const input: AddInput = {
      text: c.text, quote: c.quote, sourceRef: c.sourceRef,
      route: c.role === 'user' ? 'user-message' : 'none',
      grade: c.level, scope: 'project', workspaceId,
      // [1021 红队 #11] **显式 draft**。addLesson 的默认值是「有来源 + 有定级 ⇒ verified」，
      // 而采集是**机器自动**产物：自动提取 ≠ 人工确认。三者必须各自独立：
      //   抽取（这里，永远 draft）／人工确认（lesson confirm）／证据评级（grade）。
      // 病历：这里没传 status，于是采集出来的假用户经验落库成 status=verified、
      // grade=verified-user，而命令输出照样宣称写的是「草稿」——**输出与库里不一致**。
      status: 'draft',
    };
    const r = addLesson(gdb as never, input);
    // 回读真实状态：不信任写入参数，也不信任 addLesson 的返回值（它只回 id/reason）。
    const row = gdb.prepare('SELECT status FROM lessons WHERE id = ?').get?.(r.id) as { status?: string } | undefined;
    const saved = String(row?.status ?? '');
    if (saved === 'draft') n++;
    else notDraft.push(r.id + ' → ' + (saved || '读不到状态'));
  }
  if (notDraft.length > 0) {
    // 不静默：这已经不是"少写了几条"，而是**写入语义被别处改了**。吼出来并判失败。
    console.error(pc.red('✗ 有 ' + notDraft.length + ' 条落库后不是 draft：' + notDraft.slice(0, 5).join('，')));
    console.error(pc.red('  采集只允许产草稿。请检查 store/global.ts 的 addLesson 默认值或写入路径是否被改动。'));
    process.exitCode = 1;
    return;
  }
  console.log(pc.green('✓ 写入 ' + n + ' 条【草稿】') + pc.dim('（已回读核对 status=draft；draft 不进注入层，复核后才生效）'));
}