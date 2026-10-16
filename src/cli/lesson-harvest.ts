// lesson harvest 的实现（从项目记忆里刨草稿；纯读项目库 + 写全局库）
import { pc } from './ui.js';
import { harvestCandidates } from '../core/extract/lesson-harvest.js';
import { addLesson, type AddInput } from '../store/global.js';

interface Msg { role: string; content: string; seqNum: number; sessionId: string }

interface DbLike { prepare: (s: string) => { all: (...a: unknown[]) => unknown[] } }

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
  for (const c of fresh) {
    const input: AddInput = {
      text: c.text, quote: c.quote, sourceRef: c.sourceRef,
      route: c.role === 'user' ? 'user-message' : 'none',
      grade: c.level, scope: 'project', workspaceId,
    };
    addLesson(gdb as never, input);
    n++;
  }
  console.log(pc.green('✓ 写入 ' + n + ' 条【草稿】') + pc.dim('（draft 不进注入层；复核后才生效）'));
}