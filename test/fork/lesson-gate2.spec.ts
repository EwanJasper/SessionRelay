// 经验层「闸 2 判据 + 可见性」的收口回归（红队 A-5 / B-6 / B-7 的整改）
//
// 这四条曾经分别在三个面里各写一遍（核心库 / DSH 插件 / ZCode hook），抄完就漂移：
//   · 闸 2 用大小写敏感的 includes ⇒ 正文写 MAX_CHARS、FTS5、RRF 的经验**永远命中不了**；
//   · hook 自己发明了"中文 2 字滑窗 + 任一 bigram 命中即相关" ⇒ 写诗题注入了不相干决策；
//   · 插件缺 domain 分支、hook 缺 workspace 分支 ⇒ --scope domain 的经验两端都不出现。
// 现在判据只有一份（store/global.ts 的 gate2Score / visibleWhere），这个文件把它钉住。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openGlobal, addLesson, pickForInjection, gate2Score } from '../../src/store/global.js';
import { resolveDomain, resolveWorkspaceId, workspaceKey } from '../../src/shared/workspace.js';
import { findRelayRootInfo } from '../../src/shared/paths.js';
import { isTransientRoot } from '../../src/shared/registry.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ses-gate2-'));
const mk = () => openGlobal(path.join(tmp, Math.random().toString(36).slice(2) + '.sqlite'));
const V = { grade: 'verified-tool' as const, sourceRef: 'x:1' };

describe('[1016 收口] 闸 2：大小写', () => {
  it('正文写大写的 ASCII 标识符，query 也必须命中（旧实现恒不中）', () => {
    const db = mk();
    addLesson(db, { text: '简报名额 MAX_CHARS 是 1200', scope: 'global', ...V });
    expect(pickForInjection(db, { workspaceId: '/p', query: 'MAX_CHARS' }).length).toBe(1);
    expect(pickForInjection(db, { workspaceId: '/p', query: 'max_chars' }).length).toBe(1);
    // 但大小写归一不能变成"什么都算命中"
    expect(pickForInjection(db, { workspaceId: '/p', query: 'FTS5 是什么' })).toEqual([]);
    db.close();
  });

  it('RRF / FTS5 这类标识符：两侧任意大小写都能对上', () => {
    const db = mk();
    addLesson(db, { text: 'RRF 多路融合会放大巨型会话的优势', scope: 'global', ...V });
    expect(gate2Score('rrf', 'RRF 多路融合会放大巨型会话的优势').score).toBeGreaterThan(0);
    expect(gate2Score('用 rrf 融合排序会更好吗', 'RRF 多路融合会放大巨型会话的优势').score).toBeGreaterThan(0);
    expect(pickForInjection(db, { workspaceId: '/p', query: '用 rrf 融合排序会更好吗' }).length).toBe(1);
    db.close();
  });
});

describe('[1016 收口] 闸 2：不许把偶然重合判成相关（红队 B-7）', () => {
  it('写诗题 / 寒暄题整段静默（旧 hook 会注入 1~2 条不相干决策）', () => {
    const db = mk();
    addLesson(db, { text: '换成我写的 watch-zen-gate.ps1', scope: 'global', ...V });
    addLesson(db, { text: '决定了前端能画出什么样的卡片', scope: 'global', ...V });
    expect(pickForInjection(db, { workspaceId: '/p', query: '今天天气怎么样，帮我写一首关于春天的诗吧' })).toEqual([]);
    expect(pickForInjection(db, { workspaceId: '/p', query: '这个怎么弄一下' })).toEqual([]);
    db.close();
  });

  it('常用词不算判据：全查询只有"这个/怎么/一下"时不给结果', () => {
    const db = mk();
    addLesson(db, { text: '这个项目怎么用一下', scope: 'global', ...V });
    expect(pickForInjection(db, { workspaceId: '/p', query: '这个 怎么 一下' })).toEqual([]);
    db.close();
  });

  it('只共享一个 2 字实词不算相关（两例都是实测误判，不是假想）', () => {
    const db = mk();
    addLesson(db, { text: '放弃等待跳下一首，渲染其实还在服务端跑', scope: 'global', ...V });
    // 只共享「一首」（它是"下一首"的一截）
    expect(pickForInjection(db, { workspaceId: '/p', query: '今天天气怎么样，帮我写一首关于春天的诗吧' })).toEqual([]);
    db.close();
    const db2 = mk();
    addLesson(db2, { text: '选择，会被今天的琐碎决策挤出简报', scope: 'global', ...V });
    // 只共享「简报」
    expect(pickForInjection(db2, { workspaceId: '/p', query: 'MAX_CHARS 简报上限是多少' })).toEqual([]);
    db2.close();
  });

  it('词形差异不该漏（长度归一化 / 长度归一）：3 字窗口跨过它', () => {
    const db = mk();
    addLesson(db, { text: '检索排序要在打分阶段做长度归一（长会话天然命中更多词）', scope: 'global', ...V });
    expect(pickForInjection(db, { workspaceId: '/p', query: '长度归一化到底开不开' }).length).toBe(1);
    db.close();
  });

  it('短题面（全查询只有一个可判据的词）命中就算相关', () => {
    const db = mk();
    addLesson(db, { text: '改用截图坐标×1.2（1080x2400）直接点按', scope: 'global', ...V });
    expect(pickForInjection(db, { workspaceId: '/p', query: '截图' }).length).toBe(1);
    expect(pickForInjection(db, { workspaceId: '/p', query: '整段不相关的说法' })).toEqual([]);
    db.close();
  });

  it('真有交集时仍然命中（判据别收紧到失效）', () => {
    const db = mk();
    addLesson(db, { text: '主目录与临时目录不算项目祖先', scope: 'global', ...V });
    expect(pickForInjection(db, { workspaceId: '/p', query: '主目录为什么不能当项目根' }).length).toBe(1);
    db.close();
  });
});

