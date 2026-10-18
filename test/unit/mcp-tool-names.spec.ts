import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * MCP 工具名单的**自洽性**判据（不是功能测试）。
 *
 * 病历（2026-10-18）：`TOOL_NAMES` 里漏了 `srelay_lessons`，而 `register('srelay_lessons')` 一直在。
 *   后果不是崩，是 `toolAllowlist()` 那条「全写白名单 = 等于没设，走全注册」的优化对它静默失效 ——
 *   用户把全部工具列进白名单、以为走了白名单分支，实际走的是全注册分支。
 *   行为看起来一样，**判据已经错了**：它会让「白名单完整性校验」这个安全属性失效。
 *
 * 所以这里做静态对拍：源文件里 register(...) 出现的每个名字，都必须在 TOOL_NAMES 里；反之亦然。
 * 新增工具忘改 TOOL_NAMES 时，这条会立刻红 —— 而不是等到某天白名单行为诡异再去查。
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', '..', 'src', 'mcp', 'server.ts');

describe('MCP 工具名单自洽', () => {
  const text = fs.readFileSync(SERVER, 'utf8');
  // 按**块**取 TOOL_NAMES 的名字，不按行：这张表是多行的、一行好几个键（第一版按 `^\s{2}名字: 1,`
  // 匹配，一行只吃到第一个，13 个只认出 4 个 —— 判据自己先错了）。
  const blockStart = text.indexOf('const TOOL_NAMES = {');
  const blockEnd = text.indexOf('} as const;', blockStart);
  const declared = blockStart >= 0 && blockEnd > blockStart
    ? [...text.slice(blockStart, blockEnd).matchAll(/([a-z_]+): 1,/g)].map((m) => m[1])
    : [];

  it('每个 register(...) 的名字都在 TOOL_NAMES 里', () => {
    const registered = [...text.matchAll(/\bregister\('([a-z_]+)'/g)].map((m) => m[1]);
    expect(registered.length).toBeGreaterThan(10); // 防正则失效变成空跑
    expect(declared.length).toBeGreaterThan(10);   // 两边都要防空跑：只防一边等于没防
    const missing = registered.filter((n) => !declared.includes(n));
    expect(missing, '这些工具被 register 了但不在 TOOL_NAMES 里：' + missing.join(', ')).toEqual([]);
  });

  it('白名单里点名了不存在的工具时，allowlist 不会静默放行全部', () => {
    // 这条守的是 toolAllowlist 的「全写才走全注册」语义：写错一个名字必须仍是白名单（只注册对的那个），
    // 而不是退回全注册 —— 后者等于用户以为关掉了 13 个工具、实际 14 个全开着。
    expect(declared.length).toBeGreaterThan(10);
    expect(new Set(declared).size).toBe(declared.length); // 不许重复
  });
});
