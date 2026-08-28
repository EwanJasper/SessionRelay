// Scope 装配（方针 §6.4 交集语义 / 技术方案 §3.4）：
// CLI：B ∩ call（人自己管时间窗）；MCP：B ∩ call ∩ A（auto-scope 兜底）
// 逃生口：任一档 mode:'full' → 丢弃 A/B/C 裁剪（ignore 永在，由捕获层硬边界执行）
import type { RelayConfig } from '../../shared/config.js';
import type { ScopePredicate, ScopedWhere } from './evaluator.js';
import { buildScopeFilter } from './evaluator.js';
import { loadScopeFile, type ScopeFile } from './scopeFile.js';

export function autoPredicate(cfg: RelayConfig, now = new Date()): ScopePredicate | null {
  if (cfg.search.auto_days <= 0) return null;
  return { since: new Date(now.getTime() - cfg.search.auto_days * 86400_000).toISOString() };
}

export interface AssembleResult {
  where: ScopedWhere | null;
  scopeFile: ScopeFile | null;
  escaped: boolean; // 是否处于 full 逃生口
  auto: ScopePredicate | null;
}

export function assembleScope(i: {
  root: string;
  cfg: RelayConfig;
  callPred?: ScopePredicate | null;
  includeAuto: boolean; // MCP=true, CLI=false
  now?: Date;
}): AssembleResult {
  const sf = loadScopeFile(i.root);
  const escaped = sf?.mode === 'full' || i.callPred?.mode === 'full';
  const b = escaped || !sf ? null : sf.filters;
  const a = escaped || !i.includeAuto ? null : autoPredicate(i.cfg, i.now);
  const where = buildScopeFilter({ b, call: escaped ? null : (i.callPred ?? null), a });
  return { where, scopeFile: sf, escaped, auto: a };
}
