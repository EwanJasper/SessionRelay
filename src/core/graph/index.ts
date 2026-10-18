// 标签关系表 + 查询扩展（零模型「轻量知识图谱」）
//
// 对外只暴露三件事：建图（tags）、扩词（expand）、可解释打印（formatExpansion）。
// 检索侧接线在 src/search-svc/engine.ts 的 opts.tagExpand —— 判据不在这里重复实现。
export { buildTagGraph, ensureGraphSchema, extractSessionTags } from './tags.js';
export type { BuildStats, BuildOptions, TagCandidate, TagKind } from './tags.js';
export { expandQueryTags, formatExpansion, graphStatus } from './expand.js';
export type { ExpandOptions, ExpansionTerm, QueryExpansion, SeedInfo } from './expand.js';
