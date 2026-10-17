// 地图层 · 从「依赖」文本推出分层 + 真边（纯函数，不碰磁盘）。
//
// 为什么需要它（用户 2026-10-18）：自动孵化出来的图是**单层**的，而地图不变式要求边
//   **严格跨层向下** ⇒ 单层图上一条边都加不了。所以「建边」的前提是先有层带；
//   而层带不能凭空分，只能**从依赖关系本身推**：不依赖别人的沉到底层，依赖别人的往上抬。
//   拓扑分层同时解决三件事：多层、真边、天生无环。
//
// 三条纪律（和地图层同源）：
//   ① **匹配不上就不建边** —— 硬猜出来的边比没有边更糟（假边会让人顺着假依赖走错路）；
//   ② **认不准就不建边** —— 一个片段命中多个节点 ⇒ 记为歧义，跳过；
//   ③ **有环就整体拒绝** —— 绝不悄悄丢一条边凑出无环来。

/** 依赖列的空白写法（唯一一份）：这些都不算依赖。 */
const NO_DEP_RE = /^(无|没有|暂无|不需要|none|nil|n\/?a|-+|–|—+|\.+)$/i;

/** 「上方全部 ✅ 项」这类相对表达：依赖它**前**面所有已完成的项。 */
const REL_UP_ALL_RE = /^(上方|以上|上面|上边|前文|之前|前面)/;
const REL_ALL_RE = /(全部|所有|整体)/;

export type PlanDep = { id: string; label: string; dep: string };
export type PlanLayer = { id: string; name: string; rank: number };
export type PlanNode = { id: string; label: string; layer: string; status: string; detail?: string };
export type PlanEdge = { from: string; to: string };

export type PlanLayout = {
  layers: PlanLayer[];
  nodes: PlanNode[];
  edges: PlanEdge[];
  /** 依赖片段里指不到任何节点的（原样报出，绝不静默丢）。 */
  unresolved: string[];
  /** 一个片段同时命中多个节点、只好放弃的。 */
  ambiguous: string[];
};

export type BuiltPlan =
  | { ok: true; layout: PlanLayout }
  | { ok: false; code: 'CYCLE'; msg: string; cycle: string[] };

