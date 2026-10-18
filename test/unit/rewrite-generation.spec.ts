import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readNew } from '../../src/adapters/claude-code/index.js';

/**
 * 「变短式重写」的代际推进（第三轮验证红队 P1，端到端实测复现）。
 *
 * 病历：`tailCompleteLines` 内部自己判了 detectRewrite（文件变短）并**就地复位** offset/行号，
 *   但不把这件事回传；三个适配器只在「tailHash 变了」那一支 rewrites += 1。
 *   于是变短的重写：行号从 1 重数、genBase 不变 ⇒ seq 与上一代撞 ⇒ upsertMessage 判 conflict
 *   ⇒ **库内保留旧正文、新正文永久写不进**。实测：new=0 conflicts=1，库里三条一字未变。
 *   这正是「代际偏移」那条修复要治的病，在同胞路径上原样存在。
 */
const msg = (n, text) => JSON.stringify({ type: n % 2 === 0 ? "user" : "assistant", message: { content: text } });
const mkds = (file) => ({ source: "claude-code", sourceSessionId: "s1", sourceFile: file, title: null });

describe('变短式重写的代际推进', () => {
  it('★ 文件被重写成更短后，rewrites 必须推进（否则新正文永远写不进库）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'srelay-gen-'));
    const f = path.join(dir, 'sess.jsonl');
    fs.writeFileSync(f, [msg(0, "问题A原文"), msg(1, "回答B"), msg(2, "问题C")].join("\n") + "\n");
    const r1 = await readNew(mkds(f), undefined);
    expect(r1.messages.length).toBe(3);
    expect(r1.cursor.rewrites).toBe(0);
    // 整段重写成更短的 2 行（首行还改了）—— 这正是红队复现的那一步
    fs.writeFileSync(f, [msg(0, "问题A改写"), msg(1, "新回答")].join("\n") + "\n");
    const r2 = await readNew(mkds(f), r1.cursor);
    expect(r2.cursor.rewrites, "变短重写必须推进代际").toBeGreaterThanOrEqual(1);
    // 新内容必须落在**新一代** seq 空间（不与上一代撞）
    expect(r2.messages.length).toBe(2);
    for (const m of r2.messages) expect(m.seqNum).toBeGreaterThanOrEqual(1_000_000);
  });

  it('纯追加不误报重写（rewrites 保持 0）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'srelay-gen2-'));
    const f = path.join(dir, 'sess.jsonl');
    fs.writeFileSync(f, [msg(0, "甲")].join("\n") + "\n");
    const r1 = await readNew(mkds(f), undefined);
    fs.appendFileSync(f, msg(1, "乙") + "\n");
    const r2 = await readNew(mkds(f), r1.cursor);
    expect(r2.cursor.rewrites).toBe(0);
    expect(r2.messages.length).toBe(1);
  });
});
