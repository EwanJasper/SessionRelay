---
name: 新适配器请求
about: 请求支持一个新的 AI 编程工具
title: '[Adapter] '
labels: adapter
assignees: ''
---

**AI 工具名称**
如：通义灵码、DSH、Windsurf 等。

**工具官网**
官网或下载链接。

**你的本地会话存储位置**
通常在 `~/.` 或 `~/AppData/` 下（Windows）。
可以运行 `find ~ -name "*.jsonl" -newer /tmp -maxdepth 4 2>/dev/null | head -5` 或类似命令找到。

**存储格式**
如果知道的话：JSONL / SQLite / 加密？

**你愿意贡献适配器吗？**
参照 [Adapter SDK](docs/adapters/README.md)，最小实现只需 7 行代码。
