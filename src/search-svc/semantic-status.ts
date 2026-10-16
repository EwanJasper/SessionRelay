// 语义档的**运行期状态**（跨进程可读）——「容错不许静默」的落地处
//
// 为什么需要它（1017 夜实测出的洞）：
//   semantic.ts 的 getEmbedder 失败时是 `catch { return null }` —— 调用方把 null 当成
//   「没启用」，于是**「启用了但坏了」与「没启用」在运行期完全分不清**：
//   用户看到的是"检索好像变差了"，没有任何提示。这正是本项目第一号故障模式。
//   静态检查（resolveTransformersEntry 能不能解析到依赖）只能覆盖"没装"这一种失败；
//   模型下载失败/缓存损坏/内存不足/换模型后首次加载失败 —— 全都看不见。
//
// 为什么是一个**文件**而不是进程内变量：
//   三条链路分别在三个进程里跑 —— CLI（一次性）、守护（常驻）、DSH 宿主（常驻），
//   面板还要在宿主里读它。进程内变量跨不过去，落盘才跨得过去。
//
// ⚠️ 本模块**零依赖**（只用 node 内置）：面板宿主半要 import 它，而面板插件不允许带原生模块。
//   任何往这里加 import 的改动都会把面板拖垮 —— 有测试钉住（panel-snapshot.spec.ts）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 语义档的家目录。SRELAY_SEMANTIC_HOME 可覆盖（测试与多环境隔离用）。
 *
 * 注意：绝不能用 ~/.sessionrelay —— findRelayRoot 向上探测的就是该目录名，
 * 在家目录创建它会把用户主目录误判为"已初始化项目"（实测踩过，见 semantic.ts 旧注释）。 */
export const semanticCacheDir = (): string =>
  process.env.SRELAY_SEMANTIC_HOME || path.join(os.homedir(), '.sessionrelay-semantic');

export const semanticStatusFile = (): string => path.join(semanticCacheDir(), 'status.json');

export type SemanticState = 'never' | 'off' | 'ready' | 'failed' | 'unloaded';

export interface SemanticRuntimeStatus {
  /** never = 从没启用过；off = 配置里就是关的；ready = 装载成功；failed = 尝试过但失败；unloaded = 空闲卸载 */
  state: SemanticState;
  model: string | null;
  /** 失败原因（人话）。state=failed 时必有 */
  error: string | null;
  /** 最后一次**尝试**加载的时间 */
  attemptAt: string | null;
  /** 最后一次**成功**装载的时间 */
  loadedAt: string | null;
  /** 最后一次被使用的时间（空闲卸载看它） */
  usedAt: string | null;
  /** 最后一次卸载的时间 */
  unloadedAt: string | null;
  /** 累计装载成功 / 失败次数（同一个进程里的服务期也算） */
  loads: number;
  failures: number;
  /** 写这条状态的是谁（便于排查"到底哪个进程在报"） */
  by: string;
}

const EMPTY: SemanticRuntimeStatus = {
  state: 'never', model: null, error: null, attemptAt: null, loadedAt: null,
  usedAt: null, unloadedAt: null, loads: 0, failures: 0, by: '',
};

/** 读运行期状态。文件不存在/坏了都返回 EMPTY —— **读侧不抛**（它只用于展示与提示）。 */
export function readSemanticStatus(): SemanticRuntimeStatus {
  try {
    const raw = JSON.parse(fs.readFileSync(semanticStatusFile(), 'utf8')) as Partial<SemanticRuntimeStatus>;
    return { ...EMPTY, ...raw };
  } catch {
    return { ...EMPTY };
  }
}

/**
 * 记一次状态变化（合并写）。**永不抛**：语义档的状态记录绝不该成为新的失败源。
 * @param patch 只写变化的字段；其余保留。
 */
export function recordSemantic(patch: Partial<SemanticRuntimeStatus> & { state: SemanticState }): void {
  try {
    const cur = readSemanticStatus();
    const now = new Date().toISOString();
    const next: SemanticRuntimeStatus = { ...cur, ...patch };
    next.by = patch.by ?? (process.title || 'node');
    if (patch.state === 'ready') { next.loadedAt = now; next.loads = cur.loads + 1; next.error = null; }
    if (patch.state === 'failed') { next.failures = cur.failures + 1; next.attemptAt = now; }
    if (patch.attemptAt === undefined && (patch.state === 'ready' || patch.state === 'failed')) next.attemptAt = now;
    if (patch.state === 'unloaded') next.unloadedAt = now;
    fs.mkdirSync(semanticCacheDir(), { recursive: true });
    fs.writeFileSync(semanticStatusFile(), JSON.stringify(next, null, 2) + '\n', 'utf8');
  } catch { /* 状态写不进去也不许影响检索 */ }
}

/** 一句话人话摘要（CLI / 面板 / doctor 共用同一句，免得三处各写一套） */
export function describeSemantic(s: SemanticRuntimeStatus, enabled: boolean | null, depOk?: boolean): string {
  // enabled === null：调用方不知道这个开关（面板看到的是一台机器上所有项目，开关是按项目的）
  if (enabled === false) return '未启用（可选增强：换词查询也能命中，srelay semantic enable）';
  const prefix = enabled === null ? '（本机共享的运行期状态；开关是按项目开的）' : '';
  if (depOk === false) return prefix + '已启用但 transformers.js 缺失 —— **检索已降级为纯字面**，装回来才会恢复';
  switch (s.state) {
    case 'ready': return prefix + '装载成功' + (s.model ? '（' + s.model + '）' : '');
    case 'failed': return prefix + '**装载失败** —— 检索已降级为纯字面。原因：' + (s.error || '未知');
    case 'unloaded': return prefix + '上次空闲卸载了，下次用到时自动重装';
    case 'off': return prefix + '已启用但当前进程尚未装载（首次用到时才加载）';
    default: return prefix + '还没有跑过检索，不知道能不能起来（跑一次 srelay search 就知道）';
  }
}
