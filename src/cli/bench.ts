// srelay bench-extract —— 抽取结果的「黄金快照 + 零标注 Diff 门禁」（2026-10-15 夜）
//
// 出处：外部报告 §4.5 / §5.7（`srelay bench-extract --save-baseline / --diff`）。
// 为什么值得做：本项目的纪律是「改规则前先量」，但一直是**手写临时探针 + 人工判读**；
//   而今晚红队 B 明确指出我们的一批数字**没有绑定快照、无法复核**（数据在动、口径在变）。
//   这个命令把「先量」固化成两步：`--save`（快照）→ 改规则 → `--diff`（谁被删/谁被加，逐条列）。
//
// 零人工标注：快照是**集合**不是标注集，diff 只回答「变了哪些」，判读仍由人做（但不许偷偷变）。
// 快照自带五元组指纹（extract.ts md5 / EXTRACT_VERSION / 库大小与 mtime / 会话数 / 生成时间），
//   这样「28/908 @ 22:45 @ 全库口径」这类声称可以**自证**，而不是靠记忆。
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { requireRoot, openRelayDb, pc } from './ui.js';
import { loadConfig } from '../shared/config.js';
import { listDecisions, listUnresolved } from '../store/db.js';
import { EXTRACT_VERSION } from '../core/extract/version.js';

interface Snapshot {
  meta: { extractVersion: number; extractMd5: string; dbBytes: number; dbMtime: string; sessions: number; takenAt: string; root: string };
  decisions: string[];
  questions: string[];
}

const BENCH_DIR = ['.sessionrelay', 'bench'];

function extractMd5(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    // dist 里是打包产物，取不到源文件时返回 dist 自身的指纹（同样是「这批代码」的标识）
    for (const p of [path.join(here, '../src/core/extract/extract.ts'), path.join(here, '../core/extract/extract.ts')]) {
      if (fs.existsSync(p)) return createHash('md5').update(fs.readFileSync(p)).digest('hex').slice(0, 16);
    }
  } catch { /* 取不到就算了 */ }
  try { return createHash('md5').update(fs.readFileSync(fileURLToPath(import.meta.url))).digest('hex').slice(0, 16) } catch { return 'unknown' }
}

/** 收集当前库的抽取结果（有序、去重、稳定序列化 —— 便于逐字比对） */
export function collectSnapshot(root: string, db: ReturnType<typeof openRelayDb>): Snapshot {
  const cfg = loadConfig(root);
  const pid = cfg.identity.project_id ?? root;
  const dec = listDecisions(db, pid).map((d) => `${d.at}|${d.kind}|${d.text}`);
  const unr = listUnresolved(db, pid, 100000).map((q) => `${q.at}|${q.q}`);
  const dbFile = path.join(root, '.sessionrelay', 'relay.sqlite');
  let dbBytes = 0, dbMtime = '';
  try { const st = fs.statSync(dbFile); dbBytes = st.size; dbMtime = st.mtime.toISOString() } catch { /* 忽略 */ }
  let sessions = 0;
  try { sessions = (db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n } catch { /* 忽略 */ }
  return {
    meta: { extractVersion: EXTRACT_VERSION, extractMd5: extractMd5(), dbBytes, dbMtime, sessions, takenAt: new Date().toISOString(), root },
    decisions: dec.sort(),
    questions: unr.sort(),
  };
}

/** 集合差：removed = 基线有、现在没有；added = 现在有、基线没有 */
export function diffSnapshots(base: Snapshot, now: Snapshot):
  { removed: { decisions: string[]; questions: string[] }; added: { decisions: string[]; questions: string[] } } {
  const d = (a: string[], b: string[]) => a.filter((x) => !b.includes(x));
  return {
    removed: { decisions: d(base.decisions, now.decisions), questions: d(base.questions, now.questions) },
    added: { decisions: d(now.decisions, base.decisions), questions: d(now.questions, base.questions) },
  };
}

export async function cmdBenchExtract(opts: { root?: string; save?: string; diff?: string; json?: boolean; limit?: number }): Promise<void> {
  const root = opts.root ? path.resolve(String(opts.root)) : requireRoot();
  const db = openRelayDb(root);
  try {
    const snap = collectSnapshot(root, db);
    const dir = path.join(root, ...BENCH_DIR);
    const limit = opts.limit ?? 40;
    if (opts.diff) {
      // ⚠️ 必须先判字面量再 resolve：path.resolve('latest') 会变成 <cwd>/latest，永远对不上（第一版就这么错的）
      const baseFile = String(opts.diff).toLowerCase() === 'latest' ? path.join(dir, 'latest.json') : path.resolve(String(opts.diff));
      if (!fs.existsSync(baseFile)) { console.error(pc.red('找不到基线快照：' + baseFile)); process.exitCode = 1; return }
      const base = JSON.parse(fs.readFileSync(baseFile, 'utf8')) as Snapshot;
      const d = diffSnapshots(base, snap);
      if (opts.json) { console.log(JSON.stringify({ base: base.meta, now: snap.meta, ...d }, null, 2)); return }
      console.log(`基线 ${base.meta.extractVersion}/${base.meta.extractMd5} @ ${base.meta.takenAt.slice(0, 16)}  →  现在 ${snap.meta.extractVersion}/${snap.meta.extractMd5}`);
      console.log(`决策 ${base.decisions.length} → ${snap.decisions.length}；未决 ${base.questions.length} → ${snap.questions.length}`);
      console.log(pc.yellow(`\n剔除 ${d.removed.decisions.length} 条决策（先读这些：有没有误杀真决策）`));
      for (const x of d.removed.decisions.slice(0, limit)) console.log('  - ' + x.slice(0, 110));
      if (d.removed.decisions.length > limit) console.log(pc.dim(`  …另有 ${d.removed.decisions.length - limit} 条（--limit 调大或 --json）`));
      console.log(pc.green(`\n新增 ${d.added.decisions.length} 条决策（读这些：precision 如何）`));
      for (const x of d.added.decisions.slice(0, limit)) console.log('  + ' + x.slice(0, 110));
      console.log(pc.yellow(`\n未决剔除 ${d.removed.questions.length} / 新增 ${d.added.questions.length}`));
      for (const x of d.removed.questions.slice(0, 10)) console.log('  - ' + x.slice(0, 110));
      for (const x of d.added.questions.slice(0, 10)) console.log('  + ' + x.slice(0, 110));
      return;
    }
    // 默认：保存快照（--save 指定路径；不给就写 bench/<版本>-<时间>.json 并把 latest.json 指过去）
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const file = opts.save ? path.resolve(String(opts.save)) : path.join(dir, `v${snap.meta.extractVersion}-${stamp}.json`);
    fs.writeFileSync(file, JSON.stringify(snap, null, 1), 'utf8');
    fs.writeFileSync(path.join(dir, 'latest.json'), JSON.stringify(snap), 'utf8');
    if (opts.json) { console.log(JSON.stringify({ ok: true, file, meta: snap.meta, decisions: snap.decisions.length, questions: snap.questions.length }, null, 2)); return }
    console.log(`✅ 快照已存：${file}`);
    console.log(`   版本 v${snap.meta.extractVersion} · extract.ts ${snap.meta.extractMd5} · 库 ${(snap.meta.dbBytes / 1048576).toFixed(0)}MB @ ${snap.meta.dbMtime.slice(0, 16)} · ${snap.meta.sessions} 会话`);
    console.log(`   决策 ${snap.decisions.length} 条 · 未决 ${snap.questions.length} 条（改完规则后：srelay bench-extract --diff latest）`);
  } finally { db.close() }
}
