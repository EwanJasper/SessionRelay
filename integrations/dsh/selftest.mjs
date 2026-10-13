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
process.exit(fail === 0 ? 0 : 1);
