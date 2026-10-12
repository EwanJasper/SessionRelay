// ui 仪表盘前端（design-dashboard U2/U7）：单 HTML 内联于 TS，tsup 一并打包——
// files 清单零改动、check:artifacts 零风险、无路径解析问题。
// 约定：模板字符串内部不得出现反引号与 ${}（内层 JS 一律用 '+' 拼接）。
// v1.2：会话详情下钻 + 会话内关键词搜索（点击命中/决策跳到对应消息）+ 项目健康卡片。
export const HTML: string = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>srelay 记忆仪表盘</title>
<style>
  :root { --fg:#1f2430; --dim:#6b7280; --line:#e5e7eb; --bg:#f6f7f9; --card:#fff; --accent:#3b5bdb; --ok:#2f9e44; --bad:#e03131; }
  * { box-sizing:border-box; }
  body { margin:0; font:14px/1.6 system-ui,'Segoe UI','Microsoft YaHei',sans-serif; color:var(--fg); background:var(--bg); }
  header { display:flex; align-items:center; gap:16px; padding:12px 20px; background:var(--card); border-bottom:1px solid var(--line); position:sticky; top:0; z-index:5; }
  header h1 { font-size:16px; margin:0; }
  header h1 b { color:var(--accent); }
  header .totals { color:var(--dim); font-size:13px; }
  header button { margin-left:auto; }
  button { font:inherit; padding:5px 14px; border:1px solid var(--line); border-radius:8px; background:var(--card); cursor:pointer; }
  button:hover { border-color:var(--accent); color:var(--accent); }
  button:disabled { opacity:.45; cursor:default; }
  main { display:flex; gap:16px; padding:16px 20px; align-items:flex-start; }
  aside { width:280px; flex:none; display:flex; flex-direction:column; gap:10px; }
  .pcard { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:12px 14px; cursor:pointer; }
  .pcard:hover { border-color:var(--accent); }
  .pcard.sel { border-color:var(--accent); box-shadow:0 0 0 2px #3b5bdb22; }
  .pcard .row1 { display:flex; align-items:center; gap:8px; font-weight:600; }
  .pcard .path { color:var(--dim); font-size:12px; font-family:Consolas,monospace; word-break:break-all; }
  .pcard .meta { color:var(--dim); font-size:12px; margin-top:4px; }
  .dot { width:9px; height:9px; border-radius:50%; display:inline-block; flex:none; }
  .dot.on { background:var(--ok); } .dot.off { background:var(--bad); }
  section.detail { flex:1; min-width:0; display:flex; flex-direction:column; gap:14px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:14px 16px; }
  .card h3 { margin:0 0 10px; font-size:14px; color:var(--dim); font-weight:600; }
  .kv { display:flex; flex-wrap:wrap; gap:8px 22px; }
  .kv .k { color:var(--dim); font-size:12px; }
  .kv .v { font-weight:600; font-size:13px; }
  .pill { display:inline-block; padding:1px 10px; border-radius:99px; background:#eef2ff; color:var(--accent); font-size:12px; margin-right:6px; }
  .pill.warn { background:#fff4e6; color:#e8590c; }
  .pill.gray { background:#f1f3f5; color:#495057; }
  .bars .b { display:flex; align-items:center; gap:8px; margin:4px 0; font-size:12px; }
  .bars .b .label { width:110px; color:var(--dim); text-align:right; flex:none; }
  .bars .b .track { flex:1; background:#f1f3f5; border-radius:4px; height:14px; }
  .bars .b .fill { height:14px; border-radius:4px; background:var(--accent); min-width:2px; }
  .bars .b .num { width:52px; flex:none; }
  .chartwrap { overflow-x:auto; }
  .empty { color:var(--dim); font-size:13px; padding:8px 0; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th, td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--dim); font-weight:500; font-size:12px; }
  td.title { max-width:420px; }
  td .snippet { color:var(--dim); font-size:12px; margin-top:2px; }
  tr.clickable { cursor:pointer; }
  tr.clickable:hover td { background:#f8f9ff; }
  .filters { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:10px; }
  .filters select, .filters input { font:inherit; padding:4px 8px; border:1px solid var(--line); border-radius:8px; background:var(--card); }
  .filters input { width:220px; }
  .pager { display:flex; align-items:center; gap:10px; margin-top:8px; color:var(--dim); font-size:12px; flex-wrap:wrap; }
  .mono { font-family:Consolas,monospace; font-size:12px; }
  .list-item { padding:6px 0; border-bottom:1px dashed var(--line); font-size:13px; }
  .list-item:last-child { border-bottom:none; }
  .list-item .src { color:var(--dim); font-size:12px; margin-right:8px; }
  .list-item.clickable { cursor:pointer; }
  .list-item.clickable:hover .t { color:var(--accent); }
  #deny { display:none; position:fixed; inset:0; background:#f8fafc; z-index:9; align-items:center; justify-content:center; flex-direction:column; gap:8px; }
  .badge { display:inline-block; padding:0 8px; border-radius:99px; font-size:11px; }
  .badge.user { background:#e7f5ff; color:#1c7ed6; }
  .badge.assistant { background:#ebfbee; color:#2f9e44; }
  .badge.note { background:#fff4e6; color:#e8590c; }
  .badge.tool, .badge.system { background:#f1f3f5; color:#495057; }
  .msg { padding:8px 0; border-bottom:1px dashed var(--line); }
  .msg:last-child { border-bottom:none; }
  .msg-head { display:flex; gap:8px; align-items:center; font-size:12px; color:var(--dim); }
  .msg-head .sq { font-family:Consolas,monospace; }
  .msg-body { white-space:pre-wrap; word-break:break-word; margin-top:4px; font-size:13px; max-height:340px; overflow:auto; background:#fafbfc; border-radius:6px; padding:8px 10px; }
  .msg.hl { background:#fff9db; border-radius:8px; padding:8px; }
  mark { background:#ffe066; padding:0 2px; border-radius:3px; }
  .sres { padding:6px 10px; border:1px solid var(--line); border-radius:8px; margin:6px 0; cursor:pointer; }
  .sres:hover { border-color:var(--accent); }
  .sres .sline { font-size:12px; color:var(--dim); margin-bottom:2px; }
  .backrow { display:flex; align-items:center; gap:10px; margin-bottom:8px; }
  .logtail { font-family:Consolas,monospace; font-size:11.5px; background:#fafbfc; border:1px solid var(--line); border-radius:6px; padding:8px 10px; max-height:220px; overflow:auto; white-space:pre-wrap; word-break:break-all; color:#495057; }
  footer { text-align:center; color:var(--dim); font-size:12px; padding:10px 0 24px; }
  @media (max-width:900px){ main{flex-direction:column} aside{width:100%} }
</style>
</head>
<body>
<div id="deny"><h2 id="deny-title"></h2><div class="empty" id="deny-body"></div></div>
<header>
  <h1><b>srelay</b> 记忆仪表盘</h1>
  <span class="totals" id="totals">加载中…</span>
  <button id="refresh">刷新</button>
</header>
<main>
  <aside id="projects"></aside>
  <section class="detail" id="detail"><div class="card"><div class="empty">选择左侧项目查看详情</div></div></section>
</main>
<footer>只读观察窗 · 仅本机 127.0.0.1 · 零外呼 · 数据来自各项目 .sessionrelay</footer>
<script>
(function () {
  'use strict';
  var TOKEN = null;
  var DENIED = false;
  var t0 = new URLSearchParams(location.search).get('token');
  if (t0) { sessionStorage.setItem('srelay-token', t0); history.replaceState(null, '', '/'); }
  TOKEN = sessionStorage.getItem('srelay-token');

  var MSG_PAGE = 50;
  var state = {
    projects: [], sel: null, sessFilter: { state: '', source: '', q: '' }, page: 1, days: 30,
    view: 'project',
    sess: { id: null, meta: null, from: 1, kw: '', results: null, hlSeq: null }
  };

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function escMark(s, kw) {
    var e = esc(s);
    if (!kw) return e;
    var lk = esc(kw).toLowerCase(), le = e.toLowerCase();
    var out = '', i = 0, idx;
    while ((idx = le.indexOf(lk, i)) !== -1) {
      out += e.slice(i, idx) + '<mark>' + e.slice(idx, idx + lk.length) + '</mark>';
      i = idx + lk.length;
    }
    return out + e.slice(i);
  }
  function fmtBytes(n) {
    if (!n) return '0 B';
    var u = ['B', 'KB', 'MB', 'GB'], i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (i === 0 ? n : n.toFixed(1)) + ' ' + u[i];
  }
  function fmtDate(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    function p(x) { return (x < 10 ? '0' : '') + x; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }
  function fmtAgo(iso) {
    if (!iso) return '—';
    var s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 90) return '刚刚';
    if (s < 3600) return Math.round(s / 60) + ' 分钟前';
    if (s < 86400) return Math.round(s / 3600) + ' 小时前';
    return Math.round(s / 86400) + ' 天前';
  }
  function stateZh(s) { return { active: '活跃', pending_end: '待确认', confirmed: '已确认', archived: '已归档' }[s] || s; }
  function roleZh(r) { return { user: '用户', assistant: 'AI', note: '笔记', tool: '工具', system: '系统' }[r] || r; }

  function showDeny(title, body) {
    DENIED = true;
    $('deny-title').textContent = title;
    $('deny-body').innerHTML = body;
    $('deny').style.display = 'flex';
  }

  function api(path) {
    return fetch(path, { headers: { 'X-Srelay-Token': TOKEN || '' } })
      .then(function (r) {
        if (r.status === 403) {
          showDeny('令牌已失效', '服务可能已重启（每次 <span class="mono">srelay ui</span> 都会换新令牌）。请重新执行 <span class="mono">srelay ui</span>，用它打印的链接打开。');
          throw new Error('deny');
        }
        return r.json();
      })
      .then(function (j) { if (!j.ok) throw new Error(j.error || 'api error'); return j.data; });
  }
  function enc(s) { return encodeURIComponent(s); }

  // ── 总览 ──
  function loadOverview() {
    return api('/api/overview').then(function (d) {
      state.projects = d.projects;
      var t = d.totals;
      $('totals').textContent = t.projects + ' 项目 · ' + t.sessions + ' 会话 · ' + t.messages + ' 消息 · ' + fmtBytes(t.dbBytes);
      renderSidebar();
      if (!state.sel && d.projects.length) selectProject(d.projects[0].root);
      else if (state.sel && !d.projects.some(function (p) { return p.root === state.sel; }) && d.projects.length) selectProject(d.projects[0].root);
    }).catch(function () {});
  }

  function renderSidebar() {
    var html = state.projects.map(function (p) {
      var n = 0; for (var k in p.sessions) n += p.sessions[k];
      var dot = p.error ? '<span class="dot off"></span>' : (p.daemonAlive ? '<span class="dot on"></span>' : '<span class="dot off"></span>');
      return '<div class="pcard' + (p.root === state.sel ? ' sel' : '') + '" data-root="' + esc(p.root) + '">' +
        '<div class="row1">' + dot + esc(p.name) + '</div>' +
        '<div class="path">' + esc(p.root) + '</div>' +
        '<div class="meta">' + (p.error ? '<span style="color:var(--bad)">' + esc(p.error) + '</span>' :
          n + ' 会话 · ' + p.messageTotal + ' 消息 · ' + fmtBytes(p.dbBytes) + ' · 守护' + (p.daemonAlive ? '在跑' : '未跑')) + '</div>' +
        '</div>';
    }).join('');
    if (!state.projects.length) html = '<div class="card"><div class="empty">注册表为空——先在某项目里执行 srelay init</div></div>';
    $('projects').innerHTML = html;
    Array.prototype.forEach.call(document.querySelectorAll('.pcard'), function (el) {
      el.onclick = function () { selectProject(el.getAttribute('data-root')); };
    });
  }

  // ── 项目详情 ──
  function selectProject(root) {
    state.sel = root; state.view = 'project'; state.page = 1; state.sessFilter = { state: '', source: '', q: '' };
    renderSidebar();
    loadProject(); loadSessions(); loadGrowth(); loadHealth();
  }

  function loadProject() {
    api('/api/project?root=' + enc(state.sel)).then(function (d) {
      var st = '';
      for (var k in d.sessions) st += '<span class="pill">' + stateZh(k) + ' ' + d.sessions[k] + '</span>';
      var src = '';
      var srcTotal = 0;
      for (var s in d.bySource) srcTotal += d.bySource[s];
      for (var s2 in d.bySource) {
        var pct = srcTotal ? Math.round(d.bySource[s2] / srcTotal * 100) : 0;
        src += '<div class="b"><span class="label">' + esc(s2) + '</span><span class="track"><span class="fill" style="width:' + pct + '%"></span></span><span class="num">' + d.bySource[s2] + '</span></div>';
      }
      var dec = d.decisions.length ? d.decisions.map(function (x) {
        return '<div class="list-item clickable" data-sid="' + esc(x.sessionId) + '"><span class="src">' + fmtDate(x.at) + ' · ' + esc(x.source) + '</span><span class="t">' + esc(x.text) + '</span></div>';
      }).join('') : '<div class="empty">暂无已确认决策</div>';
      var unres = d.unresolved.length ? d.unresolved.map(function (x) {
        return '<div class="list-item clickable" data-sid="' + esc(x.sessionId) + '"><span class="src">' + fmtAgo(x.at) + ' · ' + esc(x.source) + '</span><span class="t">' + esc(x.q) + '</span></div>';
      }).join('') : '<div class="empty">暂无未决问题</div>';
      $('detail').innerHTML =
        '<div class="card"><div class="row1" style="display:flex;align-items:center;gap:10px;font-weight:600;font-size:15px">' +
        '<span class="dot ' + (d.daemonAlive ? 'on' : 'off') + '"></span>' + esc(d.name) +
        '<span style="color:var(--dim);font-weight:400;font-size:12px" class="mono">' + esc(d.root) + '</span></div>' +
        '<div class="kv" style="margin-top:8px">' +
        '<div><div class="k">捕获模式</div><div class="v">' + esc(d.mode) + '</div></div>' +
        '<div><div class="k">消息总数</div><div class="v">' + d.messageTotal + '</div></div>' +
        '<div><div class="k">库体积</div><div class="v">' + fmtBytes(d.dbBytes) + '</div></div>' +
        '<div><div class="k">日志体积</div><div class="v">' + fmtBytes(d.logBytes) + '</div></div>' +
        '<div><div class="k">最近事件</div><div class="v">' + fmtAgo(d.lastEventAt) + '</div></div>' +
        '</div></div>' +
        '<div class="card"><h3>会话构成</h3><div style="margin-bottom:8px">' + st + '</div><div class="bars">' + src + '</div></div>' +
        '<div class="card"><h3>消息增长（近 ' + state.days + ' 天 · UTC 日）</h3><div class="chartwrap" id="growth"></div></div>' +
        '<div class="card"><h3>会话（点击行进入会话详情）</h3><div id="sess"></div></div>' +
        '<div class="card"><h3>最近决策（点击跳到对应会话）</h3>' + dec + '</div>' +
        '<div class="card"><h3>未决问题（点击跳到对应会话）</h3>' + unres + '</div>' +
        '<div class="card"><h3>健康 · 守护日志尾部</h3><div id="health"><div class="empty">加载中…</div></div></div>';
      Array.prototype.forEach.call(document.querySelectorAll('.list-item.clickable'), function (el) {
        el.onclick = function () { openSession(el.getAttribute('data-sid')); };
      });
      loadGrowth(); loadSessions(); loadHealth();
    }).catch(function () {});
  }

  function loadHealth() {
    var el = $('health'); if (!el || state.view !== 'project') return;
    api('/api/project/health?root=' + enc(state.sel)).then(function (d) {
      var s = d.stats || {};
      var statsLine = 'ignore 拦截 ' + (s.blocked_by_ignore || 0) + ' 次 · 已确认会话 ' + (s.confirmed || 0) + ' · 手动保存 ' + (s.manual_save || 0);
      var tail = d.logTail && d.logTail.length
        ? '<div class="logtail">' + d.logTail.slice(-18).map(esc).join('\\n') + '</div>'
        : '<div class="empty">无守护日志（尚未运行过 srelay watch）</div>';
      el.innerHTML = '<div style="margin-bottom:8px;color:var(--dim);font-size:12px">' + statsLine + '</div>' + tail;
    }).catch(function () {});
  }

  function loadGrowth() {
    var el = $('growth'); if (!el) return;
    api('/api/project/growth?root=' + enc(state.sel) + '&days=' + state.days).then(function (d) {
      if (!d.length) { el.innerHTML = '<div class="empty">窗口内无消息</div>'; return; }
      var max = 1; for (var i = 0; i < d.length; i++) if (d[i].msgs > max) max = d[i].msgs;
      var W = Math.max(640, d.length * 24), H = 200, bw = 16, gap = 8;
      var s = '<svg width="' + W + '" height="' + H + '" style="display:block">';
      for (var j = 0; j < d.length; j++) {
        var h = Math.max(2, Math.round(d[j].msgs / max * (H - 46)));
        var x = j * (bw + gap) + 4, y = H - 26 - h;
        s += '<rect x="' + x + '" y="' + y + '" width="' + bw + '" height="' + h + '" rx="3" fill="#3b5bdb"><title>' + d[j].date + ' · ' + d[j].msgs + ' 条</title></rect>';
        if (j % Math.ceil(d.length / 8) === 0) s += '<text x="' + (x + bw / 2) + '" y="' + (H - 8) + '" font-size="10" fill="#6b7280" text-anchor="middle">' + d[j].date.slice(5) + '</text>';
        if (d[j].msgs === max) s += '<text x="' + (x + bw / 2) + '" y="' + (y - 5) + '" font-size="10" fill="#6b7280" text-anchor="middle">' + d[j].msgs + '</text>';
      }
      s += '</svg>';
      el.innerHTML = s;
    }).catch(function () {});
  }

  function loadSessions() {
    var el = $('sess'); if (!el || state.view !== 'project') return;
    var f = state.sessFilter;
    var qs = 'root=' + enc(state.sel) + '&page=' + state.page +
      (f.state ? '&state=' + enc(f.state) : '') +
      (f.source ? '&source=' + enc(f.source) : '') +
      (f.q ? '&q=' + enc(f.q) : '');
    api('/api/project/sessions?' + qs).then(function (d) {
      var srcOpts = '<option value="">全部来源</option>';
      var seen = {};
      for (var i = 0; i < d.rows.length; i++) seen[d.rows[i].source] = 1;
      for (var k in seen) srcOpts += '<option value="' + esc(k) + '"' + (f.source === k ? ' selected' : '') + '>' + esc(k) + '</option>';
      var stOpts = '<option value="">全部状态</option>';
      var sts = ['active', 'pending_end', 'confirmed', 'archived'];
      for (var j = 0; j < sts.length; j++) stOpts += '<option value="' + sts[j] + '"' + (f.state === sts[j] ? ' selected' : '') + '>' + stateZh(sts[j]) + '</option>';
      var rows = d.rows.map(function (r) {
        return '<tr class="clickable" data-sid="' + esc(r.id) + '"><td class="mono">' + esc(r.id.slice(0, 8)) + '</td><td>' + esc(r.source) + '</td><td>' + stateZh(r.state) +
          '</td><td class="title">' + esc(r.title || '（无标题）') + (r.snippet ? '<div class="snippet">' + esc(r.snippet) + '</div>' : '') +
          '</td><td>' + r.messageCount + '</td><td style="color:var(--dim)">' + fmtAgo(r.lastEventAt) + '</td></tr>';
      }).join('');
      el.innerHTML =
        '<div class="filters">' +
        '<select id="f-state">' + stOpts + '</select>' +
        '<select id="f-source">' + srcOpts + '</select>' +
        '<input id="f-q" placeholder="项目内全文搜索（FTS）" value="' + esc(f.q) + '">' +
        '<button id="f-go">查询</button></div>' +
        (rows ? '<table><tr><th>ID</th><th>来源</th><th>状态</th><th>标题</th><th>消息</th><th>最近活动</th></tr>' + rows + '</table>' : '<div class="empty">无匹配会话</div>') +
        '<div class="pager"><button id="pg-prev"' + (state.page <= 1 ? ' disabled' : '') + '>上一页</button>' +
        '<span>第 ' + d.page + ' 页' + (d.hasMore ? ' · 有更多' : '') + '</span>' +
        '<button id="pg-next"' + (d.hasMore ? '' : ' disabled') + '>下一页</button>' +
        (d.mode === 'search' ? '<span>（搜索结果最多 50 条）</span>' : '') + '</div>';
      $('f-go').onclick = function () {
        state.sessFilter = { state: $('f-state').value, source: $('f-source').value, q: $('f-q').value.trim() };
        state.page = 1; loadSessions();
      };
      $('f-q').onkeydown = function (e) { if (e.key === 'Enter') $('f-go').click(); };
      $('pg-prev').onclick = function () { if (state.page > 1) { state.page--; loadSessions(); } };
      $('pg-next').onclick = function () { if (d.hasMore) { state.page++; loadSessions(); } };
      Array.prototype.forEach.call(el.querySelectorAll('tr.clickable'), function (tr) {
        tr.onclick = function () { openSession(tr.getAttribute('data-sid')); };
      });
    }).catch(function () {});
  }

  // ── 会话详情（v1.2）──
  function openSession(id, focusSeq) {
    state.view = 'session';
    state.sess = { id: id, meta: null, from: 1, kw: '', results: null, hlSeq: focusSeq || null };
    loadSessionMeta();
  }

  function backToProject() {
    state.view = 'project';
    loadProject();
  }

  function loadSessionMeta() {
    var s = state.sess;
    api('/api/session?root=' + enc(state.sel) + '&id=' + enc(s.id)).then(function (m) {
      s.meta = m;
      var topics = (m.topics || []).map(function (t) { return '<span class="pill">' + esc(t) + '</span>'; }).join('');
      var tags = (m.userTags || []).map(function (t) { return '<span class="pill gray">#' + esc(t) + '</span>'; }).join('');
      var files = (m.files || []).slice(0, 30).map(function (f) {
        return '<div class="mono" style="color:var(--dim);padding:1px 0">' + esc(f) + '</div>';
      }).join('');
      var dec = (m.decisions || []).length ? m.decisions.map(function (x) {
        return '<div class="list-item clickable" data-seq="' + (x.seq || '') + '"><span class="src">#' + (x.seq || '?') + (x.at ? ' · ' + fmtDate(x.at) : '') + '</span><span class="t">' + esc(x.text) + '</span></div>';
      }).join('') : '<div class="empty">本会话无已提取决策</div>';
      var qs = (m.questions || []);
      var unres = qs.filter(function (x) { return x.unresolved; });
      var qhtml = qs.length ? qs.map(function (x) {
        return '<div class="list-item' + (x.seq ? ' clickable' : '') + '"' + (x.seq ? ' data-seq="' + x.seq + '"' : '') + '><span class="src">#' + (x.seq || '?') + '</span><span class="t">' + esc(x.q) + (x.unresolved ? ' <span class="pill warn">未决</span>' : '') + '</span></div>';
      }).join('') : '<div class="empty">无关键问题记录</div>';
      $('detail').innerHTML =
        '<div class="card"><div class="backrow"><button id="s-back">← 返回项目</button></div>' +
        '<div class="row1" style="display:flex;align-items:center;gap:10px;font-weight:600;font-size:15px;flex-wrap:wrap">' +
        esc(m.title || '（无标题）') +
        '<span class="pill">' + stateZh(m.state) + '</span>' +
        '<span class="pill gray">' + esc(m.source) + '</span></div>' +
        '<div class="kv" style="margin-top:8px">' +
        '<div><div class="k">消息数</div><div class="v">' + m.messageCount + '</div></div>' +
        '<div><div class="k">创建</div><div class="v">' + fmtDate(m.createdAt) + '</div></div>' +
        '<div><div class="k">最近活动</div><div class="v">' + fmtAgo(m.lastEventAt) + '</div></div>' +
        (m.author ? '<div><div class="k">作者</div><div class="v">' + esc(m.author) + '</div></div>' : '') +
        '</div>' +
        ((topics || tags) ? '<div style="margin-top:8px">' + topics + tags + '</div>' : '') +
        (m.summaryRule ? '<div style="margin-top:8px"><div class="k" style="color:var(--dim);font-size:12px">规则摘要</div><div style="font-size:13px">' + esc(m.summaryRule) + '</div></div>' : '') +
        (files ? '<details style="margin-top:8px"><summary style="cursor:pointer;color:var(--dim);font-size:12px">涉及的文件（' + m.files.length + '）</summary><div style="margin-top:4px">' + files + '</div></details>' : '') +
        '</div>' +
        '<div class="card"><h3>会话内搜索</h3>' +
        '<div class="filters"><input id="s-q" placeholder="在本会话全部消息中搜关键词（原文匹配）…" style="width:340px"><button id="s-go">搜索</button><span id="s-hint" style="color:var(--dim);font-size:12px"></span></div>' +
        '<div id="s-res"></div></div>' +
        '<div class="card"><h3>决策（点击跳到对应消息）</h3>' + dec + '</div>' +
        ((qs.length) ? '<div class="card"><h3>关键问题（' + unres.length + ' 未决 · 点击跳转）</h3>' + qhtml + '</div>' : '') +
        '<div class="card"><h3>消息流</h3><div id="m-pager-top"></div><div id="msgs"><div class="empty">加载中…</div></div><div id="m-pager-bottom"></div></div>';
      $('s-back').onclick = backToProject;
      $('s-go').onclick = runSessionSearch;
      $('s-q').onkeydown = function (e) { if (e.key === 'Enter') $('s-go').click(); };
      Array.prototype.forEach.call(document.querySelectorAll('.list-item.clickable[data-seq]'), function (el) {
        el.onclick = function () {
          var sq = Number(el.getAttribute('data-seq'));
          if (sq > 0) jumpToSeq(sq);
        };
      });
      // 默认打开末页；带 focusSeq 则跳到所在页
      var maxSeq = m.messageCount;
      var from = s.hlSeq ? Math.floor((s.hlSeq - 1) / MSG_PAGE) * MSG_PAGE + 1 : Math.max(1, Math.floor((maxSeq - 1) / MSG_PAGE) * MSG_PAGE + 1);
      loadSessionMessages(from);
      runSessionSearchIfNeeded();
    }).catch(function (e) {
      $('detail').innerHTML = '<div class="card"><button id="s-back">← 返回项目</button><div class="empty" style="color:var(--bad)">会话加载失败：' + esc(e.message) + '</div></div>';
      $('s-back').onclick = backToProject;
    });
  }

  function runSessionSearchIfNeeded() { /* 占位：搜索状态由用户交互触发 */ }

  function loadSessionMessages(from) {
    var el = $('msgs'); if (!el) return;
    var s = state.sess;
    api('/api/session/messages?root=' + enc(state.sel) + '&id=' + enc(s.id) + '&from=' + from).then(function (d) {
      s.from = d.from;
      var pagerHtml =
        '<button data-nav="first"' + (d.page <= 1 ? ' disabled' : '') + '>首页</button>' +
        '<button data-nav="prev"' + (d.page <= 1 ? ' disabled' : '') + '>上一页</button>' +
        '<span>第 ' + d.page + ' / ' + d.pages + ' 页 · 消息 #' + d.from + '-#' + d.to + ' / 共 ' + d.maxSeq + ' 条</span>' +
        '<button data-nav="next"' + (d.page >= d.pages ? ' disabled' : '') + '>下一页</button>' +
        '<button data-nav="last"' + (d.page >= d.pages ? ' disabled' : '') + '>末页</button>';
      ['m-pager-top', 'm-pager-bottom'].forEach(function (pid) {
        var p = $(pid); if (!p) return;
        p.innerHTML = '<div class="pager">' + pagerHtml + '</div>';
        Array.prototype.forEach.call(p.querySelectorAll('button[data-nav]'), function (b) {
          b.onclick = function () {
            var nav = b.getAttribute('data-nav');
            var f2 = d.from;
            if (nav === 'first') f2 = 1;
            else if (nav === 'prev') f2 = Math.max(1, d.from - MSG_PAGE);
            else if (nav === 'next') f2 = d.from + MSG_PAGE;
            else f2 = Math.floor((d.maxSeq - 1) / MSG_PAGE) * MSG_PAGE + 1;
            s.hlSeq = null;
            loadSessionMessages(f2);
          };
        });
      });
      if (!d.msgs.length) { el.innerHTML = '<div class="empty">无消息</div>'; return; }
      el.innerHTML = d.msgs.map(function (m) {
        var hl = s.hlSeq === m.seq ? ' hl' : '';
        return '<div class="msg' + hl + '" id="msg-' + m.seq + '">' +
          '<div class="msg-head"><span class="sq">#' + m.seq + '</span><span class="badge ' + esc(m.role) + '">' + roleZh(m.role) + '</span><span>' + (m.at ? fmtDate(m.at) : '') + '</span></div>' +
          '<div class="msg-body">' + escMark(m.content, s.kw) + (m.truncated ? '<div class="empty" style="padding:4px 0 0">…（正文超长，已截断显示前 4000 字，全文共 ' + m.fullLen + ' 字——用 srelay show 查看）</div>' : '') + '</div>' +
          '</div>';
      }).join('');
      if (s.hlSeq) {
        var target = $('msg-' + s.hlSeq);
        if (target) target.scrollIntoView({ block: 'center' });
      } else {
        window.scrollTo(0, 0);
      }
    }).catch(function () {});
  }

  function runSessionSearch() {
    var s = state.sess;
    var kw = ($('s-q') ? $('s-q').value : '').trim();
    s.kw = kw;
    var box = $('s-res');
    if (!kw) { s.results = null; s.kw = ''; if (box) box.innerHTML = ''; if ($('s-hint')) $('s-hint').textContent = ''; loadSessionMessages(s.from); return; }
    api('/api/session/search?root=' + enc(state.sel) + '&id=' + enc(s.id) + '&q=' + enc(kw)).then(function (d) {
      s.results = d;
      if ($('s-hint')) $('s-hint').textContent = '命中 ' + d.total + ' 条消息' + (d.total > d.matches.length ? '（仅列出前 ' + d.matches.length + ' 条）' : '');
      if (!d.matches.length) { box.innerHTML = '<div class="empty">本会话无匹配</div>'; return; }
      box.innerHTML = d.matches.map(function (m) {
        return '<div class="sres" data-seq="' + m.seq + '"><div class="sline">#' + m.seq + ' · ' + roleZh(m.role) + (m.at ? ' · ' + fmtDate(m.at) : '') + '</div><div>' + escMark(m.snippet, kw) + '</div></div>';
      }).join('');
      Array.prototype.forEach.call(box.querySelectorAll('.sres'), function (r) {
        r.onclick = function () { jumpToSeq(Number(r.getAttribute('data-seq'))); };
      });
      // 当前页若在视野内顺便高亮
      loadSessionMessages(s.from);
    }).catch(function () {});
  }

  function jumpToSeq(seq) {
    var s = state.sess;
    var from = Math.floor((seq - 1) / MSG_PAGE) * MSG_PAGE + 1;
    s.hlSeq = seq;
    loadSessionMessages(from);
  }

  $('refresh').onclick = function () {
    if (DENIED) return;
    loadOverview();
    if (state.view === 'project' && state.sel) { loadProject(); }
    else if (state.view === 'session' && state.sess.id) { loadSessionMeta(); }
  };
  setInterval(function () { if (!document.hidden && !DENIED) loadOverview(); }, 10000);

  if (!TOKEN) showDeny('需要一次性令牌', '本仪表盘的数据接口需要令牌。请在终端执行 <span class="mono">srelay ui</span>，用它打印的带 <span class="mono">?token=</span> 的链接打开。');
  else loadOverview();
})();
</script>
</body>
</html>
`;
