// Adapter 公共类型（技术方案 §3.1）
export interface DiscoveredSession {
  source: string;
  sourceSessionId: string;
  sourceFile: string;          // claude-code: jsonl 绝对路径；zcode: 'zcode:<sessionId>' 概念路径
  title?: string | null;
  createdAt?: string;          // ISO
  updatedAt?: string;          // ISO（结束判定信号源）
  sizeBytes: number;
  mtimeMs: number;             // 回填过滤/backfill 用
}

export type ParseOutcome =
  | { kind: 'message'; role: 'user' | 'assistant'; content: string; seqNum: number; createdAt?: string }
  | { kind: 'skip' }   // 非消息行（summary/子链/hook 附件等，预期内）
  | { kind: 'bad' };   // JSON 解析失败（格式漂移候选）

export interface ReadResult {
  messages: Array<{ role: 'user' | 'assistant'; content: string; seqNum: number; createdAt?: string }>;
  badLines: number;
  cursor: unknown;             // T34：结构由 adapter 自定义
}
