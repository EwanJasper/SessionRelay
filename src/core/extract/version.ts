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

export const EXTRACT_VERSION = 20;
