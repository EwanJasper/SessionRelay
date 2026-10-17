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
  const rule = `session:${source}/${sourceSessionId}`;
  const file = ignoreFilePath(projectRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (parseIgnore(existing).includes(rule)) return; // 幂等：重复 forget / 重复导入不堆叠
  fs.appendFileSync(file, `${existing.endsWith('\n') || existing === '' ? '' : '\n'}${rule}\n`);
}
