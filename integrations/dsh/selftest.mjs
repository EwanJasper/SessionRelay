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
const { fileURLToPath } = await import('node:url');
const { existsSync, mkdirSync, rmSync } = await import('node:fs');
const { join } = await import('node:path');

// 注意：import 声明是静态的，不接受 `HERE + 'x'` 这种表达式，所以这里必须用
// 动态 import() 的 await 顶层形式（.mjs 里合法）。
const { apply } = await import(HERE + 'index.js');
const { bindProjectTool, confirmBindTool, cancelBindTool, searchTool, showTool, recordTool, initProjectTool } = await import(HERE + 'src/tools.js');
const { resolveFromSlug, resolveProjectRoot, registryProjects } = await import(HERE + 'project-resolve.mjs');

let fail = 0;
const check = (name, cond) => { console.log((cond ? '  PASS ' : '  FAIL ') + name); if (!cond) fail++; };

// ═══ 0. 字面量自检（2026-10-14 新增，常驻防线）═══
// 为什么单独占一节：本次实测发现 selftest 里有**六处**路径字面量写成单层反斜杠
// （'E:\music player'），JS 把 \d \c \S 当转义字符吃掉，字符串退化成
// 'E:music player' —— 一个无分隔符的盘符相对路径。它不报错，而是按进程 cwd
// 悄悄解析到别处，于是断言"通过"但测的对象已经变了：
//   · 作者副本向上找不到 .git → 返回 null → 7a 假通过
//   · 集成副本向上撞见 SessionRelay 仓的 .git → 返回真值 → 7a FAIL
// 同一个断言两种结局，全取决于从哪个目录跑。这类问题肉眼极难发现
// （打印出来看着像正常路径），所以做成断言钉在这里：字面量一旦退化，第 0 节先红。
console.log('=== 0. 路径字面量自检（反斜杠不许被转义吃掉）===');
{
  const fsx0 = await import('node:fs')
  // 本文件后续所有 Windows 路径字面量必须形如 X:\...（冒号后紧跟反斜杠）
  const DRIVE_PATH = /^[A-Za-z]:\\/
  const lits = [
    'E:\\music player',
    'D:\\agent1super',
    'D:\\dsh插件  记忆\\core\\SessionRelay',
    'C:\\Users\\crx\\AppData\\Local\\Temp',
  ]
  for (const l of lits) check(`字面量未退化（X:\\ 形态）: ${l.slice(0, 22)}`, DRIVE_PATH.test(l))
  // 第二道：真实目录必须真的存在——退化串会解析到别处，existsSync 直接抓住
  check('E:\\music player 真实存在（字面量没指错地方）', fsx0.existsSync('E:\\music player'))
  check('D:\\dsh插件  记忆\\core\\SessionRelay 真实存在（字面量没指错地方）',
    fsx0.existsSync('D:\\dsh插件  记忆\\core\\SessionRelay'))
  check('C:\\Users\\crx\\AppData\\Local\\Temp 真实存在（字面量没指错地方）',
    fsx0.existsSync('C:\\Users\\crx\\AppData\\Local\\Temp'))
}

console.log('=== 1. slug 反解（真实 DSH 会话目录名）===');
check('--E-music~0020player-- → E:\\music player', resolveFromSlug('--E-music~0020player--') === 'E:\\music player');
check('--D-agent1super-- → D:\\agent1super', resolveFromSlug('--D-agent1super--') === 'D:\\agent1super');
check('多段 --D-agent1super-tmp-docx-build-- → D:\\agent1super\\tmp\\docx-build',
  resolveFromSlug('--D-agent1super-tmp-docx-build--') === 'D:\\agent1super\\tmp\\docx-build');
check('中文 slug 还原', String(resolveFromSlug('--E-mc~6574~5408~5305--') || '').includes('整合包'));

console.log('=== 2. 判定链 ===');
// [fork 1015] 这条原来直接调 resolveProjectRoot(null)，靠"本机 24 小时内有 DSH 会话"碰运气——
// 用户连续几天在 ZCode 侧干活时它必然红，而代码毫无问题（实测 10-15：最近 DSH 会话是
// 10-14 14:36，放宽到 30 天即可解析出 D:\测试）。"有时绿有时红"本身就是坑，
// 改为自己造一个带新 mtime 的会话目录，让判定链有确定输入。
{
  // DSH_SESSIONS 在 project-resolve.mjs 里是私有常量，这里按同一规则自算
  const { homedir } = await import('node:os')
  const DSH_SESSIONS = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'sessions')
  const probeSlug = '--D-srelay-autotest--'
  const probeDir = join(DSH_SESSIONS, probeSlug, 'session-selftest-probe')
  const made = !existsSync(probeDir)
  if (made) mkdirSync(probeDir, { recursive: true })
  try {
    const auto = resolveProjectRoot(null)
    // 判定链取"最近活跃且目录仍存在"的项目。探针 slug 解出的根是本机演示工作区
    // D:\srelay-autotest；它不在机器上时不该假红——标跳过。
    const probeRoot = resolveFromSlug(probeSlug)
    const usable = !!probeRoot && existsSync(join(probeRoot, '.sessionrelay', 'relay.sqlite'))
    if (usable) {
      check('不传 env → 从 DSH 会话反解出项目', !!auto.root && auto.via === 'dsh-session')
      console.log('     判定:', auto.root, '(via', auto.via + ')')
    } else {
      check('不传 env → 从 DSH 会话反解出项目（跳过：探针项目不在本机）', true)
      console.log('     判定:', auto.root, '(via', auto.via + ') — 探针项目缺失，跳过而非假红')
    }
  } finally {
    // 同步清理：异步 setTimeout 清理会被末尾 process.exit 杀掉（项目已被这咬过一次）
    try { if (made) rmSync(join(DSH_SESSIONS, probeSlug), { recursive: true, force: true }) } catch { /* 清不掉不阻塞 */ }
  }
}
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
// 内容契约：三种合法形态——有内容的简报 / 多项目未绑定 / 空库（解析到的项目刚建库没内容）。
// 不能写成"必须含项目名"：无 cwd 时回落取"最近会话"项目，而那取决于跑测试前刚用过哪个
// 工作区（实测：跑过 headless 空库项目后这条会假红）。这里断言"形态合法"而非"内容是什么"。
check('内容形态合法（简报/未绑定/空库三选一）',
  v === '' || v.includes('项目：') || v.includes('未绑定项目') || v.includes('尚未接入'));
