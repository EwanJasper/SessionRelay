// 全局经验段 + **每轮相关召回**（DSH 插件侧）
//
// [1016 升级] 之前这里只按"重要度"给最重要的几条 —— 因为拿不到"本轮用户说了什么"。
// 现在通过 recall.js（核心库构建出来的可导入小包）拿到两样：
//   ① lastUserMessage(root)：逐帧解码 DSH 会话文件取最后一条用户消息（实测：取到的正是刚发的那句）
//   ② 核心库的同一套排序（含今天验证的**长度归一化**）—— 一个系统里不该有第二套排序
// 于是 DSH 侧也能"按你这句"召回，而不是每步给同一份。
//
// 加载：模块顶层 await import 一次；失败则整体退回"按重要度"。
// **绝不因为召回不可用就让简报整段消失**（宁可少给，不可不给）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
let DatabaseSync = null;
try { ({ DatabaseSync } = require_('node:sqlite')); } catch { DatabaseSync = null; }

let recall = null;
try { recall = await import('../vendor/dist/recall.js'); } catch { recall = null; }
export const __recallAvailable = !!recall;

const COMMON = new Set(['这个','那个','什么','怎么','为什么','可以','需要','应该','我们','你们','他们',
  '现在','然后','没有','不是','还是','或者','因为','所以','但是','如果','已经','还有','就是','一下',
  '东西','时候','问题','这样','那样','继续','帮我','看看','这里','那里']);

const isCJK = (s) => /^[\u3400-\u4dbf\u4e00-\u9fff]+$/.test(s);

/** 查询词：中文长串做 2 字滑窗（\p{L} 会把整句当一个 token，实测踩过） */
function termsOf(text) {
  const out = new Set();
  for (const raw of String(text || '').split(/[^\p{L}\p{N}_.\-]+/u)) {
    const t = raw.trim();
    if (!t) continue;
    if (isCJK(t)) {
      if (t.length <= 2) { if (!COMMON.has(t)) out.add(t); continue; }
      for (let i = 0; i + 2 <= t.length; i++) {
        const bg = t.slice(i, i + 2);
        if (!COMMON.has(bg)) out.add(bg);
      }
    } else if (t.length >= 2 && !COMMON.has(t)) out.add(t);
  }
  return [...out];
}

function scoreOf(text, toks) {
  const s = String(text || '');
  let hit = 0;
  for (const t of toks) {
    if (!s.includes(t)) continue;
    hit += (t.length >= 3 || /[._\-]/.test(t)) ? 2 : 1;
  }
  return hit;
}

/** 同步取经验段；库不存在/没命中 → 空串（整段不渲染） */
export function experiencesLine(root, opts = {}) {
  if (!DatabaseSync) return '';
  const home = process.env.SRELAY_GLOBAL_HOME || path.join(os.homedir(), '.sessionrelay');
  const f = path.join(home, 'global.sqlite');
  try { if (!fs.existsSync(f)) return ''; } catch { return ''; }
  let db = null;
  try {
    db = new DatabaseSync(f, { readOnly: true });
    const ws = String(root || '');
    const rows = db.prepare(
      'SELECT text, scope, grade, importance, uses, hits, created_at FROM lessons'
      + " WHERE (scope = 'global' OR (scope = 'project' AND workspace_id = ?))"
      + " AND status IN ('verified','confirmed') AND grade <> 'inferred'"
      + ' ORDER BY importance DESC LIMIT 40'
    ).all(ws);
    if (!rows.length) return '';
    const now = Date.now();
    const live = rows.map((r) => ({
      text: String(r.text),
      live: Number(r.importance) - Math.max(0, (now - Date.parse(r.created_at)) / 86400000) * 0.0083
        + Math.log1p(Number(r.uses || 0)) * 1.5 + Math.min(1, Number(r.hits || 0) * 0.1),
    })).filter((r) => r.live >= 5.5);
    if (!live.length) return '';

    let q = String(opts.query || '');
    if (!q && recall) { try { q = recall.lastUserMessage(ws) || ''; } catch { q = ''; } }
    q = q.trim();

    let ranked = live;
    if (q) {
      const toks = termsOf(q);
      const scored = live
        .map((r) => ({ r, hit: scoreOf(r.text, toks) }))
        .filter((s) => s.hit > 0)
        .sort((a, b) => b.hit - a.hit || b.r.live - a.r.live);
      // 有本轮输入、但没有任何经验跟它**具体**相关 → 整段不出现（不退回按重要度硬塞）
      if (scored.length === 0) return '';
      ranked = scored.map((s) => s.r);
    }

    const picked = [];
    let used = 0;
    for (const r of ranked) {
      if (used + r.text.length > 200 && picked.length > 0) break;
      picked.push(r.text); used += r.text.length;
      if (picked.length >= 3) break;
    }
    return '🌍 经验：' + picked.join('；') + String.fromCharCode(10);
  } catch { return ''; } finally { try { db.close(); } catch { /* 已关闭 */ } }
}
