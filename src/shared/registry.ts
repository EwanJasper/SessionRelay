// 全局项目注册表（design-serve-resolve §5）：serve 信号链第 4 级的候选来源。
// 路径铁律：绝不能是 ~/.sessionrelay —— findRelayRoot 向上探测的就是这个目录名，
// 家目录建它会让 home 子目录下的项目解析全部误判（~/.sessionrelay-semantic 同款规避）。
// 测试用 SRELAY_REGISTRY_DIR 重定向，不得污染真实家目录。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { relayDir } from './paths.js';
import { isDaemonAlive } from './lock.js';

export interface RegistryEntry {
  root: string;
  registeredAt: string;
  lastActiveAt: string;
}

interface RegistryFile {
  version: 1;
  projects: RegistryEntry[];
}

export function registryDir(): string {
  return process.env.SRELAY_REGISTRY_DIR ?? path.join(os.homedir(), '.sessionrelay-registry');
}

function registryFile(): string {
  return path.join(registryDir(), 'projects.json');
}

function read(): RegistryFile {
  try {
    const raw = JSON.parse(fs.readFileSync(registryFile(), 'utf8')) as RegistryFile;
    if (raw && Array.isArray(raw.projects)) return { version: 1, projects: raw.projects };
  } catch { /* 缺失/损坏 → 视为空（design §5：不 crash） */ }
  return { version: 1, projects: [] };
}

function write(r: RegistryFile): void {
  try {
    fs.mkdirSync(registryDir(), { recursive: true });
    const tmp = registryFile() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(r, null, 2), 'utf8');
    fs.renameSync(tmp, registryFile());
  } catch { /* 写失败不影响调用方（登记是旁路优化） */ }
}

/** 登记/刷新一个项目（upsert 自己的 root 键；多守护并发写按 root 合并，微小丢心跳窗口可接受） */
export function touchRegistry(root: string): void {
  const r = read();
  const abs = path.resolve(root);
  // [fork 1013] 审计 P2：拒绝临时目录注册。上游 e7fe17a 只让测试子进程不再污染新条目，
  // 但手工在 Temp 下建栈的存量条目永不过期（实测 16 个候选里 12 个是 %TEMP%\sb7-* 沙盒）。
  // 这里是写侧闸门：临时目录不是项目，它的会话不该进真实项目的候选列表。
  if (isTransientRoot(abs)) return;
  const now = new Date().toISOString();
  const e = r.projects.find((p) => path.resolve(p.root) === abs);
  if (e) e.lastActiveAt = now;
  else r.projects.push({ root: abs, registeredAt: now, lastActiveAt: now });
  write(r);
}

/**
 * [fork 1013 审计 P2 / 1016 红队 A-12 加固] 判定临时/一次性目录。
 * Windows: %TEMP%\sb7-* 这类测试沙盒；Linux: /tmp/*。
 *
 * 旧判据是字符串前缀 `startsWith(tmp + path.sep)`，三条脆点（红队 A-12 实测）：
 *   ① 8.3 短名 / 盘符大小写变体（C:/Users/CRX~1/... vs C:/Users/crx/...）**判据整条静默失效**
 *      —— 本机没触发，换机器才炸；
 *   ② 用 path.sep 拼前缀，而 Windows 两种分隔符都合法（反斜杠输入、正斜杠调用会漏判）；
 *   ③ 临时目录**自身**不算临时目录（靠 + sep 兜着），于是 %TEMP% 本身能被登记成项目根。
 * 现在：两边都过 realpath（存在的话）+ 分隔符归一 + 大小写归一，并显式把 tmpdir 自身算作临时目录。
 * ⚠️ realpath 失败（路径不存在——正是"还没建"的常见情形）就退回 path.resolve，绝不因为探测失败而改变判定。
 * ⚠️ 因此 **8.3 短名（C:/Users/CRX~1/...）只在目录确实存在时才会被归一**；不存在时两种写法可能仍判不同。
 *    复审（A-12）在本机构造不出可区分的用例，所以这条只标"方向对"，**不算已证实修好**。
 */