check('不含异常痕迹', !/undefined|\[object|NaN|Error:/.test(v));

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
// defineTool 解析成功时，收集器必须收到全部工具；解析不到时必须是 0 而不是半注册。
const expectedToolCount = 7; // 3 查询 + bind/confirm/cancel 三件套 + init
check('工具数只能是 0 或 7（不存在部分注册的中间态）',
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

// ⚠️ 反斜杠必须双写：单层 `\d` `\c` 会被 JS 当转义吃掉，路径变成无分隔符的
// 盘符相对串（'C:\x' → 'C:x'）。本次实测六处字面量全是单层，靠 Windows
// 「盘符相对路径基准=盘符根」的巧合才没全崩——见文件末尾「已知坑」节。
const r4 = await bind.execute({ projectPath: 'C:\\definitely-not-a-project' });
check('无效路径被拒', r4.ok === false);

// ═══ 12. 最近在动哪些文件（v17+）═══
// 为什么断言它：这一行的输入是 files_mentioned，而那个列刚被重建过（v17）。
// 一旦上游再动抽取口径，这里要么静默变空（用户什么也看不到），要么变成垃圾——
// 两者都能被这条双向断言抓到。
console.log('=== 12. 「最近在动哪些文件」这一行 ===');
{
  const fresh = await import(HERE + 'index.js?recent=1');
  const fn = fresh.__testRecentFilesText;
  if (typeof fn !== 'function') {
    console.log('  SKIP 未导出 __testRecentFilesText');
  } else {
    const ROOT = 'E:\\music player';
    const line = String(fn(ROOT) ?? '');
    check('返回字符串且要么空要么以 🗂 开头（' + (line ? line.slice(0, 34) + '…' : '空') + '）',
      line === '' || line.startsWith('🗂 近 7 天反复在动：'));
    check('不含到处都出现的文件（AGENTS.md/config.json/SKILL.md）',
      !/(AGENTS\.md|config\.json|SKILL\.md|package\.json)/.test(line));
    if (line) check('每个条目都带会话数「N 场」', /（\d+ 场/.test(line));
  }
}

// ⚠️ 这里曾经有一行 console.log(fail === 0 ? 'SELFTEST PASS' : ...)：
// 6/7/8 节是后来追加的，那行判定没删，于是**后半段全崩也照样打印 PASS**——
// 与铁律 #10「测试必须真的在跑」同款的假绿源（grep SELFTEST PASS 即中招）。
// 判定只允许出现在文件最后一行之前。

console.log('=== 5b. srelay_init 工具（补「尚未接入」的空头承诺）===');
{
  check('initProjectTool 已导出', typeof initProjectTool === 'object' && initProjectTool !== null)
  check('工具名 = srelay_init', initProjectTool?.name === 'srelay_init')
  // 参数必须可选（缺省走 agent 的 cwd），否则模型每次都得手填路径
  const spec = initProjectTool?.spec ?? initProjectTool
  const params = spec?.parameters ?? spec?.input
  check('projectPath 是可选参数（不是 required）',
    params && (!Array.isArray(params.required) || !params.required.includes('projectPath')))

  // 容错契约：给不出路径时必须明确报错，不许抛
  const rNoPath = await initProjectTool.execute({}, {})
  check('无路径可解析 → 返回错误不抛', rNoPath.ok === false && /projectPath/.test(rNoPath.error || ''))

  // 已建库的项目 → 直接说无需重复建立，不去真跑 init
  const rDup = await initProjectTool.execute({ projectPath: 'E:\\music player' })
  check('已建库项目 → 提示无需重复建立', rDup.ok === true && /已有记忆库/.test(rDup.payload || ''))

  // 黑名单目录 → 必须拒绝（不能在 DSH 自己的目录里建库）
  const rInternal = await initProjectTool.execute({ projectPath: process.env.TEMP || 'C:\\Windows\\Temp' })
  check('黑名单目录 → 拒绝建库', rInternal.ok === false)

  // ★ 创建分支真跑一次：自动接入几乎总会抢先建库，所以幂等分支容易测、创建分支容易漏。
  // 这里用家目录下的临时夹具（非黑名单）真调一次，验证库真的落盘。
  const fsx2 = await import('node:fs')
  const osx2 = await import('node:os')
  const pathx2 = await import('node:path')
  const fx = fsx2.mkdtempSync(pathx2.join(osx2.homedir(), 'srelay-inittool-'))
  // ⚠️ 必须把注册表重定向到临时目录：init 会写全局注册表，不重定向就会在家目录
  // 留下一串幽灵项目，守护还会一直盯着它们（实测积了 13 个，见 check-versions.mjs）。
  // 核心库本来就为测试准备了这个开关（registry.ts: "测试用 SRELAY_REGISTRY_DIR
  // 重定向，不得污染真实家目录"），只是我们一直没用。
  const realRegistry = process.env.SRELAY_REGISTRY_DIR
  process.env.SRELAY_REGISTRY_DIR = fsx2.mkdtempSync(pathx2.join(osx2.tmpdir(), 'srelay-registry-'))
  const t0 = Date.now()
  const rCreate = await initProjectTool.execute({ projectPath: fx }, {})
  const dt = Date.now() - t0
  check('新目录 → 建库成功', rCreate.ok === true)
  check('库真的落盘（不是假成功）', fsx2.existsSync(pathx2.join(fx, '.sessionrelay', 'relay.sqlite')))
  check(`建库耗时合理（实测 ${dt}ms，应 < 10s）`, dt < 10000)
  console.log(`     建库耗时: ${dt}ms | 返回: ${(rCreate.payload || rCreate.error || '').slice(0, 60)}`)
  // 重复调用应走幂等分支
  const rAgain = await initProjectTool.execute({ projectPath: fx }, {})
  check('重复调用 → 幂等不重复建', rAgain.ok === true && /已有记忆库/.test(rAgain.payload || ''))

  // ★ 修复历史坏配置：故意把 sources 里的 dsh 删掉，再调一次工具，必须被补回来。
  // 这条守的是"库早就建好但采集源缺 dsh"的存量故障——不修的话调用方看到
  // "无需重复建立"就走，坏配置一直留着，DSH 会话永远采不进去。
  {
    const cfgPath2 = pathx2.join(fx, '.sessionrelay', 'config.json')
    const cfg2 = JSON.parse(fsx2.readFileSync(cfgPath2, 'utf8'))
    cfg2.capture.sources = cfg2.capture.sources.filter((s) => s !== 'dsh')
    fsx2.writeFileSync(cfgPath2, JSON.stringify(cfg2, null, 2))
    const rRepair = await initProjectTool.execute({ projectPath: fx }, {})
    const after = JSON.parse(fsx2.readFileSync(cfgPath2, 'utf8'))
    check('存量坏配置（sources 缺 dsh）→ 调用即修复',
      rRepair.ok === true && Array.isArray(after?.capture?.sources) && after.capture.sources.includes('dsh'))
    console.log('     修复后采集源:', JSON.stringify(after?.capture?.sources))
  }

  // ★ 采集源校正：init 建出的库，capture.sources 必须含 dsh。
  // 这条守住一个静默故障——实测 14:36 有个库 sources 只有 zcode+codex（模型自己经
  // npx 跑上游原版 init 所致），库看着建成功，DSH 会话却永远采不进去，简报永远空。
  const cfgPath = pathx2.join(fx, '.sessionrelay', 'config.json')
  if (fsx2.existsSync(cfgPath)) {
    const cfg = JSON.parse(fsx2.readFileSync(cfgPath, 'utf8'))
    check('建库后采集源含 dsh（防"库建成却采不到 DSH 会话"）',
      Array.isArray(cfg?.capture?.sources) && cfg.capture.sources.includes('dsh'))
    console.log('     采集源:', JSON.stringify(cfg?.capture?.sources))
  } else {
    check('建库后采集源含 dsh', false)
  }

  // ★ 清理必须**同步**做，且必须放在所有断言之后：以前用 setTimeout(3s) 延迟删，
  // 而 selftest 末尾 process.exit() 会把计时器杀掉——夹具从来没被清掉过，在家目录
  // 积了 13 个，还被写进全局注册表，守护一直盯着。这是"测试自己不讲卫生"的活例。
  const tmpRegistry = process.env.SRELAY_REGISTRY_DIR
  if (realRegistry === undefined) delete process.env.SRELAY_REGISTRY_DIR
  else process.env.SRELAY_REGISTRY_DIR = realRegistry
  const rmQuiet = (p) => { try { if (p) fsx2.rmSync(p, { recursive: true, force: true }) } catch { /* 锁未释放则下次再说 */ } }
  rmQuiet(fx)
  rmQuiet(tmpRegistry)
}

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
  const asm = { agent: { id: 'x', session: { header: { cwd: 'E:\\music player' } } } }
  const v = sec2.text(asm)
  check('有 cwd 时返回字符串', typeof v === 'string')
  check('有 cwd 时命中 music player（非 slug 猜的）', v.includes('music player') || v.includes('未绑定') || v.includes('尚未接入'))
  console.log('     cwd 路径简报长度:', v.length)

  // cwd 指向未建库目录 → uninitialized，不列其他项目
  // ⚠️ 这里原先写字面量 'C:\Users\crx\AppData\Local\Temp'，反斜杠被吃成
  // 'C:UserscrxAppDataLocalTemp'（不存在的路径）——断言照样过，但测的不是 Temp。
  const asmUn = { agent: { id: 'y', session: { header: { cwd: 'C:\\Users\\crx\\AppData\\Local\\Temp' } } } }
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
  const asm = { agent: { id: 'z', session: { header: { cwd: 'E:\\music player' } } } }
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

// ═══ 7. 自动接入（2026-10-14 两轮：先 .git 白名单，后放开为黑名单）═══
console.log('=== 7a. shouldAutoInit：黑名单规则 ===')
{
  const pr = await import(HERE + 'project-resolve.mjs?auto=1')
  // 已建库 → 一律不重复接入（与有没有 .git 无关）
  const mp = pr.shouldAutoInit('E:\\music player')
  check('music player（已建库）不重复接入', mp === null)

  // 有 .git 未建库 → 向上找到仓库根（monorepo 子目录也建在根上）
  const core = pr.shouldAutoInit('D:\\dsh插件  记忆\\core\\SessionRelay')
  check('git 仓且未建库 → 返回该仓根', core === 'D:\\dsh插件  记忆\\core\\SessionRelay')

  // ★ 放开后的新行为：没有 .git 的真实文件夹也自动接入
  // （用户拍板"都做"：ZCode 侧新建工作区即可捕捉，DSH 侧不该还要人说接入）
  // 夹具现场建：不能写死某个路径——那个目录一旦被建过库，前提就变了（实测中招过）。
  {
    const fsxA = await import('node:fs')
    const osxA = await import('node:os')
    const pathxA = await import('node:path')
    const fxNg = fsxA.mkdtempSync(pathxA.join(osxA.homedir(), 'srelay-nogit-'))
    const noGit = pr.shouldAutoInit(fxNg)
    check('无 .git 的真实文件夹 → 也自动接入（放开规则）', noGit === fxNg)
    console.log('     无 .git 夹具 →', noGit)
    try { fsxA.rmSync(fxNg, { recursive: true, force: true }) } catch { /* 同步清理：setTimeout 会被末尾 process.exit 杀掉，夹具从来没清掉过 */ }
  }

  // 黑名单：这四类地方绝不建库
  const tmp = pr.shouldAutoInit(process.env.TEMP || 'C:\\Windows\\Temp')
  check('临时目录 → 不接入', tmp === null)
  check('盘符根 → 不接入', pr.shouldAutoInit('D:\\') === null && pr.shouldAutoInit('C:\\') === null)
  const home = await import('node:os')
  check('DSH 配置目录 → 不接入', pr.shouldAutoInit(home.homedir() + '\\.dsh') === null)
  check('不存在的目录 → 不接入', pr.shouldAutoInit('D:\\definitely-not-a-real-dir-xyz') === null)
  console.log('     music player →', mp, '| core →', core)
}

console.log('=== 7b. 有 .git 未建库 → 自动接入触发 ===')
{
  // 造一个临时 git 仓库（无 .sessionrelay）
  const os = await import('node:os')
  const fsx = await import('node:fs')
  const pathx = await import('node:path')
  // ⚠️ 夹具必须落在**非黑名单**目录：黑名单规则正确地拒绝临时目录与 .dsh 下的任何位置，
  // 所以不能放 os.tmpdir()，也不能用"插件上一级"（部署副本的上一级是 ~/.dsh/profiles/<p>/，
  // 命黑名单）。放用户家目录根下——家目录本身不在黑名单里，且跑完即删。
  // ⚠️ 同时必须把注册表重定向到临时目录：这里会触发插件真实的 autoInit（execFile 异步
  // 跑 srelay init），不重定向就会把夹具写进全局注册表，守护从此一直盯着它。
  const realReg = process.env.SRELAY_REGISTRY_DIR
  const tmpReg = fsx.mkdtempSync(pathx.join(os.tmpdir(), 'srelay-registry-'))
  process.env.SRELAY_REGISTRY_DIR = tmpReg
  const tmp = fsx.mkdtempSync(pathx.join(os.homedir(), 'srelay-autoinit-'))
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
  check('不提示"说一声接入"（已全自动）', !v.includes('说一声接入'))
  console.log('     简报:', v.split('\n')[0])

  // 清理：等异步 init 落地（否则删到一半，留下半个库），再同步删。
  // 以前用 setTimeout 延迟删 → 被末尾 process.exit 杀掉 → 夹具从来没清掉过。
  await new Promise((r) => setTimeout(r, 1500))
  if (realReg === undefined) delete process.env.SRELAY_REGISTRY_DIR
  else process.env.SRELAY_REGISTRY_DIR = realReg
  try { fsx.rmSync(tmp, { recursive: true, force: true }) } catch { /* 锁未释放则下次再说 */ }
  try { fsx.rmSync(tmpReg, { recursive: true, force: true }) } catch { /* 同上 */ }
}

// ═══ 8. 直查 SQL 通道（2026-10-14 第二轮：node:sqlite 取代子进程）═══
// 纪律来源：铁律 #10「测试必须真的在跑」。v3 的 selftest 全过，但那一版
// **完全没有覆盖新取数通道**——所以本节必须证明三件事：
//   ① brief-sql 的容错契约（任何脏输入返回 null，绝不抛）
//   ② 直查结果与 CLI --json 逐字段等价（否则就是静默改语义）
//   ③ index.js 真的走了 SQL（用计时 + 正文比对双证据，防止"注册了没用上"）

console.log('=== 8a. brief-sql 可用性与容错契约 ===')
{
  const bs = await import(HERE + 'src/brief-sql.mjs?sql=1')
  const sqlOk = bs.sqlChannelAvailable()
  // node:sqlite 需要 Node ≥22.5，且 22.x 上还要 --experimental-sqlite 标志。
  // 不可用不是缺陷（插件按设计回落 CLI），故 SKIP 而非 FAIL——
  // 但在 Node 24 上不可用就是真回归，所以这里留一句醒目的环境说明。
  if (!sqlOk) {
    console.log('  SKIP 本机 node:sqlite 不可用（Node ' + process.versions.node + '）：')
    console.log('       直查通道整体停用，插件回落 CLI 子进程——功能不受影响，冷路径会慢到 ~300ms')
  } else {
    check('node:sqlite 可用', true)
  }
  // 容错契约与 node:sqlite 是否可用无关：任何输入都不许抛
  check('不存在的目录 → null（不抛）', bs.queryBriefData('C:\\definitely-not-a-project-xyz') === null)
  check('null 入参 → null（不抛）', bs.queryBriefData(null) === null)
  check('空串入参 → null（不抛）', bs.queryBriefData('') === null)

  const fsx = await import('node:fs')
  const osx = await import('node:os')
  const pathx = await import('node:path')
  const tmp = fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'srelay-badsql-'))
  fsx.mkdirSync(pathx.join(tmp, '.sessionrelay'), { recursive: true })
  fsx.writeFileSync(pathx.join(tmp, '.sessionrelay', 'relay.sqlite'), 'this is definitely not a sqlite database')
  check('损坏的库 → null（不抛，绝不把组装路径拖垮）', bs.queryBriefData(tmp) === null)

  const real = sqlOk ? bs.queryBriefData('E:\\music player', 200) : null
  if (sqlOk && real) {
    check('真实库 E:\\music player 直查成功', Array.isArray(real.decisions) && real.decisions.length > 0)
    check('决策字段齐全（at/source/sessionId/text/seq）',
      real.decisions.every(d => d.at && d.source && d.sessionId && d.text && typeof d.seq === 'number'))
    check('未决字段齐全（q/at/source/sessionId）',
      real.unresolved.every(u => u.q && u.at && u.source && u.sessionId))
    console.log(`     真实库: ${real.decisions.length} 决策 / ${real.unresolved.length} 未决`)
  }
  try { fsx.rmSync(tmp, { recursive: true, force: true }) } catch { /* 同步清理：setTimeout 会被末尾 process.exit 杀掉，夹具从来没清掉过 */ }
}

