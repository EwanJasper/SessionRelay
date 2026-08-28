# SessionRelay 改进方案 v1.0 — 适配器插件化 + 上下文压缩防护

> **日期**：2026-08-28（更新：删除 suggest_related_sessions——冗余，已有工具覆盖）
> **性质**：五项改动的完整技术方案（含代码级设计），供实现前评审
> **上游**：指导方针 v3.1 Review #9 / 技术方案 v1.1
> **触发来源**：实机使用中发现的三类问题——ZCode 压缩删消息、服务安装权限壁垒、适配器硬编码

---

## 目录

1. [改动总览](#一改动总览)
2. [改动 1：适配器注册表与 custom 通道](#二改动-1适配器注册表与-custom-通道)
3. [改动 2：ZCode adapter 捕获 compaction 摘要](#三改动-2zcode-adapter-捕获-compaction-摘要)
4. [改动 3：sync 检测 compaction 数据丢失并警告](#四改动-3sync-检测-compaction-数据丢失并警告)
5. [改动 4：install-service 改注册表 Run 键](#五改动-4install-service-改注册表-run-键)
6. [改动 5：suggest_related_sessions MCP 工具](#六改动-5suggest_related_sessions-mcp-工具)
7. [改动 6：README 重构——MCP 接入章节 + 守护必要性](#七改动-6readme-重构)
8. [Adapter SDK 文档](#八adapter-sdk-文档)
9. [实施顺序与验收标准](#九实施顺序与验收标准)

---

## 一、改动总览

| # | 改动 | 类型 | 优先级 | 核心价值 |
|---|------|------|--------|---------|
| 1 | 适配器注册表 + custom 通道 | **架构** | 🔴 最高 | 加新 agent = 零改核心代码 |
| 2 | ZCode adapter 捕获 compaction 摘要 | 防护 | 🔴 高 | 压缩时至少留住 AI 摘要 |
| 3 | sync 检测 compaction 丢数据并警告 | 防护 | 🔴 高 | 用户知情权 |
| 4 | install-service 改注册表 Run 键 | 可用性 | 🟡 中 | 普通用户可安装守护 |
| 5 | suggest_related_sessions MCP 工具 | 增强 | 🟡 中 | AI 智能推荐关联会话 |
| 6 | README 重构（MCP 章节 + 守护说明） | 文档 | 🟡 中 | 新用户上手 |
| — | Adapter SDK 文档 | 文档 | 🟡 中 | 第三方贡献者指南 |

**依赖关系**：改动 2/3 依赖改动 1 的统一接口（先做注册表，再改 adapter 实现）；改动 5 独立；改动 4/6 独立。

---

## 二、改动 1：适配器注册表与 custom 通道

### 2.1 问题

当前 `sync.ts` 和 `watch.ts` 里适配器调用是硬编码 if/else：

```typescript
// sync.ts — 加新 agent 必须改这里
if (source === 'claude-code') discovered = claude.discover(root, claudeProjectsDir(cfg));
else if (source === 'zcode') discovered = zcode.discover(root, zcodeDbPath(cfg));
else continue;

// ingestOne 里 readNew 也是硬编码
const read = ds.source === 'claude-code'
    ? await claude.readNew(ds, cursorBefore)
    : zcode.readNew(ds, zcodeDbPath(ctx.cfg), cursorBefore);
```

问题：
- 每加一个 agent 要改 sync.ts、watch.ts、doctor.ts 三个文件的 if/else
- Claude Code 和 ZCode 的接口签名不一致（async vs sync、参数结构不同）
- 没有动态加载机制——新 agent 无法通过"放一个文件"来接入
- 技术方案 v1.1 设计了 registry 和 custom 通道但从未实现

### 2.2 设计目标

1. **加新 agent = 零改核心代码**——注册表模式，新 adapter 只需注册
2. **统一接口**——所有 adapter 实现同一个 TypeScript interface
3. **custom 通道**——`.sessionrelay/adapters/*.js` 动态加载，无需编译
4. **向后兼容**——现有 claude-code 和 zcode adapter 迁移到新接口，行为不变

### 2.3 统一适配器接口

```typescript
// src/adapters/types.ts（重写）

/** 适配器配置——从 RelayConfig.capture 中提取，按 adapter.id 命名空间 */
export interface AdapterConfig {
  /** 适配器私有的配置项（如 claude-code 的 projects_dir、zcode 的 db_path） */
  [key: string]: unknown;
}

/** 统一适配器接口——所有会话源必须实现 */
export interface SessionSourceAdapter {
  /** 唯一标识（如 'claude-code'、'zcode'、'dsh'、'cursor'） */
  readonly id: string;

  /** 人类可读名称（用于 status/doctor 显示） */
  readonly displayName: string;

  /**
   * 发现属于指定项目的会话
   * @param projectRoot 项目根目录绝对路径
   * @param config 适配器配置
   * @returns 会话列表（按 mtime 降序）
   */
  discover(projectRoot: string, config: AdapterConfig): DiscoveredSession[];

  /**
   * 增量读取新消息
   * @param ds discover 返回的会话描述
   * @param cursor 上次水位（结构由 adapter 自定义）
   * @param config 适配器配置
   * @returns 新消息 + 新水位
   */
  readNew(ds: DiscoveredSession, cursor: unknown, config: AdapterConfig): Promise<ReadResult>;

  /**
   * 返回需要监听的文件系统根目录（供 watch 守护用）
   * 返回空数组表示该源不需要文件监听（如轮询型源）
   */
  watchRoots?(projectRoot: string, config: AdapterConfig): string[];

  /**
   * 健康检查（供 doctor 用）
   * 返回 null 表示健康；返回 string 为问题描述
   */
  healthCheck?(projectRoot: string, config: AdapterConfig): string | null;

  /**
   * 检测上下文压缩（改动 2/3 用）
   * 返回该会话的 compaction 信息；无压缩返回 null
   */
  detectCompaction?(ds: DiscoveredSession, config: AdapterConfig): CompactionInfo | null;
}

/** compaction 检测结果 */
export interface CompactionInfo {
  /** 压缩发生时间 */
  compactedAt: string;
  /** 压缩前消息数（估算） */
  estimatedDeleted: number;
  /** AI 生成的压缩摘要（如果有） */
  summary?: string;
}

/** 发现的会话（不变，保持现有结构） */
export interface DiscoveredSession {
  source: string;
  sourceSessionId: string;
  sourceFile: string;
  title?: string | null;
  createdAt?: string;
  updatedAt?: string;
  sizeBytes: number;
  mtimeMs: number;
}

/** 读取结果（不变） */
export interface ReadResult {
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string; seqNum: number; createdAt?: string }>;
  badLines: number;
  cursor: unknown;
}
```

### 2.4 适配器注册表

```typescript
// src/adapters/registry.ts（新增）

import type { SessionSourceAdapter, AdapterConfig } from './types.js';
import * as claude from './claude-code/index.js';
import * as zcode from './zcode/index.js';

const builtins = new Map<string, SessionSourceAdapter>();
const customs = new Map<string, SessionSourceAdapter>();

/** 注册内置适配器（启动时调用一次） */
export function registerBuiltin(adapter: SessionSourceAdapter): void {
  builtins.set(adapter.id, adapter);
}

// 启动时注册内置 adapter
registerBuiltin(claude.adapter);
registerBuiltin(zcode.adapter);

/**
 * 从 .sessionrelay/adapters/ 目录加载自定义适配器
 * 每个文件 export 一个实现 SessionSourceAdapter 的对象
 * 文件名即 source id（如 dsh.js → source='dsh'）
 */
export function loadCustomAdapters(projectRoot: string): { loaded: string[]; errors: string[] } {
  const dir = path.join(projectRoot, '.sessionrelay', 'adapters');
  if (!fs.existsSync(dir)) return { loaded: [], errors: [] };

  const loaded: string[] = [];
  const errors: string[] = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.js')) continue;
    const sourceId = f.replace('.js', '');
    try {
      const mod = await import(path.join(dir, f));
      const adapter = mod.default ?? mod;
      if (!adapter.id || !adapter.discover || !adapter.readNew) {
        errors.push(`${f}: 缺少 id/discover/readNew`);
        continue;
      }
      customs.set(sourceId, adapter);
      loaded.push(sourceId);
    } catch (e) {
      errors.push(`${f}: ${e.message}`);
    }
  }
  return { loaded, errors };
}

/** 获取适配器（先查 custom，再查 builtin） */
export function get(sourceId: string): SessionSourceAdapter | undefined {
  return customs.get(sourceId) ?? builtins.get(sourceId);
}

/** 列出所有可用适配器 */
export function list(): SessionSourceAdapter[] {
  return [...customs.values(), ...builtins.values()];
}

/** 从 config 提取适配器配置 */
export function adapterConfig(cfg: RelayConfig, sourceId: string): AdapterConfig {
  // 内置 adapter 的已知配置项
  if (sourceId === 'claude-code') {
    return { projectsDir: claudeProjectsDir(cfg) };
  }
  if (sourceId === 'zcode') {
    return { dbPath: zcodeDbPath(cfg) };
  }
  // custom adapter 的配置从 config.capture.custom[sourceId] 取
  return (cfg.capture as Record<string, unknown>)[`custom_${sourceId}`] as AdapterConfig ?? {};
}
```

### 2.5 sync.ts 改造

```typescript
// 改造前（硬编码）
for (const source of cfg.capture.sources) {
  if (source === 'claude-code') discovered = claude.discover(root, claudeProjectsDir(cfg));
  else if (source === 'zcode') discovered = zcode.discover(root, zcodeDbPath(cfg));
  else continue;
}

// 改造后（注册表）
import { loadCustomAdapters, get, adapterConfig } from '../adapters/registry.js';

// sync 启动时加载 custom adapter
loadCustomAdapters(root);

for (const source of cfg.capture.sources) {
  const adapter = get(source);
  if (!adapter) {
    result.warnings.push(`未知会话源：${source}（可用：${list().map(a => a.id).join(', ')}）`);
    continue;
  }
  discovered = adapter.discover(root, adapterConfig(cfg, source));
}
```

`ingestOne` 同理改造——从 `adapter.get(ds.source).readNew(ds, cursor, config)` 取代 if/else。

### 2.6 watch.ts 改造

```typescript
// 改造前
if (source === 'claude-code') roots.add(claudeProjectsDir(opts.config));
if (source === 'zcode') roots.add(path.dirname(zcodeDbPath(opts.config)));

// 改造后
const adapter = get(source);
if (adapter?.watchRoots) {
  for (const dir of adapter.watchRoots(root, adapterConfig(opts.config, source))) {
    roots.add(dir);
  }
}
```

### 2.7 doctor.ts 改造

```typescript
// 改造后：遍历注册表，每个 adapter 做健康检查
for (const adapter of list()) {
  const issue = adapter.healthCheck?.(root, adapterConfig(cfg, adapter.id));
  checks.push({
    name: `${adapter.displayName} 源`,
    level: issue ? 'warn' : 'ok',
    detail: issue ?? '可达',
  });
}
```

### 2.8 现有 adapter 迁移

**Claude Code adapter** 改造为：

```typescript
// src/adapters/claude-code/index.ts（重写，合并 adapter.ts + tailer.ts）
export const adapter: SessionSourceAdapter = {
  id: 'claude-code',
  displayName: 'Claude Code',
  discover(root, config) {
    const projectsDir = config.projectsDir as string;
    return discover(root, projectsDir);  // 复用现有逻辑
  },
  async readNew(ds, cursor, config) {
    return readNew(ds, cursor);  // 复用现有逻辑
  },
  watchRoots(root, config) {
    return [config.projectsDir as string];
  },
  healthCheck(root, config) {
    return fs.existsSync(config.projectsDir as string) ? null : `目录不存在：${config.projectsDir}`;
  },
};
```

**ZCode adapter** 改造为：

```typescript
// src/adapters/zcode/index.ts（重写）
export const adapter: SessionSourceAdapter = {
  id: 'zcode',
  displayName: 'ZCode',
  discover(root, config) {
    return discover(root, config.dbPath as string);
  },
  async readNew(ds, cursor, config) {
    return Promise.resolve(readNew(ds, config.dbPath as string, cursor));
  },
  watchRoots(root, config) {
    const dbPath = config.dbPath as string;
    return fs.existsSync(dbPath) ? [path.dirname(dbPath)] : [];
  },
  healthCheck(root, config) {
    const dbPath = config.dbPath as string;
    if (!fs.existsSync(dbPath)) return `数据库不存在：${dbPath}`;
    try {
      const z = new Database(dbPath, { readonly: true });
      z.close();
      return null;
    } catch (e) {
      return `只读探测失败：${e.message}`;
    }
  },
  detectCompaction(ds, config) {
    // 改动 2 的实现，见下文
  },
};
```

### 2.9 custom adapter 文件格式

用户只需在 `.sessionrelay/adapters/` 目录放一个 JS 文件：

```javascript
// .sessionrelay/adapters/dsh.js — DSH 适配器示例
import fs from 'node:fs';
import path from 'node:path';

export default {
  id: 'dsh',
  displayName: 'DSH',

  discover(projectRoot, config) {
    // 找到 DSH 的会话存储
    const dshDir = path.join(process.env.HOME, '.dsh', 'sessions');
    if (!fs.existsSync(dshDir)) return [];
    // 按项目路径过滤会话文件
    return fs.readdirSync(dshDir)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        const fp = path.join(dshDir, f);
        const st = fs.statSync(fp);
        return {
          source: 'dsh',
          sourceSessionId: f.replace('.json', ''),
          sourceFile: fp,
          sizeBytes: st.size,
          mtimeMs: st.mtimeMs,
          updatedAt: new Date(st.mtimeMs).toISOString(),
        };
      });
  },

  async readNew(ds, cursor, config) {
    // 读取 JSON 文件，解析消息
    const raw = JSON.parse(fs.readFileSync(ds.sourceFile, 'utf8'));
    const cur = cursor ?? { offset: 0 };
    // ... 解析逻辑
    return { messages, badLines: 0, cursor: newCursor };
  },

  watchRoots(root, config) {
    return [path.join(process.env.HOME, '.dsh', 'sessions')];
  },
};
```

然后在 `config.json` 的 `capture.sources` 里加 `"dsh"` 即可——**零改核心代码**。

---

## 三、改动 2：ZCode adapter 捕获 compaction 摘要

### 3.1 背景

实测发现 ZCode 上下文压缩时会物理删除旧消息（rowid 出现大段断裂），同时写入一条 `type='compaction'` 的 part，包含 AI 生成的压缩摘要。当前 adapter 只读 `type='text'` 的 part，跳过了 compaction。

### 3.2 compaction part 数据结构

```json
{
  "type": "compaction",
  "auto": true,
  "trigger": "auto",
  "phase": "mid_turn",
  "compactReason": "context_limit",
  "tail_start_id": "msg_mt9iefwu_...",
  "preCompactTokenCount": 561572,
  "truePostCompactTokenCount": 26034,
  "summarySource": "model",
  "summaryMessageId": "msg_mt9igx77_...",
  "compactBoundary": {
    "boundaryId": "compact_...",
    "summarySource": "model",
    "preCompactTokenCount": 561572,
    "truePostCompactTokenCount": 26034
  }
}
```

关键字段：
- `summaryMessageId` — 压缩摘要所在的消息 ID
- `preCompactTokenCount` — 压缩前 token 数（可用于估算被删消息量）
- `compactReason` — 触发原因

### 3.3 实现方案

在 ZCode adapter 的 `readNew()` 中增加 compaction part 处理：

```typescript
// src/adapters/zcode/index.ts — readNew 增强

async readNew(ds, cursor, config) {
  const z = new Database(config.dbPath, { readonly: true });
  try {
    // 现有逻辑：读取 type='text' 的 part ...
    
    // 新增：读取 type='compaction' 的 part（增量）
    const compParts = z.prepare(`
      SELECT p.id, p.message_id, p.time_created, p.data
      FROM part p
      WHERE p.session_id = ?
        AND json_extract(p.data, '$.type') = 'compaction'
        AND p.time_created > ?
      ORDER BY p.time_created
    `).all(ds.sourceSessionId, cursor.lastCompactionTime ?? 0);

    for (const cp of compParts) {
      const data = JSON.parse(cp.data);
      // 从 summaryMessageId 找到摘要消息的 text part
      const summaryText = z.prepare(`
        SELECT GROUP_CONCAT(json_extract(pp.data, '$.text'), ' ') AS text
        FROM part pp
        WHERE pp.message_id = ?
          AND json_extract(pp.data, '$.type') = 'text'
      `).get(data.summaryMessageId)?.text;

      if (summaryText && summaryText.trim()) {
        messages.push({
          role: 'system',  // 特殊角色标记：这是压缩摘要，不是原始对话
          content: `[上下文压缩摘要] ${summaryText.trim().slice(0, 2000)}`,
          seqNum: seq++,  // 继续编号
          createdAt: new Date(cp.time_created).toISOString(),
        });
      }
    }

    return { messages, badLines, cursor: newCursor };
  } finally {
    z.close();
  }
}
```

### 3.4 UnifiedMessage role 扩展

当前 `UnifiedMessage.role` 只有 `'user' | 'assistant' | 'system' | 'tool'`。compaction 摘要用 `system` 即可，content 前缀 `[上下文压缩摘要]` 让检索时能识别。

---

## 四、改动 3：sync 检测 compaction 数据丢失并警告

### 4.1 检测逻辑

```typescript
// src/capture/sync.ts — 在 ingestOne 后增加检测

async function checkCompactionDataLoss(
  db: DB,
  adapter: SessionSourceAdapter,
  ds: DiscoveredSession,
  config: AdapterConfig,
  result: SyncStats,
): Promise<void> {
  if (!adapter.detectCompaction) return;

  const compaction = adapter.detectCompaction(ds, config);
  if (!compaction) return;

  // 查我们库里该会话的消息数
  const sessionRow = db.prepare(
    'SELECT id, message_count FROM sessions WHERE source = ? AND source_session_id = ?'
  ).get(ds.source, ds.sourceSessionId) as { id: string; message_count: number } | undefined;

  if (!sessionRow) return; // 新会话，还没入库

  // 估算：如果源里被删了很多消息但我们库里的数远少于压缩前应有的量
  // 粗略判断：库里消息数 < (源里现有消息数 + estimatedDeleted * 0.5) → 可能丢数据
  const sourceMsgCount = ds.sizeBytes; // 对于 zcode 这是 0，需要 adapter 提供

  // 更好的判断：compaction.estimatedDeleted > 0 且库里没有对应的 system 角色消息
  const hasCompactionMsg = db.prepare(`
    SELECT COUNT(*) n FROM messages
    WHERE session_id = ? AND role = 'system' AND content LIKE '[上下文压缩摘要]%'
  `).get(sessionRow.id).n > 0;

  if (compaction.estimatedDeleted > 10 && !hasCompactionMsg) {
    result.warnings.push(
      `⚠️ 会话「${ds.title ?? ds.sourceSessionId}」检测到 ZCode 上下文压缩，` +
      `约 ${compaction.estimatedDeleted} 条原始消息可能已丢失。` +
      `建议开启守护（srelay watch --install-service）避免此问题。`
    );
  }
}
```

### 4.2 detectCompaction 实现（ZCode）

```typescript
// src/adapters/zcode/index.ts — detectCompaction

detectCompaction(ds, config) {
  const z = new Database(config.dbPath, { readonly: true });
  try {
    // 查该会话是否有 compaction part
    const comp = z.prepare(`
      SELECT data FROM part
      WHERE session_id = ?
        AND json_extract(data, '$.type') = 'compaction'
      ORDER BY time_created DESC LIMIT 1
    `).get(ds.sourceSessionId);

    if (!comp) return null;

    const data = JSON.parse(comp.data);
    // 估算被删消息数：preCompactTokenCount / 平均每条消息 token 数（约 500）
    const estimatedDeleted = Math.floor(
      (data.preCompactTokenCount - data.truePostCompactTokenCount) / 500
    );

    return {
      compactedAt: new Date(data.compactBoundary?.boundaryId ? Date.now() : Date.now()).toISOString(),
      estimatedDeleted: Math.max(0, estimatedDeleted),
      summary: data.summaryMessageId ? undefined : undefined, // 从 summaryMessageId 查 text
    };
  } finally {
    z.close();
  }
}
```

### 4.3 SyncStats 扩展

```typescript
export interface SyncStats {
  // ... 现有字段
  warnings: string[];  // 新增：警告列表（compaction 丢数据、未知源等）
}
```

CLI 输出：sync 完成后如果有 warnings，逐条打印。

---

## 五、改动 4：install-service 改注册表 Run 键

### 5.1 问题

`schtasks /Create /SC ONLOGON` 需要管理员权限，普通用户装不了。

### 5.2 方案

Windows 上改用注册表 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` 键（当前用户级，零权限要求）。macOS/Linux 用 launchd/systemd user unit（后续落）。

```typescript
// src/cli/watch.ts — installWatchService 改造

export async function installWatchService(root: string): Promise<void> {
  if (process.platform === 'win32') {
    // 写注册表 Run 键（不需要管理员）
    const cmdPath = path.join(relayDir(root), 'watch-task.cmd');
    // 确保 cmd 文件存在（现有逻辑）
    fs.writeFileSync(cmdPath, [...].join('\r\n'), 'utf8');

    // 用 PowerShell 写注册表（避免 cmd 转义地狱）
    const regPath = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
    const regName = 'SessionRelayWatch';
    execFileSync('powershell', [
      '-Command',
      `Set-ItemProperty -Path '${regPath}' -Name '${regName}' -Value '${cmdPath}'`,
    ]);
    console.log(pc.green('✓') + ` 守护已注册（登录自启动，无需管理员）`);
  } else if (process.platform === 'darwin') {
    // launchd LaunchAgent（后续实现）
    console.log(pc.yellow('macOS 服务注册开发中；先手动 srelay watch --foreground'));
  } else {
    // systemd user unit（后续实现）
    console.log(pc.yellow('Linux 服务注册开发中；先手动 srelay watch --foreground'));
  }
}

export async function uninstallWatchService(root: string): Promise<void> {
  if (process.platform === 'win32') {
    execFileSync('powershell', [
      '-Command',
      `Remove-ItemProperty -Path '${regPath}' -Name '${regName}' -ErrorAction SilentlyContinue`,
    ]);
  }
}

export async function watchServiceStatus(root: string): Promise<string> {
  if (process.platform === 'win32') {
    try {
      const result = execFileSync('powershell', [
        '-Command',
        `(Get-ItemProperty '${regPath}' -ErrorAction SilentlyContinue).${regName}`,
      ], { encoding: 'utf8' });
      return result.trim() ? '已注册' : '未注册';
    } catch {
      return '未注册';
    }
  }
  return '未实现';
}
```

---

## 六、改动 5：suggest_related_sessions MCP 工具

### 6.1 设计

新增一个只读 MCP 工具，AI 在新会话开始时调用，系统基于多维相关性返回 top-N 推荐会话。

### 6.2 相关性计算

```typescript
interface Suggestion {
  sessionId: string;
  title: string | null;
  source: string;
  createdAt: string;
  relevance: number;      // 0-1
  reasons: string[];       // 为什么推荐（透明可解释）
}

function computeRelevance(
  query: { topics: string[]; files: string[]; recentDays: number },
  candidate: { topics: string[]; files: string[]; createdAt: string; messageCount: number },
): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];

  // 话题重叠（权重 0.4）
  const topicOverlap = query.topics.filter(t => candidate.topics.includes(t));
  if (topicOverlap.length > 0) {
    score += 0.4 * Math.min(topicOverlap.length / query.topics.length, 1);
    reasons.push(`话题重叠：${topicOverlap.join('、')}`);
  }

  // 文件重叠（权重 0.3）
  const fileOverlap = query.files.filter(f =>
    candidate.files.some(cf => cf.startsWith(f.split('/')[0]))
  );
  if (fileOverlap.length > 0) {
    score += 0.3 * Math.min(fileOverlap.length / Math.max(query.files.length, 1), 1);
    reasons.push(`涉及文件：${fileOverlap.slice(0, 3).join('、')}`);
  }

  // 时间邻近（权重 0.2）——越近越相关
  const daysAgo = (Date.now() - new Date(candidate.createdAt).getTime()) / 86400_000;
  const recencyScore = Math.max(0, 1 - daysAgo / 30);
  score += 0.2 * recencyScore;
  if (daysAgo < 7) reasons.push(`${Math.round(daysAgo)} 天前`);

  // 消息量（权重 0.1）——大会话通常更重要
  if (candidate.messageCount > 50) {
    score += 0.1;
    reasons.push(`${candidate.messageCount} 条消息（大量讨论）`);
  }

  return { score, reasons };
}
```

### 6.3 MCP 工具注册

```typescript
server.registerTool('suggest_related_sessions', {
  title: '推荐相关会话',
  description: '基于话题/文件/时间推荐与当前工作相关的历史会话。新会话开始时调用，快速定位该关注哪些历史讨论',
  inputSchema: {
    query: z.string().describe('当前正在做什么（自然语言，用于提取话题）'),
    limit: z.number().optional().default(5),
  },
}, async (args) => {
  // 1. 从 query 中提取关键词（用分词器）
  const tokens = segment(args.query, { keepSingles: false });
  // 2. 取最近 confirmed 会话作为候选
  const candidates = listSessions(db, { projectId: project, state: 'confirmed', limit: 50 });
  // 3. 计算相关性
  const suggestions = candidates
    .map(c => {
      const full = getSessionFull(db, c.id);
      return computeRelevance(
        { topics: tokens, files: full?.files ?? [], recentDays: 30 },
        { topics: full?.topics ?? [], files: full?.files ?? [], createdAt: c.createdAt, messageCount: c.messageCount },
      );
    })
    .filter(s => s.score > 0.2)
    .sort((a, b) => b.score - a.score)
    .slice(0, args.limit)
    .map(s => ({
      sessionId: c.id,
      title: c.title,
      source: c.source,
      relevance: Number(s.score.toFixed(2)),
      reasons: s.reasons,
      provenance: { sessionId: c.id, source: c.source, createdAt: c.createdAt },
    }));

  return toolOut({ count: suggestions.length, suggestions });
});
```

---

## 七、改动 6：README 重构

### 7.1 新增章节：MCP 接入指南

```markdown
## MCP 接入指南

### Claude Code

```bash
claude mcp add sessionrelay --scope user -- srelay serve
```

### ZCode / 其他 MCP 客户端

在 MCP 配置中添加：
```json
{
  "mcpServers": {
    "sessionrelay": { "command": "srelay", "args": ["serve"] }
  }
}
```

### 验证

注册后问你的 AI："之前为什么决定用 PostgreSQL？"
它应调用 `get_decisions` 并给出带出处的回答。
```

### 7.2 新增章节：为什么需要守护进程

```markdown
## 为什么需要守护进程

ZCode 在上下文压缩时会**物理删除旧消息**（实测确认）。守护进程每 30 秒自动同步，
确保消息在被删之前入库。

不开守护的风险：手动 sync 之间的间隔内，如果 ZCode 触发压缩，
被删的原始消息将**永久丢失**。

```bash
srelay watch --install-service   # Windows 注册表自启动（无需管理员）
srelay watch --foreground        # macOS/Linux 前台运行（服务注册开发中）
```
```

### 7.3 已知限制补充

```markdown
- ZCode 上下文压缩会物理删除旧消息——开启守护（srelay watch --install-service）可将窗口缩至 30 秒内；压缩后 AI 生成的摘要会被捕获为 system 角色消息
```

### 7.4 路线图更新

在 Phase 4 中增加：
- Adapter SDK 正式发布（文档 + 模板 + 测试框架）
- DSH / Cursor 官方适配器

---

## 八、Adapter SDK 文档

新增 `docs/adapters/README.md`：

```markdown
# 编写自定义适配器

## 最小实现

在 `.sessionrelay/adapters/` 目录创建 JS 文件（文件名即 source ID）：

\`\`\`javascript
// .sessionrelay/adapters/my-agent.js
export default {
  id: 'my-agent',
  displayName: 'My Agent',
  discover(projectRoot, config) { /* 返回 DiscoveredSession[] */ },
  async readNew(ds, cursor, config) { /* 返回 ReadResult */ },
};
\`\`\`

然后在 `.sessionrelay/config.json` 的 `capture.sources` 里加 `"my-agent"`。

## 完整接口

| 方法 | 必须实现 | 说明 |
|------|---------|------|
| `id` | ✅ | 唯一标识 |
| `displayName` | ✅ | 显示名 |
| `discover(root, config)` | ✅ | 发现属于该项目的会话 |
| `readNew(ds, cursor, config)` | ✅ | 增量读取新消息 |
| `watchRoots(root, config)` | 可选 | 返回需监听的目录 |
| `healthCheck(root, config)` | 可选 | doctor 自检 |
| `detectCompaction(ds, config)` | 可选 | 检测上下文压缩 |

## 水位（cursor）

`cursor` 是一个不透明对象，由你的 adapter 自己定义和序列化。
常见模式：
- 文件型源：`{ offset: number, lines: number }` — 字节偏移 + 行号
- 数据库型源：`{ rowid: number }` — 递增主键
- 混合型源：`{ lastTime: number, lastId: string }` — 时间戳 + ID

## seq_num 契约

`seq_num` 必须是**确定性序号**——同一条消息被重放时必须得到相同的 seq_num。
这是幂等去重键 `(session_id, seq_num)` 的前提。
```

---

## 九、实施顺序与验收标准

| 步骤 | 内容 | 验收标准 |
|------|------|---------|
| 1 | 统一接口 + 注册表 + 现有 adapter 迁移 | `npm test` 全绿（现有 90 测试不 break） |
| 2 | sync.ts / watch.ts / doctor.ts 改用注册表 | 同上 + `srelay sync` / `srelay status` / `srelay doctor` 行为不变 |
| 3 | ZCode compaction 摘要捕获 | 新增测试：伪造 compaction part → sync 后 system 角色消息存在 |
| 4 | sync compaction 警告 | 新增测试：伪造 compaction + 库缺数据 → warnings 包含警告 |
| 5 | install-service 注册表 | 手动验证：非管理员可安装/卸载/查询 |
| 6 | suggest_related_sessions | 新增 MCP 契约测试：返回 suggestions 数组 + reasons |
| 7 | README + Adapter SDK 文档 | 人工审查 |
| 8 | 全量回归 + 构建 + 推送 | CI 全绿 |

**预计改动文件**：
- 新增：`src/adapters/registry.ts`、`docs/adapters/README.md`
- 重写：`src/adapters/types.ts`、`src/adapters/claude-code/index.ts`、`src/adapters/zcode/index.ts`
- 修改：`src/capture/sync.ts`、`src/capture/watch.ts`、`src/cli/watch.ts`、`src/cli/doctor.ts`、`src/mcp/server.ts`、`README.md`
- 新增测试：compaction 捕获/警告、custom adapter 加载、suggest_related_sessions

**预计新增决策编号**：
- D24：适配器注册表（统一接口 + custom 通道，加新 agent 零改核心）
- T41：compaction 摘要捕获（system 角色 + [上下文压缩摘要] 前缀）
- T42：suggest_related_sessions（话题 0.4 + 文件 0.3 + 时间 0.2 + 量 0.1）
