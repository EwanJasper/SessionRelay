# core/decay —— 时间衰减（纯函数，不接线）

把「三个月前的决策」和「今天的决策」在排序上区分开。**只调排序分数，绝不过滤记录。**

## 交付物

| 文件 | 作用 |
|---|---|
| `decay.ts` | 唯一判据：按类别分半衰期的衰减系数 + 排序辅助。**零 import**（面板宿主无原生模块，必须能直接 import） |
| `decay.test.mjs` | node --test 单测，20 条，钉住默认值/公式/保底/容错/零依赖 |
| `decay-control.mjs` | 对照实验：跑真库，证明"同一批候选衰减前后 100% 保留，只有排名变化" |
| `README.md` | 本文件（设计理由 + 实测数字 + 负结果） |

## 接口

```ts
decayFactor(ageMs, kind, opts?)            // → (0,1] 的乘数（绝不返回布尔）
decayFactorDetailed(ageMs, kind, opts?)    // 同上 + 半衰期/是否触保底/不衰减原因（note）
applyDecay(score, ageMs, kind, opts?)      // score × 系数；score<=0 原样返回（防方向反转）
rankByDecayedScore(cands, opts?)           // 同一批候选给出「不衰减/衰减后」两套名次
ageMsOf(at, now?)                          // ISO/epoch/Date → 年龄；坏时间戳 → null（不惩罚）
resolveDecayConfig(raw?) / decayConfigWarnings(raw)  // 配置默认值与逐条校验
DEFAULT_DECAY / DEFAULT_HALF_LIFE_DAYS / DecayConfig // 给 RelayConfig 用的唯一默认值来源
```

## 默认值（Lead 实测后再定，先给保守值）

| 字段 | 默认 | 理由 |
|---|---|---|
| enabled | **false** | 项目规则 1「先量再接」：默认档不带未实测量程的效应；开/关只有一个布尔可解释 |
| mode | exponential | exp(-λt)，λ=ln2/半衰期 |
| decision | 90 天 | 一个季度前的技术决策通常仍在生效；更老的多数已被新决策覆盖（supersede 另有判据） |
| negative | 180 天 | 负结果是「试过不行」；衰减快了就有人把同一条死路再走一遍（ADR-001：负结果比正结果重要） |
| question | **null（不衰减）** | 未决问题是欠条：欠得越久越该被看见，让时间压下去 = 让"没人回答过的问题"静默消失 |
| lesson | 180 天 | 经验是已沉淀的判据，衰减慢于决策 |
| floor | 0.25 | 正好是 2 个半衰期的自然值：保底打两折。老但强的记录仍能压过新但弱的 |
| alpha | 1 | 仅 power 模式；幂律仍以半衰期处 =1/2 定义，换模式参数才有可比性 |

## 先量的基线（改之前）

1. 生产排序**完全没有时间项**：`src/search-svc/engine.ts` 的分数只有 -bm25 + message_count 惩罚；
   决策简报是 `ORDER BY created_at DESC`（纯时间序）。所以"三个月前的权重一样"成立。
2. 真库（`D:/agent1super/.sessionrelay/relay.sqlite`，只读实测）：
   - 863 条决策（491 decision / 372 negative），年龄 p50 **35.1 天**、p90 57.2 天、**最大 66.1 天**
   - 67 条未决问题，**最老 66 天，≥90 天的 0 条**
   - 全局经验 17 条，全部 <7 天
   ⇒ **"三个月前"的场景在当前库里还没出现**（库只有 66 天）。
   所以上线后线上差异小是预期的，不是 bug；真实效果要靠时间老化或人造长龄样本（对照脚本已覆盖 180/365/1095/3650 天）。
   顺带一个可用于定默认值的数：90 天半衰期在 66 天的记录上只打到 0.601，不会把任何东西埋掉。

## 实测对照（`node src/core/decay/decay-control.mjs`）

查询代理「sqlite」（153 条命中：decision 63 / negative 83 / question 3 / lesson 4）：

