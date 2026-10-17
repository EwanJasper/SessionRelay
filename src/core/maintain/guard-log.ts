// 守护断线核算（空间自愈 · 可观测层）
//
// ── 病历（实测，2026-10-18）────────────────────────────────────────────
//   D:/agent1super/.sessionrelay/guard.log:
//     2026-10-18 02:00  instances=0/1  fork=OK (0.5.1-fork.1)
//   那一刻守护是 0 个实例，但 stats.json 后来又在更新 —— 说明它自己回来了，
//   可是**中间断了多长、断的时候丢没丢采集，没人知道**：guard.log 只记瞬时状态，不记时长，
//   也不记"恢复之后补没补"。
//
// 本模块只做两件事（不碰 guard.log 的写入方 watch-guard.ps1，那个脚本不在本仓）：
//   ① 把 guard.log 里的 instances=0 序列**合成断线区间**（含仍在持续的那段），算出分钟数；
//   ② 对超过阈值的区间给出"补采"判定：查项目库里**落在断线窗口内**的消息条数
//      （>0 = 恢复后已补进库；=0 = 没看到补采痕迹，说"未见"而不是断言"没补"）。
//   结论由 "srelay maintain --guard [--append]" 打印，或由生命周期 guard 阶段回写进 guard.log。
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { dbFile } from '../../shared/paths.js';

export const GUARD_ALARM_DEFAULT_MIN = 5;

export interface GuardSample {
  /** 解析出的本地时间（毫秒） */
  atMs: number;
  /** 原始时间文本（YYYY-MM-DD HH:MM，guard.log 的写法） */
  atText: string;
  instances: number;
  /** 期望实例数（instances=0/1 的斜杠右侧）；没写就是 null */
  want: number | null;
  raw: string;
}

export interface GuardGap {
  /** 断线开始时刻（第一个 instances=0 样本） */
  startMs: number;
  /** 恢复时刻（第一个 instances>0 样本）；仍在断线则为 null */
  endMs: number | null;
  /** 断线持续分钟（仍在断线时按 nowMs 算） */
  minutes: number;
  /** 是否已恢复 */
  closed: boolean;
  /** 是否达到报警阈值 */
  alarm: boolean;
}

export interface GuardAnalysis {
  samples: GuardSample[];
  gaps: GuardGap[];
  /** 达到报警阈值的区间 */
  alarming: GuardGap[];
}

export interface GuardProjectReport {
  root: string;
  file: string;
  exists: boolean;
  analysis: GuardAnalysis;
  /** 每条报警区间的补采判定（null = 主库打不开，无法判断） */
  backfill: Array<{ gap: GuardGap; messages: number | null }>;
  /** 本次真正追加进 guard.log 的行（append=true 才有） */
  appended: string[];
}

function two(n: number): string { return String(n).padStart(2, '0'); }

/** 本地时间戳（与 guard.log 同格式，便于 grep） */
export function formatStamp(ms: number): string {
  const d = new Date(ms);
  return d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate()) + ' ' + two(d.getHours()) + ':' + two(d.getMinutes());
}

/** 解析 guard.log：只认带 instances= 的行（dashboards=/patches= 等行忽略，但保留样本顺序）。 */
export function parseGuardSamples(text: string): GuardSample[] {
  const out: GuardSample[] = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})\s+instances=(\d+)(?:\/(\d+))?/);
    if (!m) continue;
    const atMs = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])).getTime();
    if (!Number.isFinite(atMs)) continue;
    out.push({
      atMs,
      atText: m[1] + '-' + m[2] + '-' + m[3] + ' ' + m[4] + ':' + m[5],
      instances: Number(m[6]),
      want: m[7] === undefined ? null : Number(m[7]),
      raw,
    });
  }
  return out.sort((a, b) => a.atMs - b.atMs);
}

/** 把连续的 instances=0 样本合成断线区间。判据（唯一一份）不含任何阈值 —— 阈值只决定"报不报"。 */
export function analyzeGuardGaps(samples: GuardSample[], opts: { alarmMinutes?: number; nowMs?: number } = {}): GuardAnalysis {
  const nowMs = Number.isFinite(opts.nowMs) ? Number(opts.nowMs) : Date.now();
  const alarmMinutes = Number.isFinite(Number(opts.alarmMinutes)) ? Number(opts.alarmMinutes) : GUARD_ALARM_DEFAULT_MIN;
  const gaps: GuardGap[] = [];
  let i = 0;
  while (i < samples.length) {
    if (samples[i].instances !== 0) { i++; continue; }
    const startMs = samples[i].atMs;
    let j = i;
    while (j < samples.length && samples[j].instances === 0) j++;
    const endMs = j < samples.length ? samples[j].atMs : null;
    const minutes = Math.max(0, Math.round((((endMs ?? nowMs) - startMs) / 60000) * 10) / 10);
    gaps.push({ startMs, endMs, minutes, closed: endMs !== null, alarm: minutes >= alarmMinutes });
    i = j;
  }
  return { samples, gaps, alarming: gaps.filter((g) => g.alarm) };
}

