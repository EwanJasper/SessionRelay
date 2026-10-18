// DSH 会话文件格式层（~/.dsh/sessions/ 逆向，2026-10-11 实测定稿）
// 容器：zstd 多帧流 + 逐帧 NDJSON；首行 {"type":"session","version":N,...} 头，
// 之后为带单调 seq 的类型化事件（user/message、assistant/message、tool/call、compaction/* 等）。
// Node 的 createZstdDecompress 在帧边界收口（实测单帧模式），故多帧拼接必须逐帧
// zstdDecompressSync——帧边界由魔数 28 B5 2F FD 扫描确定；帧压缩载荷内出现伪魔数
// 的概率 ≈ 2^-32/位置，受害帧跳过重同步即可（源文件为唯一事实源，索引可 rebuild）。
// zstd 解压：Node ≥24 原生（zlib.zstdDecompressSync）；≤23 无此 API——默认导入 +
// 特性探测，绝不命名导入（Node 22 上缺失命名导出会在模块链接期炸掉整个守护）。
import fs from 'node:fs';
import zlib from 'node:zlib';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 当前 Node 是否具备原生 zstd 解压（≥24） */
export const hasNativeZstd = typeof zlib.zstdDecompressSync === 'function';

/** DSH 路径 slug：'E:\music player' → '--E-music~0020player--'。
 * 规则（5 组真实数据反推并固化进测试）：':' 删除、'\'/'/' → '-'、空格 → '~0020'、
 * 非 ASCII → '~' + 4 位大写十六进制（UTF-16 码元）、其余 ASCII 原样；两端 '--' 定界。 */
export function dshSessionSlug(p: string): string {
  let out = '';
  for (const ch of p) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === ':') continue;
    if (ch === '\\' || ch === '/') { out += '-'; continue; }
    if (ch === ' ') { out += '~0020'; continue; }
    if (code < 0x80) { out += ch; continue; }
    out += '~' + code.toString(16).toUpperCase().padStart(4, '0');
  }
  return '--' + out + '--';
}

/** 从缓冲区 from 起扫描全部帧起始偏移（附 EOF 哨兵） */
export function frameOffsets(raw: Buffer): number[] {
  const offsets: number[] = [];
  let i = raw.indexOf(MAGIC);
  while (i !== -1) { offsets.push(i); i = raw.indexOf(MAGIC, i + MAGIC.length); }
  offsets.push(raw.length);
  return offsets;
}

export interface FrameWalkResult {
  /** 每帧解出的 NDJSON 行（按帧序拼接；坏帧跳过计数） */
  lines: string[];
  /** 解码失败帧数（伪魔数切分 / 截断尾帧） */
  failedFrames: number;
}

/** 逐帧解码整个缓冲：每帧独立 zstdDecompressSync，坏帧跳过不中断 */
export function decodeFramesFrom(raw: Buffer): FrameWalkResult {
  if (!hasNativeZstd) return { lines: [], failedFrames: 0 };
  const lines: string[] = [];
  let failed = 0;
  const offsets = frameOffsets(raw);
  for (let k = 0; k < offsets.length - 1; k++) {
    const slice = raw.subarray(offsets[k], offsets[k + 1]);
    try {
      const chunk = zlib.zstdDecompressSync(slice).toString('utf8');
      for (const l of chunk.split('\n')) if (l.trim()) lines.push(l);
    } catch {
      failed++;
    }
  }
  return { lines, failedFrames: failed };
}

/** 从文件直读（readFileSync 一次载入；最大实测 15MB，量级安全） */
export function decodeSessionFile(file: string): FrameWalkResult {
  return decodeFramesFrom(fs.readFileSync(file));
}
