// 产物断言（发版审核两轮事故的固化防线）：
// 1) MCP 工具名在文档全覆盖（related 事故：String.replace 静默漏掉第二张表）
// 2) 无旧工具计数残留（16 工具时代不能再出现 "15 tools"）
// 3) CHANGELOG 顶部版本与 package.json 一致（发版时容易忘改）
// 用法：node scripts/check-artifacts.mjs（CI test job 末尾 + 本地手动）
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let failures = 0;
const fail = (m) => { console.error(`✗ ${m}`); failures++; };
const ok = (m) => console.log(`✓ ${m}`);

// ── 1) 工具名文档全覆盖 ──
const serverSrc = read('src/mcp/server.ts');
const toolNames = [...serverSrc.matchAll(/registerTool\('([a-z_]+)'/g)].map((m) => m[1]);
if (toolNames.length === 0) fail('未能从 server.ts 提取到任何 registerTool');
const readme = read('README.md');
const readmeEn = read('README.en.md');
const guide = read('docs/user-guide.md');
for (const name of toolNames) {
  for (const [doc, label] of [[readme, 'README.md'], [guide, 'user-guide.md']]) {
    if (!doc.includes(name)) fail(`工具 ${name} 未出现在 ${label}`);
  }
}
if (failures === 0) ok(`${toolNames.length} 个 MCP 工具名在 README.md 与 user-guide.md 全覆盖`);

// ── 2) 无旧计数残留（若将来加第 17 个工具，此处随源码计数自动演进） ──
const count = toolNames.length;
for (const [doc, label] of [[readme, 'README.md'], [readmeEn, 'README.en.md'], [guide, 'user-guide.md']]) {
  const stale = new RegExp(`[^0-9]${count - 1} (个工具|tools)`, 'g');
  if (stale.test(doc)) fail(`${label} 仍含旧计数 "${count - 1} 工具" 表述`);
}
if (failures === 0) ok(`无旧计数（${count - 1}）残留`);

// ── 3) CHANGELOG 顶部版本 = package.json（顶部为 Unreleased 时跳过） ──
const pkg = JSON.parse(read('package.json'));
const changelog = read('CHANGELOG.md');
const top = /^## \[([^\]]+)\]/m.exec(changelog)?.[1];
if (top && top !== 'Unreleased' && top !== pkg.version) {
  fail(`CHANGELOG 最新条目 ${top} ≠ package.json ${pkg.version}（发版忘改？）`);
} else {
  ok(`CHANGELOG 版本一致性（顶部：${top ?? '（空）'} / pkg：${pkg.version}）`);
}

if (failures > 0) {
  console.error(`\n${failures} 处产物不一致`);
  process.exit(1);
}
console.log('\n产物断言全部通过');
