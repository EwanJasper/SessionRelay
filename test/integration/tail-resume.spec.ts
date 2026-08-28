// S2 出口验收：实时捕获 + resume 正确触发一次回滚（方针 Phase 0 S2 / T20/T23）。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { tailCompleteLines, detectRewrite, detectGrowth } from '../../src/adapters/claude-code/tailer.js';
import { watchDir } from '../../src/adapters/claude-code/watcher.js';
import { transition } from '../../src/core/state/machine.js';
import { createDb, insertSession, insertMessage, countMessages, setSessionState } from '../../src/store/db.js';

const TMP = path.resolve('test/.tmp/s2');

beforeAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
});
afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

const line = (i: number) =>
  JSON.stringify({
    type: i % 2 ? 'user' : 'assistant',
    message: { role: i % 2 ? 'user' : 'assistant', content: `消息${i}：讨论数据库索引方案` },
    timestamp: `2026-08-28T10:${String(i % 60).padStart(2, '0')}:00Z`,
  });

describe('S2 tailer · 完整行与行号确定性', () => {
  it('只消费完整行，残行留待下轮补齐', async () => {
    const f = path.join(TMP, 'partial.jsonl');
    fs.writeFileSync(f, `${line(1)}\n${line(2)}\n`);
    fs.appendFileSync(f, '{"type":"user","broken'); // 无换行的半行
    const r1 = await tailCompleteLines(f, 0, 0);
    expect(r1.lines.length).toBe(2);
    expect(r1.pendingBytes).toBeGreaterThan(0);

    const r2 = await tailCompleteLines(f, r1.newOffset, r1.consumedLineCount);
    expect(r2.lines.length).toBe(0);
    expect(r2.newOffset).toBe(r1.newOffset);

    fs.appendFileSync(f, 'tail"}\n');
    const r3 = await tailCompleteLines(f, r2.newOffset, r2.consumedLineCount);
    expect(r3.lines.length).toBe(1);
    expect(r3.lines[0].lineNo).toBe(3);
  });

  it('行号确定性：同一 offset 重放得到相同行号与文本（幂等键前提，§3.1 契约）', async () => {
    const f = path.join(TMP, 'determinism.jsonl');
    fs.writeFileSync(f, Array.from({ length: 10 }, (_, i) => line(i + 1)).join('\n') + '\n');
    const a = await tailCompleteLines(f, 0, 0);
    const b = await tailCompleteLines(f, 0, 0);
    expect(b.lines).toEqual(a.lines);
    expect(a.lines.map((l) => l.lineNo)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
});

describe('S2 resume 回滚 + 崩溃幂等（tailer × 状态机 × 幂等键联动）', () => {
  it('confirmed 会话追加新行 → RESUMED 回滚 active；offset 回退重放零重复', async () => {
    const f = path.join(TMP, 'resume.jsonl');
    fs.writeFileSync(f, Array.from({ length: 10 }, (_, i) => line(i + 1)).join('\n') + '\n');

    const db = createDb();
    insertSession(db, {
      id: 'sess1', source: 'claude-code', sourceSessionId: 'abc',
      projectId: 'p1', createdAt: '2026-08-28T10:00:00Z',
    });
    const r1 = await tailCompleteLines(f, 0, 0);
    expect(r1.lines.length).toBe(10);
    for (const l of r1.lines) {
      insertMessage(db, { sessionId: 'sess1', role: 'user', content: `消息${l.lineNo}`, seqNum: l.lineNo });
    }
    expect(countMessages(db, 'sess1')).toBe(10);

    // 模拟冷却期满：confirmed + 固化摘要
    setSessionState(db, 'sess1', 'confirmed', { summaryRule: '旧摘要', confirmedAt: '2026-08-28T12:00:00Z' });

    // 模拟 --resume：文件追加 5 行
    fs.appendFileSync(f, Array.from({ length: 5 }, (_, i) => line(11 + i)).join('\n') + '\n');
    const size = fs.statSync(f).size;
    expect(detectGrowth(size, r1.newOffset)).toBe(true);
    expect(detectRewrite(size, r1.newOffset)).toBe(false);

    const r2 = await tailCompleteLines(f, r1.newOffset, r1.consumedLineCount);
    expect(r2.lines.length).toBe(5);
    expect(r2.lines[0].lineNo).toBe(11);

    // 新行到达非 active 会话 → RESUMED（回滚 + 清摘要）
    const t = transition('confirmed', 'NEW_LINE');
    expect(t).toMatchObject({ ok: true, to: 'active', effect: 'rollback' });
    setSessionState(db, 'sess1', t.to!, { summaryRule: null });
    for (const l of r2.lines) {
      insertMessage(db, { sessionId: 'sess1', role: 'user', content: `消息${l.lineNo}`, seqNum: l.lineNo });
    }
    expect(countMessages(db, 'sess1')).toBe(15);
    const row = db.prepare('SELECT state, summary_rule FROM sessions WHERE id = ?').get('sess1') as { state: string; summary_rule: string | null };
    expect(row.state).toBe('active');
    expect(row.summary_rule).toBeNull();

    // 崩溃回放：offset 从未推进，从 0 重读 15 行重插 → OR IGNORE 全部去重
    const replay = await tailCompleteLines(f, 0, 0);
    expect(replay.lines.length).toBe(15);
    let changed = 0;
    for (const l of replay.lines) {
      changed += insertMessage(db, { sessionId: 'sess1', role: 'user', content: `消息${l.lineNo}`, seqNum: l.lineNo });
    }
    expect(changed).toBe(0);
    expect(countMessages(db, 'sess1')).toBe(15);
  });

  it('文件重写检测：长度回退 → 整体重摄取路径', async () => {
    const f = path.join(TMP, 'rewrite.jsonl');
    fs.writeFileSync(f, Array.from({ length: 20 }, (_, i) => line(i + 1)).join('\n') + '\n');
    const r = await tailCompleteLines(f, 0, 0);
    fs.writeFileSync(f, line(1) + '\n'); // agent 压缩归档式重写
    expect(detectRewrite(fs.statSync(f).size, r.newOffset)).toBe(true);
  });
});

describe('S2 watcher · 实时捕获', () => {
  it('append 后在去抖窗口内收到文件事件（win fs.watch 递归）', async () => {
    const dir = path.join(TMP, 'watch');
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, 'w.jsonl');
    fs.writeFileSync(f, '');

    const got = new Promise<string>((resolve) => {
      const h = watchDir(dir, (file) => {
        h.close();
        resolve(file);
      }, 200);
    });
    await new Promise((r) => setTimeout(r, 400)); // watcher 就绪
    fs.appendFileSync(f, line(1) + '\n');

    const file = await Promise.race([
      got,
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('watch 事件超时')), 5000)),
    ]);
    expect(file.replace(/\\/g, '/')).toMatch(/w\.jsonl$/);
  });
});
