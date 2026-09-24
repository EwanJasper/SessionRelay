// 适配器公共类型（技术方案 §3.1 / 改进方案 改动1）
// 统一接口：所有会话源 adapter 实现同一个 interface，核心代码只与注册表交互

/** 适配器配置——从 RelayConfig 中按 adapter.id 提取 */
export interface AdapterConfig {
  [key: string]: unknown;
}

/** 统一适配器接口 */
export interface SessionSourceAdapter {
  /** 唯一标识（如 'claude-code'、'zcode'、'dsh'） */
  readonly id: string;

  /** 人类可读名称（用于 status/doctor 显示） */
  readonly displayName: string;

  /**
   * 发现属于指定项目的会话
   * @param projectRoot 项目根目录绝对路径
   * @param config 适配器配置
   */
  discover(projectRoot: string, config: AdapterConfig): DiscoveredSession[];

  /**
   * 增量读取新消息
   * @param ds discover 返回的会话描述
   * @param cursor 上次水位（结构由 adapter 自定义）
   * @param config 适配器配置
   */
  readNew(ds: DiscoveredSession, cursor: unknown, config: AdapterConfig): Promise<ReadResult>;

  /**
   * 返回需要监听的文件系统根目录（供 watch 守护用）
   * 返回空数组表示该源不需要文件监听
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

  /**
   * [fork 0922] 内容变更探针：一次调用返回"会话ID → 内容签名"全表快照。
   * 供 runSync 水位线跳过未变更会话——每周期总共一次聚合查询，而非每会话逐条探测。
   * 签名必须由内容决定（如 MAX(rowid)），不得用 mtime：内容变更未必 bump mtime（上游测试契约）。
   * 未实现时 runSync 退回 mtimeMs+sizeBytes 签名（对文件型源已足够）。
   */
  changeProbe?(config: AdapterConfig): Map<string, string>;
}

/** compaction 检测结果 */
export interface CompactionInfo {
  compactedAt: string;
  estimatedDeleted: number;
  summaryMessageId?: string;
}

/** 发现的会话 */
export interface DiscoveredSession {
  source: string;
  sourceSessionId: string;
  sourceFile: string;
  title?: string | null;
  createdAt?: string;
  updatedAt?: string;
  sizeBytes: number;
  mtimeMs: number;
  /** [fork 0924] 会话来源提示：适配器识别出"非项目正主"的会话（如工作流子代理）时标注，
   *  入库时写入 origin 列，决策检索默认排除——防施工碎片淹没项目决策 */
  originHint?: 'workflow';
}

/** 读取结果 */
export interface ReadResult {
  messages: Array<{
    role: 'user' | 'assistant' | 'system';
    content: string;
    seqNum: number;
    createdAt?: string;
  }>;
  badLines: number;
  cursor: unknown;
}
