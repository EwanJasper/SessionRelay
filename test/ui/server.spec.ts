// ui HTTP 层（design-dashboard §5/§5.1）：安全矩阵全量 + API 正反例。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createDb, insertSession, insertMessage } from '../../src/store/db.js';
import { dbFile, projectIdOf } from '../../src/shared/paths.js';
import { touchRegistry } from '../../src/shared/registry.js';
import { defaultConfig, saveConfig } from '../../src/shared/config.js';
import { startUiServer, type UiServerHandle } from '../../src/ui/server.js';

const TMP = path.resolve('test/.tmp/ui-server');
const REG = path.join(TMP, 'registry');
const PROJ = path.join(TMP, 'proj');

process.env.SRELAY_REGISTRY_DIR = REG;

let h: UiServerHandle;

beforeAll(async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(path.join(PROJ, '.sessionrelay'), { recursive: true });
  const cfg = defaultConfig();
  cfg.identity.project_id = projectIdOf(PROJ);
  saveConfig(PROJ, cfg);
  const now = new Date().toISOString();
  const db = createDb(dbFile(PROJ));
  const pid = projectIdOf(PROJ);
  insertSession(db, { id: 's1', source: 'zcode', sourceSessionId: 'z1', projectId: pid, createdAt: now, title: '会话一', topics: [] });
  insertMessage(db, { sessionId: 's1', role: 'user', content: '磁悬浮轴承选型讨论：决定采用 PG', seqNum: 1, createdAt: now });
  db.prepare(`UPDATE sessions SET state='confirmed', message_count=1, last_event_at=?, decisions=? WHERE id='s1'`)
    .run(now, JSON.stringify([{ text: '决定采用 PG', seq: 1, at: now }]));
  db.close();
  touchRegistry(PROJ);
  h = await startUiServer();
});

afterAll(async () => {
  await h.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  delete process.env.SRELAY_REGISTRY_DIR;
});

function req(p: string, init?: RequestInit): Promise<Response> {
  return fetch('http://127.0.0.1:' + h.port + p, init);
}
function authed(p: string): Promise<Response> {
  return req(p, { headers: { 'X-Srelay-Token': h.token } });
}

/** fetch 不允许改 Host 头，DNS rebinding 用例走原生 http */
function rawHostReq(path: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { host: '127.0.0.1', port: h.port, path, headers: { Host: host, 'X-Srelay-Token': h.token } },
      (res) => { resolve(res.statusCode ?? 0); res.resume(); },
    );
    r.on('error', reject);
    r.end();
  });
}

function rawHost(host: string): Promise<number> {
  return rawHostReq('/api/overview', host);
}

function rawHostIndex(host: string): Promise<number> {
  return rawHostReq('/', host);
}

describe('ui · 安全矩阵（§5.1 全量）', () => {
  it('仅绑定 127.0.0.1', () => {
    const addr = h.server.address() as { address: string };
    expect(addr.address).toBe('127.0.0.1');
  });

  it('无 token → 403（数据面；HTML 外壳除外）', async () => {
    expect((await req('/api/overview')).status).toBe(403);
  });

  it('错 token → 403', async () => {
    const r = await req('/api/overview', { headers: { 'X-Srelay-Token': 'deadbeef' } });
    expect(r.status).toBe(403);
  });

  it('DNS rebinding：伪造 Host → 403；合法 Host → 200', async () => {
    expect(await rawHost('evil.com:1234')).toBe(403);
    expect(await rawHost('127.0.0.1:' + h.port)).toBe(200);
  });

  it('永不返回 CORS 头（跨源读不到响应）', async () => {
    const r = await authed('/api/overview');
    expect(r.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('非 GET → 405（只读）', async () => {
    const r = await req('/api/overview', { method: 'POST', headers: { 'X-Srelay-Token': h.token } });
    expect(r.status).toBe(405);
  });

  it('HTML 外壳免令牌：裸 / 与带 token 的 / 都 200（刷新/收藏不再死，U13）', async () => {
    const bare = await req('/');
    expect(bare.status).toBe(200);
    expect((await bare.text()).includes('记忆仪表盘')).toBe(true);
    const withToken = await req('/?token=' + h.token);
    expect(withToken.status).toBe(200);
    expect((await withToken.text()).includes('记忆仪表盘')).toBe(true);
  });

  it('HTML 外壳仍受 Host 校验（rebinding 不放过空壳）', async () => {
    expect(await rawHostIndex('evil.com:1234')).toBe(403);
  });

  it('未知路径 → 404', async () => {
    expect((await authed('/api/nope')).status).toBe(404);
  });
});

describe('ui · API 正反例', () => {
  it('overview：含注册项目', async () => {
    const j = await (await authed('/api/overview')).json();
    expect(j.ok).toBe(true);
    expect(j.data.projects.some((p: { root: string }) => p.root === PROJ)).toBe(true);
  });

  it('project：正常返回构成与决策', async () => {
    const j = await (await authed('/api/project?root=' + encodeURIComponent(PROJ))).json();
    expect(j.ok).toBe(true);
    expect(j.data.decisions[0].text).toBe('决定采用 PG');
  });

  it('project：未注册 root → 404 project not registered（U6）', async () => {
    const r = await authed('/api/project?root=' + encodeURIComponent(path.join(TMP, 'nope')));
    expect(r.status).toBe(404);
    expect((await r.json()).error).toBe('project not registered');
  });

  it('sessions：q 搜索路径可达（FTS，jieba 懒加载）', async () => {
    const r = await authed('/api/project/sessions?root=' + encodeURIComponent(PROJ) + '&q=' + encodeURIComponent('磁悬浮'));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.data.mode).toBe('search');
  }, 30_000);

  it('sessions：列表分页', async () => {
    const j = await (await authed('/api/project/sessions?root=' + encodeURIComponent(PROJ))).json();
    expect(j.data.mode).toBe('list');
    expect(j.data.rows.length).toBe(1);
  });

  it('growth：返回当日桶', async () => {
    const j = await (await authed('/api/project/growth?root=' + encodeURIComponent(PROJ) + '&days=7')).json();
    expect(j.ok).toBe(true);
    expect(j.data.length).toBeGreaterThanOrEqual(1);
  });

  it('health：ok', async () => {
    const j = await (await authed('/api/health')).json();
    expect(j.data.ok).toBe(true);
  });
});
