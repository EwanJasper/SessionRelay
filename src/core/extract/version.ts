// 提取规则族版本（常量所在地）。
//
// 为什么单独一个文件：版本号有两处需要——
//   · store/db.ts 的 applyExtraction：写派生列时打上「这批数据是哪个规则版本算的」
//   · capture/recompute.ts：重算判据（sessions.extracted_version < EXTRACT_VERSION）
// 把常量留在 recompute.ts 会让 store 反向 import capture，形成循环依赖。故挪到中性模块，
// recompute.ts 原样 re-export —— 既有 import 点（bin/srelay.ts、cli/doctor.ts）一行不用改。
//
// ⚠️ 完整变更史（每一条都是实测驱动，别只改数字）在 src/capture/recompute.ts 顶部注释里，
//    那是唯一权威；本文件只放常量，避免两处各写一份导致漂移。

// [v21 · 1017 夜 · U-A 真根治] 未决判据加第三维「这句后来被回答了吗」（wasAnswered）。
//   原判据 unresolved = tailAsked || UNRESOLVED_HINT 实测与「未答」不相关：7/7 被标未决的条目
//   其后各有 305~524 条 assistant 消息（调研件 §2.5）。加这一维会**减少** unresolved 数量 ——
//   这正是目的：宁缺勿滥。改判据必须递增版本，否则存量库不会被重算。
// [v22 · 1020 · 序号漂移治根] 决策/未决条目除了 `seq`（位置索引）再存一份 `msgId`（稳定主键）。
//   病历：`seq` 是消息在会话里的序号，消息被裁剪后整体前移 ⇒ 按 seq 回查会**指到错的那条**，
//   而且不报错（dsh-memory-kit 把这个列为他们的头号坑，叫「序号漂移」）。
//   实测：agent1super 库 857 条决策里 **525 条（61%）按 seq 定位不到**（消息已被归档裁掉）。
//   加 msgId 后，能定位的比例应由 38.7% 显著上升（**这条待实测验证**）。
//   改字段 = 改提取输出形状 ⇒ 必须递增版本，否则存量库不会重算、老条目永远没有 msgId。
// [v23 · 1020] 抽取端加「决策动词后紧跟逗号」判据 —— 那是从句子中段截出的残片。
//   实测 agent1super 库 864 条里命中 19 条，**逐条看过 19/19 全是垃圾、零误伤**：
//     「决定，因为两条路的工作量差一个数量级」「选择，17 t/s 是真实天花板」
//     「采用，无需改配置」「决定，duration 只是上限」
//   与简报端第 8~11 条互补：那几条管**已入库**的，这条让它们**根本不入库**。
export const EXTRACT_VERSION = 23;
