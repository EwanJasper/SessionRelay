// ui 仪表盘 HTTP 层（design-dashboard §5 安全模型）：
// 只读 · 仅绑 127.0.0.1 · 一次性 token · Host 校验（防 DNS rebinding）· 永不返回 CORS 头。
// 前台生命周期（U5）：Ctrl-C 即停，不做守护——不新增孤儿进程风险面。
import http from 'node:http';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { HTML } from './public.js';
import { uiOverview, uiProject, uiSessions, uiGrowth, closeAllDbs, NotRegistered } from './api.js';

export interface UiServerHandle {
  server: http.Server;
  port: number;
  token: string;
  url: string;
  close(): Promise<void>;
}

export function startUiServer(opts: { port?: number } = {}): Promise<UiServerHandle> {
  const token = crypto.randomBytes(16).toString('hex');
  const ctx: { allowedHosts?: Set<string> } = {};
  const server = http.createServer((req, res) => handle(req, res, token, ctx));
  return new Promise<UiServerHandle>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      ctx.allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
      const url = `http://127.0.0.1:${port}/?token=${token}`;
      resolve({
        server, port, token, url,
        close: () => new Promise<void>((r) => {
          server.closeAllConnections?.();
          server.close(() => { closeAllDbs(); r(); });
        }),
      });
    });
  });
}

function json(res: http.ServerResponse, code: number, obj: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function handle(req: http.IncomingMessage, res: http.ServerResponse, token: string, ctx: { allowedHosts?: Set<string> }): void {
  const u = new URL(req.url ?? '/', 'http://127.0.0.1');
  // ① Host 校验——所有请求一律执行，防 DNS rebinding（外域解析到 127.0.0.1 后同源读取）
  const host = String(req.headers.host ?? '');
  if (!ctx.allowedHosts?.has(host)) return json(res, 403, { ok: false, error: 'forbidden host' });
  // ② 只读：非 GET 一律 405
  if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'read-only' });
  // ③ token：API 走 X-Srelay-Token 头；首载页面允许 ?token= 一次性引导
  const headerToken = Array.isArray(req.headers['x-srelay-token']) ? req.headers['x-srelay-token'][0] : req.headers['x-srelay-token'];
  const authed = headerToken === token || (u.pathname === '/' && u.searchParams.get('token') === token);
  if (!authed) return json(res, 403, { ok: false, error: 'invalid token' });

  try {
    if (u.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(HTML);
      return;
    }
    if (u.pathname === '/api/overview') return json(res, 200, { ok: true, data: uiOverview() });
    if (u.pathname === '/api/project') {
      return json(res, 200, { ok: true, data: uiProject(u.searchParams.get('root') ?? '') });
    }
    if (u.pathname === '/api/project/sessions') {
      const p = Number(u.searchParams.get('page') ?? '1');
      return json(res, 200, {
        ok: true,
        data: uiSessions(u.searchParams.get('root') ?? '', {
          state: u.searchParams.get('state') ?? undefined,
          source: u.searchParams.get('source') ?? undefined,
          q: u.searchParams.get('q') ?? undefined,
          page: Number.isFinite(p) && p > 0 ? Math.floor(p) : 1,
        }),
      });
    }
    if (u.pathname === '/api/project/growth') {
      const d = Number(u.searchParams.get('days') ?? '30');
      return json(res, 200, { ok: true, data: uiGrowth(u.searchParams.get('root') ?? '', Number.isFinite(d) ? d : 30) });
    }
    if (u.pathname === '/api/health') {
      return json(res, 200, { ok: true, data: { ok: true, uptimeSec: Math.round(process.uptime()) } });
    }
    return json(res, 404, { ok: false, error: 'not found' });
  } catch (e) {
    if (e instanceof NotRegistered) return json(res, 404, { ok: false, error: 'project not registered' });
    json(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}

function openBrowser(url: string): void {
  const plat = process.platform;
  const cmd = plat === 'win32' ? 'cmd' : plat === 'darwin' ? 'open' : 'xdg-open';
  const args = plat === 'win32' ? ['/c', 'start', '', url] : [url];
  execFile(cmd, args, () => { /* 打不开不影响服务（可手动复制 URL） */ });
}

/** CLI 入口：srelay ui */
export async function cmdUi(opts: { port?: number; open?: boolean }): Promise<void> {
  let handle: UiServerHandle;
  try {
    handle = await startUiServer({ port: opts.port });
  } catch (e) {
    const msg = e instanceof Error && e.message.includes('EADDRINUSE')
      ? `端口 ${opts.port} 已被占用（srelay ui 默认随机端口，--port 为可选固定端口）`
      : `启动失败：${e instanceof Error ? e.message : String(e)}`;
    console.error(msg);
    process.exitCode = 1;
    return;
  }
  console.log('');
  console.log('  srelay 记忆仪表盘（只读 · 仅本机）');
  console.log(`  ${handle.url}`);
  console.log('');
  console.log('  Ctrl-C 停止 · 本服务不写入任何数据 · 关闭后需重新执行 srelay ui');
  if (opts.open !== false) openBrowser(handle.url);
  await new Promise<void>((resolve) => {
    const stop = (): void => {
      process.off('SIGINT', stop); process.off('SIGTERM', stop);
      void handle.close().then(() => resolve());
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    handle.server.on('close', () => resolve());
  });
}
