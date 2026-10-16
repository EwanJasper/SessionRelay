// 零模型查询改写（1016 竞品调研借鉴点 ②）
//
// 为什么需要它：我们的实测短板是「换个说法就不认」——
//   关键词问法 20/20 进 top-10，大白话问法 top-1 只有 10/20。
// 借鉴对象：AstrBot memory_companion 的 retrieval 层（默认档同样没有 embedding，
//   靠「剔问句外壳 + 手写同义家族 + CJK bigram 滑窗展开」把词法召回顶上去）。
//
// 设计纪律（三条，都很重要）：
//   1) **只做加法，不做替换**：改写产出的是「补充查询」，主查询一个字不动。
//      这样即使改写很烂，最坏情况也只是多几条尾部候选，不会把原来对的挤掉。
//   2) **只动查询侧，不动索引侧**：索引分词器换不得（ADR-002 实测 jieba 排位更优）。
//   3) **全零模型、零依赖**：一张手写表 + 几个正则，没有模型、没有网络。

/** 问句外壳词：删掉它们不影响语义，留着反而污染 FTS 匹配 */
const SCAFFOLD = new Set([
  '请问', '帮我', '我想', '想知道', '麻烦', '一下', '的话',
  '什么', '怎么', '怎样', '为什么', '如何', '是不是', '有没有', '能不能', '可不可以',
  '多少', '哪些', '哪个', '哪里', '时候', '那个', '这个', '这些', '那些',
  '吗', '呢', '吧', '啊', '的话', '到底', '究竟',
])

/** 同义家族：一族之内任意成员命中，就把同族其它成员作为补充词 */
const FAMILIES: string[][] = [
  ['记忆', '回忆', '记住', '记录', '存档'],
  ['简报', '摘要', '概览', '总览', '提示'],
  ['决策', '决定', '结论', '拍板'],
  ['未决', '待定', '悬而未决', '未解决', '遗留'],
  ['归档', '存档', '清理', '蒸发'],
  ['抽取', '提取', '解析', '抽出来'],
  ['检索', '搜索', '查找', '查询', '找'],
  ['插件', '扩展', 'extension', 'plugin'],
  ['报错', '错误', '异常', '失败', '挂'],
  ['超时', '卡住', '卡死', '无响应', '僵死'],
  ['删', '删除', '移除', '去掉', '干掉'],
  ['改用', '换成', '改成', '改为', '换成另一种'],
  ['放弃', '不做', '否决', '算了'],
  ['修复', '修好', '修', '补上'],
  ['版本', '版次', 'ver'],
  ['配置', '设置', 'config', '选项'],
  ['安装', '装上', '部署', '装'],
  ['继承', '沿用', '照抄', '借鉴'],
]

const isCJK = (s: string) => /^[\u3400-\u4dbf\u4e00-\u9fff]+$/.test(s)

/**
 * CJK 字符 bigram：只在「词长 ≥ 4」时展开。
 * 为什么限定长度：2~3 字的词本身就是最小语义单位，再切只剩单字，噪声大于收益。
 */
export function charBigrams(tok: string): string[] {
  if (!isCJK(tok) || tok.length < 4) return []
  const out: string[] = []
  for (let i = 0; i + 2 <= tok.length; i++) out.push(tok.slice(i, i + 2))
  return out
}

export interface RewriteResult {
  /** 补充单元（每个单元是 FTS 词元数组）；空数组 = 这次改写没产出任何东西 */
  extraUnits: string[][]
  /** 被剔掉的问句外壳词 */
  dropped: string[]
  /** 命中的同义家族（便于事后复盘"为什么召回了这条"） */
  families: string[][]
}

/**
 * 把查询改写成「补充单元」。
 * @param query 原始查询（未分词）
 * @param tokens 已分词的主词元（来自 parseQuery，保证与主查询同源）
 * @param segment 分词器（注入，避免本模块反向依赖 tokenizer 的具体实现）
 */
export function rewriteQuery(
  tokens: string[],
  segment: (text: string) => string[],
): RewriteResult {
  const dropped: string[] = []
  const families: string[][] = []
  const extra: string[][] = []
  const seen = new Set(tokens)

  const push = (t: string) => {
    if (!t || seen.has(t)) return
    seen.add(t)
    extra.push([t])
  }

  for (const tok of tokens) {
    // ① 同义家族：命中一族就把**同族其它成员**作为补充词（补充词也要能分词对上）
    for (const fam of FAMILIES) {
      if (!fam.includes(tok)) continue
      families.push(fam)
      for (const alt of fam) {
        if (alt === tok) continue
        for (const piece of segment(alt)) push(piece)
      }
    }
    // ② CJK bigram 展开（词长 ≥4）
    for (const bg of charBigrams(tok)) push(bg)
  }

  return { extraUnits: extra, dropped, families }
}

/** 从主词元里挑出问句外壳词（调用方决定剔不剔——只在还剩得下东西时才剔） */
export function pickScaffold(tokens: string[]): string[] {
  return tokens.filter((t) => SCAFFOLD.has(t))
}
