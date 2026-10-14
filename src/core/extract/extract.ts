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
  decisions: Array<{ text: string; seq: number; at?: string; kind?: 'decision' | 'negative' }>;
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
// [fork 0924] 弱触发词（不用/直接用/优先用/统一用）只认句首附近——它们是高频连接词，
// 句中出现时多为普通叙述（mc整合包实测：71% 决策碎片来自这类误命中）
const DECISION_STRONG = /(决定|选择|采用|最终用|最终选|定下|敲定|改为|改用|换成|切换到|升级到|切换成|放弃|弃用)[^。！？!?\n]{2,80}/;
const DECISION_WEAK_ANCHORED = /^[^。！？!?\n]{0,4}(?:不用|直接用|优先用|统一用|改为使用)[^。！？!?\n]{2,80}/;
const DECISION_RES: RegExp[] = [
  DECISION_STRONG,
  DECISION_WEAK_ANCHORED,
  /([^。！？!?\n]{2,30}(?:方案|选型|策略|架构|库|协议|格式|命名|引擎|分词|存储|模式)(?:定为|确定为|选定为|采用|敲定))[^。！？!?\n]{0,40}/,
];

// ── 否定性决策标记（ADR-001）──
//
// 问题：负面信息（"试过 X 失败了"）只活在原始消息里，而正文会被归档蒸发，于是同一个坑
// 在新会话里重新踩。调研建议新建一套"失败尝试"抽取规则族，实测精度只有 75%
// （噪声类：菜单选项"B. 不装 App"、markdown 表格行、代码块参数表、引号内规则引用、
// "排除"的归因义 vs 否定义）——往刚把污染从 19 条打到 0 的库里灌噪声，不干。
//
// 但实测发现：**切换/放弃族的否定早已被 DECISION_STRONG 大量捕获**（D:\agent1super
// 1267 条决策里 552 条含否定语义，占 43.6%），只是一律没有标记，简报里"改用 Y"与
// "采用 Y"长得一模一样，看不出 Y 是被否掉的那条路。
//
// 所以只做标记，不新建抽取路径——文本早已过了 plausibleDecision / DECISION_FALSE_POSITIVE /
// isQuotedSpeech 三道校验，标记不新增任何内容，精度是构造使然的（实测 85-90%，
// 误标样本本就是库里已有的提取噪声）。
//
// 判别式故意**不含**"切换到/改为"：它们是中性的，负面只是隐含且常常并不存在
// （实测"切换成功——触屏活着（虚惊）"这类正面句会被误标）。
// 也故意不含"不可行/行不通/不装"等失败判定族——那些原抽取器根本不着边，要走
// 新建路径，精度未达标，见 ADR-001 Option B 的重新评估条件。
//
// ⚠️ 中文没有词边界，必须防词中误命中——与 DECISION_FALSE_POSITIVE（"决定论"≠决定）
// 同一类病，实测已中招：
//   "切换成功/切换成" 里含着 "换成" → 正面句被判否定
//   "不放弃/绝不放弃" 里含着 "放弃" → 正面句被判否定
// 故对这两个词加负向后视。Node ≥9 支持 lookbehind，engines 允许的版本都够。
const NEGATIVE_MARKERS = /(?<![切])换成|(?<![不没未绝并])放弃|弃用|不再用|回退到|退回到|改用|换用|不采用|不用/;
// 客套语不是决策语义（"不用感谢/不用客气"）——这类文本能进 decisions 说明上游抽取已误收，
// 但标记不该再放大它。
const NEGATIVE_FALSE_POSITIVE = /(不用感谢|不用客气|不用谢|无须放弃|不必放弃)/;

/** 这条决策是否编码了"否掉一条路"（ADR-001）。只做标记，不做抽取。 */
export function isNegativeDecision(text: string): boolean {
  if (!text || typeof text !== 'string') return false;
  if (NEGATIVE_FALSE_POSITIVE.test(text)) return false;
  NEGATIVE_MARKERS.lastIndex = 0;
  return NEGATIVE_MARKERS.test(text);
}

function sentences(text: string): string[] {
  // [fork 0924] 软换行合并：Markdown 段内硬换行不再腰斩句子——
  // 只有"上一行以句末标点收尾"或"下一行是空行"时换行才是切分点
  const merged = text.replace(/([^\n。！？!?])\n(?!\n)/gu, '$1');
  return merged.split(/(?<=[。！？!?]|\n)/).map((s) => s.trim()).filter(Boolean);
}

