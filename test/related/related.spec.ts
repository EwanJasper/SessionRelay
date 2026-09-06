// 相关会话推荐（design-related）：重叠轨计分 / 向量轨定序 / 融合 / 边界
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createDb, insertSession, insertMessage, upsertSessionVector } from '../../src/store/db.js';
import { suggestRelated } from '../../src/search-svc/related.js';
import { resetSemanticCaches, l2 } from '../../src/search-svc/semantic.js';
import { defaultConfig, saveConfig, type RelayConfig } from '../../src/shared/config.js';
import { projectIdOf } from '../../src/shared/paths.js';

const TMP = path.resolve('test/.tmp/related');
const PROJECT = path.join(TMP, 'app');
const PID = projectIdOf(PROJECT);

beforeAll(() => {
  for (let i = 0; i < 3; i++) { try { fs.rmSync(TMP, { recursive: true, force: true }); break; } catch { /* retry */ } }
  fs.mkdirSync(path.join(PROJECT, '.sessionrelay'), { recursive: true });
});
afterAll(() => {
  resetSemanticCaches();
  for (let i = 0; 3 > i; i++) { try { fs.rmSync(TMP, { recursive: true, force: true }); return; } catch { /* retry */ } }
});

const cfgWith = (semantic?: RelayConfig['semantic']): RelayConfig => {
  const cfg = defaultConfig();
  cfg.identity.project_id = PID;
  if (semantic) cfg.semantic = semantic;
  saveConfig(PROJECT, cfg);
  return cfg;
};

const seed = (id: string, o: { topics?: string[]; files?: string[]; tags?: string[]; title?: string; state?: string; project?: string; firstUser?: string }) => {
  const db = createDb(dbFile());
  insertSession(db, { id, source: 'zcode', sourceSessionId: id, projectId: o.project ?? PID, createdAt: '2026-08-20T08:00:00Z', title: o.title ?? `会话 ${id}`, topics: o.topics, files: o.files, tags: o.tags, state: o.state ?? 'confirmed' });
  if (o.firstUser) insertMessage(db, { sessionId: id, role: 'user', content: o.firstUser, seqNum: 1 });
  db.close();
};
const dbFile = () => path.join(PROJECT, '.sessionrelay', 'relay.sqlite');

describe('related · 重叠轨（无向量降级）', () => {
  it('R1 分层计分：话题×3 > 标签×2 > 文件/标题×1，自排除，零重叠为空', async () => {
    seed('anc0000000000001', { topics: ['db'], tags: ['重要'], files: ['src/db.ts'], title: '连接池参数', firstUser: '连接池怎么配' });
    seed('top0000000000001', { topics: ['db', 'cache'], title: '完全无关标题' });      // 3 分（话题）
    seed('tag0000000000001', { tags: ['重要'], title: '也无关' });                     // 2 分（标签）
    seed('fil0000000000001', { files: ['src/db.ts'], title: '还是无关' });             // 1 分（文件）
    seed('tok0000000000001', { title: '连接池调优经验' });                             // ≥1（标题分词：连接池）
    seed('emp0000000000001', { title: '彻底无关的讨论' });                             // 0 分不进
    const db = createDb(dbFile());
    const { items } = await suggestRelated(db, cfgWith(), { projectId: PID, anchorId: 'anc0000000000001' });
    db.close();
    const ids = items.map((i) => i.sessionId);
    expect(ids).not.toContain('anc0000000000001');            // 自排除
    expect(ids).not.toContain('emp0000000000001');            // 零重叠不进
    expect(ids.indexOf('top0000000000001')).toBeLessThan(ids.indexOf('tag0000000000001')); // 话题 > 标签
    expect(items[0].reason).toContain('共享话题');
    expect(items.every((i) => i.viaVector === false)).toBe(true);
  });

  it('R2 重叠轨候选含 active（无向量时刚结束的会话也能被找到）', async () => {
    seed('anc0000000000001', { topics: ['db'] });
    seed('act0000000000001', { topics: ['db'], state: 'active' });
    const db = createDb(dbFile());
    const { items } = await suggestRelated(db, cfgWith(), { projectId: PID, anchorId: 'anc0000000000001' });
    db.close();
    expect(items.some((i) => i.sessionId === 'act0000000000001' && i.state === 'active')).toBe(true);
  });

  it('R3 空结果：count=0 语义（不是错误）；跨项目不可见', async () => {
    // 独立项目 id——同库文件里其他用例的种子不干扰空结果断言
    seed('r3anc0000000001', { topics: ['db'], project: 'proj-r3-empty' });
    seed('other000000000001', { topics: ['db'], project: 'proj-other' });
    const db = createDb(dbFile());
    const none = await suggestRelated(db, cfgWith(), { projectId: 'proj-r3-empty', anchorId: 'r3anc0000000001' });
    expect(none.items).toHaveLength(0);
    // 其他项目的同话题会话不可见（跨项目隔离）
    const proj2 = await suggestRelated(db, cfgWith(), { projectId: 'proj-other', anchorId: 'other000000000001' });
    expect(proj2.items.every((i) => i.sessionId !== 'r3anc0000000001')).toBe(true);
    db.close();
  });

  it('R4 limit 硬顶 10（design §4 滥用防护）', async () => {
    seed('anc0000000000001', { topics: ['db'] });
    for (let i = 0; i < 14; i++) seed(`bulk${String(i).padStart(10, '0')}00`, { topics: ['db'] });
    const db = createDb(dbFile());
    const { items } = await suggestRelated(db, cfgWith(), { projectId: PID, anchorId: 'anc0000000000001', limit: 99 });
    db.close();
    expect(items.length).toBeLessThanOrEqual(10);
  });
});