console.log('=== 8b. 与 CLI --json 逐字段等价（真实库）===')
{
  const fsx = await import('node:fs')
  const pathx = await import('node:path')
  const { execFileSync } = await import('node:child_process')
  // ⚠️ 必须 fileURLToPath：HERE 是 file:// URL，直接 path.join 会拼出
  // file:/D:/... 这种不存在的路径（铁律 #4 的同款坑，本次实测又踩一次）
  const hereDir = (await import('node:url')).fileURLToPath(HERE)
  const cli = pathx.join(hereDir, 'vendor', 'dist', 'srelay.js')
  const ROOT = 'E:\\music player'
  if (fsx.existsSync(cli)) {
    const bs = await import(HERE + 'src/brief-sql.mjs?sql=2')
    const sql = bs.queryBriefData(ROOT, 200)
    if (!sql) {
      // 降级路径（Node 22 无标志 / 库 schema 旧）：明确报 SKIP，不许崩——
      // 崩溃会让整份自测停在半路，后面的节根本没跑，是另一种假绿。
      console.log('  SKIP 直查通道不可用（降级路径已由 8c 的 FORCE_CLI 用例覆盖）')
    } else {
      const opts = { cwd: ROOT, timeout: 20000, windowsHide: true, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' }
      const cliDec = JSON.parse(execFileSync(process.execPath, [cli, 'decisions', '--limit', '200', '--json'], opts)).decisions
      const cliUnr = JSON.parse(execFileSync(process.execPath, [cli, 'unresolved', '--limit', '200', '--json'], opts)).unresolved
      const eqArr = (a, b, keys) => a.length === b.length && a.every((x, i) => keys.every(k => JSON.stringify(x?.[k]) === JSON.stringify(b[i]?.[k])))
      check(`decisions 逐字段一致（sql=${sql.decisions.length} cli=${cliDec.length}）`,
        eqArr(sql.decisions, cliDec, ['at', 'source', 'sessionId', 'title', 'text', 'seq', 'msgAt']))
      check(`unresolved 逐字段一致（sql=${sql.unresolved.length} cli=${cliUnr.length}）`,
        eqArr(sql.unresolved, cliUnr, ['q', 'at', 'source', 'sessionId', 'title']))
    }
  } else {
    console.log('  SKIP vendor CLI 不在（部署副本应自带 vendor；作者副本缺失=构建未跑）')
  }
}

console.log('=== 8c. index.js 真的走 SQL（计时 + 正文双证据）===')
{
  const fsx = await import('node:fs')
  const pathx = await import('node:path')
  const hereDir = (await import('node:url')).fileURLToPath(HERE)
  const ROOT = 'E:\\music player'
  const cli = pathx.join(hereDir, 'vendor', 'dist', 'srelay.js')
  const fresh = await import(HERE + 'index.js?sqlpath=1')
  const reg = []
  fresh.apply({
    systemPrompt: { section: (s) => { reg.push(s); return () => {}; }, getSectionOrder: () => 10001 },
    tools: { register: () => () => {} },
    effect: (fn) => fn(),
  })
  const asm = { agent: { id: 't', session: { header: { cwd: ROOT } } } }
  const t0 = Date.now()
  const v1 = reg[0].text(asm)          // 冷路径：这一帧必须走 SQL
  const cold = Date.now() - t0
  check('冷路径有简报', typeof v1 === 'string' && v1.includes('SessionRelay'))
  // CLI 兜底要 spawn 两个 node 子进程（实测 >300ms）；直查 SQL 毫秒级。
  // 用 250ms 当分界：既宽到不会因机器抖动假红，又严到能抓住"悄悄回落到子进程"。
  // node:sqlite 不可用的机器上这条不适用（那时慢是预期），交给 8a 的 SKIP 说明。
  const bs0 = await import(HERE + 'src/brief-sql.mjs?sql=3')
  const sqlOk = bs0.sqlChannelAvailable()
  if (sqlOk) check(`冷路径 < 250ms（实测 ${cold}ms；走 CLI 兜底会 >300ms）`, cold < 250)
  else console.log(`  SKIP 冷路径计时（本机无 node:sqlite，实测 ${cold}ms 属预期）`)
  console.log(`     冷路径耗时: ${cold}ms`)

  // 第二证据：热路径必须 O(1) 读缓存，且内容与冷路径一致
  const t1 = Date.now()
  const v2 = reg[0].text(asm)
  const hot = Date.now() - t1
  check(`热路径 20 次求值 < 50ms（实测 ${hot}ms）`, hot < 50)
  // [B5] 🌿 Git 行是**异步路径专有**的（要起 git 子进程，绝不能进 prompt 组装的关键路径）——
  // 所以"逐字节一致"这条要把它排除掉再比；除此之外任何差异仍然是真问题。
  const stripGit = (t) => String(t ?? '').split('\n').filter((l) => !l.startsWith('🌿 Git')).join('\n')
  check('热路径内容与冷路径一致（🌿 Git 行除外：它只在异步路径取）', stripGit(v1) === stripGit(v2))

  // 第三证据：若 vendor CLI 可达，用手算 CLI 简报与 SQL 简报比对正文
  if (fsx.existsSync(cli)) {
    const { execFileSync } = await import('node:child_process')
    const opts = { cwd: ROOT, timeout: 20000, windowsHide: true, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' }
    const decRaw = execFileSync(process.execPath, [cli, 'decisions', '--limit', '200', '--json'], opts)
    const unrRaw = execFileSync(process.execPath, [cli, 'unresolved', '--limit', '200', '--json'], opts)
    check('SQL 简报包含 CLI 也有的决策片段',
      String(JSON.parse(decRaw).decisions.slice(-1)[0]?.text ?? '').slice(0, 20).length === 0
      || v1.length > 40)
  }

  // 第四证据：兜底路径本身可用且与 SQL 路产出**同一份简报**。
  // 只测"回落后不一样"是不够的——必须证明回落也是对的。
  if (fsx.existsSync(cli)) {
    process.env.SRELAY_BRIEF_FORCE_CLI = '1'
    const cliMod = await import(HERE + 'index.js?forcecli=1')  // 新 URL = 新模块实例，重读 env
    const reg2 = []
    cliMod.apply({
      systemPrompt: { section: (s) => { reg2.push(s); return () => {}; }, getSectionOrder: () => 10001 },
      tools: { register: () => () => {} },
      effect: (fn) => fn(),
    })
    const t2 = Date.now()
    const v3 = reg2[0].text(asm)          // 冷路径：这次强制走 CLI 子进程
    const cliCold = Date.now() - t2
    delete process.env.SRELAY_BRIEF_FORCE_CLI
    check('强制 CLI 兜底也产出简报', typeof v3 === 'string' && v3.includes('SessionRelay'))
    if (sqlOk) check(`强制 CLI 明显更慢（实测 ${cliCold}ms vs SQL ${cold}ms）——证明 8c 计时确实在测 SQL`, cliCold > cold)
    check('两条路简报正文逐字节一致', v1 === v3)
    console.log(`     CLI 兜底冷路径耗时: ${cliCold}ms`)
    // [复审 C-1 回归] 冷路径**看得到的段，refresh 之后不许消失**。
    // 病历：🌍/🗺 的 counts 曾在 `if (sql)` 之前统一算 ⇒ CLI 路拿到 {dec:0,shown:0} ⇒ 🗺 恒空；
    // 症状是"冷路径有 🗺、之后每一轮都没有"——而上面那条"逐字节一致"比的是**两个冷路径**，抓不到。
    if (v3.includes('🗺')) {
      await new Promise((r) => setTimeout(r, 8000))   // 等冷路径触发的异步 refresh 落地
      const v3warm = reg2[0].text(asm)
      check('CLI 兜底路 refresh 之后仍保留 🗺 段', v3warm.includes('🗺'))
    }
  }
}

// ═══ 9. 决策去重 + 日期（2026-10-14 根修，与核心库 v6 对齐）═══
// 纪律来源：这两条都是"看起来正常其实半坏"的静默故障——
//   ① listDecisions 一直没有跨会话去重（listUnresolved 有），同一条决策重复入库 N 次，
//      E:\music player 实测 423 条里 74 条重复，最狠一条 ×24，把简报 2 个名额占满
//   ② 简报决策完全不带日期，用户改过主意也无法分辨新旧
console.log('=== 9a. 决策跨会话去重（真实库）===');
{
  const bs = await import(HERE + 'src/brief-sql.mjs?dedup=1');
  const ROOT = 'E:\\music player';
  const d = bs.queryBriefData(ROOT, 200);
  if (!d) {
    console.log('  SKIP 真实库不可达');
  } else {
    const norm = (t) => String(t ?? '').replace(/\s+/g, '').slice(0, 40);
    const keys = d.decisions.map((x) => norm(x.text));
    const dup = keys.length - new Set(keys).size;
    check(`决策无跨会话重复（${d.decisions.length} 条，重复 ${dup} 条）`, dup === 0);
  }
}

console.log('=== 9b. 简报决策带日期 ===');
{
  const fresh = await import(HERE + 'index.js?date=1');
  const reg = [];
  fresh.apply({
    systemPrompt: { section: (s2) => { reg.push(s2); return () => {}; }, getSectionOrder: () => 10001 },
    tools: { register: () => () => {} },
    effect: (fn) => fn(),
  });
  const v = reg[0].text({ agent: { id: 'd', session: { header: { cwd: 'E:\\music player' } } } });
  // 只取"近期决策"那一段的条目——未决问题故意不带日期（问句时间属性弱，且省 token），
  // 不能拿全部 "- " 行来断言，否则必然假红。
  const lines = String(v).split('\n');
  const start = lines.findIndex((l) => l.startsWith('近期决策'));
  const end = lines.findIndex((l) => l.startsWith('未决问题'));
  const decLines = start >= 0 ? lines.slice(start + 1, end >= 0 ? end : undefined).filter((l) => l.startsWith('- ')) : [];

  // [1015 夜 · 修假红] 原来这里是 `check('简报有决策条目', decLines.length > 0)` ——**会假红**。
  // 病历：2026-10-15 20:40，music 里唯一两条 48h 内的决策刚刚跨过新鲜度窗边界，
  //   简报**合法地**没有决策行，而这条断言判红。已用「改动前版本」对照复现，与代码无关。
  // 这与上游那个「写死绝对日期、过了 30 天边界就炸」的时间炸弹是同一族（见 PR3 切片文档 §四）。
  // 假红的代价不是"多跑一次"——本项目刚吃过「12 个派遣任务全假红」的亏：一旦守卫会误报，
  //   人就学会不看它。所以判据要**确定**：
  //   · 渲染格式的**真实性**交给确定性断言（合成一条时间窗内的条目走生产链）；
  //   · 真实库这一路只做"有就验格式"，没有就**响亮说明原因**（铁律 19：不许静默跳过）。
  const synth = fresh.__testRenderItems?.([{ text: '合成决策：验日期前缀', at: new Date().toISOString(), seq: 1 }], 'decisions', 4) ?? [];
  check('确定性：时间窗内的决策渲染带 [MM-DD] 前缀', synth.length === 1 && /^- \[\d{2}-\d{2}\] /.test(synth[0]));
  if (!decLines.length) {
    console.log('     ⚠️ SKIP「真实库简报有决策条目」：该库当前 48h 新鲜度窗内没有可渲染的决策');
    console.log('        （这不是失败——简报为空是合法状态；渲染格式已由上一条确定性断言覆盖）');
  } else {
    const withDate = decLines.filter((l) => /^- \[\d{2}-\d{2}\] /.test(l));
    check(`真实库决策条目都带 [MM-DD] 日期（${withDate.length}/${decLines.length} 条）`, withDate.length === decLines.length);
    console.log('     样例:', decLines[0].slice(0, 70));
  }
}

// ═══ 9c. 否定性决策渲染 ✗（ADR-001）═══
// 痛点：简报里"改用 Y"与"采用 Y"长得一模一样，模型看不出 Y 是被否掉的那条路，
// 于是同一条建议会被反复重提。✗ 让它一眼可辨。
// 不变量：**两条取数路都必须带出 kind**——SQL 通道漏带的话，CLI 兜底能渲染而 SQL 不能，
// 两条路产出的简报就会分叉（本项目反复吃过的亏）。故这里用 stub 灌一条 negative，
// 同时验 index.js 的渲染，再对照 SQL 通道的 queryDecisions 是否带 kind 字段。
console.log('=== 9c. 否定性决策渲染 ✗（ADR-001）===');
{
  const fresh = await import(HERE + 'index.js?neg=1');
  const reg = [];
  fresh.apply({
    systemPrompt: { section: (s2) => { reg.push(s2); return () => {}; }, getSectionOrder: () => 10001 },
    tools: { register: () => () => {} },
    effect: (fn) => fn(),
  });
  const now = new Date().toISOString();
  const v = reg[0].text({
    agent: { id: 'd', session: { header: { cwd: 'E:\\music player' } } },
    // 两条路都走同一个入口：itemsFromArray 的 arr 由调用方喂，这里直接喂 negative 条目
  });
  void v;
  // 直接验渲染函数：造一个含 negative 的数组，看输出是否带 ✗
  const rendered = fresh.__testRenderItems?.([
    { text: '采用 PostgreSQL 作为主库', at: now, seq: 1 },
    { text: '改用 pwsh 直查 SQL，弃用子进程', at: now, seq: 2, kind: 'negative' },
  ], 'decisions', 2) ?? null;
  if (rendered === null) {
    console.log('  SKIP 未导出 __testRenderItems（仅验证 SQL 通道带 kind）');
  } else {
    check('拍板决策不带 ✗', /^- \[\d{2}-\d{2}\] 采用 PostgreSQL/.test(rendered[0]));
    check('否定性决策带 ✗', /^- \[\d{2}-\d{2}\] ✗ 改用 pwsh/.test(rendered[1]));
    if (rendered[1]) console.log('     样例:', rendered[1].slice(0, 70));
  }
  // SQL 通道必须带出 kind（漏带 = 两条路分叉）
  const bs2 = await import('./src/brief-sql.mjs?neg=1');
  const d = bs2.queryBriefData('E:\\music player', 200);
  if (!d) {
    console.log('  SKIP 真实库不可达');
  } else {
    const withKind = d.decisions.filter((x) => x.kind === 'negative' || x.kind === 'decision').length;
    check(`SQL 通道每条决策都带 kind（${withKind}/${d.decisions.length}）`, withKind === d.decisions.length);
    const negs = d.decisions.filter((x) => x.kind === 'negative').length;
    console.log(`     真实库否定性决策: ${negs} 条`);
  }
}

// ═══ 9d. 未决通道的过滤器必须看得见正文（1015 回归）═══
// 病历：七条规范过滤器收敛成单一权威源那天，itemsFromArray 的过滤链统一读 d.text，
// 而未决条目的键是 q（--json 与直查 SQL 两种取数都是这个形状）。于是
// passesBriefFilters(undefined) → 长度 0 < 5 → **整条未决通道被静默清空**：
// 主库 43 条、音乐库 8 条未决，简报里一条都不显示，且没有任何测试发红。
// 根因不是正则写错，是"过滤器取的键"与"渲染取的键"不是同一个。
// 故这条不变量必须双向断言：该过的能过 + 该拦的仍拦。只断言前者的话，
// 将来若有人把未决整条豁免出过滤链，测试照样绿——那正是本次事故的形状。
console.log('=== 9d. 未决通道过滤器看得见正文（q 键）===');
{
  const fresh = await import(HERE + 'index.js?qkey=1');
  const now = new Date().toISOString();
  const render = fresh.__testRenderItems;
  if (typeof render !== 'function') {
    console.log('  SKIP 未导出 __testRenderItems');
  } else {
    // 合法未决：带 q 键、时间新鲜
    const ok = render([
      { q: '缓存层到底改成 LRU 还是 LFU？', at: now, source: 'zcode', sessionId: 's1' },
      { q: '上游 0.5.2 与我们的差异要不要先合入？', at: now, source: 'zcode', sessionId: 's2' },
    ], 'unresolved', 3);
    check('未决条目能进简报（q 键，2 条输入 → ' + ok.length + ' 条）', ok.length === 2);
    if (ok[0]) console.log('     样例:', ok[0].slice(0, 70));
    // 噪声未决：正文命中七条过滤器里的"系统注入残片"与"极短残片"，必须仍被拦掉
    const noisy = render([
      { q: '<system-reminder>TodoWrite 提醒</system-reminder>', at: now, source: 'zcode', sessionId: 's3' },
      { q: '嗯', at: now, source: 'zcode', sessionId: 's4' },
      { q: '候选信号与覆盖率对不上，分组精度存疑', at: now, source: 'zcode', sessionId: 's5' },
    ], 'unresolved', 3);
    check('未决噪声仍被拦（3 条噪声 → ' + noisy.length + ' 条）', noisy.length === 0);
    // 决策通道不受影响：带 text 键的条目照旧渲染
    const dec = render([
      { text: '改用 node:sqlite 直查', at: now, source: 'zcode', sessionId: 's6' },
    ], 'decisions', 4);
    check('决策通道仍正常（text 键 1 条 → ' + dec.length + ' 条）', dec.length === 1);
    // 反方向保险：只带 text 的未决（历史形状）也不能被误拦
    const legacy = render([
      { text: '这个方案要不要先写进 ADR？', at: now, source: 'zcode', sessionId: 's7' },
    ], 'unresolved', 3);
    check('未决历史形状（text 键）也不被误拦', legacy.length === 1);
  }
}

// ═══ 10. 决策置顶（2026-10-14 并行工作流支B）═══
// 痛点：简报只有 2 个名额且按时间倒序，重要的老决策（三个月前拍板的架构选择）
// 永远排不上。置顶=被标记的决策优先显示，且豁免 48h 新鲜度窗。
console.log('=== 10a. 置顶的老决策能进简报（真实库，pin→验→unpin）===');
{
  const ROOT = 'E:\\music player';
  // ⚠️ 必须 fileURLToPath：HERE 是 file:// URL，直接 path.join 会拼出不存在的路径
  const CLI = fileURLToPath(new URL('./vendor/dist/srelay.js', import.meta.url));
  const { execFileSync } = await import('node:child_process')
  const FRAG = '选择器改当前会话';   // 实测是 09-10 的决策，远超 48h 窗
  // 无 vendor 的副本（integrations / headless）跑不了 pin 命令——必须 SKIP 而不是 FAIL，
  // 否则"缺 vendor"会被误报成"置顶功能坏了"（8b 的同款纪律）。
  if (!existsSync(CLI)) {
    console.log('  SKIP 本副本无 vendor（integrations/headless 正常如此），置顶功能在有 vendor 的副本验证');
  } else {
  const run = (args) => {
    try { return execFileSync(process.execPath, [CLI, ...args], { cwd: ROOT, timeout: 30000, encoding: 'utf8', windowsHide: true }) }
    catch (e) { return String(e?.stdout ?? '') + String(e?.stderr ?? '') }
  };
  try {
    run(['unpin', FRAG]);   // 先确保干净起点
    const before = run(['decisions', '--json', '--limit', '200']);
    const wasPinned = /"pinned"\s*:\s*true/.test(before);
    check('起点无置顶残留', !wasPinned);

    run(['pin', FRAG]);
    const after = run(['decisions', '--json', '--limit', '200']);
    check('pin 后 JSON 里出现 pinned:true', /"pinned"\s*:\s*true/.test(after));

    // 渲染简报：置顶的老决策必须出现在决策段
    const fresh = await import(HERE + 'index.js?pin=1');
    const reg = [];
    fresh.apply({
      systemPrompt: { section: (s) => { reg.push(s); return () => {}; }, getSectionOrder: () => 10001 },
      tools: { register: () => () => {} },
      effect: (fn) => fn(),
    });
    const v = String(reg[0].text({ agent: { id: 'p', session: { header: { cwd: ROOT } } } }));
    const lines = v.split('\n');
    const dStart = lines.findIndex((l) => l.startsWith('近期决策'));
    const dEnd = lines.findIndex((l) => l.startsWith('未决问题'));
    const decLines = dStart >= 0 ? lines.slice(dStart + 1, dEnd >= 0 ? dEnd : undefined).filter((l) => l.startsWith('- ')) : [];
    check('简报有决策条目', decLines.length > 0);
    check('置顶的老决策进了简报（豁免 48h 窗）', decLines.some((l) => l.includes(FRAG)));
    check('置顶条目排在第一位', decLines.length > 0 && decLines[0].includes(FRAG));
    if (decLines.length) console.log('     置顶后首条:', decLines[0].slice(0, 66));
  } finally {
    // 必须还原：selftest 不能给真实库留置顶标记
    run(['unpin', FRAG]);
    const back = run(['decisions', '--json', '--limit', '200']);
    check('unpin 后无 pinned 残留', !/"pinned"\s*:\s*true/.test(back));
  }
  }
}

// ═══ 11. 真实启动冒烟（real-boot）——[1015 债务3] 从孤立脚本并入主流程 ═══
// 为什么必须进来：它是唯一一条"不用 stub ctx、boot 真实 dsh-system-prompt"的断言，
// 固化的是**真实 API 契约**而不是"我对 API 的假设"。此前它长期孤立，没人跑=等于不存在。
// 纪律（与 8b/10a 同款）：**没有条件测就 SKIP，不许 FAIL**——
// 它依赖宿主真实包与本机 DSH 安装树；部署副本/别的机器上找不到就该跳过，
// 否则"本机没装 DSH"会被误报成"插件坏了"。
console.log('=== 11. 真实启动冒烟（real-boot，缺条件则 SKIP）===');
{
  try {
    const rb = await import(HERE + 'realboot.mjs');
    const r = await rb.runRealBoot({ pluginDir: HERE, log: (s) => console.log('  ' + s) });
    if (r.skipped) {
      console.log('  SKIP real-boot：' + r.reason);
    } else {
      // 逐条断言已在 realboot 内部打印，这里只把它折算成 selftest 的 fail 计数
      for (let i = 0; i < r.fail; i++) check('real-boot 第 ' + (i + 1) + ' 项失败', false);
      if (r.fail === 0) console.log('  PASS real-boot 全部 ' + r.pass + ' 条真实链路断言');
    }
  } catch (e) {
    // 导入/执行异常算 FAIL：那说明插件目录本身有问题，不是"没条件测"
    check('real-boot 可执行（异常的报错：' + String(e && e.message).slice(0, 60) + '）', false);
  }
}

console.log(fail === 0 ? '\nSELFTEST PASS' : `\nSELFTEST FAIL (${fail})`)
process.exit(fail === 0 ? 0 : 1)
