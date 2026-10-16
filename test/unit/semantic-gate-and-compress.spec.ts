// 「开关只判一处」的**机器判据**（调研件 §3.2 纪律 3）
//
// 为什么需要它：本项目实测栽过两次同型事故 ——
//   · lengthNorm 的开关只关了主路、没关融合路 ⇒ 对照组是脏的；
//   · semantic 的开关若判在 semanticSearch 里而不是 getEmbedder 里，
//     related.ts 就会在"关掉之后继续跑语义"（它自己调 getEmbedder，不经过 semanticSearch）。
// 靠人眼守不住，所以写成测试：故意在别处加一处判断，这条必须变红。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('语义档 · 开关只判一处', () => {
  it('全仓读 semantic.enabled 的地方只许有两处：闸门 + 运维分支', () => {
    const hits: string[] = [];
    for (const f of walk(SRC)) {
      const rel = path.relative(SRC, f).replace(/\\/g, '/');
      const src = fs.readFileSync(f, 'utf8');
      src.split('\n').forEach((line, i) => {
        if (!/semantic\??\.enabled/.test(line)) return;
        if (/^\s*(\/\/|\*)/.test(line)) return;          // 注释不算
        hits.push(rel + ':' + (i + 1) + ' ' + line.trim());
      });
    }
    // 判据要分两类，混在一起写会写出**假的严格**：
    //   ① **决定"跑不跑推理"** 的判据 —— 全仓只许有一处：semantic.ts 的 getEmbedder（唯一闸门）。
    //   ② **只显示/只写配置** 的地方 —— 它们不决定推理，但必须**登记在册**（否则新加的第三处没人知道）。
    // 我第一版把两类合成一个白名单，结果 doctor/status/knobs 被判越界 —— 那不是它们错，
    // 是判据写得比事实严（假红会让下一个人直接删掉这条测试，比没有更糟）。
    const GATE = 'search-svc/semantic.ts';
    const DISPLAY_ONLY: Record<string, string> = {
      'cli/semantic.ts': '运维分支：enable/disable/status 的显示与写配置，不决定推理',
      'cli/doctor.ts': '诊断显示：报"启用了但依赖缺失/上次装载失败"',
      'cli/status.ts': '状态面板显示',
      'panel/knobs.ts': '旋钮声明（不是判据，是配置清单）',
      'panel/snapshot.ts': '面板取数里的说明文字',
    };
    const offenders = hits.filter((h) => {
      const file = h.split(':')[0];
      return file !== GATE && !(file in DISPLAY_ONLY);
    });
    expect(offenders, '开关出现了**新的**判据 —— 要么改用 getEmbedder()，要么来 DISPLAY_ONLY 登记').toEqual([]);
    // 白名单本身也要防漂移：登记的文件必须真的还在读它（否则就是一条永远绿的死规则）
    for (const file of Object.keys(DISPLAY_ONLY)) {
      expect(hits.some((h) => h.startsWith(file + ':')), file + ' 已不再读开关，把它从 DISPLAY_ONLY 删掉').toBe(true);
    }
    expect(hits.length, '闸门本身必须还在（否则这条测试就永远绿了）').toBeGreaterThan(0);
  });

  it('related.ts 不许自己读开关（它必须只经 getEmbedder）', () => {
    const src = fs.readFileSync(path.join(SRC, 'search-svc', 'related.ts'), 'utf8');
    expect(/semantic\??\.enabled/.test(src), 'related.ts 读开关 = 关掉之后它还会跑语义').toBe(false);
  });
});

