// ─────────── 损坏库自愈（从原始会话重放）───────────
//
// 架构给了我们底气：**记忆库是派生存储**，原始会话在 DSH/ZCode 那边好好躺着，所以最可靠的
// 恢复不是"回滚备份"，而是"清库 → 重新采集"。备份只该用 VACUUM INTO（copy 不带 -wal 的
// .sqlite 是撕裂快照，2026-10-17 的事故就是这么来的）。
//
// ⚠️ 本文件原名 tools/ses-repair.mjs（外挂脚本），按 ADR-002 §4 搬进内核。两条路径：
//   ① 正常：改名 relay.sqlite/-wal/-shm 到 .damaged-<stamp>（留证），再 sync 重放；
//   ② EBUSY 兜底（1017 实测）：持有者在别的进程里（DSH 宿主内的插件连接查不到进程）时改名
//      会一直失败 —— 改成"复制留证 + 原地截断为 0 字节（SQLite 里 0 字节是合法空库）+ sync"。
//      代价：不能保留原 inode，别的进程手里的旧句柄会直接看到新库；但那些读者本来读的就是
//      坏库，这么做只会变好。

import fs from 'node:fs';
import path from 'node:path';
import { createDb } from '../../store/db.js';
import { loadConfig } from '../../shared/config.js';
import { runSync } from '../../capture/sync.js';

export interface IntegrityVerdict { ok: boolean; detail: string; sessions?: number; messages?: number; sizeMb?: number }

/** 体检一个库：读失败/完整性异常都返回 ok:false，并给出人话原因（不抛） */
export function integrityOf(file: string): IntegrityVerdict {
  if (!fs.existsSync(file)) return { ok: false, detail: '库不存在' };
  const sizeMb = Number((fs.statSync(file).size / 1048576).toFixed(1));
  try {
    const d = createDb(file);
    try {
      const v = String(Object.values(d.prepare('PRAGMA integrity_check').get() as Record<string, unknown>)[0]).slice(0, 80);
      const sessions = Number((d.prepare('SELECT count(*) c FROM sessions').get() as { c: number }).c);
      const messages = Number((d.prepare('SELECT count(*) c FROM messages').get() as { c: number }).c);
      return { ok: v === 'ok', detail: v, sessions, messages, sizeMb };
    } finally { try { d.close(); } catch { /* 已关 */ } }
  } catch (e) { return { ok: false, detail: '读取失败：' + String((e as Error).message).slice(0, 60), sizeMb }; }
}

export interface RepairOutcome extends IntegrityVerdict { repaired: boolean; mode?: 'rename' | 'in-place'; note: string }

/** 修一个项目的库：先改名留证，EBUSY 时改走原地截断；两种情况最后都用 sync 重放。 */
export async function repairProject(root: string): Promise<RepairOutcome> {
  const dir = path.join(root, '.sessionrelay');
  const db = path.join(dir, 'relay.sqlite');
  const before = integrityOf(db);
  if (before.ok) return { ...before, repaired: false, note: '完整，无需重建' };

  const stamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
  const aside = db + '.damaged-' + stamp;
  let mode: 'rename' | 'in-place' = 'rename';
  let moved = true;
  for (const f of [db, db + '-wal', db + '-shm']) {
    if (!fs.existsSync(f)) continue;
    try { fs.renameSync(f, f === db ? aside : aside + path.basename(f).replace('relay.sqlite', '')); }
    catch { moved = false; break; }
  }
  if (!moved) {
    mode = 'in-place';
    try { fs.copyFileSync(db, aside); }
    catch (e) { return { ...before, repaired: false, note: '改名与复制都失败：' + String((e as Error).message).slice(0, 60) }; }
    for (const f of [db, db + '-wal', db + '-shm']) {
      if (!fs.existsSync(f)) continue;
      try { const fd = fs.openSync(f, 'r+'); fs.ftruncateSync(fd, 0); fs.closeSync(fd); }
      catch (e) { return { ...before, repaired: false, note: '截断失败 ' + path.basename(f) + '：' + String((e as Error).message).slice(0, 50) }; }
    }
  }

  // 重放：sync 会重建 schema 并把原始会话灌回来（幂等）
  try {
    const cfg = loadConfig(root);
    const r = await runSync({ projectRoot: root, config: cfg });
    const after = integrityOf(db);
    return { ...after, repaired: after.ok, mode, note: '已重建（' + (mode === 'rename' ? '改名留证' : '就地截断') + '）：+'
      + r.newSessions + ' 场 / +' + r.newMessages + ' 条' };
  } catch (e) {
    return { ...before, repaired: false, mode, note: '重新采集失败：' + String((e as Error).message).slice(0, 80) };
  }
}
