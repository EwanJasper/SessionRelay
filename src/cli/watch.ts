// srelay watch：守护入口（服务注册三平台实现在 cli/service.ts）
import fs from 'node:fs';
import { loadConfig } from '../shared/config.js';
import { isDaemonAlive } from '../shared/lock.js';
import { runWatch } from '../capture/watch.js';
import { findRelayRoot } from '../shared/paths.js';
import { pc } from './ui.js';
import { installWatchService, uninstallWatchService, watchServiceStatus, watchLogPath, rotateWatchLog } from './service.js';

export async function cmdWatch(opts: { foreground?: boolean; installService?: boolean; uninstall?: boolean; status?: boolean }): Promise<void> {
  // watch 默认前台运行（服务与手动皆同路径）
  const root = process.cwd();
  if (opts.uninstall) return uninstallWatchService(root);
  if (opts.status) {
    const alive = isDaemonAlive(root);
    console.log(`守护：${alive.alive ? pc.green(`运行中 (pid ${alive.pid})`) : pc.red('未运行')} · 服务：${await watchServiceStatus(root)}`);
    // 静默启动后报错的可诊断出口：日志尾部（用户教训——闪框有信号，纯静默=故障不可见）
    const logFile = findRelayRoot(root) ? watchLogPath(findRelayRoot(root)!) : null;
    if (logFile && fs.existsSync(logFile)) {
      const tail = fs.readFileSync(logFile, 'utf8').trimEnd().split('\n').slice(-3);
      console.log(pc.dim('日志尾部（' + logFile.replace(/\\/g, '/') + '）：'));
      for (const line of tail) console.log(pc.dim('  ' + line));
    }
    return;
  }
  if (opts.installService) return installWatchService(root);
  // 前台守护：要求已初始化
  const rr = findRelayRoot(root);
  if (!rr) {
    console.log(pc.red('✗ 未找到 .sessionrelay，请先 srelay init'));
    process.exit(1);
  }
  rotateWatchLog(rr); // 服务化输出无限追加，启动时自轮转（三平台统一由 node 自理）
  await runWatch({ projectRoot: rr, config: loadConfig(rr) });
}

// 兼容旧导入（init/doctor/status 引用）——实现在 service.ts
export { installWatchService, uninstallWatchService, watchServiceStatus };
