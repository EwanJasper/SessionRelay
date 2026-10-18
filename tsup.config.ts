// tsup 构建配置（技术方案 T32：原生模块必须 external，绝不可打进 bundle）
//
// [1016] 两个入口：
//   srelay.js —— CLI（原样）
//   recall.js —— **给适配器 import 的小包**（DSH 插件 / ZCode hook）：
//     导出 lastUserMessage（DSH 会话逐帧解码）与召回相关原语。
//     为什么要它：适配器拿不到 TS 源码，此前各自实现了一套打分，
//     于是核心库验证过的排序改进（如长度归一）它们吃不到 —— 一个系统里不该有第二套排序。
// [1017 夜] 第三个入口：
//   panel.js —— 面板宿主半的进口（总览/压缩图谱/经验图谱/设置）。
//     必须**自成一体**（splitting:false）：一旦与主入口共享 chunk，那个 chunk 可能把
//     better-sqlite3 带进来，而面板插件里没有原生模块 ⇒ DSH 启动时整块加载失败。
//     依赖闭包由 tools/check-panel-deps.mjs 实测（不接受"看起来是纯的"）。
import { defineConfig } from 'tsup';

const external = [
  'better-sqlite3',          // 原生（napi），随依赖安装
  '@node-rs/jieba',          // 原生（napi 预编译）
  '@node-rs/jieba/dict',
];

export default defineConfig([
  {
    entry: { srelay: 'src/bin/srelay.ts', recall: 'src/recall-entry.ts' },
    format: ['esm'],
    platform: 'node',
    target: 'node18',
    outDir: 'dist',
    sourcemap: false,
    clean: false,
    external,
  },
  {
    entry: { panel: 'src/panel-entry.ts' },
    format: ['esm'],
    platform: 'node',
    target: 'node18',
    outDir: 'dist',
    sourcemap: false,
    splitting: false,
    clean: false,
    external,
  },
]);
