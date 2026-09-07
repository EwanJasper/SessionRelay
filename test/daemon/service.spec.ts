// 守护服务注册（三平台）：纯函数内容断言 + 平台化集成策略
// CI 策略：macos runner 真装真卸（launchd 是 macOS init，runner 必有）；
// linux 只做 systemd-analyze verify 语法校验（runner 的 user systemd 不可靠，避免 flaky）；
// windows 已有本机手动验证 + 现网用户，内容断言覆盖。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildLaunchdPlist, buildSystemdUnit, serviceId, launchdPlistPath, systemdUnitPath, buildWatchArgs } from '../../src/cli/service.js';

const ROOT = path.resolve('/tmp/fake-project'); // 内容断言与平台无关
const NODE = process.execPath;
const ARGS = [NODE, 'cli.js', 'watch', '--foreground'];

describe('daemon service · 内容生成（纯函数，全平台跑）', () => {
  it('S1 launchd plist：Label/RunAtLoad/ProgramArguments/WorkingDirectory 齐全且 XML 转义', () => {
    const xml = buildLaunchdPlist(ROOT, NODE, ARGS);
    expect(xml).toContain(`com.sessionrelay.watch-${serviceId(ROOT)}`);
    expect(xml).toContain('<key>RunAtLoad</key>');
    expect(xml).toContain(`<string>${ROOT}</string>`); // WorkingDirectory
    for (const a of ARGS) expect(xml).toContain(a);
    // 路径含 & < > 时转义（Windows 风格路径注入 plist 的防线）
    const evil = buildLaunchdPlist('/tmp/a&b<c>', NODE, ARGS);
    expect(evil).toContain('&amp;');
    expect(evil).toContain('&lt;');
  });

  it('S2 systemd unit：ExecStart 引号转义 + WantedBy=default.target + Restart 显式关闭', () => {
    const unit = buildSystemdUnit(ROOT, NODE, ARGS);
    expect(unit).toContain('WantedBy=default.target');
    expect(unit).toContain('Restart=no'); // 与 Windows Run 键行为对齐：不做崩溃重启
    expect(unit).toContain(`WorkingDirectory=${ROOT}`);
    expect(unit).toMatch(/ExecStart=.+watch --foreground/);
    // 含空格的参数必须带引号
    const spaced = buildSystemdUnit(ROOT, '/path with space/node', ['a b']);
    expect(spaced).toContain('"/path with space/node"');
    expect(spaced).toContain('"a b"');
  });

  it('S3 serviceId：同 root 稳定、跨 root 不同、非法字符清洗', () => {
    expect(serviceId(ROOT)).toBe(serviceId(ROOT));
    expect(serviceId('/a')).not.toBe(serviceId('/b'));
    expect(serviceId('C:\\Users\\测试\\项目')).not.toMatch(/[\\/:]/); // slug 后无路径分隔符
  });

  it('S4 路径派生：plist 与 unit 落在用户目录约定位置', () => {
    expect(launchdPlistPath(ROOT)).toContain(path.join(os.homedir(), 'Library', 'LaunchAgents'));
    expect(systemdUnitPath(ROOT)).toContain(path.join(os.homedir(), '.config', 'systemd', 'user'));
  });

  it('S5 buildWatchArgs：dev/prod 两形态都以 watch --foreground 收尾', () => {
    const args = buildWatchArgs(ROOT);
    expect(args.slice(-2)).toEqual(['watch', '--foreground']);
  });
});

// 平台集成（真实安装循环）仅在 darwin 跑：launchd 是 macOS init，CI runner 必有；
// 其余平台内容断言已覆盖（windows 本机现网验证，linux runner user systemd 不可靠）。
describe.skipIf(process.platform !== 'darwin')('daemon service · macOS 真装循环', () => {
  it('S6 install → status 已注册 → uninstall → status 未注册', async () => {
    const { installWatchService, uninstallWatchService, watchServiceStatus } = await import('../../src/cli/service.js');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'srelay-svc-'));
    fs.mkdirSync(path.join(tmp, '.sessionrelay'), { recursive: true });
    try {
      await installWatchService(tmp);
      expect(await watchServiceStatus(tmp)).toBe('已注册');
      expect(fs.existsSync(launchdPlistPath(tmp))).toBe(true);
      await uninstallWatchService(tmp);
      expect(fs.existsSync(launchdPlistPath(tmp))).toBe(false);
      expect(await watchServiceStatus(tmp)).not.toBe('已注册');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 30000);
});


