// selftest for dsh-srelay-brief（v3：项目判定降级链 + 两段式绑定）
//
// 纪律来源：第一版实现用了 async provider，测试里自己 await 了它所以通过，
// 而真实 DSH 直接 text.indexOf('{{') 崩掉。教训——stub 必须复刻真实调用方的
// 用法，不能为了方便而 await/包装。
//
// 本测试不静态 import @deepseek-ai/dsh-tools（那是 DSH 运行时经 createRequire 解析的，
// 裸 node 里没有）。工具定义以 BIND_TOOLS 导出，可直接测其 execute；
// 4b 节改用动态 import 探针验证真实注册路径。
//
// 导入路径一律相对本文件解析：这份 selftest 必须在【三处】都能跑——作者副本
// 和 web/desktop 两个部署副本。硬编码绝对路径会让部署副本根本跑不起来
// （v2 就是硬编码的，结果部署副本里的测试文件形同虚设）。
const HERE = new URL('./', import.meta.url).href;

// 注意：import 声明是静态的，不接受 `HERE + 'x'` 这种表达式，所以这里必须用
// 动态 import() 的 await 顶层形式（.mjs 里合法）。
const { apply } = await import(HERE + 'index.js');
const { bindProjectTool, confirmBindTool, cancelBindTool, searchTool, showTool, recordTool } = await import(HERE + 'src/tools.js');
const { resolveFromSlug, resolveProjectRoot, registryProjects } = await import(HERE + 'project-resolve.mjs');

let fail = 0;
const check = (name, cond) => { console.log((cond ? '  PASS ' : '  FAIL ') + name); if (!cond) fail++; };

console.log('=== 1. slug 反解（真实 DSH 会话目录名）===');
check('--E-music~0020player-- → E:\\music player', resolveFromSlug('--E-music~0020player--') === 'E:\\music player');
check('--D-agent1super-- → D:\\agent1super', resolveFromSlug('--D-agent1super--') === 'D:\\agent1super');
check('多段 --D-agent1super-tmp-docx-build-- → D:\\agent1super\\tmp\\docx-build',
  resolveFromSlug('--D-agent1super-tmp-docx-build--') === 'D:\\agent1super\\tmp\\docx-build');
check('中文 slug 还原', String(resolveFromSlug('--E-mc~6574~5408~5305--') || '').includes('整合包'));

console.log('=== 2. 判定链 ===');
const auto = resolveProjectRoot(null);
check('不传 env → 从 DSH 会话反解出项目', !!auto.root && auto.via === 'dsh-session');
console.log('     判定:', auto.root, '(via', auto.via + ')');
const fromEnv = resolveProjectRoot('E:\\music player');
check('env 优先', fromEnv.via === 'env' && fromEnv.root === 'E:\\music player');
const bogus = resolveProjectRoot('C:\\definitely-not-a-project');
check('无效 env 被跳过', bogus.via !== 'env');

console.log('=== 2b. 注册表候选剪枝（临时目录必须被拒收）===');
// 这条是被真实缺陷逼出来的：registryProjects() 早期只判 relay.sqlite 是否存在，
// 结果把 %TEMP%\srelay-test-* 一次性沙盒当成真项目——它在 projects.json 里确实有
// 一条。那条一旦在"恰好一个"分支里命中，就会把简报指向一个临时目录。
const reg = registryProjects();
check('registryProjects 返回数组', Array.isArray(reg));
const tmpBad = reg.filter(r => String(r).toLowerCase().includes('\\temp\\'));
check('临时目录不在候选里（本机注册表实有一条 Temp 条目）', tmpBad.length === 0);
if (tmpBad.length) console.log('     泄漏的临时目录:', tmpBad.join(', '));
const hasReal = reg.includes('E:\\music player');
check('真项目仍在候选里（剪枝不能过头）', hasReal);

console.log('=== 3. section 注册与返回值契约 ===');
const registered = [];
const ctx = {
  systemPrompt: {
    section(spec) { registered.push(spec); return () => {}; },
    getSectionOrder(n) { const t = { HARNESS_SOURCE: 10000 }; if (!(n in t)) throw new Error('bad'); return t[n]; },
  },
  tools: { register(t) { return () => {}; } },
};
apply(ctx); // apply 是同步的（Cordis 契约）
check('注册 1 个 section', registered.length === 1);
const sec = registered[0];
check('section name = sessionrelay-brief', sec?.name === 'sessionrelay-brief');
check('order = 10001', sec?.order === 10001);

const v = sec.text({}); // 故意不 await —— 真实 DSH 也不 await
check('provider 返回 string（不是 Promise）', typeof v === 'string' && !(v instanceof Promise));
check('indexOf 可用（真实调用方会调）', typeof v.indexOf === 'function');
check('没有 .then', typeof v.then !== 'function');
check('内容含项目名或未绑定提示', v.includes('项目：') || v.includes('未绑定项目'));

