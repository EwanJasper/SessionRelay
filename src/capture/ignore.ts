// .sessionrelayignore 匹配器（方针 §6.2 边界层，gitignore 子集）
// Phase 1 语义：source:<id> / title:<关键词> / 裸 glob 匹配源文件路径（目录尾 / 前缀匹配）
// Phase 2 扩展：会话内容中的 files_mentioned 匹配（依赖元数据提取）
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
  title: string | null;
  sourceFile: string;
}

export function isSessionBlocked(patterns: string[], t: IgnoreTarget): boolean {
  const filePosix = t.sourceFile.replace(/\\/g, '/');
  for (const raw of patterns) {
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
