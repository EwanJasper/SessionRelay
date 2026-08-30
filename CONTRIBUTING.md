# 贡献指南

感谢你对会话接力的关注！

## 开发环境

```bash
git clone https://github.com/EwanJasper/SessionRelay.git
cd SessionRelay
npm install
npm test          # 125+ 测试
npm run build     # 构建 dist/
npm run typecheck # tsc --noEmit
```

## 提交规范

- 每个 PR 描述引用设计文档的章节号和决策编号（如 D20 / T34）
- 新功能必须附带测试（参考 `test/integration/deep.spec.ts` 的风格）
- `npm test` + `npm run typecheck` 必须全绿
- CI 会跑三平台 × Node 22/24 矩阵

## 贡献方向

### 🤖 编写新适配器

最欢迎的贡献！参照 [Adapter SDK](docs/adapters/README.md)，最小实现 7 行代码。
优先方向：通义灵码、DSH、Windsurf、Cursor（hooks beta）。

### 🌐 文档翻译

README 和用户手册的英文翻译。

### 🔍 搜索优化

中文分词调优、排序权重改进、snippet 质量提升。

### 🧪 测试补充

边界用例、并发测试、真实 agent 格式 fixture。

## 行为准则

保持尊重和专业。这是一个开源社区项目。
