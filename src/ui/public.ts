// ui 仪表盘前端（design-dashboard U2/U7）：单 HTML 内联于 TS，tsup 一并打包——
// files 清单零改动、check:artifacts 零风险、无路径解析问题。
// 约定：模板字符串内部不得出现反引号与 ${}（内层 JS 一律用 '+' 拼接）。
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
  .filters { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:10px; }
  .filters select, .filters input { font:inherit; padding:4px 8px; border:1px solid var(--line); border-radius:8px; background:var(--card); }
  .filters input { width:220px; }
  .pager { display:flex; align-items:center; gap:10px; margin-top:8px; color:var(--dim); font-size:12px; }
  .mono { font-family:Consolas,monospace; font-size:12px; }
  .list-item { padding:6px 0; border-bottom:1px dashed var(--line); font-size:13px; }
  .list-item:last-child { border-bottom:none; }
  .list-item .src { color:var(--dim); font-size:12px; margin-right:8px; }
  #deny { display:none; position:fixed; inset:0; background:#f8fafc; z-index:9; align-items:center; justify-content:center; flex-direction:column; gap:8px; }
  footer { text-align:center; color:var(--dim); font-size:12px; padding:10px 0 24px; }
  @media (max-width:900px){ main{flex-direction:column} aside{width:100%} }
</style>
</head>
<body>
<div id="deny"><h2>令牌无效</h2><div class="empty">请从终端重新执行 <span class="mono">srelay ui</span>，用打印的 URL 打开。</div></div>
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
  var t0 = new URLSearchParams(location.search).get('token');
  if (t0) { sessionStorage.setItem('srelay-token', t0); history.replaceState(null, '', '/'); }
  TOKEN = sessionStorage.getItem('srelay-token');

  var state = { projects: [], sel: null, sources: [], sessFilter: { state: '', source: '', q: '' }, page: 1, days: 30 };

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
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
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
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

  function api(path) {
    return fetch(path, { headers: { 'X-Srelay-Token': TOKEN || '' } })
      .then(function (r) {
        if (r.status === 403) { $('deny').style.display = 'flex'; throw new Error('deny'); }
        return r.json();
      })
      .then(function (j) { if (!j.ok) throw new Error(j.error || 'api error'); return j.data; });
  }

  // ── 总览 ──
  function loadOverview(selKeep) {
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
    state.sel = root; state.page = 1; state.sessFilter = { state: '', source: '', q: '' };
    renderSidebar();
    loadProject(); loadSessions(); loadGrowth();
  }

  function loadProject() {
    api('/api/project?root=' + encodeURIComponent(state.sel)).then(function (d) {
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
        return '<div class="list-item"><span class="src">' + fmtDate(x.at) + ' · ' + esc(x.source) + '</span>' + esc(x.text) + '</div>';
      }).join('') : '<div class="empty">暂无已确认决策</div>';
      var unres = d.unresolved.length ? d.unresolved.map(function (x) {
        return '<div class="list-item"><span class="src">' + fmtAgo(x.at) + ' · ' + esc(x.source) + '</span>' + esc(x.q) + '</div>';
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
        '<div class="card"><h3>会话</h3><div id="sess"></div></div>' +
        '<div class="card"><h3>最近决策</h3>' + dec + '</div>' +
        '<div class="card"><h3>未决问题</h3>' + unres + '</div>';
      // 重挂详情区后补挂增长与会话
      loadGrowth(); loadSessions();
    }).catch(function () {});
  }

  function loadGrowth() {
    var el = $('growth'); if (!el) return;
    api('/api/project/growth?root=' + encodeURIComponent(state.sel) + '&days=' + state.days).then(function (d) {
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
    var el = $('sess'); if (!el) return;
    var f = state.sessFilter;
    var qs = 'root=' + encodeURIComponent(state.sel) + '&page=' + state.page +
      (f.state ? '&state=' + encodeURIComponent(f.state) : '') +
      (f.source ? '&source=' + encodeURIComponent(f.source) : '') +
      (f.q ? '&q=' + encodeURIComponent(f.q) : '');
    api('/api/project/sessions?' + qs).then(function (d) {
      state.sources = Object.keys(d.rows.reduce(function (m, r) { m[r.source] = 1; return m; }, {}));
      var srcOpts = '<option value="">全部来源</option>';
      var seen = {};
      for (var i = 0; i < d.rows.length; i++) seen[d.rows[i].source] = 1;
      for (var k in seen) srcOpts += '<option value="' + esc(k) + '"' + (f.source === k ? ' selected' : '') + '>' + esc(k) + '</option>';
      var stOpts = '<option value="">全部状态</option>';
      var sts = ['active', 'pending_end', 'confirmed', 'archived'];
      for (var j = 0; j < sts.length; j++) stOpts += '<option value="' + sts[j] + '"' + (f.state === sts[j] ? ' selected' : '') + '>' + stateZh(sts[j]) + '</option>';
      var rows = d.rows.map(function (r) {
        return '<tr><td class="mono">' + esc(r.id.slice(0, 8)) + '</td><td>' + esc(r.source) + '</td><td>' + stateZh(r.state) +
          '</td><td class="title">' + esc(r.title || '（无标题）') + (r.snippet ? '<div class="snippet">' + esc(r.snippet) + '</div>' : '') +
          '</td><td>' + r.messageCount + '</td><td style="color:var(--dim)">' + fmtAgo(r.lastEventAt) + '</td></tr>';
      }).join('');
      el.innerHTML =
        '<div class="filters">' +
        '<select id="f-state">' + stOpts + '</select>' +
        '<select id="f-source">' + srcOpts + '</select>' +
        '<input id="f-q" placeholder="关键词搜索（FTS）" value="' + esc(f.q) + '">' +
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
    }).catch(function () {});
  }

  $('refresh').onclick = function () {
    loadOverview(true);
    if (state.sel) { loadProject(); loadSessions(); loadGrowth(); }
  };
  setInterval(function () { if (!document.hidden) loadOverview(true); }, 10000);

  if (!TOKEN) $('deny').style.display = 'flex';
  else loadOverview();
})();
</script>
</body>
</html>
`;
