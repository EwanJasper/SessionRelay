// 一键发版链（发版漏环节三次事故的根治）：
//   bump → CHANGELOG 校验 → build+test → commit+tag → push → 等 CI 绿 → npm publish → GitHub release
// 每个检查点失败即停；已完成的步骤幂等可续跑。
// 用法：
//   node scripts/release.mjs patch            # 0.4.4 → 0.4.5
//   node scripts/release.mjs minor            # 0.4.4 → 0.5.0
//   node scripts/release.mjs <显式版本>        # 0.5.0
//   node scripts/release.mjs resume           # 从上次中断处续跑
// 前置：CHANGELOG 顶部已写好【将要发布的版本】条目（Unreleased 或目标版本号均可，脚本自动改名）。
import { execFileSync, execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const pkgPath = path.join(ROOT, 'package.json');
const clPath = path.join(ROOT, 'CHANGELOG.md');
const statePath = path.join(ROOT, '.release-state.json');
const NPM = 'https://registry.npmjs.org/';
const REPO = 'EwanJasper/SessionRelay';

const log = (s) => console.log(`[release] ${s}`);
const die = (s) => { console.error(`[release] ✗ ${s}`); process.exit(1); };
const sh = (cmd, opts = {}) => execSync(cmd, { encoding: 'utf-8', cwd: ROOT, stdio: opts.quiet ? 'pipe' : 'inherit', ...opts });
const today = () => new Date().toISOString().slice(0, 10);

let state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf-8')) : { done: [] };
const mark = (step) => { state.done.push(step); writeFileSync(statePath, JSON.stringify(state, null, 2)); };
const isDone = (step) => state.done.includes(step);
const savePkg = () => JSON.parse(readFileSync(pkgPath, 'utf-8'));

// ── 0) 参数 ──
const arg = process.argv[2];
if (!arg || arg === '--help') die('用法：node scripts/release.mjs <patch|minor|major|显式版本|resume>');
const pkg0 = savePkg();

// ── 1) 确定目标版本 ──
let target;
if (arg === 'resume') {
  if (!state.target) die('resume 但无 .release-state.json——从头运行：node scripts/release.mjs <patch|minor>');
  target = state.target;
  log(`续跑：目标 v${target}，已完成 ${state.done.join(', ') || '（无）'}`);
} else {
  const [maj, min, pat] = pkg0.version.split('.').map(Number);
  if (arg === 'patch') target = `${maj}.${min}.${pat + 1}`;
  else if (arg === 'minor') target = `${maj}.${min + 1}.0`;
  else if (arg === 'major') target = `${maj + 1}.0.0`;
  else if (/^\d+\.\d+\.\d+$/.test(arg)) target = arg;
  else die(`无法识别的参数：${arg}`);
  state = { target, done: [] };
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}
if (target === pkg0.version && !isDone('bump')) die(`目标版本 ${target} 与 package.json 相同`);

// ── 2) 预检：工作区干净（resume 除外）──
if (!isDone('commit')) {
  const dirty = sh('git status --porcelain', { quiet: true }).trim();
  if (dirty) die('工作区有未提交改动，先提交或 stash（发版应从干净树开始）');
}

// ── 3) CHANGELOG：顶部条目必须是目标版本或 Unreleased（改名），否则拒绝 ──
const cl = readFileSync(clPath, 'utf-8');
const topM = /^## \[([^\]]+)\] - (\d{4}-\d{2}-\d{2})/m.exec(cl);
if (!topM) die('CHANGELOG 找不到版本条目（## [x.y.z] - 日期）');
if (topM[1] !== target && topM[1] !== 'Unreleased') {
  die(`CHANGELOG 顶部是 [${topM[1]}]，既不是目标 ${target} 也不是 Unreleased——先写好发版条目再跑`);
}
if (!isDone('changelog')) {
  if (topM[1] === 'Unreleased') {
    writeFileSync(clPath, cl.replace('## [Unreleased]', `## [${target}] - ${today()}`));
    log(`CHANGELOG：Unreleased → [${target}] - ${today()}`);
  } else {
    log(`CHANGELOG：顶部已是 [${target}] ✓`);
  }
  mark('changelog');
}

// ── 4) bump package.json ──
if (!isDone('bump')) {
  const pkg = savePkg();
  pkg.version = target;
  // 保持字段顺序：直接字符串替换 version 行最稳（避免重排整个文件）
  const raw = readFileSync(pkgPath, 'utf-8').replace(new RegExp(`("version":\\s*)"${pkg0.version === pkg.version ? '[^"]+' : pkg0.version}"`), `$1"${target}"`);
  writeFileSync(pkgPath, raw);
  if (savePkg().version !== target) die('version 写入失败');
  log(`package.json → ${target}`);
  mark('bump');
}

// ── 5) 产物断言 + 全量验证 ──
if (!isDone('verify')) {
  log('check:artifacts + build + test ...');
  sh('npm run check:artifacts', { quiet: true });
  sh('npm run build', { quiet: true });
  sh('npm test', { quiet: true });
  log('验证全绿 ✓');
  mark('verify');
}

// ── 6) commit + tag + push ──
if (!isDone('push')) {
  sh('git add -A');
  const bumpOnly = sh('git status --porcelain', { quiet: true }).trim();
  if (bumpOnly || !isDone('commit')) {
    sh(`git -c user.email="107449146+EwanJasper@users.noreply.github.com" -c user.name="EwanJasper" commit -m "chore: release ${target}"`, { quiet: true });
  }
  if (!isDone('commit')) mark('commit');
  const tag = `v${target}`;
  try { sh(`git tag ${tag}`, { quiet: true }); } catch { log(`tag ${tag} 已存在，继续`); }
  sh('git push');
  try { sh(`git push origin ${tag}`, { quiet: true }); } catch { log('tag 已在远端'); }
  log('已推送，等待 CI ...');
  mark('push');
}

// ── 7) 等 CI 绿（硬门禁：0.4.0 事故的教训——CI 没绿绝不 publish）──
if (!isDone('ci')) {
  const sha = sh('git rev-parse HEAD', { quiet: true }).trim();
  let ok = false;
  for (let i = 0; i < 40; i++) { // 最多 20 分钟
    let out = '';
    try { out = sh(`gh run list --commit ${sha} --json status,conclusion --limit 1`, { quiet: true }); } catch { /* gh 偶发 */ }
    const runs = JSON.parse(out || '[]');
    if (runs.length > 0 && runs[0].status === 'completed') {
      if (runs[0].conclusion === 'success') { ok = true; break; }
      die(`CI 结论 = ${runs[0].conclusion}（非 success）——修完再 resume`);
    }
    process.stdout.write('.');
    await new Promise((r) => setTimeout(r, 30_000));
  }
  console.log('');
  if (!ok) die('CI 20 分钟未完成——稍后 node scripts/release.mjs resume');
  log('CI 绿 ✓');
  mark('ci');
}

// ── 8) npm publish ──
if (!isDone('publish')) {
  sh(`npm publish --registry ${NPM}`, { quiet: false });
  log('npm publish ✓（传播延迟数分钟属正常）');
  mark('publish');
}

// ── 9) GitHub release ──
if (!isDone('release')) {
  const clNow = readFileSync(clPath, 'utf-8');
  const entry = /^## \[([^\]]+)\] - \d{4}-\d{2}-\d{2}\n([\s\S]*?)(?=\n## |\n?$)/m.exec(clNow);
  if (!entry || entry[1] !== target) die('CHANGELOG 顶部条目与目标版本不符，无法生成 release notes');
  const notes = `${entry[2].trim()}\n\n**Full Changelog**: https://github.com/${REPO}/compare/v${prevVersion(target)}...v${target}`;
  writeFileSync(path.join(ROOT, '.release-notes.tmp'), notes);
  sh(`gh release create v${target} --title "v${target}" --notes-file .release-notes.tmp`, { quiet: true });
  sh('node -e "require(\'fs\').unlinkSync(\'.release-notes.tmp\')"', { quiet: true });
  log(`GitHub release v${target} ✓`);
  mark('release');
}

// ── 收尾 ──
sh('node -e "require(\'fs\').unlinkSync(\'.release-state.json\')"', { quiet: true });
log(`🎉 v${target} 发布链完成（npm 传播 + GitHub release 页面可能有数分钟延迟）`);

function prevVersion(t) {
  const [maj, min, pat] = t.split('.').map(Number);
  if (pat > 0) return `${maj}.${min}.${pat - 1}`;
  if (min > 0) return `${maj}.${min - 1}.0`;
  return `${maj - 1}.0.0`;
}