- 候选 153 → 153，**id 逐一相同（含重复重数）**；衰减后最小分 0.6012（>0）；
- 关掉衰减时 rankWith===rankWithout（开关确实作用于全部路径）；
- ≥60 天老记录 15 条**全部仍在结果里**；最老一条 66.1 天：名次 94 → 153（系数 0.601）；
- top-10 换血 1 条，平均名次移动 38.3 位，**top-10 平均年龄 22.6 → 17.8 天**（变新 4.8 天）；
- 人造长龄：3 年强相关（2.50）仍压过今天弱相关（1.00）；10 年记录被 floor 兜住（0.250）但**仍在结果里**；
- 未决问题 10 年系数 = 1.000；负结果 180 天系数 0.500 > 决策 0.250。

## 负结果 / 边界（比正结果重要）

1. **未决问题默认不衰减**是刻意选择，不是漏配。若 Lead 实测发现"三年前的孤儿问句仍压住今天的"，改
   `DEFAULT_HALF_LIFE_DAYS.question = 365` 一处即可；不要改成 filter。
2. **与 `store/lesson-gate.ts` 的边界（必须二选一）**：那里已有 `DECAY_PER_DAY=0.0083` 的**线性**年龄扣分，
   输出是"够不够注入阈值"的**判决**（会让老条目掉出注入层）。本模块是**乘性排序**，语义是"排后面"而非"消失"。
   两者不是一份判据的两份副本，但**会叠加**：若经验排序接本模块、注入闸门仍用 lesson-gate 的线性扣分，
   就是双倍衰减。建议把 lesson-gate 的年龄项换成这里的指数项（改 store/ 不属本任务范围，Lead 决定）。
3. **非正分数不缩放**：若调用方传的是 bm25 原值（负数），乘 <1 的系数会把负数推向 0 = 反而加分，
   出现"越老越靠前"的方向反转。这里原样返回并在 note 说明，绝不猜调用方的分数尺度。
4. **幂律不是"无限自由"**：power 模式用 `(1+a·t)^-α, a=(2^(1/α)-1)/H` 定义，保证 f(H)=1/2；
   否则两种模式的分母含义不同，参数扫描会得出错误结论。

## 接线片段（Lead 用）

```ts
// shared/config-merge.ts
import { DecayConfig, defaultDecayConfig, resolveDecayConfig } from '../core/decay/decay.js';
export interface RelayConfig { /* ... */ decay?: DecayConfig; }
// defaultConfig(): decay: defaultDecayConfig(),
// mergeConfig():   decay: resolveDecayConfig((raw.decay ?? {}) as Record<string, unknown>),

// 排序处（决策简报/会话检索），先取值再乘 —— 没有任何过滤分支：
const cfg = loadConfig(root).decay;
const ranked = rankByDecayedScore(candidates, cfg); // candidates: {id, score, ageMs, kind}
```

配置加载处记得把 `decayConfigWarnings(raw.decay)` 打到日志，否则配置写错会静默退化成默认值。

## 跑法

```bash
cd core/SessionRelay
node --test src/core/decay/decay.test.mjs      # 20/20
node src/core/decay/decay-control.mjs          # PASS / FAIL（可当守门用例）
node node_modules/typescript/bin/tsc --noEmit  # 类型零错
```

⚠️ 六门说明：`vitest.config.ts` 的 include 是 `test/**/*.spec.ts`，**不会收集本目录的测试**
（写作用域限制，不能往 test/unit 放文件）。所以 `node tools/ses-rebuild.mjs` 的六门**不覆盖**这套单测。
建议 Lead 接线时把上面第二、三行加进守门（或把 `decay.test.mjs` 挪到 test/unit 并改 import）。

本次实测状态：`node tools/check-invariants.mjs` 全绿（本模块未触发任何一条静态不变量）；
未跑完整 ses-rebuild —— 因为 graph-recall / extract-v2 此刻正在写 search-svc / extract，
重建会把他们的半成品打进 dist 并重启共享守护，留给接线后统一跑。
