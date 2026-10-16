// 全局经验段的取数与渲染（DSH 插件侧）
//
// 为什么单独一个文件：插件是**自包含**的（不 import 核心库源码），
// 而经验库在**另一个库**（~/.sessionrelay/global.sqlite）——与项目库同构但不同文件。
// 口径与核心库 store/global.ts 的 pickForInjection 保持一致，改一处要同步另一处。
//
// 三条纪律（来自实测，别改）：
//   ① **只取 verified/confirmed 且非 inferred** —— 草稿永不进注入层；
//   ② **相关性要具体**：命中标识符（含 . _ - 的长词）或实词；常用词不算数；
//   ③ **预算 ≤200 字符 / ≤3 条**，没命中就返回空串（整段不渲染）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const COMMON = new Set(['这个','那个','什么','怎么','为什么','可以','需要','应该','我们','你们','他们','现在','然后','没有','不是','还是','或者','因为','所以','但是','如果','已经','还有','就是','一下','东西','时候','问题','这样','那样']);

function globalDb() {
  const home = process.env.SRELAY_GLOBAL_HOME || path.join(os.homedir(), '.sessionrelay');
  const f = path.join(home, 'global.sqlite');
  try { if (!fs.existsSync(f)) return null; } catch { return null; }
  return f;
}

/** 取经验段（同步、只读、毫秒级；库不存在/打不开一律返回空串，绝不抛） */
export function experiencesLine(root, opts = {}) {
  const f = globalDb();
  if (!f) return '';
  let db;
  try {
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(f, { readOnly: true });
  } catch { return ''; }
  try {
    const ws = String(root || '');
    const rows = db.prepare(
      "SELECT text, scope, grade, importance, uses, hits, created_at FROM lessons "
      + "WHERE (scope = 'global' OR (scope = 'project' AND workspace_id = ?)) "
      + "AND status IN ('verified','confirmed') AND grade <> 'inferred' "
      + 'ORDER BY importance DESC LIMIT 40'
    ).all(ws);
    if (!rows.length) return '';
    // 年龄衰减 + 复用回血（与核心库同一公式）
    const now = Date.now();
    const live = rows.map((r) => ({
      ...r,
      live: Number(r.importance) - Math.max(0, (now - Date.parse(r.created_at)) / 86400000) * 0.0083
        + Math.log1p(Number(r.uses || 0)) * 1.5 + Math.min(1, Number(r.hits || 0) * 0.1),
    })).filter((r) => r.live >= 5.5);
    if (!live.length) return '';
    const q = String(opts.query || '').trim();
    let ranked = live;
    if (q) {
      const toks = q.split(/[\s,，。；;:：!！?？]+/).filter((t) => t.length >= 2 && !COMMON.has(t));
      const specific = toks.filter((t) => t.length >= 3 || /[._\-/]/.test(t));
      const scored = live.map((r) => {
        let hit = 0;
        for (const t of specific) if (String(r.text).includes(t)) hit += 2;
        for (const t of toks) if (String(r.text).includes(t)) hit += 1;
        return { r, hit };
      }).filter((s) => s.hit > 0);
      scored.sort((a, b) => b.hit - a.hit || b.r.live - a.r.live);
      ranked = scored.map((s) => s.r);
      if (!ranked.length) return '';   // 闸 2：没有具体重合就整段不出现
    }
    const picked = [];
    let used = 0;
    for (const r of ranked) {
      const len = String(r.text).length;
      if (used + len > 200 && picked.length > 0) break;
      picked.push(r); used += len;
      if (picked.length >= 3) break;
    }
    return '🌍 经验：' + picked.map((r) => r.text).join('；') + String.fromCharCode(10);
  } catch { return ''; } finally { try { db.close(); } catch {} }
}