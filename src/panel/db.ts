// 面板用的**只读**数据库句柄（最小接口）
//
// 为什么不是直接用 store/db.ts 的 better-sqlite3：
//   面板的宿主半跑在 DSH 进程里，那里没有 better-sqlite3 的原生二进制（也不该为一个只读面板
//   塞 27MB 原生依赖进插件）。node:sqlite 是 Node 22.5+ 内置，读 WAL 库与 better-sqlite3 同一格式，
//   零依赖。
// 为什么是"最小接口"而不是各自写 SQL：
//   取数逻辑（SQL + 口径）只在 panel/snapshot.ts 一份；本文件只负责"把库打开成那个形状"。
//   于是同一份取数在三个地方跑同一份代码：CLI/测试（better-sqlite3 或 node:sqlite）、插件、
//   ses-serve 应急入口。
//
// ⚠️ 打不开就是打不开：**不许静默降级成空数据**（本项目头号故障模式）。调用方拿到的是异常或
//   明确列在 errors[] 里的失败原因。

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';

export interface ReadonlyStmt {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
}

export interface ReadonlyDb {
  prepare(sql: string): ReadonlyStmt;
  close(): void;
}

export interface OpenReport {
  db: ReadonlyDb | null;
  driver: 'node:sqlite' | 'better-sqlite3' | null;
  error: string | null;
}

function tryNodeSqlite(file: string): ReadonlyDb | null {
  try {
    // 同步取：node:sqlite 在 Node 22.5+ 才有，本模块仍要能在 22.x 下被 import（拿到 null 而已）
    const req = createRequire(import.meta.url);
    const { DatabaseSync } = req('node:sqlite') as { DatabaseSync: new (f: string, o?: Record<string, unknown>) => ReadonlyDb };
    return new DatabaseSync(file, { readOnly: true });
  } catch { return null; }
}

function tryBetterSqlite(file: string): ReadonlyDb | null {
  try {
    const req = createRequire(import.meta.url);
    const mod = req('better-sqlite3') as { default?: new (f: string, o?: Record<string, unknown>) => ReadonlyDb } | (new (f: string, o?: Record<string, unknown>) => ReadonlyDb);
    const Ctor = (typeof mod === 'function' ? mod : mod.default) as new (f: string, o?: Record<string, unknown>) => ReadonlyDb;
    return new Ctor(file, { readonly: true, fileMustExist: true });
  } catch { return null; }
}

/** 只读打开一个 SQLite 文件；两个驱动都失败时 db=null 且 error 有话说 */
export function openReadonly(file: string): OpenReport {
  if (!existsSync(file)) return { db: null, driver: null, error: '库文件不存在：' + file };
  const n = tryNodeSqlite(file);
  if (n) return { db: n, driver: 'node:sqlite', error: null };
  const b = tryBetterSqlite(file);
  if (b) return { db: b, driver: 'better-sqlite3', error: null };
  return { db: null, driver: null, error: '两个只读驱动都打不开：' + file + '（node:sqlite 与 better-sqlite3 均不可用）' };
}

/** 拿一个句柄就必须还 —— 用 withDb 而不是手工 close（异常路径最容易漏） */
export function withDb<T>(file: string, fn: (db: ReadonlyDb) => T, onError?: (msg: string) => void): T | null {
  const o = openReadonly(file);
  if (!o.db) { if (onError) onError(String(o.error)); return null; }
  try { return fn(o.db); }
  catch (e) { if (onError) onError(String((e as Error)?.message ?? e)); return null; }
  finally { try { o.db.close(); } catch { /* 关不上不影响结果 */ } }
}
