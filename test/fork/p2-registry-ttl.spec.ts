// 审计报告 P2：全局注册表的存量污染无 TTL、无清理
// 依据：E:\music player\docs\sessionrelay-审计报告-20261013.md
// 实测：16 个候选中 12 个是 %TEMP%\sb7-* 测试沙盒（目录至今仍在 → 永远剪不掉），
// 后果是 guidance 载荷被稀释、"唯一存活"自动选中被推向 multiple_alive。
//
// 三条不变量：
//   ① 写侧拒绝 tmpdir 注册（新污染不再产生）
//   ② 读侧 TTL 剪枝：过期且守护已死的条目落盘删除（存量有回收路径）
//   ③ 守护还活着的项目不因"久无心跳"被剪（换机/重启 ≠ 废弃）
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isTransientRoot, touchRegistry, registryCandidates } from '../../src/shared/registry.js';

const TMP = path.resolve('test/.tmp/registry-p2');
const REG = path.join(TMP, 'registry');

function regFile() { return path.join(REG, 'projects.json'); }
function readReg(): { projects: Array<{ root: string; registeredAt: string; lastActiveAt: string }> } {
  return JSON.parse(fs.readFileSync(regFile(), 'utf8'));
}
function writeReg(projects: Array<{ root: string; registeredAt: string; lastActiveAt: string }>) {
  fs.mkdirSync(REG, { recursive: true });
  fs.writeFileSync(regFile(), JSON.stringify({ version: 1, projects }));
}
function proj(name: string): string {
  const dir = path.join(TMP, 'proj', name);
  fs.mkdirSync(path.join(dir, '.sessionrelay'), { recursive: true });
  return dir;
}

describe('P2 · 注册表污染治理', () => {
  beforeEach(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
    fs.mkdirSync(REG, { recursive: true });
    process.env.SRELAY_REGISTRY_DIR = REG;
  });
  afterEach(() => { delete process.env.SRELAY_REGISTRY_DIR; });

  it('① 写侧：临时目录注册被拒', () => {
    expect(isTransientRoot(path.join(os.tmpdir(), 'sb7-abc', 'stack'))).toBe(true);
    expect(isTransientRoot(proj('real'))).toBe(false);
    // touchRegistry 对 tmpdir 是静默 no-op（登记是旁路优化，不该抛）——
    // 连注册表文件都不该被创建
    const sb = path.join(os.tmpdir(), 'sb7-abc', 'stack');
    fs.mkdirSync(path.join(sb, '.sessionrelay'), { recursive: true });
    touchRegistry(sb);
    expect(fs.existsSync(regFile())).toBe(false);
  });

  it('② 读侧：过期（>30d）且守护已死的条目被落盘删除', () => {
    const stale = proj('stale');
    writeReg([
      { root: stale, registeredAt: '2026-07-01T00:00:00Z', lastActiveAt: '2026-08-01T00:00:00Z' },
    ]);
    const live = registryCandidates();
    expect(live.map(c => c.root)).not.toContain(stale);
    expect(readReg().projects).toHaveLength(0); // 真的落盘删了，不是只从视图隐藏
  });

  it('②b 新项目（心跳新鲜）保留，不受 TTL 影响', () => {
    const fresh = proj('fresh');
    touchRegistry(fresh);
    expect(registryCandidates().map(c => c.root)).toContain(fresh);
  });

  it('③ 过期但守护仍活着的项目不剪（换机/重启 ≠ 废弃）', () => {
    const p = proj('rebooting');
    writeReg([
      { root: p, registeredAt: '2026-01-01T00:00:00Z', lastActiveAt: '2026-01-02T00:00:00Z' },
    ]);
    // 伪装存活守护：lock 文件 pid=当前进程 + 新鲜心跳（与 serve-resolve 测试同一手法）
    const lock = path.join(p, '.sessionrelay', 'lock');
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, heartbeat: Date.now() }));
    const live = registryCandidates();
    expect(live.map(c => c.root)).toContain(p);
    expect(readReg().projects).toHaveLength(1); // 没被剪
  });

  it('④ 目录已删的条目仍按原逻辑剪掉（既有行为不回退）', () => {
    const gone = path.join(TMP, 'proj', 'gone');
    fs.mkdirSync(path.join(gone, '.sessionrelay'), { recursive: true });
    writeReg([{ root: gone, registeredAt: new Date().toISOString(), lastActiveAt: new Date().toISOString() }]);
    fs.rmSync(gone, { recursive: true, force: true });
    expect(registryCandidates()).toHaveLength(0);
    expect(readReg().projects).toHaveLength(0);
  });

  it('⑤ 真实存量：12 个 Temp 沙盒 + 1 个真项目的混合名单只剩真项目', () => {
    const real = proj('real');
    const sb: string[] = [];
    for (let i = 0; i < 12; i++) {
      const d = path.join(os.tmpdir(), `sb7-0-${i}`, 'stack');
      fs.mkdirSync(path.join(d, '.sessionrelay'), { recursive: true });
      sb.push(d);
    }
    writeReg([
      ...sb.map((root, i) => ({ root, registeredAt: '2026-09-24T00:00:00Z', lastActiveAt: `2026-09-2${i % 10}T00:00:00Z` })),
      { root: real, registeredAt: new Date().toISOString(), lastActiveAt: new Date().toISOString() },
    ]);
    const live = registryCandidates();
    expect(live.map(c => c.root)).toEqual([real]); // 12 个沙盒全清，只剩真项目
    expect(readReg().projects.map(p => p.root)).toEqual([real]);
  });
});
