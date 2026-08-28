// Claude Code JSONL tailer（方针 §6.1 / 技术方案 §5.1，Spike S2）：
// - 只消费以 \n 结尾的完整行（防 agent 正在写的半行污染坏行计数）
// - offset 只推进到最后一个完整换行符之后（残行字节留待下轮）
// - 从 fromByte 增量读取，绝不整文件重读重分词
import { open } from 'node:fs/promises';

export interface TailedLine {
  lineNo: number; // 会话内确定性行号（幂等键 seq_num 的来源，技术方案 §3.1 契约）
  text: string;
}

export interface TailResult {
  lines: TailedLine[];
  newOffset: number;      // 已消费字节（到最后完整 \n 之后）
  pendingBytes: number;   // 未消费的残尾字节
  consumedLineCount: number; // 含本次后累计完整行数
}

export async function tailCompleteLines(
  path: string,
  fromByte: number,
  consumedLineCount: number,
): Promise<TailResult> {
  const fh = await open(path, 'r');
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    const chunk = Buffer.alloc(1 << 16);
    let pos = fromByte;
    for (;;) {
      const { bytesRead } = await fh.read(chunk, 0, chunk.length, pos);
      if (bytesRead === 0) break;
      chunks.push(Buffer.from(chunk.subarray(0, bytesRead)));
      total += bytesRead;
      pos += bytesRead;
    }
  } finally {
    await fh.close();
  }
  const all = Buffer.concat(chunks);
  const lastNl = all.lastIndexOf(0x0a);
  if (lastNl === -1) {
    return { lines: [], newOffset: fromByte, pendingBytes: total, consumedLineCount };
  }
  // UTF-8 多字节字符不会包含 0x0A，按字节切分安全
  const text = all.subarray(0, lastNl + 1).toString('utf8');
  const rawLines = text.split('\n');
  rawLines.pop(); // 最后一个 \n 之后的空串
  let n = consumedLineCount;
  const lines: TailedLine[] = rawLines.map((t) => ({ lineNo: ++n, text: t }));
  return {
    lines,
    newOffset: fromByte + lastNl + 1,
    pendingBytes: total - (lastNl + 1),
    consumedLineCount: n,
  };
}

/** 文件被整体改写检测（行数回退 / 长度小于已消费 offset） */
export function detectRewrite(fileSize: number, lastConsumedOffset: number): boolean {
  return fileSize < lastConsumedOffset;
}

/** resume 检测：非 active 会话出现增长（方针 §6.1 RESUMED 事件的判定依据） */
export function detectGrowth(fileSize: number, lastConsumedOffset: number): boolean {
  return fileSize > lastConsumedOffset;
}