describe('[1016 收口] 可见性：一份实现管三个面', () => {
  it('workspace 归一：大小写与分隔符不同 = 同一个项目', () => {
    const db = mk();
    addLesson(db, { text: '项目级经验', scope: 'project', workspaceId: 'D:\\proj', grade: 'verified-file', sourceRef: 'x:1' });
    expect(pickForInjection(db, { workspaceId: 'd:/proj' }).length).toBe(1);
    expect(pickForInjection(db, { workspaceId: 'D:\\proj\\' }).length).toBe(1);
    expect(pickForInjection(db, { workspaceId: 'D:/another' })).toEqual([]);
    db.close();
  });

  it('domain 作用域：给了标签才可见（没标签 = 不猜）', () => {
    const db = mk();
    addLesson(db, { text: '域级经验：Windows 路径大小写', scope: 'domain', domain: 'windows-paths', grade: 'verified-file', sourceRef: 'x:1' });
    expect(pickForInjection(db, { workspaceId: '/p' })).toEqual([]);
    expect(pickForInjection(db, { workspaceId: '/p', domain: 'windows-paths' }).length).toBe(1);
    expect(pickForInjection(db, { workspaceId: '/p', domain: 'other' })).toEqual([]);
    db.close();
  });

  it('workspaceKey 只做比较用的归一，不动盘上路径', () => {
    expect(workspaceKey('D:\\dsh插件  记忆')).toBe('d:/dsh插件  记忆');
    expect(workspaceKey('/p/')).toBe('/p');
  });

  it('resolveDomain：config.json 的 domain 生效，SRELAY_DOMAIN 覆盖它', () => {
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'ses-dom-'));
    fs.mkdirSync(path.join(proj, '.sessionrelay'), { recursive: true });
    fs.writeFileSync(path.join(proj, '.sessionrelay', 'config.json'), JSON.stringify({ domain: 'ai-memory' }));
    expect(resolveDomain(proj)).toBe('ai-memory');
    expect(resolveDomain(path.join(proj, 'nope'))).toBeUndefined();
    process.env.SRELAY_DOMAIN = 'windows-paths';
    try { expect(resolveDomain(proj)).toBe('windows-paths'); } finally { delete process.env.SRELAY_DOMAIN; }
    fs.rmSync(proj, { recursive: true, force: true });
  });

  it('resolveWorkspaceId：项目根优先于当前子目录', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ses-ws-'));
    fs.mkdirSync(path.join(root, '.sessionrelay'), { recursive: true });
    const sub = path.join(root, 'core', 'x');
    fs.mkdirSync(sub, { recursive: true });
    // 临时目录不参与向上认领 —— 这里直接测"根目录自己"的解析
    expect(resolveWorkspaceId(root)).toBe(path.resolve(root));
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('[1016 收口] 根发现的两个脆点（红队 A-7 / A-12）', () => {
  it('A-12：临时目录自身与大小写变体都算「临时目录」', () => {
    expect(isTransientRoot(os.tmpdir())).toBe(true);
    expect(isTransientRoot(path.join(os.tmpdir(), 'sb7-abc', 'stack'))).toBe(true);
    expect(isTransientRoot(path.resolve(os.tmpdir()).toUpperCase())).toBe(true);
    expect(isTransientRoot(path.join(os.tmpdir(), 'a', '..', 'b'))).toBe(true);
  });

  it('A-12：普通项目目录不受影响', () => {
    const p = fs.mkdtempSync(path.join(os.homedir(), '.ses-not-tmp-'));
    try { expect(isTransientRoot(p)).toBe(false); } finally { fs.rmSync(p, { recursive: true, force: true }); }
  });

  it('A-7：被跳过的祖先库要**报出来**（而不是静默 null）', () => {
    const home = path.resolve(os.homedir());
    if (!fs.existsSync(path.join(home, '.sessionrelay'))) return;   // 本机没有这种布局就跳过
    const sub = ['Desktop', '.dsh', 'Documents', 'Downloads']
      .map((d) => path.join(home, d))
      .find((d) => fs.existsSync(d) && !isTransientRoot(d));
    if (!sub) return;
    const info = findRelayRootInfo(sub);
    expect(info.root).toBeNull();
    expect(info.skipped).toContain(home);
  });
});