describe('daemon service · 守护入口稳定性（chunk-hash 事故回归）', () => {
  it('S7 入口解析：绝不指向带 hash 的 chunk 文件（dist 重建后失效的根因）', async () => {
    const { resolveWatchEntry } = await import('../../src/cli/service.js');
    const { entry } = resolveWatchEntry();
    // chunk 文件名模式：name-HASH.js（tsup 产物）——入口若匹配此模式即回归
    expect(path.basename(entry)).not.toMatch(/-[A-Z0-9]{8}\.js$/);
    // dev 模式指向源码入口；prod 模式必须是稳定的 dist/srelay.js
    const isDev = entry.endsWith('.ts');
    if (isDev) {
      expect(entry.endsWith(path.join('src', 'bin', 'srelay.ts'))).toBe(true);
    } else {
      expect(entry.endsWith(path.join('dist', 'srelay.js'))).toBe(true);
    }
    expect(fs.existsSync(entry)).toBe(true);
  });

  it('S8 windowsSilentVbs：引用 cmd 且以隐藏窗口启动（参数 0 = 闪黑框修复）', async () => {
    const { windowsSilentVbs } = await import('../../src/cli/service.js');
    const vbs = windowsSilentVbs('C:\\x\\watch-task.cmd');
    expect(vbs).toContain(', 0, False'); // 0 = 隐藏窗口
    expect(vbs).toContain('watch-task.cmd');
    expect(vbs).toContain('Wscript.Shell');
  });

  it('S9 prod 分支：假 chunk URL 解析出同目录稳定 srelay.js（dev 形态测不到的路径）', async () => {
    const { resolveWatchEntryFrom } = await import('../../src/cli/service.js');
    // 模拟打包形态：import.meta.url 是 <pkg>/dist/chunk-HASH.js
    const fakeChunkUrl = new URL(`file:///${path.join(path.resolve('dist'), 'chunk-ABCD1234.js').replace(/\\/g, '/')}`).href;
    const r = resolveWatchEntryFrom(fakeChunkUrl);
    expect(r.entry.endsWith(path.join('dist', 'srelay.js'))).toBe(true); // 与 chunk 同目录，稳定文件名
    expect(r.entry).not.toContain('chunk-');
    expect(r.exists).toBe(true); // 本仓库 dist 刚构建过，srelay.js 真实存在
  });
});

describe('daemon service · 日志可见性（0.4.2：静默启动必须有诊断出口）', () => {
  it('S10 vbs 引用 cmd + 日志路径约定', async () => {
    const { windowsSilentVbs, watchLogPath } = await import('../../src/cli/service.js');
    const vbs = windowsSilentVbs('C:\\x\\watch-task.cmd');
    expect(vbs).toContain('watch-task.cmd');
    expect(watchLogPath('/tmp/proj')).toMatch(/watch\.log$/);
  });

  it('S10b launchd plist / systemd unit 均指向 watch.log', async () => {
    const { buildLaunchdPlist, buildSystemdUnit, watchLogPath } = await import('../../src/cli/service.js');
    const log = watchLogPath(ROOT);
    const plist = buildLaunchdPlist(ROOT, NODE, ARGS);
    expect(plist).toContain('StandardOutPath');
    expect(plist).toContain('StandardErrorPath');
    expect(plist).toContain(log.replace(/&/g, '&amp;'));
    const unit = buildSystemdUnit(ROOT, NODE, ARGS);
    expect(unit).toContain(`StandardOutput=append:${log}`);
    expect(unit).toContain(`StandardError=append:${log}`);
  });

  it('S11 rotateWatchLog：超 1MB 截断留尾 100KB，未超不动', async () => {
    const { rotateWatchLog, watchLogPath } = await import('../../src/cli/service.js');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'srelay-log-'));
    fs.mkdirSync(path.join(tmp, '.sessionrelay'), { recursive: true });
    try {
      const log = watchLogPath(tmp);
      // 未超阈值：不轮转
      fs.writeFileSync(log, 'x'.repeat(1000));
      expect(rotateWatchLog(tmp)).toBe(false);
      // 超 1MB：截断保留尾部
      fs.writeFileSync(log, 'HEAD-MARKER' + 'y'.repeat(2_000_000) + 'TAIL-MARKER');
      expect(rotateWatchLog(tmp)).toBe(true);
      const after = fs.readFileSync(log, 'utf8');
      expect(after.length).toBeLessThan(200_000);
      expect(after).toContain('TAIL-MARKER'); // 尾部保留
      expect(after).not.toContain('HEAD-MARKER'); // 头部丢弃
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('S12 readLogTail：只读尾部——大文件堆占用 O(bytes) 与文件大小无关（内存评估回归）', async () => {
    const { readLogTail, watchLogPath } = await import('../../src/cli/service.js');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'srelay-tail-'));
    fs.mkdirSync(path.join(tmp, '.sessionrelay'), { recursive: true });
    try {
      const log = watchLogPath(tmp);
      // 不存在：空串不抛
      expect(readLogTail(tmp)).toBe('');
      // 5MB 日志：读 2KB 尾部，堆增量应远小于文件大小
      fs.writeFileSync(log, 'z'.repeat(5_000_000) + '\nTAIL-LINE-1\nTAIL-LINE-2\n');
      const before = process.memoryUsage().heapUsed;
      const tail = readLogTail(tmp, 2048);
      const delta = process.memoryUsage().heapUsed - before;
      expect(tail).toContain('TAIL-LINE-2'); // 尾部内容正确
      expect(tail.length).toBeLessThanOrEqual(4096); // 读取量受控（全量读会是 5MB 字符串）
      expect(delta).toBeLessThan(1024 * 1024); // 堆增量 <1MB（旧实现全量读 ≈ 5MB+）
      // 小于 bytes 的文件：全文返回
      fs.writeFileSync(log, 'short');
      expect(readLogTail(tmp, 2048)).toBe('short');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