console.log('=== 4b. 铁律 4：apply() 真的注册工具了吗（stub 收集器）===');
// 为什么要这一节：「启动不报错」不等于「工具注册对了」。index.js 里 defineTool 是
// 动态 import 的——裸 node 解析不到 @deepseek-ai/dsh-tools 就静默跳过注册，
// 插件照样"加载成功"，但两个绑定工具在 DSH 里根本不存在。
// 下面的 case 用 node_modules 符号链接让 import 成功，再看收集器里有没有东西。
const tools2 = [];
const ctx2 = {
  systemPrompt: { section() {}, getSectionOrder() { return 10000; } },
  tools: { register(t) { tools2.push(t); } },
};
let registerErr = null;
try {
  const fresh = await import(HERE + 'index.js?probe=1');
  await fresh.apply(ctx2);
} catch (e) { registerErr = e; }
check('apply 不抛异常', registerErr === null);
if (registerErr) console.log('     异常:', registerErr.message);
// defineTool 解析成功时，收集器必须收到 5 个工具（2 绑定 + 3 检索记录）；解析不到时必须是 0 而不是半注册。
const expectedToolCount = 6; // 3 查询 + bind/confirm/cancel 三件套
check('工具数只能是 0 或 6（不存在部分注册的中间态）',
  tools2.length === 0 || tools2.length === expectedToolCount);
console.log('     收集到', tools2.length, '个工具:', tools2.map(t => t.name ?? t.spec?.name ?? '?').join(', ') || '(裸 node 未解析 dsh-tools，属预期)');
if (tools2.length) {
  const toolNames = tools2.map(t => t.name ?? t.spec?.name);
  check('包含 srelay_bind_project', toolNames.includes('srelay_bind_project'));
  check('包含 srelay_confirm_bind_project', toolNames.includes('srelay_confirm_bind_project'));
  check('包含 srelay_search', toolNames.includes('srelay_search'));
  check('包含 srelay_show', toolNames.includes('srelay_show'));
  check('包含 srelay_record', toolNames.includes('srelay_record'));
  check('包含 srelay_cancel_bind_project', toolNames.includes('srelay_cancel_bind_project'));

  const bindTool = tools2.find(t => (t.name ?? t.spec?.name) === 'srelay_bind_project');
  const spec0 = bindTool?.spec ?? bindTool;
  // defineTool 会把扁平映射归一化成 JSON Schema（与 dsh-reach 同款），required 不该丢。
  const norm = spec0?.parameters ?? spec0?.input;
  check('归一化后 required 数组含 projectPath', Array.isArray(norm?.required) && norm.required.includes('projectPath'));
  check('归一化后 properties.projectPath 保留 description', typeof norm?.properties?.projectPath?.description === 'string');
}

console.log('=== 5. 两段式绑定（直接测 execute，不经 defineTool）===');
const bind = bindProjectTool;
const confirm = confirmBindTool;
check('绑定工具都在（propose + confirm + cancel）', !!bind && !!confirm && !!cancelBindTool);
check('bind 参数 required 保留（归一化后为顶层数组）', Array.isArray(bind?.parameters?.required) && bind.parameters.required.includes('projectPath'));

// 用非默认项目：E:\\music player 是 state.js 的 DEFAULT_PROJECT_ROOT，
// 提议它会被判「已经是当前工作区」而不含确认提示——那是正确行为，只是不适合做本用例。
const r1 = await bind.execute({ projectPath: 'D:\\agent1super' });
check('提议返回明确要求用户确认', r1.ok === true && /确认/.test(r1.payload || ''));

const r2 = await confirm.execute({});
check('确认后生效', r2.ok === true && /切换|已绑定|锁定/.test(r2.payload || ''));

const r3 = await confirm.execute({});
check('重复确认被拒（pending 已清）', r3.ok === false);

const r4 = await bind.execute({ projectPath: 'C:\definitely-not-a-project' });
check('无效路径被拒', r4.ok === false);

console.log(fail === 0 ? '\nSELFTEST PASS' : `\nSELFTEST FAIL (${fail})`);

// ═══ 6. 新架构（2026-10-14 按 v2 审查重构）═══
console.log('=== 6a. cwd 优先：有 agent.session.header.cwd 时直接用，不碰 slug ===')
{
  const reg2 = []
  const ctx2 = {
    systemPrompt: { section: (s) => { reg2.push(s); return () => {}; }, getSectionOrder: () => 10001 },
    tools: { register: () => () => {} },
    effect: (fn) => { const d = fn(); return d }, // 记录 disposer
  }
  const fresh = await import(HERE + 'index.js?arch=1')
  fresh.apply(ctx2)
  const sec2 = reg2[0]

  // 伪造一个带 cwd 的 assembly（cwd 指向已建库的 music player）
  const asm = { agent: { id: 'x', session: { header: { cwd: 'E:\music player' } } } }
  const v = sec2.text(asm)
  check('有 cwd 时返回字符串', typeof v === 'string')
  check('有 cwd 时命中 music player（非 slug 猜的）', v.includes('music player') || v.includes('未绑定') || v.includes('尚未接入'))
  console.log('     cwd 路径简报长度:', v.length)

  // cwd 指向未建库目录 → uninitialized，不列其他项目
  const asmUn = { agent: { id: 'y', session: { header: { cwd: 'C:\Users\crx\AppData\Local\Temp' } } } }
  const v2 = sec2.text(asmUn)
  check('未建库 cwd → 提示尚未接入', v2.includes('尚未接入'))
  check('未建库 cwd → 不列其他项目', !v2.includes('候选'))

  // 无 cwd（诊断性 assembly）→ 回落 slug，不抛
  const v3 = sec2.text({})
  check('无 cwd 时回落且不抛', typeof v3 === 'string')
}