function pathKey(p: string): string {
  let s = path.resolve(p);
  try { s = fs.realpathSync.native(s); } catch { /* 不存在：用 resolve 结果 */ }
  return s.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * 本机上算"临时目录"的**全部形态**（1017 补）。
 * 病历：以前只认 os.tmpdir()，而它只反映 TMPDIR/TMP/TEMP 里的一个 —— 本机 os.tmpdir()=D:\Temp，
 * 但 %LOCALAPPDATA%\Temp 同样真实存在：DSH 插件侧的自动接入就漏过它，在那儿建了库、
 * 还写进注册表，连"插件在临时目录上不建库"这条自测的前提都被改掉了（假红至今）。
 * 判据只维护这一处，插件侧（project-resolve.mjs）经 vendor 复用同一函数。
 */
function tempRoots(): string[] {
  const out: string[] = [os.tmpdir()];
  for (const k of ['TEMP', 'TMP']) { const v = process.env[k]; if (v) out.push(v); }
  const la = process.env.LOCALAPPDATA;
  if (la) out.push(path.join(la, 'Temp'));
  if (process.platform !== 'win32') out.push('/tmp', '/var/tmp');   // Windows 上 resolve('/tmp') 会落到当前盘根，不能收
  return out;
}

export function isTransientRoot(abs: string): boolean {
  const p = pathKey(abs);
  for (const t of tempRoots()) {
    const tk = pathKey(t);
    if (p === tk || p.startsWith(tk + '/')) return true;
  }
  return false;
}

/** [fork 1013] 审计 P2：注册表条目过期阈值（天）。超过且守护已死 → 视为废弃，
 *  下次 registryCandidates() 落盘删除。默认 30 天：足够覆盖"项目换机器休息一个月"，
 *  又不会让三个月前的测试沙盒继续稀释候选列表。 */
const REGISTRY_TTL_DAYS = 30;

export interface RegistryCandidate {
  root: string;
  name: string;
  daemonAlive: boolean;
  lastActiveAt: string | null;
}

/** 读侧视图：剪枝失效条目（目录或 .sessionrelay 不存在），附带守护存活信号 */
export function registryCandidates(): RegistryCandidate[] {
  const r = read();
  const live: RegistryCandidate[] = [];
  let pruned = false;
  const cutoff = Date.now() - REGISTRY_TTL_DAYS * 86_400_000;
  const alive = (p: RegistryEntry) => existsSync(p.root) && existsSync(relayDir(p.root));
  const keep: RegistryEntry[] = [];
  for (const p of r.projects) {
    // [fork 1013] 读侧同样拒收临时目录：写侧闸门只防新污染，9 月底的存量
    // Temp 下 sb7-* 沙盒还没过 30 天 TTL，靠 TTL 清不掉——目录还在、日期新鲜，正是它们能
    // 一直稀释候选列表的原因。这里按"是不是临时目录"直接判死。
    if (isTransientRoot(p.root)) { pruned = true; continue; }
    if (!alive(p)) { pruned = true; continue; }
    // [fork 1013] TTL 剪枝：过期且守护已死 = 废弃项目。守护还活着的不剪——
    // 那说明只是这个项目近期没心跳（本机重启/换机），不是废弃。
    const at = Date.parse(p.lastActiveAt ?? '');
    const expired = Number.isFinite(at) && at < cutoff;
    const daemon = isDaemonAlive(p.root).alive;
    if (expired && !daemon) { pruned = true; continue; }
    keep.push(p);
    live.push({
      root: p.root,
      name: path.basename(p.root),
      daemonAlive: daemon,
      lastActiveAt: p.lastActiveAt ?? null,
    });
  }
  if (pruned) write({ version: 1, projects: keep });
  return live.sort((a, b) => (b.lastActiveAt ?? '').localeCompare(a.lastActiveAt ?? ''));
}
