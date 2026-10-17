import fs from 'node:fs';
import type { Database } from 'better-sqlite3';

/**
 * SQLite 空间回收（FTS 索引垃圾 + freelist）。
 *
 * ── 为什么需要它（实测病历，2026-10-18）────────────────────────────────────
 * 用户问「库会不会长到几个 G」。全部 9 个项目库实测 195 MB，不算大，但拆开看吓人：
 *
 *   E:/work        文件 32.27 MB，messages 表只有 0.86 MB / 902 条
 *                  ⇒ messages_fts_data 占 **28.55 MB**，是它索引内容的 33 倍
 *   E:/小说项目     文件 14.20 MB，messages 0.67 MB / 310 条，fts 12.87 MB（19 倍）
 *
 * 在**副本**上跑 rebuild + VACUUM（不碰原库）实测：
 *   E:/work        32.27 → 3.02 MB   （-29.25 MB, -91%）
 *   E:/小说项目     14.20 → 1.41 MB   （-12.79 MB, -90%）
 *   D:/agent1super 68.52 → 56.50 MB  （-12.02 MB, -18%）
 *   E:/music player 62.99 → 58.86 MB （-4.13 MB）
 *   六库合计      195.02 → 135.74 MB （**省 59.28 MB / 30%，总共 4 秒**）
 *
 * 根因：删/改消息**不会让 FTS 缩小**。触发器（messages_fts_ad / _au）只是往 FTS5
 *   影子表里写 delete 标记，这些墓碑要等 merge/optimize/rebuild 才真正回收。
 *   于是「数据被清掉了、文件却没变小」—— 用户看到的就是"一直涨"。
 *
 * 判据**故意保守**：只在文件显著大于实际内容时才动手（默认 2.0 倍）。
 *   · 正常的库（agent1super 1.74、music 1.63、mc 1.53）**不动** —— rebuild 要独占
 *     写锁、VACUUM 要重写整个文件，为省几 MB 冒这个风险不值得；
 *   · 病态的库（work 37 倍、小说项目 21 倍）自动回收。
 *   · 想强制回收旧的正常库：`srelay maintain --fts --force`。
 */
export interface FtsSpaceStats {
  /** 数据库文件字节数 */
  fileBytes: number;
  /** 实际内容字节数（messages + sessions 的文本列长度之和） */
  contentBytes: number;
  /** 消息条数 */
  messages: number;
}

export interface FtsMaintOptions {
  /** 文件 / 内容 的倍数阈值，超过才回收。默认 2.0 */
  ratio?: number;
  /** 无视阈值强制回收 */
  force?: boolean;
}

export interface FtsMaintResult {
  stats: FtsSpaceStats;
  beforeBytes: number;
  afterBytes: number;
  reclaimed: number;
  rebuilt: boolean;
  /** 没回收时的原因（容错不许静默：跳过也必须说为什么） */
  skippedReason?: string;
}

/** 判据（**唯一一份**）：文件体积相对实际内容的膨胀倍数 */
export function wasteRatio(s: FtsSpaceStats): number {
  return s.contentBytes > 0 ? s.fileBytes / s.contentBytes : 0;
}

export function shouldReclaim(s: FtsSpaceStats, o: FtsMaintOptions = {}): boolean {
  if (o.force) return true;
  // 内容/条数太小的库不参与判断：几百字节的库比值毫无意义（VACUUM 反而浪费时间）。
  // ⚠️ 这两个门槛是我第一版写错的地方，被单测当场抓住 —— 原来写的是 contentBytes < 1MB，
  //   而**真正的病态库恰好内容就很小**（E:/work 0.86 MB 内容撑出 32 MB 文件、
  //   小说项目 0.67 MB 撑出 14 MB）⇒ 阈值把要治的病全排除在外，机制等于不存在。
  //   判据必须按"比值"干活，"内容多少"只用来排除真正的新库/空库。
  if (s.contentBytes < 65_536 || s.messages < 50) return false;
  return wasteRatio(s) >= (o.ratio ?? 2.0);
}

/** 只读测量（不写库、不加锁） */
export function measureFtsSpace(db: Database, file: string): FtsSpaceStats {
  let fileBytes = 0;
  try { fileBytes = fs.statSync(file).size; } catch { /* 文件不在就当 0 */ }
  const one = (sql: string): number => {
    try { return Number((db.prepare(sql).get() as { s?: number } | undefined)?.s ?? 0); } catch { return 0; }
  };
  const contentBytes = one(
    "SELECT (SELECT SUM(length(coalesce(content,''))) + SUM(length(coalesce(search_text,''))) FROM messages)"
    + " + (SELECT SUM(length(coalesce(title,''))) + SUM(length(coalesce(summary,''))) FROM sessions) AS s"
  );
  const messages = one('SELECT count(*) AS s FROM messages');
  return { fileBytes, contentBytes, messages };
}

/**
 * 回收空间。**只在 shouldReclaim 判过之后调用**（force 由调用方决定）。
 *
 * rebuild 而非 optimize：实测 optimize 只合并段、不退墓碑、文件不缩；
 *   rebuild 按 content 表重建整个索引，才能把墓碑真的丢掉，之后 VACUUM 才收得回。
 * 失败一律抛出，不静默 —— 上层要能把"回收失败"报给人。
 */
export function maintainFts(db: Database, file: string, o: FtsMaintOptions = {}): FtsMaintResult {
  const stats = measureFtsSpace(db, file);
  const beforeBytes = stats.fileBytes;
  const finish = (rebuilt: boolean, reason?: string): FtsMaintResult => {
    let afterBytes = beforeBytes;
    try { afterBytes = fs.statSync(file).size; } catch { /* 保持原值 */ }
    return {
      stats, beforeBytes, afterBytes, reclaimed: Math.max(0, beforeBytes - afterBytes),
      rebuilt, ...(reason ? { skippedReason: reason } : {}),
    };
  };
  if (!shouldReclaim(stats, o)) {
    return finish(false, '体积正常（' + wasteRatio(stats).toFixed(2) + ' 倍 < 阈值 ' + (o.ratio ?? 2.0) + '）');
  }
  // 重建索引：把墓碑真的丢掉（只跑一次 rebuild，判据已在上面定过）
  db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')");
  try { db.exec("INSERT INTO sessions_fts(sessions_fts) VALUES('rebuild')"); } catch { /* 没有该表就跳过 */ }
  // VACUUM 必须在事务外、且不能有别的连接持有写锁
  db.exec('VACUUM');
  return finish(true);
}