describe('L3 压缩 · 边界（建设方案 §2.1）', () => {
  it('compress 与 semantic 是**两套配置**，不许互相读', async () => {
    const model = await import('../../src/core/compact/model.js');
    const cfg = { semantic: { enabled: true, model: 'x' }, compress: { enabled: true, model: 'y' } };
    const p = model.compressPolicyOf(cfg as never);
    expect(p.model, '压缩模型不许从 semantic 块取').toBe('y');
    // 反向：没有 compress 块时不许回落到 semantic 的模型
    const p2 = model.compressPolicyOf({ semantic: { model: 'x' } } as never);
    expect(p2.model).toBe('');
    expect(p2.enabled).toBe(false);
  });

  it('默认关（默认档零模型是项目底线）', async () => {
    const model = await import('../../src/core/compact/model.js');
    expect(model.compressPolicyOf({} as never).enabled).toBe(false);
    expect(model.compressPolicyOf(null).enabled).toBe(false);
    expect(model.compressBlockedBy(model.compressPolicyOf({} as never))).toContain('未启用');
  });

  it('配了开关但没配模型/端点 → **明说原因**，不静默跳过（容错不许静默）', async () => {
    const model = await import('../../src/core/compact/model.js');
    expect(model.compressBlockedBy(model.compressPolicyOf({ compress: { enabled: true } } as never))).toContain('模型');
    expect(model.compressBlockedBy(model.compressPolicyOf({ compress: { enabled: true, model: 'm' } } as never))).toContain('端点');
  });

  it('原文永不删：这条常量恒为 true（不是配置项）', async () => {
    const model = await import('../../src/core/compact/model.js');
    expect(model.KEEP_ORIGINAL_ALWAYS).toBe(true);
  });

  it('抽不出证据就丢弃：没有 evidence 的条目不许进结果', async () => {
    const model = await import('../../src/core/compact/model.js');
    const items = [
      { id: 'a', text: '把热窗从 60 天改成 30 天', at: '2026-10-01' },
      { id: 'b', text: '热窗参数定为 30 天', at: '2026-10-02' },
      { id: 'c', text: '热窗 30 天这个决定作数', at: '2026-10-03' },
    ];
    // 模型给了合并结果但**没给证据** → 丢弃
    const noEv = model.mergeCluster(items, JSON.stringify({ items: [{ text: '热窗定为 30 天' }] }));
    expect(noEv.merged).toEqual([]);
    expect(noEv.discarded).toBe(1);
    // 只回指一条 = 没合并，也没意义 → 丢弃
    const oneEv = model.mergeCluster(items, JSON.stringify({ items: [{ text: '热窗定为 30 天', evidence: ['1'] }] }));
    expect(oneEv.merged).toEqual([]);
    // 回指两条 → 收下
    const ok = model.mergeCluster(items, JSON.stringify({ items: [{ text: '热窗定为 30 天（三条同义）', evidence: ['1', '3'] }] }));
    expect(ok.merged).toHaveLength(1);
    expect(ok.merged[0].evidenceIds).toEqual(['a', 'c']);
  });

  it('模型输出带 markdown 围栏 / 前后废话也能解析（小模型很爱加）', async () => {
    const model = await import('../../src/core/compact/model.js');
    const raw = '好的，结果如下：\n\`\`\`json\n{"items":[{"text":"合并结果","evidence":["1","2"]}]}\n\`\`\`\n希望有帮助！';
    expect(model.parseMerged(raw)).toHaveLength(1);
    expect(model.parseMerged(raw)[0].text).toBe('合并结果');
  });

  it('模型输出不是 JSON → 空结果（不抛）', async () => {
    const model = await import('../../src/core/compact/model.js');
    expect(model.parseMerged('我觉得这组不用合并')).toEqual([]);
    expect(model.parseMerged('')).toEqual([]);
  });

  it('分簇：同主题不同说法能进同一簇，无关条目不进', async () => {
    const model = await import('../../src/core/compact/model.js');
    // 阈值 0.30 是**实测定的**（scripts 里量过）：同主题不同说法 0.29~0.43、不同主题 0.00。
    const items = [
      { id: '1', text: '把归档热窗从 60 天缩短到 30 天，实测省 36.9%', at: '2026-10-01' },
      { id: '2', text: '归档热窗调整为 30 天，agent1super 省 36.9%', at: '2026-10-02' },
      { id: '3', text: '面板左侧加了「记忆台」按钮', at: '2026-10-03' },
    ];
    const cs = model.clusterByTopic(items, 0.30, 2);
    expect(cs).toHaveLength(1);
    expect(cs[0].items.map((x) => x.id).sort()).toEqual(['1', '2']);
  });

  it('提示词把「抽不出证据就丢弃」写进模型侧硬约束', async () => {
    const model = await import('../../src/core/compact/model.js');
    const p = model.buildPrompt([{ id: 'a', text: 'x' }, { id: 'b', text: 'y' }]);
    expect(p).toContain('evidence');
    expect(p).toContain('拿不出证据就不要输出');
    expect(p).toContain('不许推断');
  });
});
