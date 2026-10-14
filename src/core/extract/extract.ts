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
// [fork 0924] 弱触发词只认句首附近——它们是高频连接词，句中出现时多为普通叙述
// （mc整合包实测：71% 决策碎片来自这类误命中）
//
// [fork 1015] Phase 3 修复A：`不用` 从弱触发族**整体移除**。
// 这是红队 1014 F9 修了一半的地方——那次只把它从 NEGATIVE_MARKERS（否定标记族）摘了，
// 没摘 DECISION_WEAK_ANCHORED（决策判别族），于是"你不用管过程""不用每章都烧朱雀额度"
// "旧会话不用删，放着就行"照样能进 decisions 列。
// 实测精度（10-15，两库共 88 条该分支命中）：agent1super 61 条 / music player 24 条，
// 逐条判读约 85–90% 是用户对 AI 的指令或口语，不是决策。
// 剩下的 直接用/优先用/统一用/改为使用 四条实测保留率良好（"直接用 exe 路径后台启动，
// 然后用 pid 接管"、"优先用 batch_extract.py 抓 arXiv HTML 全文"都是真决策），不动。
const DECISION_STRONG = /(决定|选择|采用|最终用|最终选|定下|敲定|改为|改用|换成|切换到|升级到|切换成|放弃|弃用)[^。！？!?\n]{2,80}/;
const DECISION_WEAK_ANCHORED = /^[^。！？!?\n]{0,4}(?:直接用|优先用|统一用|改为使用)[^。！？!?\n]{2,80}/;
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
//   "改用户配置" 里含着 "改用"（改-用-户）
//   "无需放弃治疗" 里含着 "放弃"
//   "并不弃用旧格式" 里含着 "弃用"
// 故对这两个词加负向后视。
// `不用` 已从标记族**整体移除**：红队 1014 F9 实测 453 条 negative 中 59 条（13%）
// 仅靠它命中，人工判读约三分之二是用户对 AI 的指令/口语/保留型决策——
// "你不用管过程"、"不用每章都烧朱雀额度"、"旧会话不用删，放着就行"（语义恰是保留）。
// 信号太弱，误报远大于收益。ADR-001 记的"标记不该放大客套语"正是被它违反的。
const NEGATIVE_MARKERS = /(?<![切])换成|(?<![不没未绝并需])放弃|弃用|不再用|回退到|退回到|改用|换用|不采用/;
const NEGATIVE_FALSE_POSITIVE = /(改用户|改用途|无需放弃|不必放弃|并不弃用|未弃用|不放弃|绝不放弃|切换成功|切换成)/;

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
  // [fork 1015] 内嵌 JSON 残片：原守卫只认 confirmed/title/session_id 三个键名，
  // 实测漏了 `"done": true`、`"evidence": "..."` 这类（Phase 3 修复B 顺带扩族）
  if (/"[A-Za-z_]\w*"\s*:/.test(t)) return false;
  return true;
}

