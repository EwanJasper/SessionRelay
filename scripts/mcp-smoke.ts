// 实机 MCP 冒烟：对本项目真实 relay.sqlite 起 serve，调 3 个工具（不落任何文件到项目外）
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const ROOT = 'D:/project/SomeIdeaProject/sessionRelay';

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['--import', `file:///${path.join(REPO, 'node_modules/tsx/dist/loader.mjs').replace(/\\/g, '/')}`, path.join(REPO, 'src/bin/srelay.ts'), 'serve'],
  env: { ...process.env, SRELAY_PROJECT_ROOT: ROOT } as Record<string, string>,
  stderr: 'ignore',
});
const client = new Client({ name: 'srelay-smoke', version: '0.0.0' });
await client.connect(transport);

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const res = await client.callTool({ name, arguments: args });
  return JSON.parse((res.content as Array<{ type: string; text: string }>)[0].text);
};

const stats = await call('get_stats');
console.log('get_stats →', JSON.stringify(stats, null, 2).slice(0, 500));

const search = await call('search_sessions', { query: '指导方针 决策', limit: 3 });
console.log('\nsearch_sessions("指导方针 决策") →');
for (const h of (search as { hits: Array<{ title: string; source: string; provenance: { msg: number } }> }).hits) {
  console.log(`  · ${h.title} [${h.source}] 出处 msg#${h.provenance.msg}`);
}

const decs = await call('get_decisions', {});
console.log(`\nget_decisions → ${(decs as { count: number }).count} 条，首条：`);
const first = (decs as { decisions: Array<{ text: string; provenance: { sessionId: string; msg: number } }> }).decisions[0];
if (first) console.log(`  ${first.text.slice(0, 60)} …（${first.provenance.sessionId} msg#${first.provenance.msg}）`);

await client.close();
