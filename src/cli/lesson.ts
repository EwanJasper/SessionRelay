// srelay lesson —— 全局经验层的命令行入口（设计见 docs/1016-全局经验层设计.md）
import fs from 'node:fs';
import path from 'node:path';
import { pc } from './ui.js';
import { openGlobal, addLesson, listLessons, searchLessons, maintainLessons, exportMarkdown, globalDbFile, liveImportance, INJECT_THRESHOLD, type Grade, type Scope } from '../store/global.js';
import { resolveDomain, resolveWorkspaceId } from '../shared/workspace.js';

export interface LessonFlags {
  since?: string; dry?: boolean;
  quote?: string; source?: string; route?: string; grade?: string; scope?: string;
  workspace?: string; domain?: string; status?: string; top?: string; json?: boolean;
}

export async function cmdLesson(sub: string | undefined, text: string[], f: LessonFlags): Promise<void> {
  const db = openGlobal();
  // [1016 红队 A-5] 工作区 = **项目根**（不是 cwd），领域标签来自项目配置 —— 写读两侧同源。
  // 病历：在子目录里 add 的经验，回到项目根 list 就看不见（写者存 cwd、读者拿 root）。
  const ws = f.workspace || resolveWorkspaceId(process.cwd());
  const dom = f.domain || resolveDomain(ws);
  const sel = { workspaceId: ws, domain: dom, status: f.status as never, top: f.top ? Number(f.top) : undefined };
  try {
    if (sub === 'add') {
      const body = text.join(' ').trim();
      if (!body) { console.error('用法: srelay lesson add "<一句话经验>" [--source <出处>] [--quote <原文>] [--grade verified-user] [--scope project|domain|global] [--domain <标签>]'); process.exit(2); }
      const r = addLesson(db, {
        text: body, grade: (f.grade as Grade) ?? undefined, scope: (f.scope as Scope) ?? undefined,
        workspaceId: ws, domain: dom, quote: f.quote, sourceRef: f.source, route: f.route,
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
    if (sub === 'harvest') {
      const { runHarvest } = await import('./lesson-harvest.js');
      const { requireRoot } = await import('./ui.js');
      const { openRelayDb } = await import('./ui.js');
      const root = requireRoot();
      const pdb = openRelayDb(root);
      try {
        await runHarvest(db as never, pdb as never, ws, { days: Number(f.since || '14'), dry: !!f.dry, json: !!f.json });
      } finally { pdb.close(); }
      return;
    }
    // [1016] 草稿复核入口：harvest 产出的 draft 必须**由人**升 verified 才可能进注入层。
    // 这是设计里"闸 3"的落地——**模型无权决定收不收**，人说了才算。
    if (sub === 'confirm' || sub === 'reject') {
      const ids = text.map((t) => Number(String(t).replace(/^#/, ''))).filter((n) => Number.isInteger(n) && n > 0);
      if (ids.length === 0) { console.error('用法: srelay lesson confirm <id...>   （id 见 lesson list；reject = 标 retired）'); process.exit(2); }
      const to = sub === 'confirm' ? 'verified' : 'rejected';
      // ⚠️ 只改状态是不够的：注入还有一道"等级"闸，inferred 一律进不去。
      // **人工确认本身就是证据**（强于"文件里读到"），所以 confirm 时把 inferred 抬到 verified-file（6.0）。
      // 实测踩过：只改状态 → 复核完了还是 ○、还是进不了注入层，看起来"确认没生效"。
      const upd = db.prepare('UPDATE lessons SET status = ?, updated_at = ?, grade = CASE WHEN ? = ? AND grade = ? THEN ? ELSE grade END, importance = CASE WHEN ? = ? AND grade = ? THEN ? ELSE importance END WHERE id = ?');
      const now = new Date().toISOString();
      let n = 0;
      for (const id of ids) {
        const r = upd.run(to, now, to, 'verified', 'inferred', 'verified-file', to, 'verified', 'inferred', 6.0, id);
        if (Number(r.changes) > 0) n++;
      }
      console.log(pc.green('✓ ' + n + ' 条 → ' + to) + pc.dim('（' + (to === 'verified' ? '下次注入就可能带上它们' : '已退休：不再默认注入，但仍可 lesson search 到') + '）'));
      return;
    }
    if (sub === 'maintain') {
      const r = maintainLessons(db);
      if (f.json) { console.log(JSON.stringify(r)); return; }
      console.log('衰减处理 ' + r.decayed + ' 条 · 退休 ' + r.retired + ' 条 · 复活 ' + r.resurrected + ' 条');
      console.log(pc.dim('  口径：年龄每天 -' + 0.0083 + ' 分，低于阈值 ' + INJECT_THRESHOLD + ' 分则退休（仍可被 lesson search 检索到）'));
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
    console.log(pc.dim('库: ' + globalDbFile() + '  可见范围: ' + ws + (dom ? ' + domain:' + dom : '')));
    if (rows.length === 0) { console.log('（还没有经验）用法: srelay lesson add "<一句话经验>" --source <出处>'); return; }
    for (const r of rows) {
      // ⚠️ 这里必须用**与注入闸同一个常量**（INJECT_THRESHOLD=5.5）。
      // 实测踩过：原先硬编码 6，于是刚 confirm 的条目（5.99）在列表里显示 ○ ——
      // 「看着没生效，其实已经能注入了」，是最容易让人误判的一类不一致。
      const mark = Number(liveImportance(r)) >= INJECT_THRESHOLD ? '●' : pc.dim('○');
      console.log(' ' + mark + ' [' + r.scope + '|' + r.grade + '|' + r.status + '|' + Number(liveImportance(r)).toFixed(1) + '] ' + r.text);
    }
    console.log(pc.dim('\n共 ' + rows.length + ' 条 · ● 可进注入层 · ○ 已退休（仍可 search）'));
  } finally { db.close(); }
}