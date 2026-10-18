// Claude Code JSONL tailer（方针 §6.1 / 技术方案 §5.1，Spike S2）：
// - 只消费以 \n 结尾的完整行（防 agent 正在写的半行污染坏行计数）
// - offset 只推进到最后一个完整换行符之后（残行字节留待下轮）
// - 从 fromByte 增量读取，绝不整文件重读重分词
import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';

/** 前缀尾部指纹的字节数（与 codex 原先那份一致）。 */
const TAIL_PROBE_BYTES = 256;

/**
 * 读「已消费前缀」末尾 256 字节的 sha1 短指纹。
 *
 * 为什么需要它（2026-10-18 红队 P1#4）：`detectRewrite` 只认**文件变小**。
 *   源文件被整段重写、且**变大了**时，大小判据完全不触发 ——
 *   实测 claude-code：367B → 421B 重写，`new=0 conflicts=0 badLines=1`，游标照推到 421，
 *   库里永远是旧文本，而且**连 conflict 都不报**。
 *   变小那种虽触发 rewrite，但冲突条目归零、游标照推进 ⇒ 同样不可恢复。
 *
 * 判据：append-only 时这段字节永不变；被重写则必然变。
 *   ⚠️ 这是**前缀连续性**检查，不是 detectRewrite 的第二份实现 ——
 *      大小比较仍然只有 detectRewrite 那一份，两者互补而非重复。
 *   ⚠️ 这个函数原先只长在 codex 适配器里（它自己的注释就写着「正确归宿是搬进 tailer.ts，
 *      三适配器共用」）。现在搬过来了：判据只许有一份，codex 那边改为引用这里。
 */
export async function readTailProbe(filePath: string, offset: number): Promise<string | null> {
  if (offset <= 0) return '';
  const start = Math.max(0, offset - TAIL_PROBE_BYTES);
  const len = offset - start;
  const fh = await open(filePath, 'r');
  try {
    const b = Buffer.alloc(len);
    const { bytesRead } = await fh.read(b, 0, len, start);
    if (bytesRead < len) return null;   // 文件比 offset 还短 = 被截断（那条判据归 detectRewrite）
    return createHash('sha1').update(b.subarray(0, bytesRead)).digest('hex').slice(0, 16);
  } finally {
    await fh.close();
  }
}

export interface TailedLine {
  lineNo: number; // 会话内确定性行号（幂等键 seq_num 的来源，技术方案 §3.1 契约）
  text: string;
}

export interface TailResult {
  lines: TailedLine[];
  newOffset: number;      // 已消费字节（到最后完整 \n 之后）
  pendingBytes: number;   // 未消费的残尾字节
  consumedLineCount: number; // 含本次后累计完整行数
  /**
   * 本次是否检测到**文件变短式重写**（offset 与行号被就地复位）。
   *
   * 为什么必须回传（2026-10-18 第三轮验证红队 P1，端到端实测）：
   *   这里内部判了 detectRewrite 并静默复位 offset/行号，但**不告诉调用方**；
   *   而三个适配器只在「tailHash 变了」那一支 `rewrites += 1`。
   *   于是「变短的重写」走这条分支时：行号从 1 重数、genBase 却不变 ⇒ seq 与上一代撞
   *   ⇒ upsertMessage 判 conflict ⇒ **库内保留旧正文、新正文永久写不进**。
   *   实测：重写成更短的 2 行后 new=0 conflicts=1，库里三条一字未变，而源文件已是新的。
   *   —— 这正是「代际偏移」那条修复要治的病，在同胞路径上原样存在。
   */
  rewrote?: boolean;
}

export async function tailCompleteLines(
  path: string,
  fromByte: number,
  consumedLineCount: number,
): Promise<TailResult> {
  const fh = await open(path, 'r');
  // ── [1021 红队 R1 修复] 文件被截断/整体改写后，cursor 会永远停在旧 offset ──
  //   实测后果（红队探针）：把 JSONL 截断后连续 3 次读取都是 `0 行 / newOffset 不变`，
  //   **该会话之后所有新消息永远读不到，且没有任何告警** —— 采集永久停摆。
  //   根因：本文件早就写了 `detectRewrite()`，但**从来没有被调用过**（死代码），
  //   三个适配器（claude-code / codex / qoder）都走这里，于是三条线一起中招。
  //   修法：在这里统一判一次 rewrite —— 判据**只有这一份**，三个适配器共享。
  //     文件变小 = 被截断/重写 ⇒ cursor 从头再来（行号也归零，因为它按会话内确定性计算）。
  //     `>` 而非 `>=`：文件恰好等于 offset 是正常「没有新内容」，不是 rewrite。
  let rewrote = false;
  if (fromByte > 0) {
    const st = await fh.stat();
    if (detectRewrite(Number(st.size), fromByte)) {
      fromByte = 0;
      consumedLineCount = 0;
      rewrote = true;   // 必须回传：调用方靠它推进代际（见 TailResult.rewrote 注释）
    }
  }
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
    return { lines: [], newOffset: fromByte, pendingBytes: total, consumedLineCount, rewrote };
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
    rewrote,
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
