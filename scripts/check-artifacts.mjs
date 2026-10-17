// 产物断言（发版审核两轮事故的固化防线）：
// 1) MCP 工具名在文档全覆盖（related 事故：String.replace 静默漏掉第二张表）
// 2) 无旧工具计数残留（16 工具时代不能再出现 "15 tools"）
// 3) CHANGELOG 顶部版本与 package.json 一致（发版时容易忘改）
// 用法：node scripts/check-artifacts.mjs（CI test job 末尾 + 本地手动）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let failures = 0;
const fail = (m) => { console.error(`✗ ${m}`); failures++; };
const ok = (m) => console.log(`✓ ${m}`);

// ── 1) 工具名文档全覆盖 ──
// 工具名的**唯一事实源**是 server.ts 里真实的 register('name', …) 调用。
// [1021 审查 #18] 旧实现找的是 registerTool( —— 实际代码用封装过的 register(，出现 0 次，
// 于是工具名恒为空、脚本在第一条 fail 就停了 ⇒ 文档覆盖/旧计数两段**从来没执行过**，
// 发版检查红着半年没人知道。这里除了改用真实调用点，还加三条不变量，让"抽取规则本身漂移"
// 也会红，而不是悄悄少抽几个名字（那会让检查假绿）：
//   · 抽到 0 个 → 红；
//   · 出现裸 registerTool( 调用 → 红（封装层被绕过，抽取规则已失配）；
//   · register/registerTool 调用数 ≠ 抽到的名字数 → 红（有调用写法没被识别）。
const serverSrc = read('src/mcp/server.ts');
const regCalls = [...serverSrc.matchAll(/\bregister\(\s*'([a-z_]+)'/g)].map((m) => m[1]);
const rawRegToolCount = (serverSrc.match(/\bregisterTool\s*\(/g) ?? []).length;
const registerishCount = (serverSrc.match(/\bregister(?:Tool)?\s*\(/g) ?? []).length;
const toolNames = [...new Set(regCalls)];
if (toolNames.length === 0) fail('未能从 server.ts 提取到任何 register(...) 工具名');
if (rawRegToolCount > 0) fail(`server.ts 出现 ${rawRegToolCount} 处裸 registerTool( —— 抽取规则（register(）已失配`);
if (registerishCount !== regCalls.length) {
  fail(`register 调用数 ${registerishCount} ≠ 抽到的工具名 ${regCalls.length}（有调用写法未被识别，抽取会静默漏名）`);
}
if (regCalls.length !== toolNames.length) {
  fail(`同一工具名被注册了多次：${regCalls.length} 次注册 / ${toolNames.length} 个唯一名`);
}
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

// ── 4) 发布模块的采集契约（审查 #17）──
// 病历：DSH 插件 hooks.mjs 用 recall.js 的 loadConfig / runSync 做「事件驱动即时采集」，
// 而产物只导出 runLifecycle ⇒ 该路恒失败，且失败只在 SRELAY_BRIEF_DEBUG=1 时才可见。
// 静态比对导出列表不够（树摇/构建差异都可能让它在产物里消失），所以这里**真跑一次采集**：
// 从 dist/recall.js 加载 → 临时项目 + 合成 claude-code 会话 → 断言会话与消息真的落库。
{
  const before = failures;
  const distRecall = path.join(ROOT, 'dist', 'recall.js');
  if (!fs.existsSync(distRecall)) {
    fail('dist/recall.js 不存在 —— 这条断言针对发布产物，请先 npm run build');
  } else {
    let mod = null;
    try {
      mod = await import(pathToFileURL(distRecall).href);
    } catch (e) {
      fail(`dist/recall.js 载入失败：${String(e?.message ?? e).slice(0, 140)}`);
    }
    const missing = mod ? ['loadConfig', 'runSync'].filter((k) => typeof mod[k] !== 'function') : [];
    if (mod && missing.length) {
      fail(`dist/recall.js 缺钩子依赖的导出：${missing.join(', ')}（DSH 事件驱动采集会静默停摆）`);
    } else if (mod) {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'srelay-artifact-'));
      try {
        // 临时项目：只开 claude-code 源，并把源目录指到临时目录（绝不碰用户真实 ~/.claude）
        const project = path.join(tmp, 'proj');
        fs.mkdirSync(path.join(project, '.sessionrelay'), { recursive: true });
        fs.writeFileSync(path.join(project, '.sessionrelay', 'config.json'), JSON.stringify({
          version: '1.0',
          capture: { mode: 'full', sources: ['claude-code'], claude_projects_dir: path.join(tmp, 'claude-projects') },
        }, null, 2));
        const slug = project.replace(/[\\/:]/g, '-');           // 与 adapters/claude-code 的 pathSlug 同规则
        const sessDir = path.join(tmp, 'claude-projects', slug);
        fs.mkdirSync(sessDir, { recursive: true });
        const line = (role, text) => JSON.stringify({
          type: role, message: { role, content: text }, timestamp: '2026-10-01T10:00:00Z',
          sessionId: 'sess-artifact', cwd: project, isSidechain: false,
        });
        fs.writeFileSync(path.join(sessDir, 'sess-artifact.jsonl'),
          [line('user', '发布产物采集契约测试'), line('assistant', '这是一次真实 runSync 的落库')].join('\n') + '\n');

        const cfg = mod.loadConfig(project);
        const r = await mod.runSync({ projectRoot: project, config: cfg });
        if (!(r && r.newSessions === 1 && r.newMessages === 2)) {
          fail(`真实产物采集未按预期落库：newSessions=${r?.newSessions} newMessages=${r?.newMessages}`);
        } else {
          // 再用 node:sqlite **独立复核**库文件（runSync 自开自关，这里只读）
          const { DatabaseSync } = await import('node:sqlite');
          const dbf = path.join(project, '.sessionrelay', 'relay.sqlite');
          if (!fs.existsSync(dbf)) {
            fail('采集后没有生成 relay.sqlite');
          } else {
            const db = new DatabaseSync(dbf, { readOnly: true });
            const n = db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n;
            const m = db.prepare('SELECT COUNT(*) AS n FROM messages').get().n;
            db.close();
            if (n !== 1 || m !== 2) fail(`落库复核失败：sessions=${n} messages=${m}（预期 1/2）`);
            else ok('发布模块采集契约：dist/recall.js 的 loadConfig+runSync 真跑一次采集 → 1 会话 / 2 消息落库');
          }
        }
      } catch (e) {
        fail(`真实产物采集异常：${String(e?.message ?? e).slice(0, 160)}`);
      } finally {
        try { fs.rmSync(tmp, { recursive: true, force: true }); }
        catch (e) { console.warn(`⚠ 临时目录清理失败（不影响判定）：${tmp}：${String(e?.message ?? e).slice(0, 80)}`); }
      }
    }
  }
  if (failures === before) ok('采集契约段无新增失败');
}

if (failures > 0) {
  console.error(`\n${failures} 处产物不一致`);
  process.exit(1);
}
console.log('\n产物断言全部通过');
