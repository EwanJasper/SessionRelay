// [1016 竞品调研借鉴点 ②] 零模型查询改写的三条纪律，逐条钉住。
//
// 背景：我们的短板是「换个说法就不认」（关键词 20/20 进 top-10，大白话 top-1 只有 10/20）。
// 借鉴 AstrBot memory_companion 的检索层（默认档同样零 embedding）：同义家族 + CJK bigram + 剔外壳词。
// 实测收益：大白话 hit@10 17/20 → 18/20（**+1，真实但小**）；top-1 不动。
//   ⇒ 结论：这是**排序**问题不是召回问题，下一根杠杆是融合排序，不是继续堆改写词。
import { describe, it, expect } from 'vitest';
import { rewriteQuery, charBigrams, pickScaffold } from '../../src/core/tokenize/rewrite.js';
import { createDb, insertImportedSession, insertImportedMessage } from '../../src/store/db.js';
import { searchSessions } from '../../src/search-svc/engine.js';

const seg = (t: string) => [t];   // 测试里用恒等分词，聚焦改写逻辑本身

describe('[1016] 查询改写：只做加法', () => {
  it('① 同义家族命中即补同族词（主词本身不进补充词）', () => {
    const r = rewriteQuery(['归档'], seg);
    expect(r.families.length).toBe(1);
    const flat = r.extraUnits.flat();
    expect(flat).toContain('存档');
    expect(flat).not.toContain('归档');
  });

  it('② CJK bigram 只在词长 ≥4 时展开（2~3 字不切，避免只剩单字噪声）', () => {
    expect(charBigrams('抽取质量')).toEqual(['抽取', '取质', '质量']);
    expect(charBigrams('归档')).toEqual([]);
    expect(charBigrams('abc')).toEqual([]);
  });

  it('③ 问句外壳词可被单独识别出来（是否剔除由调用方决定）', () => {
    expect(pickScaffold(['请问', '记忆', '怎么', '恢复'])).toEqual(['请问', '怎么']);
    expect(pickScaffold(['记忆', '恢复'])).toEqual([]);
  });
});

describe('[1016] 查询改写：引擎层行为', () => {
  const mk = (db: ReturnType<typeof createDb>, sid: string, title: string, content: string) => {
    const { id } = insertImportedSession(db, {
      source: 'dsh', sourceSessionId: sid, projectId: 'p', title,
      createdAt: '2026-10-16T00:00:00.000Z', lastEventAt: '2026-10-16T00:00:00.000Z',
      messageCount: 1, topics: [], decisions: [], summaryRule: null,
      author: null, importedFrom: null, originProject: null, contentHash: null, sourceFile: null,
    });
    insertImportedMessage(db, id, { seq: 1, role: 'user', content });
    return id;
  };

  it('④ rewrite:false 逐字回到旧行为（A/B 开关有效）', () => {
    const db = createDb(':memory:');
    mk(db, 'a', '甲', '把旧会话归档处理');
    const on = searchSessions(db, { project: 'p', query: '归档', limit: 10, fusion: false });
    const off = searchSessions(db, { project: 'p', query: '归档', limit: 10, rewrite: false, fusion: false });
    expect(off.every((h) => !h.viaRewrite)).toBe(true);
    expect(off.map((h) => h.sessionId)).toEqual(on.filter((h) => !h.viaRewrite).map((h) => h.sessionId));
  });

  it('⑤ 补充命中标记 viaRewrite，且**排在主路之后**（不挤掉原本对的）', () => {
    const db = createDb(':memory:');
    const strong = mk(db, 'strong', '强命中', '归档 归档 归档');
    mk(db, 'weak', '同义命中', '存档 存档');
    const hits = searchSessions(db, { project: 'p', query: '归档', limit: 10, fusion: false });
    expect(hits[0].sessionId).toBe(strong);            // 主路第一不动
    const weakIdx = hits.findIndex((h) => h.sessionId !== strong);
    if (weakIdx >= 0) expect(hits[weakIdx].viaRewrite).toBe(true);
  });
});
