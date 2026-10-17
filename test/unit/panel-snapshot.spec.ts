// 面板取数内核（panel/*）的回归测试
//
// 这组用例钉住三件事：
//   ① **零依赖**：store/lesson-gate.ts 不许有任何 import（面板宿主半零原生依赖的前提）；
//   ② **判据只有一份**：面板报的"能进注入层"必须与 isInjectable 完全一致；
//   ③ 写入只走已知旋钮，非法的整批拒绝（点错一次不该毁配置）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb } from '../../src/store/db.js';
import { dbFile, relayDir, configFile } from '../../src/shared/paths.js';
import { panelProjectCard, panelCompression, panelConfigView, panelApplyConfig } from '../../src/panel/snapshot.js';
import { KNOB_SPECS, validateKnob, getPath } from '../../src/panel/knobs.js';

let root: string;

function seedProject(n: number): void {
  fs.mkdirSync(relayDir(root), { recursive: true });
  const db = createDb(dbFile(root));
  for (let i = 0; i < n; i++) {
    db.prepare('INSERT INTO sessions (id, source, source_session_id, project_id, origin, state, created_at, last_event_at, message_count, decisions, key_questions, extracted_version)'
      + ' VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(
      's' + i, 'dsh', 'src' + i, 'proj_x', 'auto', 'confirmed',
      '2026-10-01T00:00:00Z', '2026-10-0' + ((i % 9) + 1) + 'T00:00:00Z', 3,
      JSON.stringify(i === 0
        ? [{ text: 'a', dupCount: 3 }, { text: 'b' }]
        : [{ text: 'd' + i }]),
      // 未决项必须带 unresolved:true：面板未决计数的判据是 `$.unresolved <> 0`
      //（那次 686→55 的修复把"全部 key_questions"改成"只数真未决"）。夹具原先是裸 {text}，
      // 于是这条用例在修复后恒为 0 —— 不是计数坏了，是夹具没跟上判据。
      JSON.stringify([{ text: 'q' + i, unresolved: true }]), 20);
    db.prepare('INSERT INTO messages (session_id, role, content, seq_num) VALUES (?,?,?,?)').run('s' + i, 'user', 'hello', 1);
  }
  db.close();
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'srelay-panel-'));
});
afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 清理失败不影响判据 */ } });

describe('面板 · 零依赖纪律', () => {
  it('store/lesson-gate.ts 不许有任何 import（否则面板会被原生模块拖住）', () => {
    const src = fs.readFileSync(fileURLToPath(new URL('../../src/store/lesson-gate.ts', import.meta.url)), 'utf8');
    const imports = src.split(/\r?\n/).filter((l) => /^\s*import\b/.test(l));
    expect(imports).toEqual([]);
  });
  it('panel/* 不许 import store/db.ts 或 store/global.ts（那是原生依赖的入口）', () => {
    const dir = fileURLToPath(new URL('../../src/panel/', import.meta.url));
    for (const f of fs.readdirSync(dir)) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      expect(src, f).not.toMatch(/from '.*store\/(db|global)\.js'/);
      expect(src, f).not.toMatch(/from '.*core\/tokenize\//);
    }
  });
});

describe('面板 · 项目卡片', () => {
  it('会话 / 消息 / 结论条目 / 未决条目分别计数', () => {
    seedProject(3);
    const card = panelProjectCard(root);
    expect(card.ok).toBe(true);
    expect(card.sessions).toBe(3);
    expect(card.messages).toBe(3);
    // 第 0 场 2 条结论，另两场各 1 条 ⇒ 4（按**条**算，不是"有结论的会话数"）
    expect(card.decisions).toBe(4);
    expect(card.unresolved).toBe(3);
    expect(card.archived).toBe(0);
    expect(card.dbBytes).toBeGreaterThan(0);
  });
  it('库坏了/不存在时给 error，不抛也不假装是 0', () => {
    const card = panelProjectCard(path.join(root, '不存在'));
    expect(card.ok).toBe(false);
    expect(card.error).toBeTruthy();
  });
});

