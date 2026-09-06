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

