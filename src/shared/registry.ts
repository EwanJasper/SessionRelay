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
  const now = new Date().toISOString();
  const e = r.projects.find((p) => path.resolve(p.root) === abs);
  if (e) e.lastActiveAt = now;
  else r.projects.push({ root: abs, registeredAt: now, lastActiveAt: now });
  write(r);
}

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
  for (const p of r.projects) {
    if (!existsSync(p.root) || !existsSync(relayDir(p.root))) { pruned = true; continue; }
    live.push({
      root: p.root,
      name: path.basename(p.root),
      daemonAlive: isDaemonAlive(p.root).alive,
      lastActiveAt: p.lastActiveAt ?? null,
    });
  }
  if (pruned) write({ version: 1, projects: r.projects.filter((p) => existsSync(p.root) && existsSync(relayDir(p.root))) });
  return live.sort((a, b) => (b.lastActiveAt ?? '').localeCompare(a.lastActiveAt ?? ''));
}
