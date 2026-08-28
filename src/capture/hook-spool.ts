// Hook spool（技术方案 R4）：Claude Code 生命周期钩子的最低成本落地通道
// srelay hook <event> --id <sid> → .sessionrelay/events/<ts>.json → watch 周期消费
import fs from 'node:fs';
import path from 'node:path';
import { relayDir } from '../shared/paths.js';
import type { DB } from '../store/db.js';
import { markPending } from '../store/db.js';

const eventsDir = (root: string) => path.join(relayDir(root), 'events');

export function writeHookEvent(root: string, event: string, sid: string): string {
  const dir = eventsDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
  fs.writeFileSync(file, JSON.stringify({ event, sid, at: new Date().toISOString() }));
  return file;
}

export interface SpoolResult { consumed: number; endSignals: number }

/** 消费 spool：session-end → 该会话立即转 pending（跳过 idle 等待，方针 §6.1 Adapter 信号） */
export function consumeHookEvents(root: string, db: DB, now: Date): SpoolResult {
  const dir = eventsDir(root);
  if (!fs.existsSync(dir)) return { consumed: 0, endSignals: 0 };
  let consumed = 0;
  let endSignals = 0;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const file = path.join(dir, f);
    try {
      const ev = JSON.parse(fs.readFileSync(file, 'utf8')) as { event: string; sid: string };
      if (ev.event === 'session-end') {
        // sid 是源会话 ID（如 claude-code 的 uuid）——按身份找到内部会话
        const row = db.prepare('SELECT id, state FROM sessions WHERE source_session_id = ?').get(ev.sid) as { id: string; state: string } | undefined;
        if (row && row.state === 'active') {
          markPending(db, row.id, now.toISOString());
          endSignals++;
        }
      }
      consumed++;
    } catch { /* 坏事件文件：删除防堆积 */ }
    fs.rmSync(file, { force: true });
  }
  return { consumed, endSignals };
}
