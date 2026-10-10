// 守护日志轮转（从 cli/service.ts 提升为共享实现）。
// [fork 1011] 动机：全局守护把 worker 日志双写到每个收编项目的 watch.log，
// 但轮转原先只覆盖 cwd 根——其余项目日志无限增长（实测 D 33.7MB / E 7.4MB）。
// 另：cmd 的 >> 追加句柄会让本函数的 writeFileSync 截断 EBUSY（被静默吞掉，
// 实测每小时 rotator 空转的根因）——--global 模式已改为守护自写日志（无 cmd
// 重定向，见 cli/service.ts windowsRunScript），本函数才得以生效。
import fs from 'node:fs';

/** 超过 maxBytes 截断留尾 keepBytes；返回是否发生了轮转。文件不存在/未超限返回 false。 */
export function rotateLogFile(f: string, maxBytes = 1_048_576, keepBytes = 102_400): boolean {
  try {
    if (!fs.existsSync(f)) return false;
    const size = fs.statSync(f).size;
    if (size <= maxBytes) return false;
    const fh = fs.openSync(f, 'r');
    const buf = Buffer.alloc(Math.min(keepBytes, size));
    fs.readSync(fh, buf, 0, buf.length, size - buf.length);
    fs.closeSync(fh);
    const kept = buf.toString('utf8');
    const trimmed = kept.slice(kept.indexOf('\n') + 1); // 丢弃可能被截断的首行
    fs.writeFileSync(f, `...（日志超 1MB，已截断保留尾部）\n${trimmed}`);
    return true;
  } catch {
    // 句柄竞争等瞬态：本次放弃，下个周期重试（调用方每小时重试一次）
    return false;
  }
}
