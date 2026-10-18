import fsx from 'node:fs';
import { pathToFileURL } from 'node:url';
const HERE = 'D:/dsh插件  记忆/plugins/dsh/';
const ROOT = 'D:\\dsh插件  记忆';
const mod = await import(pathToFileURL(HERE + 'index.js').href + '?dbg=' + Date.now());
const reg = [];
mod.apply({
  systemPrompt: { section: (s) => { reg.push(s); return () => {}; }, getSectionOrder: () => 10001 },
  tools: { register: () => () => {} },
  effect: (fn) => fn(),
});
const asm = { agent: { id: 't', session: { header: { cwd: ROOT } } } };
const v1 = reg[0].text(asm);
const v2 = reg[0].text(asm);
const clean = (t) => String(t ?? '').split('\n').filter((l) => !l.startsWith('🌿 Git'));
const a = clean(v1), b = clean(v2);
console.log('冷', v1.length, '热', v2.length, '一致?', a.join('\n') === b.join('\n'));
for (let i = 0; i < Math.max(a.length, b.length); i++) {
  if (a[i] !== b[i]) { console.log('首个差异 #' + i); console.log('  冷: ' + JSON.stringify(a[i])); console.log('  热: ' + JSON.stringify(b[i])); break; }
}
console.log('--- 冷路径前 30 行 ---');
console.log(a.slice(0, 30).join('\n'));