// [fork 1015] Phase 3 修复B：引号不配对=腰斩碎片。
// 实测两库 83/30 条决策引号不配对，样例几乎全是"讨论决策的散文"而非决策本身——
// "采用宿主 CLI 弹性探测"与 10-14"自包含 vendor"字面直接冲突"、
// "决定论"误命中在 `extractDecisions` 的 `DECISION_STRONG` 里"、
// "改为 Apache-2.0", "done": true, "evidence": …
// 与 plausibleDecision 的括号配对是同一族判别，但**必须在剥离前跑**：
// extractDecisions 会把尾部 `"'、，）` 一并剥掉，而 `改为"…那个"` 这种合法决策的
// 闭引号正好在尾部——先剥后查会把真决策误杀（这个交互 bug 是回归测试抓到的）。
// 故意**不**查反引号：实测真决策也用反引号包标识符（"改用 `fileURLToPath()`"）。
export function quotesBalanced(raw: string): boolean {
  if (!raw || typeof raw !== 'string') return true;
  if (((raw.match(/“/g) ?? []).length) !== ((raw.match(/”/g) ?? []).length)) return false;
  if (((raw.match(/"/g) ?? []).length) % 2 !== 0) return false;
  if (((raw.match(/‘/g) ?? []).length) !== ((raw.match(/’/g) ?? []).length)) return false;
  if (((raw.match(/'/g) ?? []).length) % 2 !== 0) return false;
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
        // [fork 1015] Phase 3 修复B：引号配对必须在**剥离前**的原始匹配文本上判——
        // 上一行的尾部剥离会把 `改为"…那个"` 的闭引号一起剥掉，先剥后查会误杀真决策
        if (!quotesBalanced(hit[0])) break;
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

// 技能目录**块**：≥3 行连续的 `- \`name\`: 描述…`。ZCode/DSH 把可用技能清单以
// markdown 列表形式注入用户消息，**没有 XML 外壳**，所以上面的成对块规则抓不到。
//
// ⚠️ 为什么必须要求"≥3 行连续"（红队 1014 F5，实测 129 条消息中招）：
// 单行形态与用户自己的技术清单**无法区分**。实测被误吃的真内容：
//   `- \`web-vitals\`: 决定把前端监控库换成 web-vitals，弃用旧的自研埋点`
//   `- \`deepseek-v4-flash-0731\`: 认 \`none\`（实测能真关掉思考）+ low/medium/high 全套`
//   `- \`zhipu-vision\`: 聊天看图主力，默认档`
// 整行被剥 → 该行既进不了 decisions 也进不了 search_text，**真决策双双失明**。
// 注释原先挑的反例（config.json / useState / AGENTS.md / postgres）都不含连字符，
// 而真实技术写作里 kebab-case 标识符遍地（web-vitals / next-auth / vue-router /
// vite-plugin-*），全部命中——那个辩护不成立。
// 实测分布：≥3 行连续 63 处（客户端目录块）、恰好 2 行 55 处、单行 5 处。
// 客户端注入的目录是 10+ 行的长列表，用户自己的清单通常 1-2 行且夹在散文里，
// 故 ≥3 是安全的判据。同时去掉 i 标志——它原本让 [a-z0-9] 匹配任意大小写，
// `AGENTS.md` 这类大写名因此中招。
const SKILL_CATALOG_BLOCK = /(?:^[ \t]*[-*+]\s*`[a-z0-9]+(?:-[a-z0-9]+)+`\s*[:：][^\n]*\n){3,}/gm

// 单行形态，**只供 doctor 检测用**（looksInjected），不用于剥离。
// 理由：doctor 面对的是已入库的决策碎片（单行），而剥离面对的是整条消息（多行）——
// 两者的正确判据不同。这是有意的分工，不是历史上那种" undocumented 的规则漂移"：
// 漂移指的是同一职责两套规则，而这里职责本来就不同（一个防误杀、一个防漏检）。
const SKILL_CATALOG_LINE = /^[ \t]*[-*+]\s*`[a-z0-9]+(?:-[a-z0-9]+)+`\s*[:：][^\n]*/gm

// [fork 1014 深夜] 无标签注入：客户端把 XML 外壳**剥掉之后**才把系统上下文存进
// user 消息，所以上面那组成对标签规则一条都匹配不到。这是现有清洗的真实盲区。
//
// 实测 D:\agent1super（43681 条消息）：
//   · 4361 条带着同一句 TodoWrite 提醒，占全部 search_text 的 **18.7%**（2.9MB/15.5MB）
//   · topics 4578 条里有 **488 条（10.7%）**是它的英文虚词残片
//   · decisions 未被污染（该文本不含决策触发词）——所以这个盲区此前的症状是
//     "索引胀大 + topics 变脏"，而不是简报出错，因此一直没被发现
//
// 判据：客户端每轮生成的样板句，逐字固定，与用户写的内容无关。
// ⚠️ 一律用**行界**匹配，不用续行匹配。红队 1014 F1 实测：真实客户端格式是
//    "标记与正文同在一行"——`Current DSH file policy: workspace-write. Any available
//    operation … fails closed.` 续行匹配要求标记句行尾紧跟换行才吃后续行，同线时
//    只命中字面标记，冒号后 70–84% 的正文原样留在索引和 topics 里（v8 声称剥干净，
//    实际只剥了 5 个短语）。行界匹配的另一个方向也安全：不越过行尾，所以不存在
//    "客户端把用户文字接在快照后就一起吃掉"的续行失效模式（F6）。
// ⚠️ 行界匹配仍有一个残留风险：注入与用户文字**同在一条线上**时会一起剥（F7 的变体）。
//    故加 CJK 护栏 `[^\n\u4e00-\u9fff]`——这些样板全是英文，而本项目用户内容是中文，
//    匹配遇中文即停，用户文字完整保留。代价是英文用户内容若与样板同线仍会被一起吃，
//    但那条路本就无解（样板与英文内容无法用字符类区分）。
// ⚠️ 故意**不剥** "Here are the existing contents of your todo list: […]"——
// 那是用户真实的待办状态，是信息不是样板（覆盖度盘点：506 条消息带计划类内容，
// 而它正是这些内容的载体）。
const NO_CJK = '\\u4e00-\\u9fff';
const TAGLESS_INJECTED: RegExp[] = [
  new RegExp(`The TodoWrite tool hasn't been used recently\\.[^\\n${NO_CJK}]*`, 'gi'),
  new RegExp(`This is just a gentle reminder - ignore if not applicable\\.[^\\n${NO_CJK}]*`, 'gi'),
  new RegExp(`Current runtime context\\.[^\\n${NO_CJK}]*`, 'gi'),
  new RegExp(`Current DSH file policy:[^\\n${NO_CJK}]*`, 'gi'),
  new RegExp(`Approval policy: ask\\.[^\\n${NO_CJK}]*`, 'gi'),
  new RegExp(`The active session goal is paused\\.[^\\n${NO_CJK}]*`, 'gi'),
]

export function stripInjected(text: string): string {
  if (!text || typeof text !== 'string') return text
  let out = text
  for (const re of INJECTED_BLOCKS) out = out.replace(re, '\n')
  // 用块判据（≥3 行连续）而非单行——单行会吃掉用户自己的 kebab-case 清单（F5）
  out = out.replace(SKILL_CATALOG_BLOCK, '\n')
  for (const re of TAGLESS_INJECTED) out = out.replace(re, '\n')
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
  // [fork 1014 深夜] TAGLESS_INJECTED 也必须同源——stripInjected 剥得掉、这里检不出的话，
  // 存量数据里的同类污染 doctor 就看不见（正是这个盲区让它活了这么久）。
  for (const re of TAGLESS_INJECTED) { re.lastIndex = 0; if (re.test(text)) return true }
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
