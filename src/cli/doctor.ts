// srelay doctor（技术方案 T12 / §8.7）：自检 + 修复建议
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { segment } from '../core/tokenize/tokenizer.js';
import { loadConfig, claudeProjectsDir, zcodeDbPath } from '../shared/config.js';
import { dbFile, findRelayRoot, ignoreFile } from '../shared/paths.js';
import { ignoreFilePath } from '../capture/ignore.js';
import { isDaemonAlive } from '../shared/lock.js';
import { looksInjected } from '../core/extract/extract.js';
import { EXTRACT_VERSION, extractVersionOf } from '../capture/recompute.js';
import { registryCandidates } from '../shared/registry.js';
import { watchServiceStatus } from './watch.js';
import { detectSources } from './init.js';
import { pc } from './ui.js';

type Level = 'ok' | 'warn' | 'err';
interface Check { name: string; level: Level; detail: string; fix?: string }

/** 收集本机技能/规则文档的正文行（去空白），供"决策是否为文档原文残片"比对用。
 *  只扫常见位置，找不到就返回空数组——比对是增强项，不是必需项。 */
function collectDocLines(): string[] {
  const home = os.homedir();
  const roots = [
    path.join(home, '.dsh', 'skills'),
    path.join(home, '.zcode', 'skills'),
    path.join(home, '.claude', 'skills'),
  ];
  const out: string[] = [];
  // ⚠️ 行数上限必须给足：原为 20000，而本机技能目录一行不落正好 21653 行——
  // 超限后 walk 直接 return，后扫的技能（steel-manning 等）整目录被跳过，
  // doc-echo 对它们的残片污染永久假阴性（安全网有洞比没有更坏）。技能文档总共
  // 就几 MB，doctor 又是按需命令，给 200000 行（约 10 倍余量）毫无负担。
  const walk = (dir: string, depth: number) => {
    if (depth > 3 || out.length > 200000) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full, depth + 1); continue; }
      if (!/\.(md|txt)$/i.test(e.name)) continue;
      try {
        const text = fs.readFileSync(full, 'utf8');
        const lines = text.split(/\r?\n/);
        for (const line of lines) {
          const t = line.replace(/\s+/g, '');
          if (t.length >= 8) out.push(t);
        }
      } catch { /* 读不了跳过 */ }
    }
  };
  for (const r of roots) { if (fs.existsSync(r)) walk(r, 0); }
  return out;
}

