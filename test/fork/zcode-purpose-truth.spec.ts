// [1015 夜 · 出口③] 会话目的判定改用**库里的真值**，不再靠标题猜；且 manual 不可被自动判据降级。
//
// 实测（tools/_probe_zcode_purpose_leak.mjs）：主库 382 场真值 subagent_child 的会话全部漏过标题正则、
// 贡献 254 条决策（占 27%）；对照库漏 69 场/54 条；反向误判 0 场。
// 双向断言：真值命中必须转 workflow；正常会话（interactive / 划词侧问）一条都不许误伤。
import { describe, it, expect } from 'vitest';
import { isSubagentKind } from '../../src/adapters/zcode/index.js';
import { createDb, upsertCapturedSession } from '../../src/store/db.js';
import type { DB } from '../../src/store/db.js';

describe('[1015 夜] ZCode 会话目的用真值', () => {
  it('① 子代理/工作流子会话判为 workflow；正常会话不许误伤', () => {
    expect(isSubagentKind('subagent_child')).toBe(true);
    expect(isSubagentKind('workflow_child')).toBe(true);
    expect(isSubagentKind('interactive')).toBe(false);
    expect(isSubagentKind('selection_side_chat')).toBe(false);
    expect(isSubagentKind('fork')).toBe(false);
    expect(isSubagentKind(null)).toBe(false);
    expect(isSubagentKind(undefined)).toBe(false);
  });
});

type Org = 'auto' | 'manual' | 'workflow';
const mk = (origin: Org) => ({
  source: 'zcode', sourceSessionId: 's1', projectId: 'p', title: 't',
  createdAt: '2026-10-15T00:00:00Z', lastEventAt: '2026-10-15T00:00:00Z', sourceFile: 'zcode:s1', origin,
});

describe('[1015 夜] origin=manual 不可被自动判据降级', () => {
  it('② 手动保存过的会话，后来的 workflow 判据不许盖掉它', () => {
    const db = createDb(':memory:') as unknown as DB;
    upsertCapturedSession(db, mk('manual'));
    upsertCapturedSession(db, mk('workflow'));
    const o1 = db.prepare('SELECT origin FROM sessions').get() as { origin: string };
    expect(o1.origin).toBe('manual');
    db.close();
  });
  it('③ 但 auto 会话该改判时就要改（别因为上一条把整条判据废了）', () => {
    const db = createDb(':memory:') as unknown as DB;
    upsertCapturedSession(db, mk('auto'));
    upsertCapturedSession(db, mk('workflow'));
    const o2 = db.prepare('SELECT origin FROM sessions').get() as { origin: string };
    expect(o2.origin).toBe('workflow');
    db.close();
  });
});
