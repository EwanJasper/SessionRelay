// 建/查标签图谱（零模型「轻量知识图谱」的运维入口）
//
// 用法：
//   npx tsx scripts/graph-tag-build.ts <库路径>              # 建（已有且同版本会话数一致就跳过）
//   npx tsx scripts/graph-tag-build.ts <库路径> --force      # 强制重建
//   npx tsx scripts/graph-tag-build.ts <库路径> --stats      # 只看现状 + top 标签
//
// 为什么单独一个脚本、而不是塞进 capture/recompute：建图是**读库算、写三张新表**的纯派生动作，
// 与采集/抽取的书写域不重叠；放脚本里谁都能在不动别人代码的前提下重建它。
import { createRequire } from 'node:module';
const require2 = createRequire(import.meta.url);
const Database = require2('better-sqlite3');

const dbPath = process.argv[2];
if (!dbPath) { console.error('用法: npx tsx scripts/graph-tag-build.ts <库路径> [--force] [--stats]'); process.exit(2); }
const force = process.argv.includes('--force');
const statsOnly = process.argv.includes('--stats');

const { buildTagGraph, graphStatus } = await import('../src/core/graph/index.js');
const db = new Database(dbPath);

if (statsOnly) {
  const st = graphStatus(db as never);
  console.log('图谱状态: ' + (st.ready ? '✅ 可用' : '🔴 ' + st.why));
  console.log('  标签 ' + st.tags + ' · 共现边 ' + st.edges + ' · 会话 ' + st.sessions);
  if (st.ready) {
    const top = db.prepare('SELECT name, kind, df FROM graph_tags ORDER BY df DESC LIMIT 20').all();
    console.log('  top 标签（按出现会话数）:');
    for (const t of top) console.log('    ' + String(t.df).padStart(4) + '  ' + t.name + '  [' + t.kind + ']');
    const hub = db.prepare('SELECT a, b, w FROM graph_tag_edges ORDER BY w DESC LIMIT 15').all();
    const nm = db.prepare('SELECT name FROM graph_tags WHERE id = ?');
    console.log('  最强共现边:');
    for (const e of hub) {
      const na = nm.get(e.a)?.name, nb = nm.get(e.b)?.name;
      console.log('    ' + Number(e.w).toFixed(2) + '  ' + na + ' ↔ ' + nb);
    }
  }
  process.exit(0);
}

const t0 = Date.now();
const res = buildTagGraph(db as never, { reuse: !force, onProgress: (d) => { if (d % 20000 === 0) console.log('  ...已扫 ' + d + ' 条消息'); } });
console.log((res.reused ? '复用已有图谱（版本/会话数一致）' : '重建完成') + `：${res.ms}ms`);
console.log('  会话 ' + res.sessions + ' · 标签 ' + res.tags + ' · 标签-会话 ' + 0 + '(见 graph_tag_sessions) · 共现边 ' + res.edges + ' · 候选对 ' + res.pairs);
const cnt = db.prepare('SELECT COUNT(*) c FROM graph_tag_sessions').get();
console.log('  标签-会话行数 ' + cnt.c + '，库内总计 ' + (Date.now() - t0) + 'ms');
db.close();
