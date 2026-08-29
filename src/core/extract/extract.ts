// 元数据提取器（方针 §6.6，规则为主，零 LLM）
// 五件套：files / topics / decisions / key_questions / code_changes
// 已知简化（诚实登记）：topics 为 TF+停用词+用户加权（无跨会话 IDF）；unresolved 为启发式
import { segment } from '../tokenize/tokenizer.js';

export interface Msg {
  role: 'user' | 'assistant';
  content: string;
  seqNum: number;
  createdAt?: string | null;
}

export interface ExtractedMeta {
  files: string[];
  topics: string[];
  decisions: Array<{ text: string; seq: number; at?: string }>;
  questions: Array<{ q: string; seq: number; at?: string; unresolved: boolean }>;
  codeBlockCount: number;
  keyExchanges: Array<{ userText: string; aiText: string; userSeq: number; reason: string }>;
}

// ── files_mentioned：路径正则（绝对路径 / 带扩展名的相对路径） ──
const PATH_RE =
  /(?:[A-Za-z]:)?(?:[\\/][\w.\-]+){1,6}|[\w.\-]+(?:[\\/][\w.\-]+)*\.(?:ts|tsx|js|jsx|mjs|cjs|py|java|go|rs|sql|md|json|ya?ml|toml|xml|css|scss|html|vue|cs|sh|ps1|c|cpp|h|hpp|proto|gradle|kt|rb|php)\b/g;

const FILE_NOISE = /^(?:v\d+\.\d+.*|\d+\.\d+.*|node_modules.*)$/;

export function extractFiles(texts: string[]): string[] {
  const out = new Set<string>();
  for (const t of texts) {
    for (const m of t.match(PATH_RE) ?? []) {
      const p = m.replace(/\\/g, '/').replace(/\/+$/, '');
      if (p.length < 4 || p.length > 160 || FILE_NOISE.test(p)) continue;
      out.add(p);
      if (out.size >= 20) return [...out];
    }
  }
  return [...out];
}

// ── topics：TF + 停用词 + 用户消息双倍权重 ──
const STOPWORDS = new Set([
  '我们', '你们', '他们', '这个', '那个', '什么', '怎么', '为什么', '可以', '应该', '就是',
  '还是', '然后', '以及', '但是', '如果', '因为', '所以', '现在', '已经', '可能', '需要',
  '使用', '进行', '讨论', '一下', '一个', '一些', '或者', '这些', '那些', '自己', '里面',
  '上面', '下面', '直接', '基本', '时候', '地方', '东西', '问题', '方案', '看看', '出来',
  'the', 'a', 'an', 'is', 'are', 'to', 'for', 'of', 'and', 'or', 'in', 'on', 'with',
  'this', 'that', 'you', 'i', 'we', 'it', 'be', 'as', 'at', 'by', 'from', 'not', 'will',
]);

export function extractTopics(msgs: Msg[]): string[] {
  const freq = new Map<string, number>();
  for (const m of msgs) {
    for (const t of segment(m.content, { keepSingles: false })) {
      if (t.length < 2 || STOPWORDS.has(t) || /^\d+$/.test(t)) continue;
      freq.set(t, (freq.get(t) ?? 0) + (m.role === 'user' ? 2 : 1));
    }
  }
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k]) => k);
}

// ── decisions：句式匹配（方针 §6.6："决定/选择/采用/放弃/最终用"） ──
const DECISION_RES: RegExp[] = [
  /(决定|选择|采用|最终用|最终选|优先用|直接用|定下|敲定|改为|改用|换成|切换到|升级到|切换成|统一用|改为使用|放弃|弃用|不用)[^。！？!?\n]{2,80}/,
  /([^。！？!?\n]{2,30}(?:方案|选型|策略|架构|库|协议|格式|命名|引擎|分词|存储|模式)(?:定为|确定为|选定为|采用|敲定))[^。！？!?\n]{0,40}/,
];

function sentences(text: string): string[] {
  return text.split(/(?<=[。！？!?\n])/).map((s) => s.trim()).filter(Boolean);
}

export function extractDecisions(msgs: Msg[]): ExtractedMeta['decisions'] {
  const out: ExtractedMeta['decisions'] = [];
  const seen = new Set<string>();
  for (const m of msgs) {
    for (const s of sentences(m.content)) {
      for (const re of DECISION_RES) {
        const hit = s.match(re);
        if (!hit) continue;
        const text = hit[0].replace(/\s+/g, ' ').trim().slice(0, 90);
        const key = text.slice(0, 20);
        if (seen.has(key)) break;
        seen.add(key);
        out.push({ text, seq: m.seqNum, at: m.createdAt ?? undefined });
        break;
      }
      if (out.length >= 10) return out;
    }
  }
  return out;
}

// ── key_questions：用户问句 + 未决启发式 ──
const Q_MARK = /[？?]/;
const Q_HINT = /(为什么|怎么|是否|要不要|还是|吗|什么|哪个|哪些|如何|多久|how|what|why|whether|which)/i;
const UNRESOLVED_HINT = /(还没|尚未|待定|再定|不确定|没定|没有结论|后续|以后再)/;

