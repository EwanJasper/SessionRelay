// ─────────── 派生列清洗：把 topics / files 里的噪声挤出去 ───────────
//
// 病历：topics 里混进过系统回显 token（\`task-notification\`/\`tool-use-id\` 这类）与停用词，
// files 列里混进过非文件串 —— 它们会顺着 meta_text 进 FTS，把检索面稀释掉。
//
// ⚠️ 判据只许有一份：这里调 core/extract 的 isTopicNoise / isLikelyFile（与抽取期同源），
// meta_text 用 store/db 的 recomputeSessionMetaText（唯一口径，含 decisions + user_tags）。
//   ⚠️ 曾用过 metaTextOf —— 它只算 title+topics，会**把决策从检索索引里删掉**（红队 P1）。
// 原先这段逻辑在 tools/ses-fix-topics.mjs（外挂脚本），按 ADR-002 §4 搬进内核。
//
// 纪律：**默认 dry-run**；写回前不改任何东西的顺序与大小写（只做删除）。

import type { DB } from '../../store/db.js';
import { recomputeSessionMetaText } from '../../store/db.js';
import { isTopicNoise, isLikelyFile } from './extract.js';

export interface DerivedCleanupReport {
  sessions: number;
  changed: number;
  topicsChanged: number;
  filesChanged: number;
  droppedKinds: number;
  fileKinds: number;
  sampleTopics: string[];
  sampleFiles: string[];
}

export function cleanDerivedColumns(db: DB, opts: { apply?: boolean } = {}): DerivedCleanupReport {
  const apply = opts.apply === true;
  const cols = (db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>).map((c) => c.name);
  const fcol = cols.includes('files_mentioned') ? 'files_mentioned' : (cols.includes('files') ? 'files' : null);
  const rows = db.prepare('SELECT id, title, topics' + (fcol ? ', ' + fcol + ' AS files' : '') + ' FROM sessions')
    .all() as Array<{ id: string; title: string | null; topics: string | null; files?: string | null }>;

  const dropT = new Map<string, number>();
  const dropF = new Map<string, number>();
  let changed = 0, tSessions = 0, fSessions = 0;
  // ⚠️ **不再自己拼 meta_text**（2026-10-18 红队 P1）：原来这条 UPDATE 写的是
  //   `meta_text = metaTextOf(title, keptT)` —— 而 metaTextOf 只算 title + topics，
  //   **丢掉 decisions 与 user_tags**。后果不是报错，是决策从检索索引里静默消失：
  //   实测 cleanup 前 search('PostgreSQL')=1 条，cleanup 后 =0 条，meta 从
  //   「…决定 采用 postgresql … pin」变成「认证 方案 讨论 认证」。
  //   对**已归档**会话（aging 已删正文）尤其致命 —— decisions 是它唯一可检索的载体。
  //   meta_text 的唯一口径在 store/db.ts 的 recomputeSessionMetaText；这里只改派生列，
  //   改完立刻让它重算（判据只许有一份，抄一遍就是第二份）。
  const upd = apply ? db.prepare('UPDATE sessions SET ' + ['topics = ?', ...(fcol ? [fcol + ' = ?'] : [])].join(', ') + ' WHERE id = ?') : null;

  for (const r of rows) {
    let topics: unknown = [], files: unknown = [];
    try { topics = r.topics ? JSON.parse(r.topics) : []; } catch { topics = []; }
    try { files = r.files ? JSON.parse(r.files) : []; } catch { files = []; }
    const keptT = Array.isArray(topics) ? topics.filter((t) => !isTopicNoise(String(t))) : [];
    const keptF = Array.isArray(files) ? files.filter((p) => isLikelyFile(String(p))) : [];
    const tChanged = Array.isArray(topics) && keptT.length !== topics.length;
    const fChanged = Array.isArray(files) && keptF.length !== files.length;
    if (!tChanged && !fChanged) continue;
    changed++;
    if (tChanged) { tSessions++; for (const t of topics as unknown[]) if (isTopicNoise(String(t))) dropT.set(String(t), (dropT.get(String(t)) ?? 0) + 1); }
    if (fChanged) { fSessions++; for (const p of files as unknown[]) if (!isLikelyFile(String(p))) dropF.set(String(p), (dropF.get(String(p)) ?? 0) + 1); }
    if (upd) {
      const args: unknown[] = [JSON.stringify(keptT)];
      if (fcol) args.push(JSON.stringify(keptF));
      upd.run(...args, r.id);
      // meta_text 交给唯一口径重算（含 decisions 前 30 字 + user_tags）。
      // 算不出来也不阻塞清理：下一轮 recompute 会再算一次。
      try { recomputeSessionMetaText(db, r.id); } catch { /* 单行失败不阻塞整批 */ }
    }
  }
  const top = (m: Map<string, number>, n: number) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => k + '×' + v);
  return {
    sessions: rows.length, changed, topicsChanged: tSessions, filesChanged: fSessions,
    droppedKinds: dropT.size, fileKinds: dropF.size,
    sampleTopics: top(dropT, 6), sampleFiles: top(dropF, 4),
  };
}