export async function cmdDoctor(): Promise<void> {
  const checks: Check[] = [];

  // 1 Node 版本（engines 要求 >=22；better-sqlite3/jieba 预编译按新 ABI 分发）
  const [maj] = process.versions.node.split('.').map(Number);
  checks.push(maj >= 22 ? c('Node 运行时', 'ok', `v${process.versions.node}`) : c('Node 运行时', 'err', `v${process.versions.node} < 22（engines 要求）`, '升级 Node 至 22+'));

  // 2 FTS5
  try {
    const t = new Database(':memory:');
    t.exec('CREATE VIRTUAL TABLE _f USING fts5(x)');
    t.close();
    checks.push(c('SQLite FTS5', 'ok', '可用'));
  } catch (e) {
    checks.push(c('SQLite FTS5', 'err', (e as Error).message, '反馈 issue；或 config.search.tokenizer 改 bigram'));
  }

  // 3 jieba
  try {
    const toks = segment('数据库索引');
    checks.push(toks.length > 0 ? c('中文分词 (jieba)', 'ok', `正常，示例 → ${toks.slice(0, 4).join(' ')}`) : c('中文分词', 'err', '返回空'));
  } catch (e) {
    checks.push(c('中文分词 (jieba)', 'err', (e as Error).message, '重装 @node-rs/jieba'));
  }

  // 4/5 数据源
  const root = findRelayRoot(process.cwd());
  const cfg = root ? loadConfig(root) : null;
  const claudeDir = cfg ? claudeProjectsDir(cfg) : path.join(os.homedir(), '.claude', 'projects');
  checks.push(fs.existsSync(claudeDir)
    ? c('Claude Code 源目录', 'ok', claudeDir)
    : c('Claude Code 源目录', 'warn', `不存在（${claudeDir}）`, '未安装/未使用 Claude Code 可忽略'));
  const zdb = cfg ? zcodeDbPath(cfg) : path.join(os.homedir(), '.zcode', 'cli', 'db', 'db.sqlite');
  if (fs.existsSync(zdb)) {
    try {
      const z = new Database(zdb, { readonly: true });
      z.prepare('SELECT COUNT(*) FROM session').get();
      z.close();
      checks.push(c('ZCode 库（只读探测）', 'ok', zdb));
    } catch (e) {
      checks.push(c('ZCode 库（只读探测）', 'warn', (e as Error).message, 'ZCode 正在写时偶发，重试即可'));
    }
  } else {
    checks.push(c('ZCode 库', 'warn', `不存在（${zdb}）`, '未安装 ZCode 可忽略'));
  }

  // 6 项目初始化与库
  if (!root) {
    checks.push(c('项目初始化', 'warn', '当前目录未初始化', 'srelay init'));
  } else {
    try {
      loadConfig(root);
      checks.push(c('config.json', 'ok', '可解析'));
    } catch (e) {
      checks.push(c('config.json', 'err', (e as Error).message, '删除后 srelay init 重建'));
    }
    if (fs.existsSync(dbFile(root))) {
      try {
        const db = new Database(dbFile(root), { readonly: true });
        const v = db.pragma('integrity_check', { simple: true });
        db.close();
        checks.push(c('relay.sqlite 完整性', v === 'ok' ? 'ok' : 'err', String(v), v === 'ok' ? undefined : 'srelay rebuild（Phase 2 交付）'));
      } catch (e) {
        checks.push(c('relay.sqlite', 'err', (e as Error).message));
      }
    } else {
      checks.push(c('relay.sqlite', 'warn', '不存在', 'srelay init'));
    }
    // [1021 审查 #07 连带] 排除文件路径必须走**唯一解析处**：用户可以在 config 里改 privacy.ignore_file，
    // 这里若还写死 '.sessionrelayignore'，自定义文件存在时也会误报「不存在（无排除规则）」
    // —— 和 #18「检查没覆盖被检查的东西」是同一种病。
    {
      const igPath = ignoreFilePath(root);
      const igName = path.basename(igPath);
      checks.push(fs.existsSync(igPath)
        ? c(igName, 'ok', '存在')
        : c(igName, 'warn', '不存在（无排除规则）'));
    }
    const alive = isDaemonAlive(root);
    if (!alive.alive) {
      checks.push(c('守护进程', 'warn', '未运行', 'srelay watch --install-service 或 srelay sync 兜底'));
      // 静默启动时代的可诊断性（0.4.2）：服务在但守护死了 + 日志有 Error = 上次异常退出
      try {
        const { readLogTail } = await import('./service.js');
        // 内存评估修复：readLogTail 只读尾部 4KB，不再全量 readFileSync
        const tail = readLogTail(root, 4000);
        if (/Error|错误|failed/i.test(tail)) {
          checks.push(c('守护日志', 'warn', '尾部含错误（服务已注册但守护未运行=疑似异常退出）', 'srelay watch --status 看日志尾部'));
        }
      } catch { /* 日志读取失败不阻塞 doctor */ }
    } else {
      checks.push(c('守护进程', 'ok', `运行中 (pid ${alive.pid}) · 服务：${await watchServiceStatus(root)}`));
    }

    // ── 新增检查：Codex / Qoder / Trae / 归档表 / custom 适配器 ──

    // Codex
    const codexDir = path.join(os.homedir(), '.codex');
    checks.push(fs.existsSync(codexDir)
      ? c('Codex 源', 'ok', codexDir)
      : c('Codex 源', 'warn', '未检测到（未安装可忽略）'));

    // Qoder
    const qoderDir = path.join(os.homedir(), '.qoder-cn');
    checks.push(fs.existsSync(qoderDir)
      ? c('Qoder 源', 'ok', qoderDir)
      : c('Qoder 源', 'warn', '未检测到（未安装可忽略）'));

    // Trae（部分支持，AI 回复加密）
    const traeDir = path.join(os.homedir(), 'AppData', 'Roaming', 'Trae CN');
    if (fs.existsSync(traeDir)) {
      checks.push(c('Trae 源', 'warn', `${traeDir}（部分支持：仅用户提问，AI 回复加密）`));
    } else {
      checks.push(c('Trae 源', 'warn', '未检测到（未安装可忽略）'));
    }

    // 归档表（M2 迁移）
    if (fs.existsSync(dbFile(root))) {
      try {
        const db = new Database(dbFile(root), { readonly: true });
        const hasCleanupLog = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cleanup_log'").get();
        const hasCleanupAt = (db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>).some(col => col.name === 'cleanup_at');
        db.close();
        checks.push(hasCleanupLog && hasCleanupAt
          ? c('归档表（M2）', 'ok', 'cleanup_log + cleanup_at 就绪')
          : c('归档表（M2）', 'warn', '缺少表或列', '重新打开库自动迁移'));
      } catch {
        checks.push(c('归档表（M2）', 'warn', '无法检测'));
      }
    }

    // custom 适配器
    const customDir = path.join(root, '.sessionrelay', 'adapters');
    if (fs.existsSync(customDir)) {
      const jsFiles = fs.readdirSync(customDir).filter(f => f.endsWith('.js'));
      checks.push(jsFiles.length > 0
        ? c('Custom 适配器', 'ok', `${jsFiles.length} 个已加载：${jsFiles.map(f => f.replace('.js', '')).join(', ')}`)
        : c('Custom 适配器', 'ok', '目录存在，无自定义适配器'));
    } else {
      checks.push(c('Custom 适配器', 'ok', '无（可在 .sessionrelay/adapters/ 添加）'));
    }
  }

  // 全局项目注册表（design-serve-resolve §5）：预演 serve 多项目解析会选中谁（C6 可诊断闭环）
  try {
    const cands = registryCandidates();
    const alive = cands.filter((x) => x.daemonAlive);
    checks.push(cands.length === 0
      ? c('项目注册表', 'ok', '空（init / 守护运行后自动登记）')
      : alive.length === 1
        ? c('项目注册表', 'ok', `${cands.length} 个候选 · 无配置时 serve 会自动选中「${alive[0].name}」（唯一存活守护）`)
        : c('项目注册表', alive.length > 1 ? 'warn' : 'ok',
            `${cands.length} 个候选 · ${alive.length === 0 ? '无存活守护，serve 不会自动选择' : `${alive.length} 个存活，serve 不会自动猜，需 project 参数显式选`}`));
  } catch (e) {
    checks.push(c('项目注册表', 'warn', (e as Error).message));
  }

  // 语义检索（R7 条件项：未启用=可选提示；启用后查依赖，回填进度在 srelay semantic status）
  if (root) {
    const cfg = loadConfig(root);
    if (cfg.semantic?.enabled === true) {
      const { resolveTransformersEntry, semanticModelOf } = await import('../search-svc/semantic.js');
      const { readSemanticStatus } = await import('../search-svc/semantic-status.js');
      const entry = resolveTransformersEntry();
      const rs = readSemanticStatus();
      if (!entry) {
        checks.push(c('语义检索', 'err', '已启用但 transformers.js 缺失（检索已自动降级纯字面）', 'npm i --prefix ~/.sessionrelay/semantic @huggingface/transformers@3'));
      } else if (rs.state === 'failed') {
        // [1017 夜] 静态依赖在、但**上一次真跑的时候装载失败了** —— 这条以前完全看不见
        checks.push(c('语义检索', 'err', '已启用且依赖在，但上次装载失败（检索已降级纯字面）', '原因：' + String(rs.error).slice(0, 120) + ' · 详查 srelay semantic status'));
      } else {
        checks.push(c('语义检索', 'ok', `已启用（${semanticModelOf(cfg)}）` + (rs.state === 'ready' ? ' · 上次装载成功' : '')));
      }
    } else {
      checks.push(c('语义检索', 'warn', '未启用（可选增强：换词查询也能命中，srelay semantic enable）'));
    }
  }

  // ═══ 记忆质量体检（2026-10-14 加）═══
  // 这一类故障全是**静默**的：库建着、守护活着、status 显示 running，但简报里全是
  // 技能目录垃圾 / 同一条决策重复 N 次 / 历史数据从没按新规则重算。所以单独列出来。
  if (root) {
    // ① 采集源覆盖：本机装着某源但 sources 里没有它 → 该源会话永远采不进去
    // 检测统一走 detectSources()（与 init 同一份事实源），换机器/换目录结构只需改那一处，
    // 不在此复制各源的目录知识（此前硬编码 ~/.dsh/sessions，DSH 之外的源漏检）
    // ⚠️ 必须尊重 capture.ignore_sources：用户可能出于隐私**故意**不采集某个源
    // （红队 1014 🟠8：装着 Trae 但不想采，旧逻辑直接 ❌ + 退出码 1，修复建议还是
    // "补进 sources"——把用户的有意选择当成故障报，比不报更烦）。
    try {
      const configured = cfg?.capture?.sources;
      const src: string[] = Array.isArray(configured) ? configured : [];
      const ignored: string[] = Array.isArray(cfg?.capture?.ignore_sources) ? cfg!.capture!.ignore_sources! : [];
      const installed = detectSources().filter(s => s.installed).map(s => s.id);
      const missing = installed.filter(id => !src.includes(id) && !ignored.includes(id));
      if (missing.length > 0) {
        checks.push(c('采集源覆盖', 'err',
          `capture.sources=[${src.join(',') || '空'}] 缺 ${missing.join(', ')}（本机已安装但未采集，其会话不会入库）`,
          `把 ${missing.join(', ')} 补进 config.json 的 capture.sources；若故意不采，写进 capture.ignore_sources`));
      } else if (installed.length === 0) {
        checks.push(c('采集源覆盖', 'ok', `本机未检测到已安装的采集源（capture.sources=[${src.join(',') || '空'}]）`));
      } else {
        const excl = ignored.filter(id => installed.includes(id));
        checks.push(c('采集源覆盖', 'ok',
          `sources=[${src.join(',')}]${excl.length ? `（已排除 ${excl.join(', ')}）` : ''}`));
      }
    } catch (e) { checks.push(c('采集源覆盖', 'warn', (e as Error).message)); }

    // ①.5 看板（progress.md）：简报里"计划/下一步"的唯一结构化来源
    // 为什么单列一项：b3 的捕获率盘点实测「计划/下一步」只被捕获 3.3%（5763 条未捕获），
    // 而 progress.md 的「进行中/阻塞」列正是这类信息的结构化来源。项目没有它，
    // 简报里就永远没有"现在卡在哪"，而用户不会知道缺了什么。
    try {
      const kanbanPath = path.join(root, 'progress.md');
      if (!fs.existsSync(kanbanPath)) {
        checks.push(c('看板 progress.md', 'warn', '没有 progress.md —— 简报里不会有「进行中/阻塞」段',
          '在项目根建 progress.md，用 | 任务 | 状态 | 模块 | 明细 | 表格；状态列带 ✅🔄⛔ 才会被读取'));
      } else {
        const kt = fs.readFileSync(kanbanPath, "utf8");
        const krows = kt.split(/\r?\n/).map((l) => l.split("|").map((s) => s.trim()))
          .filter((cols) => cols.length >= 5 && /^[✅🔄⛔⬜]/u.test(cols[2] ?? "") && /[🔄⛔]/u.test(cols[2] ?? ""));
        checks.push(krows.length > 0
          ? c('看板 progress.md', 'ok', `有 progress.md，进行中/阻塞 ${krows.length} 行`)
          : c('看板 progress.md', 'warn', 'progress.md 存在，但没有任何带 🔄/⛔ 的行 —— 简报的看板段会是空的',
            '给任务行的状态列加上 ✅/🔄/⛔/⬜（解析器只认这几个 emoji 开头的状态）'));
      }
    } catch (e) { checks.push(c('看板 progress.md', 'warn', (e as Error).message)); }

    // ② 提取版本：库落后于当前规则 → 历史数据还是旧规则算的
    try {
      const db0 = new Database(dbFile(root), { readonly: true });
      const v = extractVersionOf(db0);
      db0.close();
      checks.push(v >= EXTRACT_VERSION
        ? c('提取规则版本', 'ok', `v${v}（当前 v${EXTRACT_VERSION}）`)
        : c('提取规则版本', 'warn', `库是 v${v}，当前规则 v${EXTRACT_VERSION}`, '等守护的重算周期（默认 6 小时）跑完，或手动触发'));
    } catch (e) { checks.push(c('提取规则版本', 'warn', (e as Error).message)); }

    // ③ 记忆污染与重复：直接量简报会看到什么
    try {
      const db = new Database(dbFile(root), { readonly: true });
      const rows = db.prepare(`SELECT decisions, key_questions FROM sessions
        WHERE (decisions IS NOT NULL OR key_questions IS NOT NULL)
          AND (origin IS NULL OR origin != 'workflow')`).all() as Array<{ decisions: string | null; key_questions: string | null }>;
      let decTotal = 0, decInjected = 0, decDocEcho = 0, qTotal = 0, qInjected = 0;
      const seen = new Set<string>();
      let decDup = 0;
      // 残片污染的兜底判定：决策正文是否为某个 SKILL.md / AGENTS.md 的**原文子串**。
      // 为什么需要它：v6 剥的是"成对注入块 + 技能目录行"，但历史上已入库的污染决策
      // 往往只剩无标签残片（"再决定接受、修订或坚持"）——looksInjected 与 stripInjected
      // 严格同源后检不出这类（红队 1014 🟠4 假阴性）。doctor 是低频按需命令，扫一遍
      // 技能目录（几十个文件）完全负担得起，换来"存量污染可见"。
      const docLines = collectDocLines();
      const isDocEcho = (text: unknown) => {
        const t = String(text ?? '').replace(/\s+/g, '');
        if (t.length < 8) return false;
        for (const line of docLines) if (line.includes(t)) return true;
        return false;
      };
      for (const r of rows) {
        try {
          for (const d of JSON.parse(r.decisions ?? '[]')) {
            decTotal++;
            const txt = String(d.text ?? '');
            if (looksInjected(txt)) decInjected++;
            else if (isDocEcho(txt)) decDocEcho++;
            const k = txt.replace(/\s+/g, '').slice(0, 40);
            if (k) { if (seen.has(k)) decDup++; else seen.add(k); }
          }
        } catch { /* 坏行跳过 */ }
        try {
          for (const q of JSON.parse(r.key_questions ?? '[]')) {
            if (!q.unresolved) continue;
            qTotal++;
            if (looksInjected(String(q.q ?? ''))) qInjected++;
          }
        } catch { /* 坏行跳过 */ }
      }
      db.close();
      const injRate = decTotal ? decInjected / decTotal : 0;
      const dupRate = decTotal ? decDup / decTotal : 0;
      const polluted = decInjected + decDocEcho;
      const pollRate = decTotal ? polluted / decTotal : 0;
      checks.push(pollRate > 0.02
        ? c('决策注入污染', 'err',
            `${polluted}/${decTotal} 条决策是注入内容（${(pollRate * 100).toFixed(1)}%：标记残片 ${decInjected} + 文档回显 ${decDocEcho}）`,
            decDocEcho > 0 ? '文档回显=决策正文是某 SKILL.md/AGENTS.md 的原文子串；等重算周期（v6 起剥注入块），或 srelay rebuild 全量重建' : '等重算周期跑完（v6 起会剥掉注入块）；或先 srelay sync 触发')
        : c('决策注入污染', 'ok', decTotal ? `${polluted}/${decTotal} 条` : '暂无决策'));
      checks.push(qInjected > 0
        ? c('未决注入污染', 'warn', `${qInjected}/${qTotal} 条未决是注入内容`, '等重算周期跑完')
        : c('未决注入污染', 'ok', qTotal ? `0/${qTotal} 条` : '暂无未决'));
      // 重复不报 err：listDecisions 已在查询侧去重，这里只是让人知道存量
      checks.push(dupRate > 0.15
        ? c('决策重复率', 'warn', `${decDup}/${decTotal} 条重复（${(dupRate * 100).toFixed(0)}%）`, '查询侧已自动去重，不影响简报；想清库存可 rebuild')
        : c('决策重复率', 'ok', decTotal ? `${decDup}/${decTotal} 条（查询侧已去重）` : '暂无决策'));
    } catch (e) { checks.push(c('记忆质量', 'warn', (e as Error).message)); }
  }

  for (const k of checks) {
    const icon = k.level === 'ok' ? pc.green('✅') : k.level === 'warn' ? pc.yellow('⚠️ ') : pc.red('❌');
    console.log(`${icon} ${k.name.padEnd(18)} ${k.detail}${k.fix ? pc.dim(`  → ${k.fix}`) : ''}`);
  }
  const errs = checks.filter((k) => k.level === 'err').length;
  const warns = checks.filter((k) => k.level === 'warn').length;
  console.log(pc.dim(`\n${checks.length} 项检查：${checks.length - errs - warns} 通过 · ${warns} 提示 · ${errs} 失败`));
  if (errs > 0) process.exit(1);

  function c(name: string, level: Level, detail: string, fix?: string): Check { return { name, level, detail, fix }; }
}