describe('related · 向量轨（注入向量 / FakeEmbedder）', () => {
  it('R5 余弦定序 + 阈值裁剪（FakeEmbedder + 注入向量，model=fake-ci）', async () => {
    process.env.SRELAY_SEMANTIC_FAKE = '1';
    resetSemanticCaches();
    try {
      seed('anc0000000000001', { title: '锚' });
      seed('near000000000001', { title: '近邻' });
      seed('far00000000000001', { title: '远邻' });
      const AX = l2(new Float32Array([1, 0, 0, 0]));
      const w = createDb(dbFile());
      upsertSessionVector(w, 'anc0000000000001', 'fake-ci', AX);
      upsertSessionVector(w, 'near000000000001', 'fake-ci', l2(new Float32Array([0.95, 0.1, 0, 0]))); // cos≈0.995
      upsertSessionVector(w, 'far00000000000001', 'fake-ci', l2(new Float32Array([0, 0, 1, 0])));     // cos=0
      w.close();
      const db = createDb(dbFile());
      const { items } = await suggestRelated(db, cfgWith({ enabled: true, model: 'fake-ci', threshold: 0.4 }), { projectId: PID, anchorId: 'anc0000000000001' });
      db.close();
      // 向量轨命中 near，far 被阈值裁掉；near 无重叠元数据 → 纯向量信号
      expect(items[0].sessionId).toBe('near000000000001');
      expect(items[0].viaVector).toBe(true);
      expect(items[0].reason).toContain('向量相似');
      expect(items.some((i) => i.sessionId === 'far00000000000001')).toBe(false);
    } finally { delete process.env.SRELAY_SEMANTIC_FAKE; resetSemanticCaches(); }
  });

  it('R6 anchor 无向量（active）→ 即时嵌入（只算不入库）', async () => {
    process.env.SRELAY_SEMANTIC_FAKE = '1';
    resetSemanticCaches();
    try {
      seed('ancActive0000001', { title: '进行中的数据库讨论', state: 'active', firstUser: '连接池问题' });
      seed('dbConf000000001', { title: '已确认的历史会话', state: 'confirmed' });
      // dbConf 的向量 = FakeEmbedder 嵌 anchor 的同款输入文本 → cos=1 确定命中
      const { FakeEmbedder, semanticInputOf } = await import('../../src/search-svc/semantic.js');
      const e = new FakeEmbedder();
      const anchorInput = semanticInputOf('进行中的数据库讨论', '连接池问题');
      const w = createDb(dbFile()); upsertSessionVector(w, 'dbConf000000001', 'fake-ci', await e.embed(anchorInput)); w.close();
      const db = createDb(dbFile());
      const { items, viaVectorAny } = await suggestRelated(db, cfgWith({ enabled: true, model: 'fake-ci' }), { projectId: PID, anchorId: 'ancActive0000001' });
      db.close();
      expect(viaVectorAny).toBe(true); // active 锚即时嵌入了
      expect(items.some((i) => i.sessionId === 'dbConf000000001' && i.viaVector)).toBe(true);
      // 即时嵌入不入库
      const w2 = createDb(dbFile());
      expect((w2.prepare('SELECT COUNT(*) n FROM session_vectors WHERE session_id = ?').get('ancActive0000001') as { n: number }).n).toBe(0);
      w2.close();
    } finally { delete process.env.SRELAY_SEMANTIC_FAKE; resetSemanticCaches(); }
  });

  it('R7 融合：向量优先 + 重叠补足剩余名额去重', async () => {
    process.env.SRELAY_SEMANTIC_FAKE = '1';
    resetSemanticCaches();
    try {
      seed('anc0000000000001', { title: '数据库连接池', topics: ['db'] });
      seed('vec000000000001', { title: '完全无关标题（靠向量命中）' });
      seed('ovl000000000001', { title: '数据库备份', topics: ['db'] }); // 重叠轨命中（共享话题 db）
      const { FakeEmbedder } = await import('../../src/search-svc/semantic.js');
      const e = new FakeEmbedder();
      // vec 的向量与锚标题"数据库连接池"3-gram 重叠？造一个确定命中的：用锚文本自身嵌入
      const w = createDb(dbFile());
      upsertSessionVector(w, 'vec000000000001', 'fake-ci', await e.embed('数据库连接池'));
      w.close();
      const db = createDb(dbFile());
      const { items } = await suggestRelated(db, cfgWith({ enabled: true, model: 'fake-ci' }), { projectId: PID, anchorId: 'anc0000000000001', limit: 5 });
      db.close();
      const vec = items.find((i) => i.sessionId === 'vec000000000001');
      const ovl = items.find((i) => i.sessionId === 'ovl000000000001');
      expect(vec?.viaVector).toBe(true);
      expect(ovl?.viaVector).toBe(false);            // 重叠补足
      if (vec && ovl) expect(items.indexOf(vec)).toBeLessThan(items.indexOf(ovl)); // 向量在前
    } finally { delete process.env.SRELAY_SEMANTIC_FAKE; resetSemanticCaches(); }
  });
});
