// HANDOFF.md / timeline.md 生成（方针 §10.6：由 summary_rule 免费组装，零 LLM；页脚署名 T19）
import type { HopSessionFile } from './hop.js';

export interface HandoffDecision { at: string; source: string; sessionId: string; title: string | null; text: string; seq: number }

const d = (iso: string) => iso.slice(5, 10);

export function buildHandoff(projectName: string, sessions: HopSessionFile[], decisions: HandoffDecision[], footer: string, opts?: { summaryOnly?: boolean }): string {
  const lines: string[] = [];
  lines.push(`# 项目交接文档 · ${projectName}`);
  lines.push(`> 自动生成于 ${new Date().toISOString().slice(0, 10)} · ${sessions.length} 个会话 · 来源 ${[...new Set(sessions.map((s) => s.source))].join(', ')}`);
  lines.push('');

  lines.push('## 📋 关键决策');
  if (decisions.length === 0) lines.push('_（无已确认决策）_');
  else {
    lines.push('| 日期 | 决策 | 来源 |');
    lines.push('|------|------|------|');
    for (const dec of decisions.slice(0, 30)) {
      lines.push(`| ${d(dec.at)} | ${dec.text.replace(/\|/g, '/').slice(0, 80)} | ${dec.source} |`);
    }
  }
  lines.push('');

  lines.push('## 📁 涉及文件');
  const fileCount = new Map<string, number>();
  for (const s of sessions) for (const f of s.files) fileCount.set(f, (fileCount.get(f) ?? 0) + 1);
  const topFiles = [...fileCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
  if (topFiles.length === 0) lines.push('_（无）_');
  for (const [f, n] of topFiles) lines.push(`- \`${f}\`（讨论 ${n} 次）`);
  lines.push('');

  lines.push('## ❓ 未解决的问题');
  const unresolved = sessions.flatMap((s) => s.questions.filter((q) => q.unresolved).map((q) => ({ ...q, s })));
  if (unresolved.length === 0) lines.push('_（无）_');
  for (const q of unresolved.slice(0, 15)) lines.push(`- [ ] ${q.q}（${d(q.at ?? q.s.created_at)}，${q.s.source}）`);
  lines.push('');

  if (!opts?.summaryOnly) {
    lines.push('## 📖 会话摘要');
    for (const s of sessions) {
      lines.push(`### ${s.title ?? s.id}（${d(s.created_at)}，${s.source}）`);
      lines.push(s.summary_rule ? s.summary_rule.split('\n').slice(0, 4).join('  \n') : `_${s.messages.length} 条消息（无规则摘要）_`);
      lines.push('');
    }
  }

  lines.push('---');
  lines.push(`> ${footer}`);
  return lines.join('\n') + '\n';
}

export function buildTimeline(sessions: HopSessionFile[]): string {
  const lines = ['# 时间线', ''];
  for (const s of sessions) {
    lines.push(`- ${s.created_at.slice(0, 16).replace('T', ' ')} [${s.source}] ${s.title ?? s.id}（${s.messages.length || s.state === 'confirmed' ? 'confirmed' : 'active'}）`);
  }
  return lines.join('\n') + '\n';
}
