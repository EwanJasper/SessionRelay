// B 档 scope.json（方针 §6.4）：项目级共享的范围契约，类似 .gitignore
import fs from 'node:fs';
import path from 'node:path';
import type { ScopePredicate } from './evaluator.js';
import { relayDir } from '../../shared/paths.js';

export interface ScopeFile {
  version: '1.0';
  mode: 'predicate' | 'full';
  filters: ScopePredicate;
  issued_at: string;
  issued_by?: string;
}

export function scopeFilePath(root: string): string {
  return path.join(relayDir(root), 'scope.json');
}

export function loadScopeFile(root: string): ScopeFile | null {
  try {
    return JSON.parse(fs.readFileSync(scopeFilePath(root), 'utf8')) as ScopeFile;
  } catch {
    return null;
  }
}

export function saveScopeFile(root: string, sf: ScopeFile): void {
  const file = scopeFilePath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(sf, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

export function resetScopeFile(root: string): void {
  try { fs.rmSync(scopeFilePath(root), { force: true }); } catch { /* 忽略 */ }
}

/** scope set：整体替换（--full = 逃生口，只解除 A/B/C 裁剪，ignore 永不受影响——方针 D5） */
export function makeScopeFile(filters: ScopePredicate, opts?: { full?: boolean; by?: string }): ScopeFile {
  return {
    version: '1.0',
    mode: opts?.full ? 'full' : 'predicate',
    filters: opts?.full ? {} : filters,
    issued_at: new Date().toISOString(),
    issued_by: opts?.by,
  };
}

/** scope add：合并（数组并集，标量覆盖） */
export function mergeFilters(a: ScopePredicate, b: ScopePredicate): ScopePredicate {
  const union = (x?: string[], y?: string[]) =>
    x || y ? [...new Set([...(x ?? []), ...(y ?? [])])] : undefined;
  return {
    topics: union(a.topics, b.topics),
    tags: union(a.tags, b.tags),
    files: union(a.files, b.files),
    sources: union(a.sources, b.sources),
    since: b.since ?? a.since,
    until: b.until ?? a.until,
    sessionIds: union(a.sessionIds, b.sessionIds),
    mode: b.mode ?? a.mode,
  };
}
