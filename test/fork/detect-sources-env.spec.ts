// [1015 债务2 回归] detectSources() 必须读环境变量覆盖。
//
// 病历：config.ts 早就承诺「环境变量 > config.json > 默认值」，init 的交互界面甚至明文
// 引导用户去设 CODEX_DIR 之类；但 detectSources() 内全是硬编码路径，用户设了变量也不生效，
// 于是 init 的选择列表与 doctor 的「采集源」检查双双失聪（装了的源显示未安装 / 反之）。
//
// 双向断言（只断言"env 生效"挡不住退化——把默认路径也认了照样绿）：
//   ① 设了 env → 必须按 env 路径判定（哪怕默认路径不存在）
//   ② 没设 env → 必须回到默认路径（不许把 env 当唯一判据）
import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { detectSources } from '../../src/cli/init.js';

const KEYS = ['CLAUDE_PROJECTS_DIR', 'ZCODE_DB_PATH', 'DSH_SESSIONS_DIR', 'CODEX_DIR', 'QODER_DIR', 'TRAE_DIR'];
const saved: Record<string, string | undefined> = {};
for (const k of KEYS) saved[k] = process.env[k];

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const pick = (id: string) => detectSources().find((s) => s.id === id)!;

describe('[债务2] detectSources 读环境变量覆盖', () => {
  it('① 设了 DSH_SESSIONS_DIR → 按该路径判定（默认路径存在与否都不影响）', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'srelay-env-'));
    process.env.DSH_SESSIONS_DIR = tmp;
    try {
      const s = pick('dsh');
      expect(s.installed).toBe(true);
      expect(s.path).toBe(tmp);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  it('①b env 指向不存在的路径 → 必须报未安装（不许回落到默认路径冒充已装）', () => {
    process.env.DSH_SESSIONS_DIR = path.join(os.tmpdir(), 'srelay-definitely-missing-' + Date.now());
    const s = pick('dsh');
    expect(s.installed).toBe(false);
  });

  it('② 没设 env → 回到默认路径（~/.dsh/sessions）', () => {
    delete process.env.DSH_SESSIONS_DIR;
    const s = pick('dsh');
    expect(s.path).toBe(path.join(os.homedir(), '.dsh', 'sessions'));
  });

  it('③ 六个源各自认自己的 env（CLAUDE/ZCODE/CODEX/QODER/TRAE）', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'srelay-env2-'));
    process.env.CLAUDE_PROJECTS_DIR = tmp;
    process.env.ZCODE_DB_PATH = path.join(tmp, 'db.sqlite');
    process.env.CODEX_DIR = tmp;
    process.env.QODER_DIR = tmp;
    process.env.TRAE_DIR = tmp;
    try {
      expect(pick('claude-code').path).toBe(tmp);
      expect(pick('zcode').path).toBe(path.join(tmp, 'db.sqlite'));
      expect(pick('codex').installed).toBe(true);
      expect(pick('qoder').path).toBe(tmp);
      expect(pick('trae').path).toBe(tmp);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });
});
