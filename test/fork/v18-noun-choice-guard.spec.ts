// [v18 回归] 名词化的「选择X」（选择器/选择题/选择框…）不是拍板，除非后面紧跟变更动词。
//
// 病历：DECISION_STRONG 的「选择」分支不看词边界 ——「选择器是旧的」这种界面排障名词被判成决策入库。
// 实测（两库全量、唯一化）：主库 83 条、对照库 14 条；4 字窗口规则下主库消失 77/保留 6、对照库消失 11/保留 3，
// 且保留的 3 条对照库条目全是真决策（含 selftest §10 的置顶夹具）。
//
// 双向断言：该杀的杀（噪声）+ 该留的必须留（名词作主语的真决策、以及非名词化的正常用法）。
import { describe, it, expect } from 'vitest';
import { extractDecisions } from '../../src/core/extract/extract.js';
import type { Msg } from '../../src/core/extract/extract.js';

const m = (content: string): Msg => ({ role: 'user', content, seqNum: 1, createdAt: '2026-10-15T00:00:00Z' });
const one = (s: string) => extractDecisions([m(s)]).map((d) => d.text);

describe('[v18] 名词化「选择X」守卫', () => {
  it('① 界面排障里的名词不再入库', () => {
    expect(one('选择器是旧的')).toEqual([]);
    expect(one('选择题，它回你一个概率')).toEqual([]);
    expect(one('选择框还没弹出')).toEqual([]);
    expect(one('选择器里能看到什么')).toEqual([]);
  });

  it('② 名词作主语的真决策必须留下（4 字窗口内的变更动词）', () => {
    // ⚠️ 夹具别以「（全局）」收尾：plausibleDecision 的配对检查在**尾部剥标点之后**跑，
    // 单独一条「…（全局）」会被剥掉 `）` 变成不配对 → 被既有守卫拒收（我第一版夹具就栽在这）。
    // 真实语料里这句话后面还有「，subagent/agent-teams/deep_research 各自独立」，括号是配平的。
    expect(one('选择器改当前会话与 settings.yaml 的 agent-default-model，各 agent 独立')).toHaveLength(1);
    expect(one('选择器要放宽')).toHaveLength(1);
    expect(one('选择器里就能切 low / medium / high 三档了')).toHaveLength(1);
  });

  it('③ 非名词化的正常用法一条都不许误杀', () => {
    expect(one('选择 PostgreSQL 作为主库')).toHaveLength(1);
    expect(one('改用 node:sqlite 直查 SQL，不再起子进程')).toHaveLength(1);
    expect(one('决定把前端构建工具换成 Vite')).toHaveLength(1);
  });

  it('④ 名词出现在**句中**不被本守卫处理（只认匹配开头）', () => {
    // 「改为」在句首触发；后面的「选择器」是宾语的一部分，不属于名词化误命中
    const got = one('改为在选择器里直接切换模型档位');
    expect(got).toHaveLength(1);
  });
});
