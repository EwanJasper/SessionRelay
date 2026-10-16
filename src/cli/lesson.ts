// srelay lesson —— 全局经验层的命令行入口（设计见 docs/1016-全局经验层设计.md）
import fs from 'node:fs';
import path from 'node:path';
import { pc } from './ui.js';
import { openGlobal, addLesson, listLessons, searchLessons, maintainLessons, exportMarkdown, globalDbFile, liveImportance, type Grade, type Scope } from '../store/global.js';

export interface LessonFlags {
  quote?: string; source?: string; route?: string; grade?: string; scope?: string;
  workspace?: string; domain?: string; status?: string; top?: string; json?: boolean;
}

export async function cmdLesson(sub: string | undefined, text: string[], f: LessonFlags): Promise<void> {
  const db = openGlobal();
  const ws = f.workspace || process.cwd();
  const sel = { workspaceId: ws, domain: f.domain, status: f.status as never, top: f.top ? Number(f.top) : undefined };
  try {
    if (sub === 'add') {
      const body = text.join(' ').trim();
      if (!body) { console.error('用法: srelay lesson add "<一句话经验>" [--source <出处>] [--quote <原文>] [--grade verified-user] [--scope project|domain|global] [--domain <标签>]'); process.exit(2); }
      const r = addLesson(db, {
        text: body, grade: (f.grade as Grade) ?? undefined, scope: (f.scope as Scope) ?? undefined,
        workspaceId: ws, domain: f.domain, quote: f.quote, sourceRef: f.source, route: f.route,
      });
      if (f.json) console.log(JSON.stringify(r));
      else console.log(pc.green('✓ 已记下经验 #' + r.id) + (r.reason ? pc.yellow('（' + r.reason + '）') : ''));
      return;
    }
    if (sub === 'search') {
      const q = text.join(' ').trim();
      const rows = q ? searchLessons(db, q, sel) : [];
      if (f.json) { console.log(JSON.stringify(rows)); return; }
      if (rows.length === 0) { console.log(pc.dim('没有相关经验。')); return; }
      for (const r of rows) console.log('  [' + r.scope + '|' + r.grade + '|' + Number(liveImportance(r)).toFixed(1) + '] ' + r.text);
      return;
    }
    if (sub === 'maintain') {
      const r = maintainLessons(db);
      if (f.json) { console.log(JSON.stringify(r)); return; }
      console.log('衰减处理 ' + r.decayed + ' 条 · 退休 ' + r.retired + ' 条 · 复活 ' + r.resurrected + ' 条');
      console.log(pc.dim('  口径：年龄每天 -' + 0.0083 + ' 分，低于阈值 ' + 6 + ' 分则退休（仍可被 lesson search 检索到）'));
      return;
    }
    if (sub === 'export') {
      const out = path.join(path.dirname(globalDbFile()), 'global-experiences.md');
      fs.writeFileSync(out, exportMarkdown(db));
      console.log('已导出 → ' + out);
      return;
    }
    // 默认 list
    const rows = listLessons(db, sel);
    if (f.json) { console.log(JSON.stringify(rows)); return; }
    console.log(pc.dim('库: ' + globalDbFile() + '  可见范围: ' + ws + (f.domain ? ' + domain:' + f.domain : '')));
    if (rows.length === 0) { console.log('（还没有经验）用法: srelay lesson add "<一句话经验>" --source <出处>'); return; }
    for (const r of rows) {
      const mark = Number(liveImportance(r)) >= 6 ? '●' : pc.dim('○');
      console.log(' ' + mark + ' [' + r.scope + '|' + r.grade + '|' + r.status + '|' + Number(liveImportance(r)).toFixed(1) + '] ' + r.text);
    }
    console.log(pc.dim('\n共 ' + rows.length + ' 条 · ● 可进注入层 · ○ 已退休（仍可 search）'));
  } finally { db.close(); }
}