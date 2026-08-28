// Scope 谓词与求值器（方针 §6.4 / 技术方案 §3.4，规格模式）：
// 交集语义（方针 D5）：scope.json(B) ∩ 调用参数 ∩ auto-scope(A)，只能互相收窄；
// 唯一放行通道 mode:'full'（set_scope 逃生口）——丢弃 A/B/C 裁剪，但 ignore 永在。
export interface ScopePredicate {
  topics?: string[];
  tags?: string[];
  files?: string[];
  sources?: string[];
  since?: string;
  until?: string;
  sessionIds?: string[];
  mode?: 'predicate' | 'full';
}

export interface ScopedWhere {
  sql: string; // 引用 sessions 别名 s 的参数化片段
  params: unknown[];
}

export interface CompileOptions {
  /**
   * 排除语义（.sessionrelayignore 用）：命中任一维度即排除 → NOT (f1 OR f2 ...)。
   * Spike 修正：ignore 若按包含语义编译，敏感会话反而通过过滤（方针 D5 的实现细节）。
   */
  negate?: boolean;
}

export function escapeLikePrefix(p: string): string {
  return p.replace(/[\\%_]/g, (ch) => `\\${ch}`) + '%';
}

/** 谓词 → SQL 片段；mode:'full' 或空谓词返回 null（无约束）。ignore 谓词用 negate 编译为排除片段。 */
export function compilePredicate(p: ScopePredicate | null | undefined, opts: CompileOptions = {}): ScopedWhere | null {
  if (!p) return null;
  const frags: string[] = [];
  const params: unknown[] = [];

  if (p.topics?.length) {
    frags.push(
      `(s.topics IS NOT NULL AND EXISTS (SELECT 1 FROM json_each(s.topics) WHERE json_each.value IN (${p.topics.map(() => '?').join(',')})))`,
    );
    params.push(...p.topics);
  }
  if (p.tags?.length) {
    frags.push(
      `(s.user_tags IS NOT NULL AND EXISTS (SELECT 1 FROM json_each(s.user_tags) WHERE json_each.value IN (${p.tags.map(() => '?').join(',')})))`,
    );
    params.push(...p.tags);
  }
  if (p.files?.length) {
    const likes = p.files.map(() => `json_each.value LIKE ? ESCAPE '\\'`).join(' OR ');
    frags.push(`(s.files_mentioned IS NOT NULL AND EXISTS (SELECT 1 FROM json_each(s.files_mentioned) WHERE ${likes}))`);
    params.push(...p.files.map(escapeLikePrefix));
  }
  if (p.sources?.length) {
    frags.push(`s.source IN (${p.sources.map(() => '?').join(',')})`);
    params.push(...p.sources);
  }
  if (p.since) {
    frags.push('s.created_at >= ?');
    params.push(p.since);
  }
  if (p.until) {
    frags.push('s.created_at <= ?');
    params.push(p.until);
  }
  if (p.sessionIds?.length) {
    frags.push(`s.id IN (${p.sessionIds.map(() => '?').join(',')})`);
    params.push(...p.sessionIds);
  }

  if (frags.length === 0) return null;
  if (opts.negate) {
    return { sql: `NOT (${frags.join(' OR ')})`, params };
  }
  return { sql: `(${frags.join(' AND ')})`, params };
}

/** 交集 = AND 连接（顺序：ignore 永远排第一位） */
export function intersect(...ws: Array<ScopedWhere | null>): ScopedWhere | null {
  const valid = ws.filter((w): w is ScopedWhere => w !== null);
  if (valid.length === 0) return null;
  return { sql: valid.map((w) => w.sql).join(' AND '), params: valid.flatMap((w) => w.params) };
}

export interface ScopeAssemblyInput {
  /** 隐私硬边界：永不因 full 逃生口被移除（方针 D5） */
  ignore?: ScopePredicate | null;
  /** B 档：scope.json 项目契约 */
  b?: ScopePredicate | null;
  /** 调用时参数（MCP tool / CLI flag），只能收窄 */
  call?: ScopePredicate | null;
  /** A 档：auto-scope 兜底（cwd/branch/近 N 天） */
  a?: ScopePredicate | null;
}

/**
 * `_scoped_where()`（方针 Phase 0 S4 出口标准）：
 * 生效范围 = ignore ∩ (escape ? 空 : B ∩ call ∩ A)；escape = 任一档声明 mode:'full'。
 */
export function buildScopeFilter(input: ScopeAssemblyInput): ScopedWhere | null {
  const ignoreFrag = compilePredicate(input.ignore ?? null, { negate: true });
  const escaped = input.b?.mode === 'full' || input.call?.mode === 'full';
  const bodyFrag = escaped
    ? null
    : intersect(compilePredicate(input.b), compilePredicate(input.call), compilePredicate(input.a));
  return intersect(ignoreFrag, bodyFrag);
}
