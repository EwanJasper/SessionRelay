// srelay decisions / history / unresolved（方针 §8.2；验收：决策列表含出处 D10）
import { loadConfig } from '../shared/config.js';
import { listDecisions, listUnresolved, resolveMessageRef } from '../store/db.js';
import { searchSessions } from '../search-svc/engine.js';
import { getSession } from '../store/db.js';
import { requireRoot, openRelayDb, pc, fmtDate } from './ui.js';

export async function cmdDecisions(opts: { topic?: string; source?: string; kind?: string; limit?: number; json?: boolean }): Promise<void> {
  const root = requireRoot();
  const cfg = loadConfig(root);
  const db = openRelayDb(root);
  try {
    // [fork] listDecisions 升序返回（全列表"按时间"语义）；但 limit 语义应取"最近 N 条"——
    // 原实现 slice(0, limit) 取的是最老的 N 条，简报/CLI 的"最近决策"永远显示陈年旧账
    // ADR-001：--kind 只认 decision|negative，别的值静默忽略（打歪一个字母不该让命令失败）
    const kind = opts.kind === 'negative' || opts.kind === 'decision' ? opts.kind : undefined;
    const all = listDecisions(db, cfg.identity.project_id ?? root, { topic: opts.topic, source: opts.source, kind });
    const rows = all.slice(-(opts.limit ?? 20)).reverse();
    // ── [1021 红队 R13] 出处回跳：优先 msgId（稳定主键），缺失才回落 seq，**回落必须留痕** ──
    //   修前：直接把 `--range ${r.seq}:${r.seq}` 打给用户。会话归档/裁剪后这个 range 查不到
    //   任何东西，而且不报错 —— 存量库实测 831 条决策里 msgId 覆盖率 0%，即今天全部在走
    //   会漂移的那条路。现在：先回查真实消息行，查不到就明说"原文已归档"，不再给假 range。
    const refOf = (r: { sessionId: string; seq: number; msgId?: string | number }) =>
      resolveMessageRef(db, r.sessionId, { msgId: r.msgId, seq: r.seq });
    const prov = { byMsgId: 0, seqFallback: 0, missing: 0 };
    for (const r of rows) {
      const via = refOf(r).via;
      if (via === 'msgId') prov.byMsgId++;
      else if (via === 'seq') prov.seqFallback++;
      else prov.missing++;
    }
    if (opts.json) { console.log(JSON.stringify({ count: rows.length, decisions: rows, provenance: prov }, null, 2)); return; }
    if (rows.length === 0) {
      console.log(pc.dim(kind === 'negative'
        ? '（暂无被否掉的路。ADR-001：kind 标记要等 recompute 到 v7 后才有——srelay doctor 看「提取规则版本」）'
        : '（暂无已确认决策。会话 confirmed 后自动提取——见 srelay list --state pending）'));
      return;
    }
    console.log(`共 ${rows.length} 条${kind === 'negative' ? '被否掉的路' : '决策'}（按时间）：\n`);
    for (const r of rows) {
      // ADR-001：否定性决策加 ✗，与拍板采用的 ✓ 一眼分开
      const mark = r.kind === 'negative' ? pc.red('✗') : pc.green('✓');
      console.log(`${pc.dim(fmtDate(r.at))} ${mark} [${r.source}] ${r.text}`);
      // [R13] 出处：只打印**回查得到**的 range；查不到就说原文已归档（不再给一个查不到的 seq）
      const ref = refOf(r);
      const head = `        出处：「${(r.title ?? '').slice(0, 30)}」 ${r.sessionId}`;
      if (ref.message) {
        const seq = ref.message.seq_num;
        const how = ref.via === 'msgId'
          ? (seq === r.seq ? 'msgId 定位' : `msgId 定位 · seq 已漂移（条目记 ${r.seq}，实际在 ${seq}）`)
          : 'seq 回落 · 该条无 msgId';
        console.log(pc.dim(`${head} · msg#${seq}（${how}）· srelay show ${r.sessionId} --range ${seq}:${seq}`));
      } else {
        console.log(pc.dim(`${head} · 原文已归档（messages 里已无这条；msgId=${r.msgId ?? '无'} · seq=${r.seq}）`));
      }
    }
    // [R13] 回落留痕：不打这行，就没人知道"还有多少条在走会漂移的路"（而这是 msgId 存在的全部理由）
    if (prov.seqFallback > 0 || prov.missing > 0) {
      console.log(pc.dim(`\n出处回跳：${prov.byMsgId} 条按 msgId 稳定定位 · ${prov.seqFallback} 条回落 seq（这些条目没有 msgId）· ${prov.missing} 条原文已归档`));
    }
  } finally {
    db.close();
  }
}

export async function cmdUnresolved(opts: { limit?: number; json?: boolean }): Promise<void> {
  const root = requireRoot();
  const cfg = loadConfig(root);
  const db = openRelayDb(root);
  try {
    const cutoff = Date.now() - 14 * 86_400_000; // [fork 0922] 未解决有保质期：14 天自动淡出（老问题没被再问起就该沉底）
    const rows = listUnresolved(db, cfg.identity.project_id ?? root, 100)
      .filter((r) => new Date(r.at).getTime() >= cutoff)
      .slice(0, opts.limit ?? 20);
    if (opts.json) { console.log(JSON.stringify({ count: rows.length, unresolved: rows }, null, 2)); return; }
    if (rows.length === 0) { console.log(pc.dim('（暂无未决问题）')); return; }
    for (const r of rows) {
      console.log(`${pc.yellow('◻')} ${r.q}`);
      console.log(pc.dim(`   ${fmtDate(r.at)} [${r.source}] 「${(r.title ?? '').slice(0, 28)}」 ${r.sessionId}`));
    }
  } finally {
    db.close();
  }
}

export async function cmdHistory(filePath: string, opts?: { json?: boolean }): Promise<void> {
  const root = requireRoot();
  const cfg = loadConfig(root);
  const db = openRelayDb(root);
  try {
    // 文件路径在入库时保持标识符单 token，直接作为查询（§6.1）
    const hits = searchSessions(db, { project: cfg.identity.project_id ?? root, query: `"${filePath.replace(/\\/g, '/')}"`, limit: 20 });
    if (hits.length === 0) { console.log(pc.dim(`没有会话提到 ${filePath}`)); return; }
    console.log(`${filePath} 出现在 ${hits.length} 个会话：\n`);
    for (const h of hits) {
      const s = getSession(db, h.sessionId);
      console.log(`${pc.dim(fmtDate(s?.created_at))} [${s?.source}] 「${(s?.title ?? '').slice(0, 32)}」 ${pc.dim(s!.id)}`);
      if (h.snippet) console.log(pc.dim(`   ${h.snippet.slice(0, 90)}`));
    }
  } finally {
    db.close();
  }
}