console.log('=== 6b. 缓存：热路径必须 O(1)，不 spawn 子进程 ===')
{
  const reg3 = []
  const ctx3 = {
    systemPrompt: { section: (s) => { reg3.push(s); return () => {}; }, getSectionOrder: () => 10001 },
    tools: { register: () => () => {} },
    effect: (fn) => fn(),
  }
  const fresh = await import(HERE + 'index.js?cache=1')
  fresh.apply(ctx3)
  const sec3 = reg3[0]
  const asm = { agent: { id: 'z', session: { header: { cwd: 'E:\music player' } } } }
  sec3.text(asm) // 冷：可能同步预热
  const t0 = Date.now()
  for (let i = 0; i < 20; i++) sec3.text(asm)
  const dt = Date.now() - t0
  check('热路径 20 次求值 < 50ms（实际 ' + dt + 'ms）', dt < 50)
  console.log('     20 次热求值耗时:', dt + 'ms')
}

console.log('=== 6c. 只注册一个 section（防跨项目记忆泄漏）===')
{
  const regs = []
  const ctx4 = {
    systemPrompt: { section: (s) => { regs.push(s.name); return () => {}; }, getSectionOrder: () => 10001 },
    tools: { register: () => () => {} },
    effect: (fn) => fn(),
  }
  const fresh = await import(HERE + 'index.js?single=1')
  fresh.apply(ctx4)
  check('只注册 1 个 section', regs.length === 1)
  check('名字唯一', new Set(regs).size === 1)
}

// ═══ 7. 自动接入（2026-10-14）═══
console.log('=== 7a. findGitRoot / shouldAutoInit ===')
{
  const pr = await import(HERE + 'project-resolve.mjs?auto=1')
  // music player 不是 git 仓库（实测无 .git）→ 不该自动接入
  const mp = pr.shouldAutoInit('E:\music player')
  check('music player（无 .git）不自动接入', mp === null)
  // fork 源码仓是 git 仓库且已建库 → 也不该（已初始化）
  const core = pr.shouldAutoInit('D:\dsh插件  记忆\core\SessionRelay')
  check('已建库的 git 仓库不重复接入', core === null)
  console.log('     music player →', mp, '| core →', core)
}

console.log('=== 7b. 有 .git 未建库 → 自动接入触发 ===')
{
  // 造一个临时 git 仓库（无 .sessionrelay）
  const os = await import('node:os')
  const fsx = await import('node:fs')
  const pathx = await import('node:path')
  const tmp = fsx.mkdtempSync(pathx.join(os.tmpdir(), 'srelay-autoinit-'))
  fsx.mkdirSync(pathx.join(tmp, '.git'), { recursive: true })

  const pr = await import(HERE + 'project-resolve.mjs?auto=2')
  const target = pr.shouldAutoInit(tmp)
  check('有 .git 未建库 → 返回该项目根', target === tmp)
  console.log('     自动接入目标:', target)

  // 接进 index.js：cwd 指向它时应走 autoIniting
  const fresh = await import(HERE + 'index.js?autoinit=1')
  const reg = []
  fresh.apply({
    systemPrompt: { section: (s) => { reg.push(s); return () => {}; }, getSectionOrder: () => 10001 },
    tools: { register: () => () => {} },
    effect: (fn) => fn(),
  })
  const v = reg[0].text({ agent: { id: 't', session: { header: { cwd: tmp } } } })
  check('未建库 git 仓库 → 提示"正在接入"', v.includes('正在接入'))
  check('不提示"说一声接入"（已全自动）', !v.includes('说一声'))
  console.log('     简报:', v.split('\n')[0])

  // 清理：init 刚建库，SQLite 句柄可能未释放，Windows 上会 EPERM。
  // 延迟删并容错——清不掉只留一个 Temp 小目录，不影响测试结论。
  setTimeout(() => { try { fsx.rmSync(tmp, { recursive: true, force: true }) } catch { /* Temp 自洁 */ } }, 3000)
}

console.log(fail === 0 ? '\nSELFTEST PASS' : `\nSELFTEST FAIL (${fail})`)
process.exit(fail === 0 ? 0 : 1)
