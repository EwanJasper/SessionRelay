// .sessionrelayignore 匹配器（方针 §6.2 边界层，gitignore 子集）
// Phase 1 语义：source:<id> / title:<关键词> / 裸 glob 匹配源文件路径（目录尾 / 前缀匹配）
// Phase 2 扩展：会话内容中的 files_mentioned 匹配（依赖元数据提取）
// v3（forget 设计 §3.2）：session:<source>/<sid> 精确规则——防复活主防线，跨 rebuild 存活
import fs from 'node:fs';
import { ignoreFile } from '../shared/paths.js';

export function parseIgnore(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
}

export function loadIgnoreRules(projectRoot: string): string[] {
  try {
    return parseIgnore(fs.readFileSync(ignoreFile(projectRoot), 'utf8'));
  } catch {
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

/** forget 用：把 session: 精确规则追加进 .sessionrelayignore（强制，不可选退——设计 v4 §3.2） */
export function appendSessionIgnoreRule(projectRoot: string, source: string, sourceSessionId: string): void {
  const rule = `session:${source}/${sourceSessionId}`;
  const file = ignoreFile(projectRoot);
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (parseIgnore(existing).includes(rule)) return; // 幂等：重复 forget / 重复导入不堆叠
  fs.appendFileSync(file, `${existing.endsWith('\n') || existing === '' ? '' : '\n'}${rule}\n`);
}
