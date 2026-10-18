// panel.js —— 给「面板」用的可导入小包（DSH 插件宿主半 / 应急入口 ses-serve）
//
// 与 recall.js 同一个理由：适配器拿不到 TS 源码，绝不许各自再抄一套取数与判据。
// 差异只在依赖：这条链**不 import 任何原生模块**（better-sqlite3 / @node-rs/jieba），
// 所以宿主半可以零依赖加载（数据库用 Node 内置的 node:sqlite 打开）。
//
// 纪律：本入口的依赖闭包必须是"纯"的。dist/panel.js 里如果出现 require('better-sqlite3')
// 或 node-rs/jieba，插件就会在 DSH 里加载失败 —— tools/check-panel-deps.mjs 会拦下它。

export {
  panelOverview, panelProjectCard, panelLessons, panelLifecycle, watchdogOnline,
  panelCompression, panelConfigView, panelApplyConfig,
  panelGraph,
  // [1021 安全轴] 面板 API 的 root 白名单校验（lib/index.js 的 METHODS 里调用）
  assertRegisteredRoot,
  PANEL_CRITERIA,
} from './panel/snapshot.js';
export type {
  PanelOverview, PanelProject, PanelLessons, PanelLessonItem, PanelLifecycle,
  PanelCompression, CompressionLayer, PanelConfigView, ApplyResult,
  PanelGraph, PanelGraphTag,
} from './panel/snapshot.js';
export { openReadonly, withDb } from './panel/db.js';
export type { ReadonlyDb, ReadonlyStmt, OpenReport } from './panel/db.js';
export { KNOB_SPECS, KNOB_BY_PATH, validateKnob, knobStates } from './panel/knobs.js';
export type { KnobSpec, KnobState, KnobType } from './panel/knobs.js';
// 闸门判据（面板要把"能不能进注入层"显示得与实际一致，必须用同一份）
export { isInjectable, liveImportance, INJECT_THRESHOLD, DECAY_PER_DAY } from './store/lesson-gate.js';
// 统一路径 API（面板要报"哪个文件"）
export { dbFile, relayDir, configFile, globalDbFile } from './shared/paths.js';
export { registryCandidates } from './shared/registry.js';
export { defaultConfig, mergeConfig, saveConfig, readConfigFile } from './shared/config-merge.js';
export type { RelayConfig, CaptureMode } from './shared/config-merge.js';
