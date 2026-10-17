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
import { createDb, openReadonly } from '../../store/db.js';
import { loadConfig } from '../../shared/config.js';
import { runSync } from '../../capture/sync.js';

/**
 * 体检结论。**必须区分"读不了"和"坏了"** —— 这是 2026-10-18 事故的根因：
 *
 * 病历：那天为了重置版本戳手写了一条 UPDATE，撞上别的进程持锁（SQLITE_BUSY）。
 *   integrityOf() 用 createDb() 打开库，锁冲突时抛错 → catch 统一返回 ok:false
 *   → repairProject 把**两个完好无损的库**（agent1super 57MB / dsh插件记忆 2.3MB）
 *   改名成 .damaged-* 并另建空库。数据没丢（留在 .damaged 里），但采集停了、
 *   面板显示 0 场、还差点被当成"库损坏"去重建。
 *
 * 判据覆盖不到的地方就在这：ok 是一个布尔位，而实际情况有三类——
 *   · 真损坏（能打开，但 integrity_check != ok）     → 该隔离重建
 *   · 被别的进程锁着（SQLITE_BUSY / database is locked）→ **绝不该隔离**，等下轮重试
 *   · 文件不存在                                     → 该建库
 * 用一个布尔位表达三件事，就是把"暂时读不到"当成"永久坏了"。
 */
export type IntegrityKind = 'ok' | 'corrupt' | 'busy' | 'missing' | 'error';

export interface IntegrityVerdict {
  ok: boolean;
  /** 细分结论：只有 'corrupt' 才允许隔离重建 */
  kind: IntegrityKind;
  detail: string; sessions?: number; messages?: number; sizeMb?: number;
}

/** 锁冲突的识别（不同平台/驱动措辞不同，宁可多认几个） */
export function isBusyMessage(msg: string): boolean {
  return /database is locked|SQLITE_BUSY|SQLITE_LOCKED|EBUSY|database table is locked|database schema is locked/i.test(msg);
}

/**
 * 真损坏的识别（红队 R1）。以前这两类落进 error 分支，于是**永远不被修复**：
 * 我只把"能打开 + DDL 跑完 + integrity_check 非 ok"算 corrupt，
 * 但真损坏最常见的两种形态**在 createDb 阶段就抛了**：
 *   · 文件根本不是库 → SQLITE_NOTADB / "file is not a database"
 *   · 页结构坏了     → "database disk image is malformed"（integrity_check 之前就抛）
 * 都不隔离也不重建 ⇒ repair 每轮打印"重建失败"却永不动手。
 * 那是**静默躺平**，比误隔离更难发现。
 */
export function isCorruptMessage(msg: string): boolean {
  return /SQLITE_NOTADB|SQLITE_CORRUPT|file is not a database|database disk image is malformed|malformed database schema/i.test(msg);
}

export function integrityOf(file: string): IntegrityVerdict {
  if (!fs.existsSync(file)) return { ok: false, kind: 'missing', detail: '库不存在' };
  const sizeMb = Number((fs.statSync(file).size / 1048576).toFixed(1));
  // ★ 体检是**读**操作，必须用只读连接。
  //   用 createDb（可写）做体检 = 体检自己抢写锁 → 自己检测到「被占用」→ 自己判 busy。
  //   这是「自证预言」：库里一切正常，检查的人把它锁住了，然后报告锁冲突。
  //   只读打不开时**退一次可写**（WAL/-shm 缺失等场景只读会 CANTOPEN），但把这件事说出来——
  //   绝不因为「只读失败」就直接判库有问题，那会变成另一种躺平（永远报错、永不修）。
  let note = '';
  try {
    let d: ReturnType<typeof createDb>;
    try {
      d = openReadonly(file);
    } catch (eRo) {
      const m = String((eRo as Error).message).slice(0, 80);
      if (isBusyMessage(m) || isCorruptMessage(m)) throw eRo;   // 只读都打不开：按原逻辑走下面的分叉
      d = createDb(file);
      note = '（只读打开失败，已退回可写体检：' + m + '）';
    }
    try {
      const v = String(Object.values(d.prepare('PRAGMA integrity_check').get() as Record<string, unknown>)[0]).slice(0, 80);
      const sessions = Number((d.prepare('SELECT count(*) c FROM sessions').get() as { c: number }).c);
      const messages = Number((d.prepare('SELECT count(*) c FROM messages').get() as { c: number }).c);
      return { ok: v === 'ok', kind: v === 'ok' ? 'ok' : 'corrupt', detail: v + note, sessions, messages, sizeMb };
    } finally { try { d.close(); } catch { /* 已关 */ } }
  } catch (e) {
    const msg = String((e as Error).message).slice(0, 80);
    // ★ 关键分叉：锁冲突不是损坏。绝不能让"现在读不到"变成"隔离 + 另建空库"。
    // ★ 顺序要紧：**先判锁、再判损坏**。反过来会把锁冲突当损坏去隔离 —— 那就是 10-18 事故。
    if (isBusyMessage(msg)) return { ok: false, kind: 'busy', detail: '被占用（不是损坏）：' + msg, sizeMb };
    if (isCorruptMessage(msg)) return { ok: false, kind: 'corrupt', detail: '库已损坏：' + msg, sizeMb };
    return { ok: false, kind: 'error', detail: '读取失败（既非锁冲突也非已知损坏，本轮不动文件）：' + msg, sizeMb };
  }
}

