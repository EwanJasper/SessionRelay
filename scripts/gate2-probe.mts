// 闸 2 判据探针（人工核验用；不进产品链路）
// 用法：npx tsx scripts/gate2-probe.mts
// 作用：对若干"该命中/该静默"的题面，打印分词结果与得分，用于人工判读判据是否合理。
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { gate2Score, gate2Tokens } from '../src/store/global.js';

const QUERIES = [
  '改完插件源码为什么自测还是旧行为，硬链接 .pnpm 是不是原因？',
  '主目录为什么不能当成项目根',
  '今天天气怎么样，帮我写一首关于春天的诗吧',
  '这个怎么弄一下',
  '改用截图坐标',
  'MAX_CHARS 简报上限是多少',
  '检索排序为什么要做长度归一',
];

const f = process.env.SRELAY_GLOBAL_HOME
  ? path.join(process.env.SRELAY_GLOBAL_HOME, 'global.sqlite')
  : path.join(os.homedir(), '.sessionrelay', 'global.sqlite');
const texts: string[] = [];
try {
  const db = new DatabaseSync(f, { readOnly: true });
  for (const r of db.prepare('SELECT text FROM lessons').all() as { text: string }[]) texts.push(String(r.text));
  db.close();
} catch (e) { console.error('（读真实经验库失败：' + (e as Error).message + '）'); }

for (const q of QUERIES) {
  const toks = gate2Tokens(q);
  const hits = texts.map((t) => ({ t, s: gate2Score(q, t) })).filter((x) => x.s.score > 0);
  console.log('─'.repeat(70));
  console.log('query:', q);
  console.log('  toks:', JSON.stringify(toks));
  console.log('  命中 ' + hits.length + ' 条：');
  for (const h of hits) console.log('    [' + h.s.score + '] ' + h.t.slice(0, 60));
}
