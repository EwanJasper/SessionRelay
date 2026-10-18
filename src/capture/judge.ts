// 判定 tick（方针 §6.1 两阶段提交；Phase 2 将在 confirmed 副作用中加元数据提取与 summary_rule）
// now 可注入（技术方案 T5：冷却期逻辑必须可测，不能真等 6 小时）
import type { DB } from '../store/db.js';
import { dueIdle, dueConfirm, markPending, confirmSession, refreshExtraction, refreshDecisionsIncremental } from '../store/db.js';
import type { StatsCounter } from '../core/stats/counter.js';

export interface JudgeOptions {
  projectId: string;
  now: Date;
  idleMin: number;
  cooldownH: number;
  stats?: StatsCounter;
}

export interface JudgeResult { toPending: number; confirmed: number }

export function runJudge(db: DB, o: JudgeOptions): JudgeResult {
  const idleCutoff = new Date(o.now.getTime() - o.idleMin * 60_000).toISOString();
  const cooldownCutoff = new Date(o.now.getTime() - o.cooldownH * 3_600_000).toISOString();

  const idle = dueIdle(db, o.projectId, idleCutoff);
  for (const id of idle) {
    markPending(db, id, o.now.toISOString());
    // [fork 0924] 1a：pending 转换即刷新决策——长活会话不再冻结到 6h 确认。
    // [fork 0924b] 改增量：只提取上次水位之后的新消息（jieba 只扫增量），
    //   全量 topics/summary 重建留给 confirm——pending 时不再有 O(全会话) 的 CPU 突发
    refreshDecisionsIncremental(db, id);
  }

  // confirmed 统一走 confirmSession（提取元数据 + summary_rule + meta_text，方针 §6.6）
  const toConfirm = dueConfirm(db, o.projectId, cooldownCutoff);
  let confirmed = 0;
  for (const id of toConfirm) {
    if (confirmSession(db, id, o.now.toISOString())) confirmed++;
  }
  o.stats?.increment('confirmed', confirmed);

  return { toPending: idle.length, confirmed };
}