export interface RepairOutcome extends IntegrityVerdict { repaired: boolean; mode?: 'rename' | 'in-place'; note: string }

/** 修一个项目的库：先改名留证，EBUSY 时改走原地截断；两种情况最后都用 sync 重放。 */
export async function repairProject(root: string): Promise<RepairOutcome> {
  const dir = path.join(root, '.sessionrelay');
  const db = path.join(dir, 'relay.sqlite');
  const before = integrityOf(db);
  if (before.ok) return { ...before, repaired: false, note: '完整，无需重建' };

  // ★★ 只有"真损坏"才允许改名隔离 + 另建空库。
  //   2026-10-18 事故：库被别的进程锁着 → createDb 抛 SQLITE_BUSY → 旧代码只有 ok:false 一个信号
  //   → 把两个完好的库（57MB / 2.3MB）改名成 .damaged-* 并建了空库。
  //   现在锁冲突/读取失败一律**不动文件**，只说清楚、下轮再来。
  if (before.kind === 'busy') {
    return { ...before, repaired: false, note: '库被其他进程占用，本轮跳过（**不是损坏，未做任何改动**）。守护/DSH 关闭后会自动重试。' };
  }
  if (before.kind === 'error') {
    return { ...before, repaired: false, note: '读取失败但不是完整性错误，本轮跳过（未做任何改动）：' + before.detail };
  }
  // kind === 'missing'：文件本来就不在，直接 sync 建库，不需要"隔离"（没有东西可隔离）
  if (before.kind === 'missing') {
    try {
      const cfg = loadConfig(root);
      const r = await runSync({ projectRoot: root, config: cfg });
      const after = integrityOf(db);
      return { ...after, repaired: after.ok, mode: 'rename', note: '库不存在，已新建：+' + r.newSessions + ' 场 / +' + r.newMessages + ' 条' };
    } catch (e) {
      return { ...before, repaired: false, note: '新建失败：' + String((e as Error).message).slice(0, 80) };
    }
  }

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
    // ★ 改名失败 = 文件被占用 = 有别的进程正开着这个库。此时「原地截断」是**危险动作**：
    //   你截掉的是别人正在用的文件。所以留证必须做全，且截断前要重新确认状态。
    //
    //   ① 留证要复制**三个文件**（db / -wal / -shm），不能只复制 db ——
    //      只复制 db 会丢掉 -wal 里尚未 checkpoint 的事务，留下的是一份**撕裂的证据**：
    //      事后拿它去抢救，会发现「明明有的数据不见了」，而且无从判断是本来就没有还是复制漏了。
    //   ② 这份快照仍然是**尽力而为**（三个文件分三次复制，中途可能被改），不是一致性备份 ——
    //      所以 note 必须这么说，别让人以为拿到了可靠归档。
    const side = [
      [db, aside],
      [db + '-wal', aside + '-wal'],
      [db + '-shm', aside + '-shm'],
    ];
    for (const [src, dst] of side) {
      if (!fs.existsSync(src)) continue;
      try { fs.copyFileSync(src, dst); }
      catch (e) { return { ...before, repaired: false, note: '留证复制失败 ' + path.basename(src) + '（**未截断任何文件**）：' + String((e as Error).message).slice(0, 50) }; }
    }
    // ③ 截断前再验一次：复制期间别的进程可能已退出、库也许多数状态变了。
    //    不是 corrupt 就**立刻停手** —— 破坏性动作只对「确实是坏库」才成立。
    const recheck = integrityOf(db);
    if (recheck.kind !== 'corrupt') {
      return { ...recheck, repaired: false, mode,
        note: '复制期间库状态变成 ' + recheck.kind + '，已放弃截断（**未做破坏性改动**）；留证在 ' + path.basename(aside) + '（尽力而为快照）' };
    }
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
