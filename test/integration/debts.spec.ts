// 欠账清偿测试：save（D2 并存）/ rebuild（原则4+T31）/ export markdown/summary / --json（T14）
import { describe, it, expect, beforeAll, afterAll, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createDb, dbFile, insertSession, insertMessage, confirmSession, listSessions,
         countMessages, getSessionFull, insertImportedSession, insertImportedMessage } from '../../src/store/db.js';
import { defaultConfig, saveConfig, type RelayConfig } from '../../src/shared/config.js';
import { projectIdOf } from '../../src/shared/paths.js';
import { runRebuild } from '../../src/capture/rebuild.js';
import { runExportMarkdown, runExport } from '../../src/relay/export.js';
import { searchSessions } from '../../src/search-svc/engine.js';
import { cmdSave } from '../../src/cli/save.js';
import { cmdStatus } from '../../src/cli/status.js';

const TMP = path.resolve('test/.tmp/debts');
const PROJECT = path.join(TMP, 'app');
const CLAUDE_BASE = path.join(TMP, 'claude-projects');
const PID = projectIdOf(PROJECT);
const ORIG_CWD = process.cwd();

const claudeLine = (i: number, role: 'user' | 'assistant', text: string) =>
  JSON.stringify({ type: role, message: { role, content: text }, timestamp: `2026-08-2${Math.min(8, 1 + i % 8)}T10:00:00Z`, sessionId: 'x' });

function writeClaudeSession(id: string, lines: string[]) {
  const dir = path.join(CLAUDE_BASE, PROJECT.replace(/[\\/:]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), lines.join('\n') + '\n');
}

function cfg(over: Partial<RelayConfig['capture']> = {}): RelayConfig {
  return {
    ...defaultConfig(),
    identity: { project_id: PID },
    capture: { ...defaultConfig().capture, claude_projects_dir: CLAUDE_BASE, zcode_db_path: 'Z:\\无', sources: ['claude-code'], ...over },
  };
}

beforeAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(path.join(PROJECT, '.sessionrelay'), { recursive: true });
  saveConfig(PROJECT, cfg({ mode: 'off' })); // off 模式：save 是唯一入口（D2 验收）
  createDb(dbFile(PROJECT)).close(); // init 等价：建库建表
});
afterAll(() => { fs.rmSync(TMP, { recursive: true, force: true }); });
afterEach(() => { vi.restoreAllMocks(); process.chdir(ORIG_CWD); });

describe('欠账1 · srelay save（并存范式，off 模式唯一入口）', () => {
  it('save <id>：入库 origin=manual + 立即 confirmed（提取摘要）+ --tag/--summary 持久化', async () => {
    writeClaudeSession('sv1', [
      claudeLine(1, 'user', '认证方案怎么选？'),
      claudeLine(2, 'assistant', '决定采用 JWT 做认证，文件 src/auth/jwt.ts'),
    ]);
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a) => logs.push(a.join(' ')));
    process.chdir(PROJECT);
    await cmdSave({ id: 'sv1', tag: '架构决策,认证', summary: '定了JWT', json: true });
    const out = JSON.parse(logs[logs.length - 1]) as { saved: number };
    expect(out.saved).toBe(1);

    const db = createDb(dbFile(PROJECT));
    const row = listSessions(db, { projectId: PID }).find((r) => r.source_session_id === 'sv1')!;
    expect(row.state).toBe('confirmed');
    expect(row.origin).toBe('manual');
    expect(row.summary_rule).toContain('JWT');
    const full = getSessionFull(db, row.id)!;
    expect(full.userTags.sort()).toEqual(['架构决策', '认证']);
    expect(full.summaryRule).toBeTruthy();
    // 手动摘要层（D7）：user_summary
    const us = db.prepare('SELECT user_summary FROM sessions WHERE id=?').get(row.id) as { user_summary: string | null };
    expect(us.user_summary).toBe('定了JWT');
    db.close();
  });

  it('ignore 硬边界对手动 save 同样生效', async () => {
    writeClaudeSession('sv2', [claudeLine(1, 'user', '薪资调整讨论')]);
    fs.writeFileSync(path.join(PROJECT, '.sessionrelayignore'), 'title:薪资\n');
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a) => logs.push(a.join(' ')));
    process.chdir(PROJECT);
    await cmdSave({ id: 'sv2', json: true });
    const out = JSON.parse(logs[logs.length - 1]) as { saved: number; blocked: number };
    expect(out.saved).toBe(0);
    expect(out.blocked).toBe(1);
    const db = createDb(dbFile(PROJECT));
    expect(listSessions(db, { projectId: PID }).some((r) => r.source_session_id === 'sv2')).toBe(false);
    db.close();
    fs.rmSync(path.join(PROJECT, '.sessionrelayignore'));
  });
});