export function extractQuestions(msgs: Msg[]): ExtractedMeta['questions'] {
  const total = msgs.length;
  const out: ExtractedMeta['questions'] = [];
  msgs.forEach((m, idx) => {
    if (m.role !== 'user') return;
    for (const s of sentences(m.content)) {
      if (!Q_MARK.test(s) || s.length < 8 || !Q_HINT.test(s)) continue;
      const tailAsked = idx >= Math.floor(total * 0.7); // 会话尾部提问，大概率未被回答
      out.push({
        q: s.replace(/\s+/g, ' ').trim().slice(0, 90),
        seq: m.seqNum,
        at: m.createdAt ?? undefined,
        unresolved: tailAsked || UNRESOLVED_HINT.test(s),
      });
      if (out.length >= 10) return;
    }
  });
  return out;
}

// ── code_changes：围栏代码块计数（轻量代理指标） ──
export function countCodeBlocks(texts: string[]): number {
  let n = 0;
  for (const t of texts) n += (t.match(/```/g) ?? []).length;
  return Math.floor(n / 2);
}

// ── key_exchanges：关键往返提取（归档后推导过程的中间粒度） ──
// 规则优先级：含决策句的往返 > 含未决问题的提问 > 用户消息最长前 3 条。上限 8 组。
export interface KeyExchange { userText: string; aiText: string; userSeq: number; reason: string }

export function extractKeyExchanges(msgs: Msg[]): KeyExchange[] {
  // 配对：每条 user 消息找它后面最近的一条 assistant 回复
  const pairs: Array<{ user: Msg; ai: Msg | null }> = [];
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i].role !== 'user') continue;
    const userText = msgs[i].content.trim();
    if (userText.length < 8) continue; // 太短的（"好的""重启"）不算往返
    let ai: Msg | null = null;
    for (let j = i + 1; j < msgs.length; j++) {
      if (msgs[j].role === 'assistant') { ai = msgs[j]; break; }
      if (msgs[j].role === 'user') break; // 连续两条 user，前者无回复
    }
    pairs.push({ user: msgs[i], ai });
  }

  const scored = pairs.map(({ user, ai }) => {
    let score = 0;
    let reason = '';
    const userText = user.content.replace(/\s+/g, ' ').trim();
    // 过滤系统注入的伪用户消息（TodoWrite reminder / system-reminder / command 输出等）
    if (/^(The TodoWrite tool|<system-reminder|<command-|<local-command|\[Request interrupted)/.test(userText)) {
      return { userText, aiText: ai?.content ?? '', userSeq: user.seqNum, score: -1, reason: '系统消息' };
    }
    // 1) 含决策句
    const decisionHit = DECISION_RES.some(re => re.test(user.content) || (ai ? re.test(ai.content) : false));
    if (decisionHit) { score += 3; reason = '含决策'; }
    // 2) 含未决问题
    if (Q_MARK.test(user.content) && Q_HINT.test(user.content)) { score += 2; reason = reason || '关键提问'; }
    // 3) 用户消息长（核心需求陈述）
    if (user.content.length > 100) { score += 1; reason = reason || '需求陈述'; }
    return { userText, aiText: ai?.content ?? '', userSeq: user.seqNum, score, reason };
  }).filter(p => p.score > 0); // 过滤系统消息(score=-1)

  scored.sort((a, b) => b.score - a.score || b.userText.length - a.userText.length);
  return scored.slice(0, 8).map(p => ({
    userText: p.userText.slice(0, 200),
    aiText: p.aiText.replace(/\s+/g, ' ').trim().slice(0, 200),
    userSeq: p.userSeq,
    reason: p.reason,
  }));
}

export function extractMessages(msgs: Msg[]): ExtractedMeta {
  const texts = msgs.map((m) => m.content);
  return {
    files: extractFiles(texts),
    topics: extractTopics(msgs),
    decisions: extractDecisions(msgs),
    questions: extractQuestions(msgs),
    codeBlockCount: countCodeBlocks(texts),
    keyExchanges: extractKeyExchanges(msgs),
  };
}

// ── summary_rule：免费规则摘要（confirmed 时生成，方针 §6.6 表） ──
export function summaryRule(
  title: string | null,
  meta: ExtractedMeta,
  info: { messageCount: number; source: string; firstAt: string; lastAt: string | null },
): string {
  const lines: string[] = [title ?? '（无标题）'];
  if (meta.decisions.length > 0) {
    lines.push(`决策（${meta.decisions.length}）：` + meta.decisions.slice(0, 5).map((d, i) => `${i + 1}) ${d.text.slice(0, 60)}`).join(' '));
  }
  const unresolved = meta.questions.filter((q) => q.unresolved);
  if (unresolved.length > 0) {
    lines.push(`未决（${unresolved.length}）：` + unresolved.slice(0, 3).map((q) => q.q.slice(0, 50)).join(' / '));
  }
  if (meta.topics.length > 0) lines.push(`话题：${meta.topics.join('、')}`);
  lines.push(`数据：${info.messageCount} 消息 · ${info.source} · ${info.firstAt.slice(0, 10)} → ${(info.lastAt ?? info.firstAt).slice(0, 10)}`);
  return lines.join('\n');
}
