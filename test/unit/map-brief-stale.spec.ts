import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mapBriefLine } from '../../src/map/bridge.js';

/**
 * 第 2 档 · 过时提醒。
 *
 * 病历（2026-10-18 真实发生）：简报那行写着「下一步：待拍板 P3b」，
 * 而 P3b 当天就做完了 —— 地图只是如实显示它记的东西，它不会替你判断现实变了。
 * 机制**没法**判断「next 里那件事完成没」（那是语义），但能如实说「这张图多久没动」。
 *
 * 判据必须只用可观测量（文件 mtime），**不猜内容** —— 猜错一次，整套提醒就没人信了。
 */
function projectWithMap(ageDays: number): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'srelay-mapbrief-'));
  const mapDir = path.join(dir, '.sessionrelay', 'map');
  fs.mkdirSync(mapDir, { recursive: true });
  const file = path.join(mapDir, 'map.json');
  fs.writeFileSync(file, JSON.stringify({
    version: 1, title: 't',
    layers: [{ id: 'a', name: 'A', rank: 0 }],
    nodes: [], edges: [],
    context: { summary: '', next: '' },
  }, null, 2) + '\n', 'utf8');
  const t = new Date(Date.now() - ageDays * 86400000);
  fs.utimesSync(file, t, t);
  return dir;
}

describe('地图简报行 · 过时提醒只用可观测量', () => {
  it('刚更新过的地图不提醒', () => {
    const dir = projectWithMap(0.2);
    try {
      const line = mapBriefLine(dir);
      expect(line).toContain('🗺 地图');
      expect(line).not.toContain('未更新');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('超过 7 天没动 ⇒ 如实说几天，不猜内容', () => {
    const dir = projectWithMap(10);
    try {
      const line = mapBriefLine(dir);
      expect(line).toContain('10 天未更新');
      expect(line).toContain('可能与现实脱节');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('阈值可调（默认 7 天）', () => {
    const dir = projectWithMap(10);
    try {
      expect(mapBriefLine(dir, { staleDays: 30 })).not.toContain('未更新');
      expect(mapBriefLine(dir, { staleDays: 5 })).toContain('未更新');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('没有地图 ⇒ 空串（整行不渲染，不报错）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'srelay-nomap-'));
    try { expect(mapBriefLine(dir)).toBe(''); }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
