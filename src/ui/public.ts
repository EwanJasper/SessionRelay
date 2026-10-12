// ui 仪表盘前端（design-dashboard U2/U7）：单 HTML 内联于 TS，tsup 一并打包——
// files 清单零改动、check:artifacts 零风险、无路径解析问题。
// 约定：模板字符串内部不得出现反引号与 ${}（内层 JS 一律用 '+' 拼接）。
// v1.2：会话详情下钻 + 会话内关键词搜索 + 健康卡片。
// v1.3：可交互增长图（悬停浮层/网格线/指标切换/点柱下钻当天会话）+ 自定义下拉组件。
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
  .chartwrap { overflow-x:auto; position:relative; }
  .chart-top { display:flex; align-items:center; gap:10px; margin-bottom:10px; flex-wrap:wrap; }
  .chart-top h3 { margin:0; margin-right:auto; }
  .seg { display:inline-flex; border:1px solid var(--line); border-radius:8px; overflow:hidden; }
  .seg button { border:none; border-radius:0; padding:3px 12px; font-size:12px; background:var(--card); }
  .seg button.on { background:#eef2ff; color:var(--accent); font-weight:600; }
  #gtip { display:none; position:absolute; background:#1f2430; color:#fff; font-size:12px; padding:5px 10px; border-radius:6px; pointer-events:none; z-index:15; white-space:nowrap; box-shadow:0 4px 14px rgba(0,0,0,.2); }
  rect.bar { cursor:pointer; transition:opacity .12s; }
  rect.bar:hover { opacity:.68; }
  .gridline { stroke:#eef0f3; stroke-width:1; }
  .axlabel { font-size:10px; fill:#9aa1ab; }
  .empty { color:var(--dim); font-size:13px; padding:8px 0; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th, td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--dim); font-weight:500; font-size:12px; }
  td.title { max-width:420px; }
  td .snippet { color:var(--dim); font-size:12px; margin-top:2px; }
  tr.clickable { cursor:pointer; }
  tr.clickable:hover td { background:#f8f9ff; }
  .filters { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:10px; align-items:center; }
  .filters input { font:inherit; padding:4px 10px; border:1px solid var(--line); border-radius:8px; background:var(--card); width:220px; }
  .filters input:focus { outline:none; border-color:var(--accent); box-shadow:0 0 0 2px #3b5bdb22; }
  .pager { display:flex; align-items:center; gap:10px; margin-top:8px; color:var(--dim); font-size:12px; flex-wrap:wrap; }
  .mono { font-family:Consolas,monospace; font-size:12px; }
  .list-item { padding:6px 0; border-bottom:1px dashed var(--line); font-size:13px; }
  .list-item:last-child { border-bottom:none; }
  .list-item .src { color:var(--dim); font-size:12px; margin-right:8px; }
  .list-item.clickable { cursor:pointer; }
  .list-item.clickable:hover .t { color:var(--accent); }
  #deny { display:none; position:fixed; inset:0; background:#f8fafc; z-index:30; align-items:center; justify-content:center; flex-direction:column; gap:8px; }
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
  .dd { position:relative; display:inline-block; }
  .dd-btn { font:inherit; font-size:13px; padding:4px 28px 4px 12px; border:1px solid var(--line); border-radius:8px; background:var(--card); cursor:pointer; min-width:110px; text-align:left; position:relative; color:var(--fg); }
  .dd-btn:hover, .dd.open .dd-btn { border-color:var(--accent); }
  .dd-btn:after { content:''; position:absolute; right:10px; top:50%; margin-top:-2px; border-left:4px solid transparent; border-right:4px solid transparent; border-top:5px solid var(--dim); }
  .dd-menu { display:none; position:absolute; top:calc(100% + 4px); left:0; z-index:20; background:var(--card); border:1px solid var(--line); border-radius:8px; box-shadow:0 8px 28px rgba(31,36,48,.14); padding:4px; min-width:100%; max-height:260px; overflow:auto; }
  .dd.open .dd-menu { display:block; }
  .dd-item { padding:6px 12px; border-radius:6px; cursor:pointer; font-size:13px; }
  .dd-item:hover { background:#f1f3f5; }
  .dd-item.sel { color:var(--accent); font-weight:600; background:#eef2ff; }
  .chip { display:inline-flex; align-items:center; gap:4px; background:#eef2ff; color:var(--accent); border-radius:99px; padding:2px 4px 2px 12px; font-size:12px; font-family:Consolas,monospace; }
  .chip button { border:none; background:none; padding:1px 7px; color:var(--accent); cursor:pointer; font-size:12px; border-radius:99px; }
  .chip button:hover { background:#dbe4ff; }
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
    projects: [], sel: null, sessFilter: { state: '', source: '', q: '', day: '' }, page: 1, days: 30, metric: 'msgs',
    bySourceKeys: [],
    view: 'project',
    sess: { id: null, meta: null, from: 1, kw: '', results: null, hlSeq: null },
    growthData: null
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

  // ── 自定义下拉组件（v1.3：替换原生 select）──
  function closeAllDD(except) {
    Array.prototype.forEach.call(document.querySelectorAll('.dd.open'), function (d) {
      if (d !== except) d.classList.remove('open');
    });
  }
  document.addEventListener('click', function (e) {
    if (!e.target.closest || !e.target.closest('.dd')) closeAllDD(null);
  });
  function mountDD(mountId, options, value, onChange) {
    var mount = $(mountId); if (!mount) return;
    var cur = '';
    for (var i = 0; i < options.length; i++) if (options[i].v === value) cur = options[i].label;
    mount.innerHTML = '<div class="dd"><button type="button" class="dd-btn">' + esc(cur || options[0].label) + '</button>' +
      '<div class="dd-menu">' + options.map(function (o) {
        return '<div class="dd-item' + (o.v === value ? ' sel' : '') + '" data-v="' + esc(o.v) + '">' + esc(o.label) + '</div>';
      }).join('') + '</div></div>';
    var ddEl = mount.firstChild;
    var btn = ddEl.querySelector('.dd-btn');
    btn.onclick = function (e) {
      e.stopPropagation();
      var isOpen = ddEl.classList.contains('open');
      closeAllDD(ddEl);
      if (!isOpen) ddEl.classList.add('open');
    };
    Array.prototype.forEach.call(ddEl.querySelectorAll('.dd-item'), function (item) {
      item.onclick = function (e) {
        e.stopPropagation();
        ddEl.classList.remove('open');
        if (item.getAttribute('data-v') === String(value)) return;
        onChange(item.getAttribute('data-v'));
      };
    });
  }

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
    state.sel = root; state.view = 'project'; state.page = 1;
    state.sessFilter = { state: '', source: '', q: '', day: '' };
    renderSidebar();
    loadProject();
  }

  function loadProject() {
    api('/api/project?root=' + enc(state.sel)).then(function (d) {
      state.bySourceKeys = Object.keys(d.bySource);
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
        '<div class="card"><div class="chart-top"><h3>增长趋势</h3>' +
        '<div class="seg" id="g-metric"><button data-m="msgs">消息</button><button data-m="sess">新会话</button></div>' +
        '<span id="g-range"></span></div>' +
        '<div class="chartwrap" id="growth"><div class="empty">加载中…</div></div></div>' +
        '<div class="card"><h3>会话（点击行进入会话详情）</h3><div id="sess"></div></div>' +
        '<div class="card"><h3>最近决策（点击跳到对应会话）</h3>' + dec + '</div>' +
        '<div class="card"><h3>未决问题（点击跳到对应会话）</h3>' + unres + '</div>' +
        '<div class="card"><h3>健康 · 守护日志尾部</h3><div id="health"><div class="empty">加载中…</div></div></div>';
      Array.prototype.forEach.call(document.querySelectorAll('.list-item.clickable'), function (el) {
        el.onclick = function () { openSession(el.getAttribute('data-sid')); };
      });
      wireGrowthControls();
      loadGrowth(); loadSessions(); loadHealth();
    }).catch(function () {});
  }

  function wireGrowthControls() {
    var seg = $('g-metric'); if (!seg) return;
    Array.prototype.forEach.call(seg.querySelectorAll('button'), function (b) {
      b.onclick = function () {
        state.metric = b.getAttribute('data-m');
        wireGrowthControls();
        renderGrowthChart();
      };
      if (b.getAttribute('data-m') === state.metric) b.classList.add('on'); else b.classList.remove('on');
    });
    mountDD('g-range',
      [{ v: '30', label: '近 30 天' }, { v: '60', label: '近 60 天' }, { v: '90', label: '近 90 天' }],
      String(state.days),
      function (v) { state.days = Number(v); loadGrowth(); });
  }

  function niceCeil(n) {
    if (n <= 5) return 5;
    var pow = Math.pow(10, Math.floor(Math.log10(n)));
    for (var i = 1; i <= 5; i++) { var c = [1, 2, 2.5, 5, 10][i] * pow; if (c >= n) return c; }
    return 10 * pow;
  }

  function loadGrowth() {
    var el = $('growth'); if (!el) return;
    api('/api/project/growth?root=' + enc(state.sel) + '&days=' + state.days).then(function (d) {
      state.growthData = d;
      renderGrowthChart();
    }).catch(function () {});
  }

  function renderGrowthChart() {
    var el = $('growth'); if (!el) return;
    var d = state.growthData;
    if (!d) { el.innerHTML = '<div class="empty">加载中…</div>'; return; }
    if (!d.length) { el.innerHTML = '<div class="empty">窗口内无数据</div>'; return; }
    var kw = state.metric === 'msgs' ? 'msgs' : 'sess';
    var unit = state.metric === 'msgs' ? '条消息' : '个会话';
    var H = 210, bw = 16, gap = 8, padL = 38, padB = 26, padT = 14;
    var W = Math.max(640, d.length * (bw + gap) + padL + 12);
    var nice = niceCeil(Math.max.apply(null, d.map(function (x) { return x[kw]; })));
    var s = '<div style="position:relative;min-width:' + W + 'px">' +
      '<div id="gtip"></div>' +
      '<svg width="' + W + '" height="' + H + '" style="display:block">';
    for (var g = 0; g <= 4; g++) {
      var gy = padT + (H - padT - padB) * (1 - g / 4);
      var gv = Math.round(nice * g / 4 * 10) / 10;
      s += '<line class="gridline" x1="' + padL + '" y1="' + gy + '" x2="' + (W - 8) + '" y2="' + gy + '"/>' +
        '<text class="axlabel" x="' + (padL - 7) + '" y="' + (gy + 3) + '" text-anchor="end">' + gv + '</text>';
    }
    var step = Math.max(1, Math.ceil(d.length / 10));
    for (var j = 0; j < d.length; j++) {
      var v = d[j][kw];
      var h = v <= 0 ? 0 : Math.max(2, Math.round(v / nice * (H - padT - padB)));
      var x = padL + j * (bw + gap) + 4, y = H - padB - h;
      s += '<rect class="bar" data-i="' + j + '" x="' + x + '" y="' + y + '" width="' + bw + '" height="' + h + '" rx="3" fill="#3b5bdb"></rect>';
      if (j % step === 0) s += '<text class="axlabel" x="' + (x + bw / 2) + '" y="' + (H - 8) + '" text-anchor="middle">' + d[j].date.slice(5) + '</text>';
    }
    s += '</svg></div>';
    el.innerHTML = s;
    var tip = $('gtip');
    var wrap = el;
    Array.prototype.forEach.call(el.querySelectorAll('rect.bar'), function (r) {
      var i = Number(r.getAttribute('data-i'));
      r.addEventListener('mouseenter', function () {
        var wr = wrap.getBoundingClientRect(), br = r.getBoundingClientRect();
        tip.textContent = d[i].date + ' · ' + d[i].msgs + ' 条消息 · ' + d[i].sess + ' 个会话活跃 · 点击下钻';
        tip.style.display = 'block';
        var tx = br.left - wr.left + br.width / 2 - tip.offsetWidth / 2;
        if (tx < 2) tx = 2;
        if (tx + tip.offsetWidth > wr.scrollWidth - 2) tx = wr.scrollWidth - tip.offsetWidth - 2;
        tip.style.left = tx + 'px';
        tip.style.top = Math.max(0, br.top - wr.top - tip.offsetHeight - 6) + 'px';
      });
      r.addEventListener('mouseleave', function () { tip.style.display = 'none'; });
      r.addEventListener('click', function () { drillDay(d[i].date); });
    });
  }

  function drillDay(date) {
    state.sessFilter = { state: '', source: '', q: '', day: date };
    state.page = 1;
    loadSessions();
    var card = $('sess');
    if (card && card.closest) { var c = card.closest('.card'); if (c) c.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
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

  function loadSessions() {
    var el = $('sess'); if (!el || state.view !== 'project') return;
    var f = state.sessFilter;
    var qs = 'root=' + enc(state.sel) + '&page=' + state.page +
      (f.state ? '&state=' + enc(f.state) : '') +
      (f.source ? '&source=' + enc(f.source) : '') +
      (f.q ? '&q=' + enc(f.q) : '') +
      (f.day ? '&day=' + enc(f.day) : '');
    api('/api/project/sessions?' + qs).then(function (d) {
      var stateOpts = [{ v: '', label: '全部状态' }].concat(
        ['active', 'pending_end', 'confirmed', 'archived'].map(function (x) { return { v: x, label: stateZh(x) }; }));
      var sourceOpts = [{ v: '', label: '全部来源' }].concat(
        state.bySourceKeys.map(function (x) { return { v: x, label: x }; }));
      var rows = d.rows.map(function (r) {
        return '<tr class="clickable" data-sid="' + esc(r.id) + '"><td class="mono">' + esc(r.id.slice(0, 8)) + '</td><td>' + esc(r.source) + '</td><td>' + stateZh(r.state) +
          '</td><td class="title">' + esc(r.title || '（无标题）') + (r.snippet ? '<div class="snippet">' + esc(r.snippet) + '</div>' : '') +
          '</td><td>' + r.messageCount + '</td><td style="color:var(--dim)">' + fmtAgo(r.lastEventAt) + '</td></tr>';
      }).join('');
      el.innerHTML =
        '<div class="filters">' +
        '<span id="dd-state"></span>' +
        '<span id="dd-source"></span>' +
        '<input id="f-q" placeholder="项目内全文搜索（FTS）" value="' + esc(f.q) + '">' +
        '<button id="f-go">查询</button>' +
        (f.day ? '<span class="chip">当天 ' + esc(f.day) + '<button id="chip-x" title="清除日期过滤">✕</button></span>' : '') +
        '</div>' +
        (rows ? '<table><tr><th>ID</th><th>来源</th><th>状态</th><th>标题</th><th>消息</th><th>最近活动</th></tr>' + rows + '</table>' : '<div class="empty">无匹配会话</div>') +
        '<div class="pager"><button id="pg-prev"' + (state.page <= 1 ? ' disabled' : '') + '>上一页</button>' +
        '<span>第 ' + d.page + ' 页' + (d.hasMore ? ' · 有更多' : '') + (f.day ? ' · 已按 ' + esc(f.day) + ' 过滤' : '') + '</span>' +
        '<button id="pg-next"' + (d.hasMore ? '' : ' disabled') + '>下一页</button>' +
        (d.mode === 'search' ? '<span>（搜索结果最多 50 条）</span>' : '') + '</div>';
      mountDD('dd-state', stateOpts, f.state, function (v) {
        state.sessFilter.state = v; state.page = 1; loadSessions();
      });
      mountDD('dd-source', sourceOpts, f.source, function (v) {
        state.sessFilter.source = v; state.page = 1; loadSessions();
      });
      $('f-go').onclick = function () {
        state.sessFilter.q = $('f-q').value.trim();
        if (state.sessFilter.q) state.sessFilter.day = '';
        state.page = 1; loadSessions();
      };
      $('f-q').onkeydown = function (e) { if (e.key === 'Enter') $('f-go').click(); };
      var cx = $('chip-x');
      if (cx) cx.onclick = function () { state.sessFilter.day = ''; state.page = 1; loadSessions(); };
      $('pg-prev').onclick = function () { if (state.page > 1) { state.page--; loadSessions(); } };
      $('pg-next').onclick = function () { if (d.hasMore) { state.page++; loadSessions(); } };
      Array.prototype.forEach.call(el.querySelectorAll('tr.clickable'), function (tr) {
        tr.onclick = function () { openSession(tr.getAttribute('data-sid')); };
      });
    }).catch(function () {});
  }

  // ── 会话详情 ──
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
        ((qs.length) ? '<div class="card"><h3>关键问题（点击跳转）</h3>' + qhtml + '</div>' : '') +
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
      var maxSeq = m.messageCount;
      var from = s.hlSeq ? Math.floor((s.hlSeq - 1) / MSG_PAGE) * MSG_PAGE + 1 : Math.max(1, Math.floor((maxSeq - 1) / MSG_PAGE) * MSG_PAGE + 1);
      loadSessionMessages(from);
    }).catch(function (e) {
      $('detail').innerHTML = '<div class="card"><button id="s-back">← 返回项目</button><div class="empty" style="color:var(--bad)">会话加载失败：' + esc(e.message) + '</div></div>';
      $('s-back').onclick = backToProject;
    });
  }

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
