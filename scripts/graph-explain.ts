// 查询扩展可解释探针：打印「这个词扩展成了哪些词」，并列出扩展路真的召回了哪些会话
//
// 用法：
//   npx tsx scripts/graph-explain.ts <库路径> "怎么省空间"
//   npx tsx scripts/graph-explain.ts <库路径> "怎么省空间" --limit 5 [--hops 2] [--terms 5] [--nosearch]
import { createRequire } from 'node:module';
const require2 = createRequire(import.meta.url);
const Database = require2('better-sqlite3');

const argv = process.argv.slice(2);
const dbPath = argv[0];
const query = argv[1];
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const limit = Number(arg('limit', '5'));
const hops = Number(arg('hops', '1'));
const terms = Number(arg('terms', '4'));
const noSearch = argv.includes('--nosearch');
if (!dbPath || !query) { console.error('用法: npx tsx scripts/graph-explain.ts <库路径> "查询"'); process.exit(2); }

const { expandQueryTags, formatExpansion } = await import('../src/core/graph/index.js');
const { parseQuery } = await import('../src/core/tokenize/tokenizer.js');
const { searchSessions } = await import('../src/search-svc/engine.js');

const db = new Database(dbPath, { readonly: true });
const pid = db.prepare('SELECT project_id FROM sessions LIMIT 1').get()?.project_id;
const tokens = parseQuery(query).units.flat();
const exp = expandQueryTags(db as never, tokens, { hops, maxTerms: terms });
console.log('查询: ' + query + '（词元: ' + tokens.join('/') + '）  hops=' + hops + ' maxTerms=' + terms);
console.log(formatExpansion(exp));

if (!noSearch && exp.terms.length > 0) {
  const base = searchSessions(db as never, { project: pid, query, limit } as never);
  const expd = searchSessions(db as never, { project: pid, query, limit, tagExpand: true, tagHops: hops, tagMaxTerms: terms } as never);
  const fmt = (h) => h.map((x, i) => (i + 1) + '. ' + x.sessionId + (x.viaTag ? ' [tag]' : '')).join('  ');
  console.log('\n不扩展: ' + fmt(base));
  console.log('扩展后: ' + fmt(expd));
}
db.close();