export function guardLogFile(root: string): string { return path.join(root, '.sessionrelay', 'guard.log'); }

/** 读 guard.log 并分析（文件不存在 → 空分析，不抛）。 */
export function analyzeGuardLog(root: string, opts: { alarmMinutes?: number; nowMs?: number } = {}): { file: string; exists: boolean; analysis: GuardAnalysis } {
  const file = guardLogFile(root);
  let text = '';
  const exists = fs.existsSync(file);
  if (exists) { try { text = fs.readFileSync(file, 'utf8'); } catch { text = ''; } }
  return { file, exists, analysis: analyzeGuardGaps(parseGuardSamples(text), opts) };
}

/** 断线窗口内**入库**的消息条数（补采判定）。null = 主库打不开/查询失败，无法判断。 */
export function countBackfillMessages(root: string, fromMs: number, toMs: number): number | null {
  const f = dbFile(root);
  if (!fs.existsSync(f)) return null;
  let db: InstanceType<typeof Database> | null = null;
  try {
    db = new Database(f, { readonly: true, fileMustExist: true });
    db.pragma('busy_timeout = 3000');
    const from = new Date(fromMs).toISOString();
    const to = new Date(toMs).toISOString();
    const row = db.prepare('SELECT count(*) AS c FROM messages WHERE created_at >= ? AND created_at <= ?').get(from, to) as { c?: number } | undefined;
    return Number(row?.c ?? 0);
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch { /* 关不上不影响判定 */ }
  }
}

/** 一行报警记录（写进 guard.log 的形态；带 [lifecycle] 前缀，便于和脚本自己的行区分）。 */
export function formatGapAlert(gap: GuardGap, messages: number | null, nowMs: number): string {
  const endText = gap.endMs === null ? '现在' : formatStamp(gap.endMs);
  const dur = gap.minutes >= 60 ? (gap.minutes / 60).toFixed(1) + 'h' : gap.minutes + 'min';
  const backfill = messages === null
    ? '补采=未知（主库打不开）'
    : messages > 0
      ? '补采=是：窗口内 ' + messages + ' 条消息已入库'
      : '补采=未见：窗口内 0 条消息入库（可能本无消息，也可能没补）';
  return formatStamp(gap.endMs ?? nowMs) + '  [lifecycle] gap=' + formatStamp(gap.startMs) + '→' + endText
    + ' (' + dur + ', instances=0) · ' + backfill;
}

// 追加去重状态：放在 .sessionrelay/guard-alerts.json，不污染 guard.log。
// 仍在持续的断线每分钟时长都在变，按"开始时刻 + 小时桶"去重（每小时最多补一条，能看到"断多久"在增长）；
// 已恢复的区间只记一次（closed 键）。
function alertKey(gap: GuardGap): string {
  return gap.closed ? 'closed:' + gap.startMs : 'open:' + gap.startMs + ':' + Math.floor(gap.minutes / 60);
}

function loadAlertState(file: string): Record<string, number> {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, number>; } catch { return {}; }
}

function saveAlertState(file: string, state: Record<string, number>, nowMs: number): void {
  const cutoff = nowMs - 30 * 86_400_000;
  const pruned: Record<string, number> = {};
  for (const [k, v] of Object.entries(state)) if (Number(v) >= cutoff) pruned[k] = Number(v);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(pruned, null, 2), 'utf8');
  } catch { /* 状态写不进去不阻塞追加：最坏是重复一行，不是丢报警 */ }
}

/** 项目级：分析 → 对报警区间做补采判定 → 可选追加进 guard.log（append=true）。 */
export function analyzeProjectGuard(root: string, opts: { alarmMinutes?: number; nowMs?: number; append?: boolean } = {}): GuardProjectReport {
  const nowMs = Number.isFinite(opts.nowMs) ? Number(opts.nowMs) : Date.now();
  const { file, exists, analysis } = analyzeGuardLog(root, { alarmMinutes: opts.alarmMinutes, nowMs });
  const backfill = analysis.alarming.map((gap) => ({
    gap,
    messages: countBackfillMessages(root, gap.startMs, gap.endMs ?? nowMs),
  }));
  const report: GuardProjectReport = { root, file, exists, analysis, backfill, appended: [] };
  if (!opts.append || !exists || backfill.length === 0) return report;
  const stateFile = path.join(root, '.sessionrelay', 'guard-alerts.json');
  const state = loadAlertState(stateFile);
  const lines: string[] = [];
  for (const b of backfill) {
    const key = alertKey(b.gap);
    if (state[key] !== undefined) continue;
    lines.push(formatGapAlert(b.gap, b.messages, nowMs));
    state[key] = nowMs;
  }
  if (lines.length === 0) return report;
  try {
    fs.appendFileSync(file, lines.join('\n') + '\n', 'utf8');
    report.appended = lines;
  } catch (e) {
    // 追加失败必须抛，让调用方看得见（不许"算出来但没记"）
    throw new Error('guard.log 追加失败（' + file + '）：' + String((e as Error)?.message ?? e));
  }
  saveAlertState(stateFile, state, nowMs);
  return report;
}
