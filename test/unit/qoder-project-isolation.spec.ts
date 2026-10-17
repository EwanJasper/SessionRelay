import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { discover } from '../../src/adapters/qoder/index.js';

/**
 * Qoder 项目隔离（外部审查 #03，P1）。
 *
 * 病历：缓存目录名是 <folderName>-<hash>，适配器原来只比 folderName、忽略 hash
 *   ⇒ company-a/app 与 company-b/app 两个项目会认领同一批缓存目录，会话混进对方的库。
 *   同名目录是常态（app / server / web），这条一错，跨客户的数据就串了。
 */
const jsonl = (n) => Array.from({ length: n }, (_, i) =>
  JSON.stringify({ type: i % 2 === 0 ? 'user' : 'assistant', message: { content: '第' + i + '条' } })).join('\n');

function mkCache(dirs, lines = 3) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'srelay-qoder-'));
  const cache = path.join(root, '.qoder-cn', 'cache', 'projects');
  for (const d of dirs) {
    const task = path.join(cache, d, 'conversation-history', 'task-' + d);
    fs.mkdirSync(task, { recursive: true });
    fs.writeFileSync(path.join(task, 'task-' + d + '.jsonl'), jsonl(lines));
  }
  return { dir: root, qoderDir: root + '/.qoder-cn' };
}

const md5Short = (p) => createHash('md5').update(p).digest('hex').slice(0, 8);
describe('Qoder 项目隔离', () => {
  it('只有一个同名缓存目录 ⇒ 照常收录（兼容现状）', () => {
    const proj = path.join(os.tmpdir(), 'qa-only', 'app');
    const { qoderDir } = mkCache(['app-' + md5Short(proj)]);
    expect(discover(proj, qoderDir).length).toBe(1);
  });

  it('★ 两个同名目录、hash 能对上 ⇒ 各拿各的，不再混', () => {
    const projA = path.join(os.tmpdir(), 'company-a', 'app');
    const projB = path.join(os.tmpdir(), 'company-b', 'app');
    const { qoderDir } = mkCache(['app-' + md5Short(projA), 'app-' + md5Short(projB)]);
    const a = discover(projA, qoderDir);
    const b = discover(projB, qoderDir);
    expect(a.length).toBe(1);
    expect(b.length).toBe(1);
    expect(a[0].sourceSessionId).not.toBe(b[0].sourceSessionId);
  });

  it('★ 两个同名目录、hash 都对不上 ⇒ 拒绝认领并报出来', () => {
    const proj = path.join(os.tmpdir(), 'company-x', 'app');
    const { qoderDir } = mkCache(['app-deadbeef', 'app-cafebabe']);
    const errs = [];
    const orig = console.error;
    console.error = (...a) => { errs.push(a.map(String).join(' ')); };
    try {
      expect(discover(proj, qoderDir)).toEqual([]);
    } finally { console.error = orig; }
    expect(errs.join(' ')).toContain('无法确定');
    expect(errs.join(' ')).toContain('拒绝自动认领');
  });

  it('空正文会话（<2 行）仍然跳过', () => {
    const proj = path.join(os.tmpdir(), 'qb', 'app');
    const { qoderDir } = mkCache(['app-' + md5Short(proj)], 1);
    expect(discover(proj, qoderDir)).toEqual([]);
  });


  it('★ 单候选但摘要对不上 ⇒ 也拒绝（红队实测的洞：对方是唯一候选时会被当成自己的）', () => {
    const proj = path.join(os.tmpdir(), 'solo', 'app');
    const { qoderDir } = mkCache(['app-deadbeef']);   // 别人的目录，hash 不是本项目
    const errs = [];
    const orig = console.error;
    console.error = (...a) => { errs.push(a.map(String).join(' ')); };
    try {
      expect(discover(proj, qoderDir)).toEqual([]);
    } finally { console.error = orig; }
    expect(errs.join(' ')).toContain('拒绝自动认领');
  });
});
