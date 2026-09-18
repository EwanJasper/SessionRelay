// srelay watch：守护入口（服务注册三平台实现在 cli/service.ts）
import fs from 'node:fs';
import { loadConfig } from '../shared/config.js';
import { isDaemonAlive } from '../shared/lock.js';
import { runWatch } from '../capture/watch.js';
import { findRelayRoot } from '../shared/paths.js';
import { touchRegistry } from '../shared/registry.js';
import { pc } from './ui.js';
import { installWatchService, uninstallWatchService, watchServiceStatus, watchLogPath, rotateWatchLog, readLogTail } from './service.js';

export async function cmdWatch(opts: { foreground?: boolean; installService?: boolean; uninstall?: boolean; status?: boolean }): Promise<void> {
  // watch 默认前台运行（服务与手动皆同路径）
  const root = process.cwd();
  if (opts.uninstall) return uninstallWatchService(root);
  if (opts.status) {
    const alive = isDaemonAlive(root);
    console.log(`守护：${alive.alive ? pc.green(`运行中 (pid ${alive.pid})`) : pc.red('未运行')} · 服务：${await watchServiceStatus(root)}`);
    // 静默启动后报错的可诊断出口：日志尾部（用户教训——闪框有信号，纯静默=故障不可见）
    const rr = findRelayRoot(root);
    if (rr) {
      const tail = readLogTail(rr, 2048).trimEnd().split('\n').slice(-3);
      if (tail.some((l) => l.trim())) {
        console.log(pc.dim('日志尾部（' + watchLogPath(rr).replace(/\\/g, '/') + '）：'));
        for (const line of tail) console.log(pc.dim('  ' + line));
      }
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
  rotateWatchLog(rr); // 启动时轮转
  // 长驻不重启也要轮转（内存评估修复：启动时轮转挡不住开机到关机的堆积）——每小时一查
  const rotator = setInterval(() => rotateWatchLog(rr), 3_600_000);
  rotator.unref(); // 不阻塞进程退出
  // 注册表心跳（design-serve-resolve §5）：告诉 serve"这个项目的守护活着"——多项目自动选择的唯一自动信号
  touchRegistry(rr);
  const heartbeat = setInterval(() => touchRegistry(rr), 10 * 60_000);
  heartbeat.unref();
  await runWatch({ projectRoot: rr, config: loadConfig(rr) });
}

// 兼容旧导入（init/doctor/status 引用）——实现在 service.ts
export { installWatchService, uninstallWatchService, watchServiceStatus };