describe('欠账2 · rebuild（源是事实源，库可重建）', () => {
  it('全量重建：auto 重摄、imported 搬迁、FTS 可搜、旧库 .bak 保留', async () => {
    // 先切回 full 并 sync 入库 sv1
    saveConfig(PROJECT, cfg({ mode: 'full' }));
    const { runSync } = await import('../../src/capture/sync.js');
    let db = createDb(dbFile(PROJECT));
    db.close();
    fs.rmSync(dbFile(PROJECT), { force: true }); // 重建干净起点
    db = createDb(dbFile(PROJECT));
    await runSync({ projectRoot: PROJECT, config: cfg(), db });
    // 加一个 imported 会话（无本地源，rebuild 唯一搬不了的类别）
    const imp = insertImportedSession(db, {
      source: 'zcode', sourceSessionId: 'imp-z1', projectId: PID, title: '外部导入的会话',
      createdAt: '2026-08-01T08:00:00Z', lastEventAt: '2026-08-01T09:00:00Z', messageCount: 1,
      topics: [], decisions: [], summaryRule: null, author: '同事', importedFrom: '李四',
      originProject: 'proj_other', contentHash: 'sha256:fixed', sourceFile: null,
    });
    insertImportedMessage(db, imp.id, { seq: 1, role: 'user', content: '外部讨论跨集群部署' });
    db.close();

    const r = await runRebuild({ root: PROJECT, cfg: cfg(), force: true });
    expect(r.autoSessions).toBeGreaterThanOrEqual(1);      // sv1 重摄
    expect(r.importedPreserved).toBe(1);                    // imported 搬迁
    expect(fs.existsSync(r.bakFile)).toBe(true);

    db = createDb(dbFile(PROJECT));
    const rows = listSessions(db, { projectId: PID });
    expect(rows.some((x) => x.source_session_id === 'sv1' && x.state === 'confirmed')).toBe(true);
    const imported = rows.find((x) => x.source_session_id === 'imp-z1')!;
    expect(imported.origin).toBe('imported');
    expect(countMessages(db, imported.id)).toBe(1);
    // T31：FTS 重建后正文可搜（auto + imported 两类）
    expect(searchSessions(db, { project: PID, query: 'JWT' }).length).toBeGreaterThanOrEqual(1);
    expect(searchSessions(db, { project: PID, query: '跨集群' }).length).toBe(1);
    db.close();
  });
});

describe('欠账4 · export --format markdown / summary', () => {
  it('markdown：HANDOFF 直出含决策与署名；summary 无会话细节段', async () => {
    const db = createDb(dbFile(PROJECT));
    const mdPath = path.join(TMP, 'HANDOFF.md');
    const sPath = path.join(TMP, 'SUMMARY.md');
    const md = runExportMarkdown({ root: PROJECT, cfg: cfg(), db, all: true, output: mdPath });
    const sm = runExportMarkdown({ root: PROJECT, cfg: cfg(), db, all: true, output: sPath, summaryOnly: true });
    const mdText = fs.readFileSync(mdPath, 'utf8');
    const smText = fs.readFileSync(sPath, 'utf8');
    expect(md.sessionCount).toBeGreaterThanOrEqual(2);
    expect(mdText).toContain('# 项目交接文档');
    expect(mdText).toContain('决定采用 JWT');
    expect(mdText).toContain('由会话接力 SessionRelay 生成');
    expect(smText).toContain('关键决策');
    expect(smText).not.toContain('## 📖 会话摘要'); // 精简版无逐会话细节
    db.close();
  });
});

describe('欠账5 · --json 契约（T14）', () => {
  it('status --json：结构化输出可解析', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a) => logs.push(a.join(' ')));
    process.chdir(PROJECT);
    await cmdStatus({ json: true });
    const out = JSON.parse(logs[logs.length - 1]) as {
      mode: string; sessions: { total: number; confirmed: number }; daemon: { alive: boolean };
    };
    expect(out.mode).toBe('full');
    expect(out.sessions.total).toBeGreaterThanOrEqual(2);
    expect(typeof out.daemon.alive).toBe('boolean');
  });
});
