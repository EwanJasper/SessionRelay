import { defineConfig } from 'vitest/config';
import os from 'node:os';
import path from 'node:path';

export default defineConfig({
  test: {
    include: ['test/**/*.spec.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
    // [1016 · 测试隔离] 全局经验库默认落在 ~/.sessionrelay/global.sqlite ——
    // 测试**绝不能**读写用户真实的那个库：实测踩到——手工往真库里写了 9 条草稿后，
    // 依赖简报/经验的用例集体变红（它们读到了真实数据）。
    // 这里把测试进程的全局库指到临时目录：用例彼此隔离，也不污染用户环境。
    env: {
      SRELAY_GLOBAL_HOME: path.join(os.tmpdir(), 'sessionrelay-test-global'),
    },
  },
});