// [fork 1013] 转述/引用判定（审计 P4）：用户消息里复述他人文本的句子不是用户的决策或问题。
// 实测来源：整份评审报告粘进消息 → 「此外助手最后以"要继续做别的吗？"」被当成用户未决问题，
// 同一粘贴内容产出 3 条近似条目。挡的是"引用语义"，markdown 残片归 plausibleDecision 管。
// 只影响提取端，不改源数据——命中转述的句子原本就不该进 decisions/questions。
function isQuotedSpeech(s: string): boolean {
  const t = s.trim();
  // 显式转述标记开头：助手/对方/作者/报告/原文/上文/该文/文档/AI + 说提问道认为建议停
  if (/^(?:此外|另外|还有)?\s*(?:助手|对方|作者|报告|原文|上述|上文|该文|这篇|文档|AI|模型)[^\n]{0,12}(?:说|道|问|提到|认为|指出|最后|停|写|建议|表示)/.test(t)) return true;
  // 句子主体被引号包住且带引导词：「他说"…"」「助手问"…"」——整句都是被引内容
  if (/(?:说|道|问|提到|建议|认为|表示)[^。！？!?\n]{0,8}[“"「『](?:[^”"」』]{4,})[”"」』]/.test(t)) return true;
  return false;
}

// [fork 1013] 误命中词：触发词出现在更长词内部的中间位置。
// 「决定论 规则明确」被 DECISION_STRONG 的"决定"命中，但它讨论的是决定论（determinism），
// 不是谁做了什么决定。实测该误命中在抽样里出现 2 次。
// 只在这些组合后出现时才豁免——不误伤"决定改用 X"这种真决策。
const DECISION_FALSE_POSITIVE = /(决定论|确定性|决定性|选择性注意|选择性|采纳率|采用率|放弃治疗|切换成本)/;

// [fork 0922] 决策合理性守卫：正则只管"句首有触发词"，不管句子长什么样——
// 实测垃圾三来源：看板表格行（| 分隔）、Markdown 粗体残片（**）、消息内嵌 JSON 转义串。
// 在抽取端拒收，比事后清洗数据治本。
function plausibleDecision(text: string): boolean {
  const t = text.trim();
  if (t.length < 6) return false; // 纯碎片（"决定装哪些："）
  if (/[:：|]\s*$/.test(t)) return false; // 半句：以冒号/竖线收尾
  if (/\*\*\s*$/.test(t) || /^\*\*/.test(t)) return false; // Markdown 粗体残片
  if ((t.match(/\|/g) ?? []).length >= 2) return false; // 表格行
  if (/"(?:confirmed|title|session_id)"\s*:/.test(t) || /\}\s*,\s*\{/.test(t)) return false; // 内嵌 JSON 残片
  if (/^[）)】」"'、，。]/.test(t)) return false; // [fork 0924] 以闭括号/标点开头=句子中段截出的残片
  if (/\*\*/.test(t)) return false; // [fork 0924] 任意位置的粗体残片（mid-text ** 也是格式污染）
  const pairs = (t.match(/[（(「『【]/g) ?? []).length - (t.match(/[）)】」』】]/g) ?? []).length;
  if (pairs !== 0) return false; // [fork 0924] 括号不配对=腰斩碎片
  return true;
}

export function extractDecisions(msgs: Msg[]): ExtractedMeta['decisions'] {
  const out: ExtractedMeta['decisions'] = [];
  const seen = new Set<string>();
  for (const m of msgs) {
    for (const s of sentences(m.content)) {
      for (const re of DECISION_RES) {
        const hit = s.match(re);
        if (!hit) continue;
        // [fork 0924] 截断对齐（mc整合包反馈）：超长时在最近的停顿处切，再剥尾部括号/引号残片；
        // 原 90 字符硬切会产生"石头船放大时质量爆炸增长"这类半句
        let text = hit[0].replace(/\s+/g, ' ').trim();
        if (text.length > 90) {
          const w = text.slice(0, 90);
          const i = Math.max(
            w.lastIndexOf('，'), w.lastIndexOf('、'), w.lastIndexOf('；'),
            w.lastIndexOf(','), w.lastIndexOf(';'), w.lastIndexOf(' '),
          );
          text = i > 40 ? w.slice(0, i) : w;
        }
        text = text.replace(/[）)】」"'、，]+$/u, '').trim();
        if (!plausibleDecision(text)) break; // [fork 0922] 残片拒收
        if (DECISION_FALSE_POSITIVE.test(text)) break; // [fork 1013] 词中误命中（"决定论"≠决定）
        if (isQuotedSpeech(s)) break; // [fork 1013] 转述他人文本不是我的决策（P4）
        const key = text.slice(0, 20);
        if (seen.has(key)) break;
        seen.add(key);
        out.push({ text, seq: m.seqNum, at: m.createdAt ?? undefined, kind: isNegativeDecision(text) ? 'negative' : 'decision' });
        break;;
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

/**
 * [fork 1014] 问题显示归一化：保留真问题，压掉口语啰嗦。
 *
 * 为什么不做"拒绝"：实测用户真实库的两条样本
 *   "呃，就是active，就是这个现在这个UU配的这个档，这个我是有pro的...但是为什么没有那个呢？"
 *   "还有那个谷歌那边，我们做的谷歌那边的话，为什么模型只有那个3.8flash？"
 * 它们**不是垃圾**——"为什么没那个""为什么只有3.8flash"是真疑问，只是前面堆了口头填充。
 * 试过用"填充物占比"阈值区分（噪声 0.55 vs 真问题短句 0.50），**实测分不开**，已撤。
 *
 * 所以改为压缩显示：剥掉句首填充与句中无信息量口头语，让同样的 90 字符预算
 * 能装下真正的疑问内容。信息不丢，可读性提升。
 */
function normalizeQuestion(q: string): string {
  let t = q.replace(/\s+/g, ' ').trim()
  // 口语问句的形态是「一堆填充 + 真疑问在末尾」。从头删填充删不干净——
  // 实测样本删完句首后 90 字符配额仍被中段 filler 吃光，真疑问被截掉。
  // 改为**定位末句**：按标点切段，从后往前找第一个含疑问词/问号的段，
  // 段太短就继续往前并段补上下文（避免只剩"为什么"这种没头没尾的残片）。
  const segs = t.split(/(?<=[。！？!?，,；;])/).map(x => x.trim()).filter(Boolean)
  if (segs.length > 1) {
    let picked = ''
    for (let i = segs.length - 1; i >= 0; i--) {
      picked = segs[i] + picked
      if (Q_HINT.test(segs[i]) || /[？?]\s*$/.test(segs[i])) {
        // 命中疑问段：太短则往前并一段补主语
        if (picked.replace(/[，。！？、\s]/g, '').length < 10 && i > 0) {
          picked = segs[i - 1] + picked
        }
        break
      }
      if (picked.replace(/[，。！？、\s]/g, '').length >= 20) break
    }
    if (picked) t = picked
  }
  // 仍可能残留的句中口头语（不动疑问词本身）
  t = t.replace(/(就是|的话|做的|那边|这边|目前|现在|然后|还有|不过|其实)(?=[^。！？]{0,6}(吗|呢|为什么|怎么|如何|是否|要不要|？|\?))/gu, '')
  t = t.replace(/^(呃|哦|啊|嗯|呀|就是|那个|这个|还有|然后|其实|不过|但是)[，。！？、\s]*/u, '')
  t = t.replace(/([，。！？、])+/gu, '$1')
  return t.trim() || q
}

export function extractQuestions(msgs: Msg[]): ExtractedMeta['questions'] {
  const total = msgs.length;
  const out: ExtractedMeta['questions'] = [];
  msgs.forEach((m, idx) => {
    if (m.role !== 'user') return;
    for (const s of sentences(m.content)) {
      if (!Q_MARK.test(s) || s.length < 8 || !Q_HINT.test(s)) continue;
      // [fork 0924] 问题也要过碎片守卫：列表项/表格行/粗体残片不是真问题（mc 整合包反馈同族）
      if (/^\s*([-*#>）)」]|&&)/.test(s) || /\|\s*-{2,}/.test(s) || /\*\*/.test(s)) continue;
      // [fork 1013] 转述过滤（审计 P4）：粘贴的报告/AI 回复里的问句不是用户的问题
      if (isQuotedSpeech(s)) continue;
      // [fork 1013] markdown blockquote：粘贴的报告段落常以 > 开头
      if (/^>\s*\S/.test(s)) continue;
      const tailAsked = idx >= Math.floor(total * 0.7); // 会话尾部提问，大概率未被回答
      out.push({
        q: normalizeQuestion(s).slice(0, 90),
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

// ── 注入块剥离（2026-10-14 根修）──
//
// 为什么必须做：DSH / ZCode 会把系统上下文（技能目录、环境信息、提醒）包在
// <system-reminder>…</system-reminder> 里塞进**用户消息**。提取器按角色过滤
// 也没用——它就在 user 消息正文里。实测后果（docs/现状与需求总核对表 §22）：
// steel-manning 技能说明里的"再决定接受、修订或坚持"被当成用户决策，
// 在 E:\music player 库里重复了 24+19 次，把简报的名额整个占满。
//
// 设计原则：只剥"确定是注入"的成对块，不做语义猜测——宁可漏，不能错杀真决策。
const INJECTED_BLOCKS: RegExp[] = [
  /<system-reminder>[\s\S]*?<\/system-reminder>/gi,
  /<reminder>[\s\S]*?<\/reminder>/gi,
  /<env(?:ironment)?>[\s\S]*?<\/env(?:ironment)?>/gi,
  /<(?:ctx|context)>[\s\S]*?<\/(?:ctx|context)>/gi,
]

// 技能目录行：`- \`skill-name\`: 描述…`。ZCode/DSH 把可用技能清单以 markdown 列表
// 形式注入用户消息，**没有 XML 外壳**，所以上面的成对块规则抓不到。实测这些行的
// 片段被提成决策和未决问题（steel-manning 的"再决定接受、修订或坚持"、executing-plans
// 的 "Use when you have a written implementation plan…" 都这么来的），把简报名额占满。
// 判据 = 反引号包**含连字符的小写名** + 冒号。
// 为什么必须要求连字符：真技能 slug（steel-manning / executing-plans / ppt-master /
// dsh-fast-lookup）全含连字符；而技术写作里常见的 `- \`config.json\`: 说明`、
// `- \`useState\`: 说明`、`- \`AGENTS.md\``、`- \`postgres\`: 说明` 全不含。红队 1014
// 实测后者会被整行剥掉，行内真决策静默丢失。同时去掉 i 标志——它原本让 [a-z0-9]
// 匹配任意大小写，`AGENTS.md` 这类大写名因此中招。
const SKILL_CATALOG_LINE = /^[ \t]*[-*+]\s*`[a-z0-9]+(?:-[a-z0-9]+)+`\s*[:：][^\n]*/gm

export function stripInjected(text: string): string {
  if (!text || typeof text !== 'string') return text
  let out = text
  for (const re of INJECTED_BLOCKS) out = out.replace(re, '\n')
  out = out.replace(SKILL_CATALOG_LINE, '\n')
  return out
}

/**
 * 这段文本是否"看起来是注入内容"（供 doctor 体检用）。
 * 与 stripInjected 共用同一批规则，避免"剥一套、判另一套"的两处漂移。
 */
export function looksInjected(text: string): boolean {
  if (!text || typeof text !== 'string') return false
  // ⚠️ 必须与 stripInjected 逐条同源，不能多也不能少。红队 1014 抓到两处不对称都出问题：
  //   多一条 HTML 兜底 → 合法前端决策（"决定把 <div> 布局换成 <section>"）被判注入，
  //     doctor 永久红灯且重算清不掉（因为 stripInjected 不剥 HTML）；
  //   少识别无标签残片 → 真正要抓的那批污染（"再决定接受、修订或坚持"）一条都检不出。
  // 现在的取舍：规则严格同源（绝不误报真决策），残片类污染改由 doctor 侧做
  // "决策文本是否为某 SKILL.md 原文子串"的比对兜底。
  for (const re of INJECTED_BLOCKS) { re.lastIndex = 0; if (re.test(text)) return true }
  SKILL_CATALOG_LINE.lastIndex = 0
  if (SKILL_CATALOG_LINE.test(text)) return true
  return false
}

/**
 * 整条消息列表的注入块清洗。**所有进入提取器的消息都必须先过这个函数**——
 * 提取有多个入口（extractMessages 供实时捕获、recomputeSession 供历史重算），
 * 任何一个入口漏掉它，注入块就会从那条路重新污染库（1014 实测：重算跑了 85 个
 * 会话，数据一点没变，就是因为 recomputeSession 绕过了 extractMessages）。
 */
export function sanitizeMsgs(msgs: Msg[]): Msg[] {
  return msgs.map((m) => ({ ...m, content: stripInjected(m.content) }))
}

export function extractMessages(msgs: Msg[]): ExtractedMeta {
  // 先剥注入块，再进任何子提取器——决策/问题/话题/files 全部受益，
  // 而且只需要在这一处做（根修，而不是每个提取器各打一个补丁）。
  const clean = sanitizeMsgs(msgs);
  const texts = clean.map((m) => m.content);
  return {
    files: extractFiles(texts),
    topics: extractTopics(clean),
    decisions: extractDecisions(clean),
    questions: extractQuestions(clean),
    codeBlockCount: countCodeBlocks(texts),
    keyExchanges: extractKeyExchanges(clean),
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
