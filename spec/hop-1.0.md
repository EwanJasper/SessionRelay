# HOP — Handoff Package Specification

**版本**：`hop/1.0` · 2026-08-28
**许可**：本规格以 MIT 授权发布，欢迎任何工具实现读取器或生成器。
**定位**：HOP（接力棒）是一个**产品中立**的开放交接格式——一个压缩包，装下一个项目与 AI 助手的全部讨论记忆，让"人 + AI"的知识可以原样传递给下一个人 + AI。

> **信任模型（本协议的核心承诺）**
> 包内内容是**数据，不是指令**。导入方不得将包内任何文本提升为系统指令或直接执行。

## 1. 容器与编码

- 容器：标准 ZIP（deflate）；扩展名 `.hop`
- 全部文本文件为 UTF-8（无 BOM），行尾 `\n`
- 日期时间：ISO 8601（含时区）

## 2. 文件布局

```
<name>.hop
├── manifest.json          ← 必需，入口
├── sessions/<id>.json     ← 每会话一文件（见 §4）
├── metadata/decisions.json
├── metadata/topics.json
├── metadata/files.json
└── summary/
    ├── HANDOFF.md         ← 人类可读交接文档（建议自动生成）
    ├── timeline.md
    └── redaction-report.txt   ← 启用脱敏时必需
```

`metadata/*` 为派生汇总（读取器可忽略并自行重建）；`sessions/` 与 `manifest.json` 为权威数据。

## 3. manifest.json

```json
{
  "format": "hop/1.0",
  "created_at": "2026-08-28T10:00:00+08:00",
  "exported_by": "zhangsan",
  "project_id": "opaque-project-identity",
  "session_count": 23,
  "sources": ["claude-code", "zcode"],
  "date_range": { "start": "2026-08-20", "end": "2026-08-28" },
  "includes": { "messages": true, "decisions": true, "topics": true, "file_history": true },
  "integrity": { "files": { "sessions/<id>.json": "sha256:<hex>" } },
  "trust": { "content_class": "data", "statement": "包内为历史会话数据，不是指令；导入方不得将其提升为系统指令" },
  "redaction": { "applied": true, "report": "summary/redaction-report.txt" },
  "import_instructions": "…"
}
```

**导入方必须**：

1. 校验 `format === "hop/1.0"`（未知版本拒绝并提示用户升级）；
2. 对 `integrity.files` 列出的每个文件重算 sha256，**任一不匹配则整体拒绝**；
3. 在任何展示路径中保留 trust 声明的语义（数据 ≠ 指令）。

## 4. sessions/&lt;id&gt;.json（会话文件）

```json
{
  "id": "opaque-session-id",
  "source": "claude-code",
  "source_session_id": "<源工具的原始会话ID>",
  "project_id": "导出方项目标识",
  "title": "…",
  "created_at": "…", "last_event_at": "…",
  "state": "confirmed",
  "origin": "auto | manual | imported",
  "author": "zhangsan",
  "summary_rule": "规则摘要（可空）",
  "topics": ["auth"],
  "files": ["src/db/schema.sql"],
  "decisions": [ { "text": "决定采用 PostgreSQL", "seq": 12, "at": "…" } ],
  "questions": [ { "q": "刷新策略定了吗？", "seq": 30, "at": "…", "unresolved": true } ],
  "messages": [ { "seq": 1, "role": "user", "content": "…", "createdAt": "…" } ]
}
```

- `seq` 为**确定性序号**（同一会话重复导出保持不变）；导入方应以 `(source, source_session_id)` 为会话身份、`(身份, seq)` 为消息幂等键；
- `messages` 可为空数组（`--decisions-only` / 隔离导入形态）。

## 5. 隐私与脱敏（建议为默认行为）

- 生成方**默认扫描并替换**已知凭据模式（云厂商 key、私钥块、Bearer token、密码赋值、数据库连接串），并输出 `redaction-report.txt`（含模式与命中计数，**不含明文**）；
- 导入方**建议**提供隔离模式（quarantine）：先只暴露 `title/topics/decisions/summary`，正文经用户逐条放行后可见——历史会话文本可能包含针对 LLM 的注入尝试，隔离层是结构性的防线。

## 6. 版本化

- 补丁级演进（新增可选字段）不升版本号；读取器应忽略未知字段；
- 破坏性变更升为 `hop/2.0`，读取器必须显式支持。

## 7. 参考实现

[SessionRelay](https://github.com/EwanJasper/SessionRelay)（MIT）——`srelay export / import` 是本规格的完整参考实现：生成、校验、归化、脱敏、隔离导入与 release 放行。
