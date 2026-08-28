// tsup 构建配置（技术方案 T32：原生模块必须 external，绝不可打进 bundle）
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/bin/srelay.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node18',
  outDir: 'dist',
  outFile: 'srelay.js',
  sourcemap: true,
  external: [
    'better-sqlite3',          // 原生（napi），随依赖安装
    '@node-rs/jieba',          // 原生（napi 预编译）
    '@node-rs/jieba/dict',
  ],
});
