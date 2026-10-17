// .sessionrelayignore 匹配器（方针 §6.2 边界层，gitignore 子集）
// Phase 1 语义：source:<id> / title:<关键词> / 裸 glob 匹配源文件路径（目录尾 / 前缀匹配）
// Phase 2 扩展：会话内容中的 files_mentioned 匹配（依赖元数据提取）
// v3（forget 设计 §3.2）：session:<source>/<sid> 精确规则——防复活主防线，跨 rebuild 存活
import fs from 'node:fs';
import path from 'node:path';
import { readConfigFile, mergeConfig } from '../shared/config-merge.js';

export function parseIgnore(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
}

/**
 * **有效排除文件的唯一解析处**（[1021 审查 #07]）。
 *
 * 病历：config 声明了 privacy.ignore_file（面板 knobs 里还能改），但读取侧写死
 * `.sessionrelayignore` —— 于是自定义排除文件**完全没生效**，而且没有任何提示：
 * 复现实测：config 写 ignore_file=my-ignore.txt、两个文件各一条规则，loadIgnoreRules
 * 只拿到 .sessionrelayignore 里那条（1/2），用户以为排除了、其实没排除。
 *
 * 现在读配置解析（相对路径按项目根；也接受绝对路径）。
 * 配置坏了**不静默**：报一句原因并回退默认文件名（否则用户改错配置会看到"规则忽然全部失效"）。
 */
export function ignoreFilePath(projectRoot: string): string {
  const read = readConfigFile(projectRoot);
  if (read.error) console.warn('[ignore] ' + read.error + ' —— 本次回退默认排除文件名');
  const cfg = mergeConfig(read.raw);
  const name = String(cfg.privacy?.ignore_file ?? '').trim() || '.sessionrelayignore';
  return path.isAbsolute(name) ? name : path.join(projectRoot, name);
}

export function loadIgnoreRules(projectRoot: string): string[] {
  const file = ignoreFilePath(projectRoot);
  try {
    return parseIgnore(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    // 文件不存在 = 常态（默认就没有这个文件），不算错；**其它**读失败必须说出来
    if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      console.warn('[ignore] 排除文件读取失败（' + file + '）：' + String((e as Error)?.message ?? e).slice(0, 140));
    }
    return [];
  }
}

function segToRe(seg: string): string {
  return seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
}

function globToRegExp(pat: string, dirOnly: boolean): RegExp {
  const body = pat.split('**').map(segToRe).join('.*');
  return new RegExp('^' + body + (dirOnly ? '($|/)' : '$'));
}

export interface IgnoreTarget {
  source: string;
  sourceSessionId: string;  // forget 防复活：session: 精确规则依赖
  title: string | null;
  sourceFile: string;
}

export function isSessionBlocked(patterns: string[], t: IgnoreTarget): boolean {
  const filePosix = t.sourceFile.replace(/\\/g, '/');
  for (const raw of patterns) {
    if (raw.startsWith('session:')) {
      // forget 墓碑规则：session:<source>/<sourceSessionId> 精确匹配（主防线）
      if (raw === `session:${t.source}/${t.sourceSessionId}`) return true;
      continue;
    }
    if (raw.startsWith('source:')) {
      if (t.source === raw.slice(7).trim()) return true;
      continue;
    }
    if (raw.startsWith('title:')) {
      const kw = raw.slice(6).trim();
      if (kw && (t.title ?? '').includes(kw)) return true;
      continue;
    }
    const pat = raw.replace(/\\/g, '/');
    const dirOnly = pat.endsWith('/');
    const re = globToRegExp(dirOnly ? pat.slice(0, -1) : pat, dirOnly);
    if (re.test(filePosix)) return true;
  }
  return false;
}

/**
 * forget 用：把 session: 精确规则追加进**当前生效的**排除文件（强制，不可选退——设计 v4 §3.2）。
 * ⚠️ 必须走 ignoreFilePath：写 A 读 B 会让墓碑静默失效（本次一并修掉，原本写死 .sessionrelayignore）。
 */
export function appendSessionIgnoreRule(projectRoot: string, source: string, sourceSessionId: string): void {
  appendSessionIgnoreRules(projectRoot, [{ source, sourceSessionId }]);
}

/**
 * **批量**追加防复活规则（[1021 回归 P6]）。
 *
 * 病历：`forget --all` 原来对每个会话各调一次单条版本，而单条版本每次都
 * 「读整个文件 → 解析 → 追加一行 → 写回」⇒ 1000 个会话就是 1000 次整文件读写，
 * 实测 1848ms，且随库增大呈**平方**增长。整库遗忘本来就是最重的一次操作，
 * 不该在这里再叠一层平方。
 *
 * 判据与单条版本逐字相同（幂等跳过已存在、只在需要时补换行），
 * 区别只是**一次读、一次写**。返回实际新增的条数（供调用方回读校验用）。
 */
export function appendSessionIgnoreRules(
  projectRoot: string,
  items: Array<{ source: string; sourceSessionId: string }>,
): number {
  if (items.length === 0) return 0;
  const file = ignoreFilePath(projectRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const present = new Set(parseIgnore(existing));
  const add: string[] = [];
  for (const it of items) {
    const rule = `session:${it.source}/${it.sourceSessionId}`;
    if (present.has(rule)) continue;   // 幂等：重复 forget / 重复导入不堆叠
    present.add(rule);
    add.push(rule);
  }
  if (add.length === 0) return 0;
  const lead = existing === '' || existing.endsWith('\n') ? '' : '\n';
  fs.appendFileSync(file, lead + add.join('\n') + '\n');
  return add.length;
}