describe('面板 · 压缩图谱', () => {
  it('L0 现成证据：dupCount 累计出"合并掉的重复条数"', () => {
    seedProject(3);
    const c = panelCompression(root);
    expect(c.ok).toBe(true);
    expect(c.l0?.dupEntries).toBe(1);       // 1 条条目带 dupCount
    expect(c.l0?.merged).toBe(2);           // dupCount=3 ⇒ 合并掉 2 条
    expect(c.l0?.changedSessions).toBe(1);
  });
  it('老化计划的档位与阈值和判据同源（strengthGateOf(30) = 0.667）', () => {
    seedProject(2);
    const c = panelCompression(root);
    expect(c.aging?.hotDays).toBe(30);
    expect(c.aging?.hotGate).toBe(0.667);
    expect(c.aging?.workflowGate).toBe(0.922);
    const total = (c.aging?.strengthBuckets ?? []).reduce((a, b) => a + b.count, 0);
    expect(total).toBe(2);
  });
  it('L1 已启用、L3 默认关 —— 必须如实标出来（不许显示成"都在跑"，也不许显示成"都没做"）', () => {
    seedProject(1);
    const c = panelCompression(root);
    // L1 的变迁记在这里，防止以后有人"凭印象"改回去：
    //   1017：因"省 57% 体积但 hit@1 掉 5~7pt"被否决 → status='rejected'
    //   1021：找到真因（不是合并有损，是代表选择取了 workflow 转述）→ 改 highest-trust
    //         → 实测召回基准逐格不变、music 库 31 条隐形拍板归零 → 接进生命周期并默认开
    //   ⇒ 现在的真实状态是 'on'。断言跟着**事实**走，不跟着某个版本走。
    expect(c.layers.find((l) => l.id === 'L1')?.status).toBe('on');
    // L3 的真实状态是 'off'（**已建成、默认关**），不是 'todo'（未做）：
    // 1018 实测更正过这条描述 —— 代码、note 文案、跑法（srelay compress --dry-run）都在。
    // 本用例原先期望 'todo'，是那个错误描述的残留。
    expect(c.layers.find((l) => l.id === 'L3')?.status).toBe('off');
    // 三种状态必须能区分开：on / off / rejected 不许糊成一个
    const byId = new Map(c.layers.map((l) => [l.id, l.status]));
    expect(byId.get('L0')).toBe('on');
    expect(byId.get('L2')).toBe('on');
    expect(byId.get('P')).toBe('on');
  });
});

describe('面板 · 设置旋钮', () => {
  it('旋钮清单覆盖 RelayConfig 的每一个叶子，且每个都能校验', () => {
    seedProject(1);
    const v = panelConfigView(root);
    expect(v.knobs.length).toBe(KNOB_SPECS.length);
    expect(v.knobs.every((k) => k.source === 'default')).toBe(true);
    // 通用合法值必须落在**每个旋钮自己的区间内**：早先这里写死 1，于是任何 min>1 的旋钮
    // （如 L3 的 compress.min_cluster，min=2）都会假红。不是把 min 放宽（那会失去防护），
    // 而是让探测值跟着旋钮走。
    const legalValue = (k: typeof KNOB_SPECS[number]) => {
      if (k.type === 'boolean') return true;
      if (k.type === 'string-list') return [];
      if (k.type === 'number') return Math.min(Math.max(1, k.min ?? 1), k.max ?? Number.MAX_SAFE_INTEGER);
      return k.options ? k.options[0] : 'x';
    };
    for (const k of KNOB_SPECS) expect(validateKnob(k.path, legalValue(k)), k.path).toBeNull();
  });
  it('校验是唯一入口：越界 / 未知旋钮 / 类型错都拒绝', () => {
    expect(validateKnob('archive.hot_days', 9999)).toContain('不能大于');
    expect(validateKnob('不存在.旋钮', 1)).toContain('未知旋钮');
    expect(validateKnob('search.tokenizer', 'jieba')).toBeNull();
    expect(validateKnob('search.tokenizer', 'meab')).toContain('只能是');
    expect(validateKnob('capture.sources', ['dsh', '不存在'])).toContain('不认识的取值');
  });
  it('写入走 mergeConfig + saveConfig，改完读回来是新值', () => {
    seedProject(1);
    const r = panelApplyConfig(root, { 'archive.hot_days': 45, 'search.tokenizer': 'bigram' });
    expect(r.ok).toBe(true);
    expect(r.changed.sort()).toEqual(['archive.hot_days', 'search.tokenizer']);
    expect(r.warnings.join('')).toContain('重算');       // 换分词器必须提醒重算
    const back = JSON.parse(fs.readFileSync(configFile(root), 'utf8'));
    expect(back.archive.hot_days).toBe(45);
    expect(back.search.tokenizer).toBe('bigram');
    expect(panelConfigView(root).knobs.find((k) => k.path === 'archive.hot_days')?.source).toBe('config');
  });
  it('有一项非法 ⇒ **整批**不写（不做部分成功）', () => {
    seedProject(1);
    const r = panelApplyConfig(root, { 'archive.hot_days': 45, 'capture.mode': '乱写' });
    expect(r.ok).toBe(false);
    expect(r.rejected.length).toBe(1);
    expect(fs.existsSync(configFile(root))).toBe(false);
  });
  it('未声明的旋钮直接拒（防前端拼错路径静默丢配置）', () => {
    seedProject(1);
    expect(panelApplyConfig(root, { 'capture.不存在': 1 }).ok).toBe(false);
  });
  it('默认值表本身自洽：getPath(默认配置, 每个旋钮) 都有值', () => {
    seedProject(1);
    const cfg = JSON.parse(JSON.stringify(panelConfigView(root).knobs.map((k) => [k.path, k.value])));
    for (const [p, v] of cfg as Array<[string, unknown]>) expect(v, p).not.toBeUndefined();
    expect(getPath({ a: { b: 1 } }, 'a.b')).toBe(1);
  });
});