/** 把一格依赖文本切成片段。返回 upAll 表示「依赖上方全部已完成项」。 */
export function parseDepText(text: string): { frags: string[]; upAll: boolean } {
  const t = String(text ?? '').replace(/[\*`"]/g, '').trim();
  // 整串先判一次：`N/A` 里有 `/`，不先判就会被切成 N 和 A 两个片段（实测踩到）
  if (t === '' || NO_DEP_RE.test(t)) return { frags: [], upAll: false };
  if (REL_UP_ALL_RE.test(t) && REL_ALL_RE.test(t)) return { frags: [], upAll: true };
  const frags = t
    .split(/[,，/、;；|]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 1 && !NO_DEP_RE.test(s)); // 单字**不在这里丢**——中文任务名常常就一个字，把关交给匹配层（见 matchNodes）
  return { frags, upAll: false };
}

/**
 * 片段 → 节点 id。双向子串：`db.ts` 命中 `db.ts 迁移`，也命中 `重写 db.ts`。
 *
 * **单字片段只认完全同名**（2026-10-18 实测踩到）：`乙` 该命中节点「乙」，
 *   而 `库` 不该命中「库体积回收」——一个汉字能是任何东西的一部分，做子串匹配全是噪声。
 *   两个以上字符才允许子串（`索引` 命中「建索引」是合理的）。
 */
function matchNodes(frag: string, deps: PlanDep[]): string[] {
  const hits: string[] = [];
  for (const n of deps) {
    if (n.label === '') continue;
    if (frag.length === 1) {
      if (n.label === frag) hits.push(n.id);
      continue;
    }
    if (n.label.includes(frag)) { hits.push(n.id); continue; }
    if (frag.length >= 4 && frag.includes(n.label)) { hits.push(n.id); continue; }
  }
  return hits;
}

/** 最长路径定层：无依赖 = rank 0，其余 = 1 + max(依赖者的 rank)。顺带查环。 */
function rankByLongestPath(
  order: string[],
  uses: Map<string, string[]>,
): { ok: true; rank: Map<string, number> } | { ok: false; cycle: string[] } {
  const rank = new Map<string, number>();
  const state = new Map<string, number>(); // 1 = 正在走（灰色），2 = 走完
  const stack: string[] = [];
  const visit = (id: string): { ok: true } | { ok: false; cycle: string[] } => {
    const st = state.get(id) ?? 0;
    if (st === 2) return { ok: true };
    if (st === 1) {
      const at = stack.indexOf(id);
      return { ok: false, cycle: [...stack.slice(at < 0 ? 0 : at), id] };
    }
    state.set(id, 1);
    stack.push(id);
    let r = 0;
    for (const d of uses.get(id) ?? []) {
      const sub = visit(d);
      if (!sub.ok) return sub;
      r = Math.max(r, (rank.get(d) ?? 0) + 1);
    }
    stack.pop();
    state.set(id, 2);
    rank.set(id, r);
    return { ok: true };
  };
  for (const id of order) {
    const v = visit(id);
    if (!v.ok) return v;
  }
  return { ok: true, rank };
}

/** 单层骨架的层 id（与历史孵化的图一致，升级时不必改名）。 */
export const PLAN_LAYER_ID = 'plan';
/** 只有一层时的层名 —— 就是历史那个名字，**多一层都不该叫这个**（它会暗示已经分好层了）。 */
export const PLAN_LAYER_NAME_SINGLE = '计划（自 progress.md 导入）';

/** rank → 层 id。rank 0 沿用 `plan`（已孵化的图就长这样，升级时不必改名）。 */
export function layerIdOfRank(rank: number): string {
  return rank === 0 ? PLAN_LAYER_ID : 'plan-' + String(rank);
}

/** rank → 层名。`single` = 这张图根本没有边（退化成单层），这时别用分层的话术骗人。 */
export function layerNameOfRank(rank: number, single = false): string {
  if (rank !== 0) return '计划·第 ' + String(rank) + ' 阶';
  return single ? PLAN_LAYER_NAME_SINGLE : '计划·底层（不依赖任何任务）';
}

/**
 * 主入口：拿「节点 + 各自依赖文本」推一张分层图。
 * 没有任何可解析的依赖 ⇒ 返回单层 + 0 边（保持孵化原有的保守行为，绝不为了有边而造边）。
 */
export function buildPlanLayout(
  deps: PlanDep[],
  meta: Map<string, { status: string; detail?: string }>,
): BuiltPlan {
  const uses = new Map<string, string[]>();
  const unresolved: string[] = [];
  const ambiguous: string[] = [];
  const doneBefore: string[] = [];
  for (const n of deps) {
    const parsed = parseDepText(n.dep);
    const picked = new Set<string>();
    if (parsed.upAll) {
      for (const d of doneBefore) picked.add(d);
    } else {
      for (const frag of parsed.frags) {
        const hits = matchNodes(frag, deps).filter((id) => id !== n.id);
        if (hits.length === 1) picked.add(hits[0]);
        else if (hits.length === 0) unresolved.push(n.label + ' ← ' + frag);
        else ambiguous.push(n.label + ' ← ' + frag + '（命中 ' + String(hits.length) + ' 个）');
      }
    }
    uses.set(n.id, [...picked]);
    if (meta.get(n.id)?.status === 'done') doneBefore.push(n.id);
  }
  const order = deps.map((d) => d.id);
  const ranked = rankByLongestPath(order, uses);
  if (!ranked.ok) {
    const labels = ranked.cycle.map((id) => deps.find((d) => d.id === id)?.label ?? id);
    return {
      ok: false, code: 'CYCLE', cycle: ranked.cycle,
      msg: '依赖列绕成了环，拒绝建图（绝不悄悄丢一条边凑出无环）：' + labels.join(' → '),
    };
  }
  const edges: PlanEdge[] = [];
  for (const n of deps) {
    for (const to of uses.get(n.id) ?? []) edges.push({ from: n.id, to });
  }
  const maxRank = edges.length === 0 ? 0 : Math.max(...order.map((id) => ranked.rank.get(id) ?? 0));
  const layers: PlanLayer[] = [];
  const single = edges.length === 0;
  for (let r = 0; r <= maxRank; r++) layers.push({ id: layerIdOfRank(r), name: layerNameOfRank(r, single), rank: r });
  const nodes: PlanNode[] = deps.map((d) => {
    const m = meta.get(d.id) ?? { status: 'planned' };
    return {
      id: d.id, label: d.label,
      layer: layerIdOfRank(ranked.rank.get(d.id) ?? 0),
      status: m.status,
      ...(m.detail !== undefined && m.detail !== '' ? { detail: m.detail } : {}),
    };
  });
  return { ok: true, layout: { layers, nodes, edges, unresolved, ambiguous } };
}
