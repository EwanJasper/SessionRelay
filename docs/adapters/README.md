# Adapter SDK — 编写自定义适配器

> 会话接力的适配器是**插件化的**：放一个 JS 文件到 `.sessionrelay/adapters/` 目录，核心代码零改动。

## 最小实现

创建 `.sessionrelay/adapters/my-agent.js`：

```javascript
// .sessionrelay/adapters/my-agent.js
// 文件名即 source ID（my-agent.js → source='my-agent'）

module.exports = {
  id: 'my-agent',
  displayName: 'My Agent',

  discover(projectRoot, config) {
    // 找到属于该项目的会话文件/记录
    // 返回 DiscoveredSession[] 数组
    return [{
      source: 'my-agent',
      sourceSessionId: 'session-uuid-1',
      sourceFile: '/path/to/session/file',
      title: '讨论数据库设计',        // 可选，如果有原生标题
      createdAt: '2026-08-28T10:00:00Z',  // 可选
      updatedAt: '2026-08-28T12:00:00Z',  // 可选（结束判定信号）
      sizeBytes: 10240,
      mtimeMs: Date.now(),
    }];
  },

  async readNew(ds, cursor, config) {
    // 增量读取自上次水位以来的新消息
    // cursor 是你自己定义的对象（首次为 null）
    const cur = cursor ?? { offset: 0 };
    const content = readFileFrom(ds.sourceFile, cur.offset);

    return {
      messages: [{
        role: 'user',             // 'user' | 'assistant' | 'system'
        content: '用户说的内容',
        seqNum: 1,                // 确定性序号（幂等键，见下文）
        createdAt: '2026-08-28T10:01:00Z',
      }],
      badLines: 0,                // 解析失败的行数
      cursor: { offset: cur.offset + content.length },  // 新水位
    };
  },
};
```

然后在 `.sessionrelay/config.json` 的 `capture.sources` 里加上 `"my-agent"`：

```json
{
  "capture": {
    "sources": ["claude-code", "zcode", "my-agent"]
  }
}
```

重启 `srelay watch` 或手动 `srelay sync` 即可开始捕获。

## 完整接口

| 方法 | 必须 | 说明 |
|------|------|------|
| `id` | ✅ | 唯一标识（即 config.sources 里的名字） |
| `displayName` | ✅ | 显示名（用于 status/doctor） |
| `discover(root, config)` | ✅ | 发现属于该项目的会话 |
| `readNew(ds, cursor, config)` | ✅ | 增量读取新消息 |
| `watchRoots(root, config)` | 可选 | 返回需监听的目录（watch 守护用） |
| `healthCheck(root, config)` | 可选 | doctor 自检（返回 null=健康，string=问题） |
| `detectCompaction(ds, config)` | 可选 | 检测上下文压缩（数据丢失预警） |

## 数据类型

### DiscoveredSession

```typescript
{
  source: string;            // 你的 adapter id
  sourceSessionId: string;   // 源工具的原始会话 ID
  sourceFile: string;        // 源文件路径（或概念路径如 'myagent:xxx'）
  title?: string | null;     // 原生标题（如果有）
  createdAt?: string;        // ISO 时间
  updatedAt?: string;        // ISO 时间（结束判定用）
  sizeBytes: number;
  mtimeMs: number;           // 回填过滤用
}
```

### ReadResult

```typescript
{
  messages: Array<{
    role: 'user' | 'assistant' | 'system';
    content: string;
    seqNum: number;          // 确定性序号（见下文契约）
    createdAt?: string;
  }>;
  badLines: number;          // 解析失败计数
  cursor: unknown;           // 你自定义的水位对象
}
```

## 水位（cursor）契约

`cursor` 是一个**不透明对象**，由你的 adapter 自己定义和序列化。核心代码只做存取，不理解其内部结构。

常见模式：

| 源类型 | 水位结构 | 说明 |
|--------|---------|------|
| 文件型 | `{ offset: number, lines: number }` | 字节偏移 + 行号 |
| 数据库型 | `{ rowid: number }` | 递增主键 |
| 混合型 | `{ lastTime: number, lastId: string }` | 时间戳 + ID 去重 |

**关键要求**：同一条消息被重放时（崩溃恢复、offset 回退），必须被跳过（幂等）。

## seq_num 契约（幂等去重键）

`seqNum` 必须是**确定性序号**——同一条消息在任何情况下重放都得到相同的 seqNum。

数据库会以 `(session_id, seqNum)` 为唯一键做 `INSERT OR IGNORE`，所以：
- 如果 seqNum 重复 → 消息被跳过（幂等）
- 如果 seqNum 不确定（如随机数）→ 崩溃恢复时会产生重复消息

**最佳实践**：
- 文件型源：用行号
- 数据库型源：用数据库的 sequence/rowid
- API 型源：用消息的时间戳 + 序号

## 自定义配置

如果你需要从 config.json 传入配置：

```json
{
  "capture": {
    "sources": ["my-agent"],
    "custom_my-agent": {
      "apiUrl": "https://...",
      "token": "..."
    }
  }
}
```

adapter 的 `config` 参数会拿到 `{ apiUrl: "...", token: "..." }`。

## 参考实现

- [Claude Code adapter](../../src/adapters/claude-code/index.ts) — 文件型源（JSONL tailing）
- [ZCode adapter](../../src/adapters/zcode/index.ts) — 数据库型源（SQLite 增量 + compaction 检测）

## 已知限制

- custom adapter 文件必须是 **CommonJS**（`module.exports`），不支持 ESM（`export default`）
- adapter 在 sync/watch 进程中同步执行，长时间操作会阻塞——如果源很慢，建议缓存
- 崩溃恢复依赖 seqNum 幂等，如果 seqNum 不确定会导致重复消息
