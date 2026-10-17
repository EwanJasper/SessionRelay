// 未决段的**渲染侧**过滤器（核心库这一侧）。
//
// ⚠️ 为什么这里会有一份副本（说清楚，别让它变成"第三份悄悄漂移的名单"）：
//   同一套简报语义跑在**三个运行时**里 —— 核心 CLI（本仓）、DSH 插件、ZCode hook（都在工作区仓）。
//   插件与 hook 共用工作区仓的 plugins/dsh/src/brief-filters.mjs（有守门钉住两侧逐字一致）；
//   核心库是**独立 git 仓**，既不能 import 那个文件，也不该被它 import。
//   ⇒ 物理上必然两份。纪律是：**判据逐条对应**，并由 tools/check-brief-filters.mjs §⑥ 做
//     **行为对拍**（同一批样本，两边判决必须完全一致），改一边不改另一边会被当场抓住。
//
// 根治方向（已记进交接，未做）：把过滤器收进核心库的导出面（recall.js），
//   让三个运行时都 import 同一份 —— 那才是"同一处知识只有一份"的终态。

const BRIEF_TEXT_MIN = 5;

/** 未决段四条规则（与工作区 brief-filters.mjs 的 UNRESOLVED_FILTERS 逐条对应）。 */
export const UNRESOLVED_FILTERS: RegExp[] = [
  /-->|\|.*\||\[[^\]]*\]|\{[^}]*\}|^```|^~~~|^\s{2,}\S|^(?:subgraph|flowchart|graph\s+(?:TB|TD|LR)|sequenceDiagram|participant|classDef|end)\b|^(?:const|let|var|function|import|export|return|if|for)\s/,
  /(?:[呃呢嗯啊呀嘛][\s\S]*){2}/,
  /^[\s\S]{90,}$(?<![。！？!?…])/,
  /^(?:并|而|且)\s*/,
];

// ── 残片守卫（2026-10-17 夜 U-A 调研后加，见 docs/research/2026-10-18-U-A未决段处置调研.md）──
// 判据是"剥掉疑问词与语气词后还剩几个实义字"，不是长度：「怎么样呢？」5 字是残片，
// 而「后续还能增加什么？」9 字是真问题。
const UNRESOLVED_QUESTION_WORDS = /(怎么样|怎样|怎么|什么|为什么|为啥|如何|哪个|哪些|哪边|哪里|哪儿|是否|能否|能不能|要不要|该不该|多少|多久|什么时候|谁)/g;
const UNRESOLVED_PARTICLES = /[呢吧吗啊呀嘛哦噢]/g;

/** 剥掉疑问词/语气词/标点后剩下的实义字数（导出让守门做行为对拍）。 */
export function unresolvedContentChars(q: string): number {
  return String(q ?? '')
    .replace(UNRESOLVED_QUESTION_WORDS, '')
    .replace(UNRESOLVED_PARTICLES, '')
    .replace(/[？?！!。.，,、；;：:\s"'“”‘’()（）\-—_/\\]/g, '')
    .length;
}
export const UNRESOLVED_CONTENT_MIN = 4;

/** 未决问题是否够格进简报。false = 该拦。（与 DSH/ZCode 侧 passesUnresolvedFilters 同判据） */
export function passesUnresolvedFilters(q: string): boolean {
  const t = String(q ?? '').trim();
  if (t.length < BRIEF_TEXT_MIN) return false;
  if (unresolvedContentChars(t) < UNRESOLVED_CONTENT_MIN) return false;
  for (const re of UNRESOLVED_FILTERS) { re.lastIndex = 0; if (re.test(t)) return false; }
  return true;
}

/** 简报名额（与 DSH 插件 / ZCode hook 的 UNR_SLOTS 同值）。
 *  [1017 夜 U-A] 3 → 1：实测注入 3 条里 2 条是残片、且 3 条全来自同一个老会话。 */
export const UNR_SLOTS = 1;

// ══════ 七条规范过滤器：**只做参照，不参与本库渲染**（1017 夜 09:3x）══════
// 为什么要加这个：七条规范过滤器此前**只存在于两份客户端副本**
// （`plugins/dsh/src/brief-filters.mjs` 与 `~/.zcode/.../brief-filters.mjs`），
// 核心仓一份都没有 ⇒ 守门只能比「两侧一致」，证不了「两侧都对」。
// 而未决段四条能收进内核，是因为核心 CLI 自己在用；这七条它不用，所以一直没被收编。
//
// ⚠️ **本段刻意不接入本库的渲染路径**，只作独立第三方参照，让守门能升级成三方对拍。
//   接入与否是架构决策（要动核心 CLI 的行为），不在这里擅自决定 ——
//   三条路与代价见 `docs/1018-七条规范过滤器-无第三方-结构原因.md`。
//
// 判据源：从客户端那份搬过来的**同源副本**（不是重打一遍字面量）。
export const BRIEF_TEXT_MAX = 220;
export const BRIEF_CANONICAL_FILTERS: RegExp[] = [
  // 1. 系统注入与提醒残片（防注入块从某条路漏进 decisions 列）
  /(?:<system-reminder>|TodoWrite|task-notification|sessionrelay-brief)/i,
  // 2. 审稿/红队报告与统计残片——这类词只可能出现在「讨论怎么写代码」的会话里
  /(?:候选信号|覆盖率|精度门禁|实测两库|负对照|分组精度|点名表扬|独立\s*PR)/,
  // 3. 单字母代数占位符与反例引述（`决定用 X` 这种举例，不是真拍板）
  /(?:决定|改为|改用|换成|采用|选择)[^a-zA-Z0-9\u4e00-\u9fa5]{0,3}[XYABxyab](?:[^a-zA-Z0-9_]|$)/,
  // 4. 认识论转折评述句（`, 但…往往是` 这种复盘规律的句式）
  /[，,]\s*(?:但|而|不过)[^。！？!?\n]{0,12}(?:往往是|通常是|最值钱的)/,
  // 5. 书信/PR 评论转述（`按你在 Notes 里提议` / `期待第一批`）
  /(?:按你在.*里提议|期待第[一二三1-3]批)/,
  // 6. 极短无意义残片或纯路径碎片
  /^[\s\p{P}\d]{0,6}$/u,
  // 7. 先闭后开的撕裂直引号（`决定用 X"，但…往往是"试过 X` 的引号极性特征）
  /^[^"]*"[，,。；;]/,
  // 8. 待决问句冒充决策（1018 实测：864 条里命中 20 条 = 2.31%，逐条看过全是真问句）
  //    形状：`决定要不要 X` / `决定能不能 X` / `决定是否 X` —— 它们是在提出选择，不是拍板。
  //    排除含箭头的：那是**在描述程序逻辑**（如「决定是否调用工具 → 条件边」），
  //    实测那 2 条是唯一假阳性，加箭头排除后归零。
  /^\s*决定\s*(?:要不要|能不能|是否|该不该|如何|怎么)(?![\s\S]*[→⇒])/,
  // 9. 语音口述填充词（1020 实测 864 条命中 12 条）——用户口述里「呃/那个那个/就是说」
  //    这类填充出来的长句，抽出来是一句话但语义上是碎片的碎。
  /(呃|那个那个|就是说|然后就是|而不是是在|直接直接)/,
  // 10. 报告残渣标记（命中 17 条）——`[in_progress]`/`[completed]` 这种是我自己写的进度报告
  //    被抽进来了，不是用户的决策。只认方括号标记，不认单个箭头（箭头也可能是真决策的记号）。
  /\[(in_progress|pending|completed|done)\]/i,
  // 11. `决定了` + 疑问从句（命中 7 条）——`决定了我能不能…` / `决定了你所有…能不能走`
  //    是**在问**，不是拍板。与第 8 条（`决定要不要X`）同族但形状不同，单列。
  /^决定了[^，。]{0,3}(你|谁|能不能|要不要|为什么)/,
];

/** 与客户端 `passesBriefFilters` 同判据。false = 该拦。 */
export function passesBriefFilters(text: string): boolean {
  const t = String(text ?? '').trim();
  if (t.length < BRIEF_TEXT_MIN || t.length > BRIEF_TEXT_MAX) return false;
  for (const re of BRIEF_CANONICAL_FILTERS) { re.lastIndex = 0; if (re.test(t)) return false; }
  return true;
}
