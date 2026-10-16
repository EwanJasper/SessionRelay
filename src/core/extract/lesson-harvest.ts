// 规则抽取：从项目记忆里**刨**出`踩过的坑`这类句子，落成**草稿**。
//
// 三条纪律（设计 §11.2 / §11.3）：
//   ① **只产草稿**：draft 永远不进注入层 —— 自动化的东西不许直接污染全局注入；
//   ② **必须能回指**：每条都带 quote（原句）与 source_ref（会话:消息），人可复核；
//   ③ **等级不吹牛**：原句逐字出自**用户消息** ⇒ verified-user；否则一律 inferred。
//      哪怕是 verified-user，也只让它**有资格**进注入层，仍然先是草稿 —— 升 verified 要人点头或证据复核。
//
// 为什么不做成守护自动跑：抽错一句话就会污染**所有项目**的注入。让它是个显式命令，
// 人（或排程）决定什么时候跑、跑完要不要收。
const PATTERNS = [
  '踩坑', '血的教训', '教训是', '下次一定', '以后再', '以后要', '千万别', '别再', '不要再',
  '坑在', '根因是', '根因在', '原因是', '问题在于', '注意不能', '一定要注意', '务必',
  '失败的原因', '为什么不成功', '走过的弯路', '绕了远路', '白折腾', '浪费了',
];

const SENT_SPLIT = /(?<=[。！？；!?;\n])/;

export interface Harvested { text: string; quote: string; sourceRef: string; role: string; level: 'verified-user' | 'inferred' }

/**
 * 从一批消息里刨候选。纯函数，便于测试；写库由调用方做。
 * @param msgs [{ role, content, seqNum, sessionId }]
 */
export function harvestCandidates(msgs: Array<{ role: string; content: string; seqNum?: number; sessionId?: string }>, opts: { minLen?: number; maxLen?: number } = {}): Harvested[] {
  const minLen = opts.minLen ?? 12;
  const maxLen = opts.maxLen ?? 120;
  const out: Harvested[] = [];
  const seen = new Set<string>();
  for (const m of msgs) {
    const content = String(m.content ?? '');
    if (!content) continue;
    for (const raw of content.split(SENT_SPLIT)) {
      const s = raw.trim().replace(/\s+/g, ' ');
      if (s.length < minLen || s.length > maxLen) continue;
      if (!PATTERNS.some((p) => s.includes(p))) continue;
      // 必须像`一条经验`而不是`一句吐槽`：至少含一个动词性词尾或因果词
      if (!/[是为要别的不没]/.test(s)) continue;
      if (seen.has(s)) continue;
      seen.add(s);
      out.push({
        text: s.length > 80 ? s.slice(0, 80) : s,
        quote: s,
        sourceRef: (m.sessionId ?? '') + ':' + (m.seqNum ?? ''),
        role: String(m.role ?? ''),
        level: m.role === 'user' ? 'verified-user' : 'inferred',
      });
    }
  }
  return out;
}