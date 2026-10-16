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
