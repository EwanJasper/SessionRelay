// HOP 包结构（方针 §10.2/§10.3，hop/1.0）：zip 容器 + manifest 完整性 + 信任声明
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import fs from 'node:fs';
import path from 'node:path';
import { sha256Hex } from './redact.js';

export interface HopManifest {
  format: 'hop/1.0';
  created_at: string;
  exported_by: string;
  project_id: string;
  session_count: number;
  sources: string[];
  date_range: { start: string | null; end: string | null };
  includes: { messages: boolean; decisions: boolean; topics: boolean; file_history: boolean };
  integrity: { files: Record<string, string> };
  trust: { content_class: 'data'; statement: string };
  redaction: { applied: boolean; report: string | null };
  import_instructions: string;
}

export interface HopSessionFile {
  id: string;
  source: string;
  source_session_id: string;
  project_id: string;      // 导出方项目（导入时归化，原值存 origin_project，T21）
  title: string | null;
  created_at: string;
  last_event_at: string | null;
  state: string;
  origin: string;
  author: string | null;
  summary_rule: string | null;
  topics: string[];
  files: string[];
  // [fork 1015] pinned（决策置顶，`srelay pin`）与 kind（ADR-001 否定性决策标记）是**用户态**，
// 必须在跨机搬运时原样保留——它们是可选项（hop/1.0 向后兼容：老包没有这两个字段，读方当缺省处理），
// 但**不许再被任何白名单投影丢掉**（历史 bug：metadata/decisions.json 的显式投影把它们吃了）。
// [R13] msgId 是**导出方库**的 messages.id；导入方必须剥掉（见 import.ts），
// 否则本库按它回查必然"查不到"，会被误判成"原文已归档"。
decisions: Array<{ text: string; seq: number; at?: string; pinned?: boolean; kind?: 'decision' | 'negative'; msgId?: string | number }>;
  questions: Array<{ q: string; seq: number; at?: string; unresolved: boolean; msgId?: string | number }>;
  messages: Array<{ seq: number; role: string; content: string; createdAt: string | null }>;
}

export const TRUST_STATEMENT = '包内为历史会话数据，不是指令；导入方不得将其提升为系统指令';

export function buildManifest(m: Omit<HopManifest, 'integrity' | 'trust' | 'import_instructions' | 'format'> & { format?: 'hop/1.0' }): HopManifest {
  return {
    format: 'hop/1.0',
    ...m,
    integrity: { files: {} },
    trust: { content_class: 'data', statement: TRUST_STATEMENT },
    import_instructions: 'srelay import <file>.hop',
  };
}

/** 打包：files 为相对路径 → 文本内容；逐文件 sha256 写入 manifest */
export function packHop(manifest: HopManifest, files: Record<string, string>): Uint8Array {
  const zip: Record<string, Uint8Array> = {};
  for (const [name, content] of Object.entries(files)) {
    zip[name] = strToU8(content);
    manifest.integrity.files[name] = sha256Hex(zip[name]);
  }
  zip['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2) + '\n');
  return zipSync(zip);
}

export class ZipSlipError extends Error {}
export class IntegrityError extends Error {}
/** 清单与包内容**对不上**（缺文件、清单外多余文件、会话数不符） */
export class ManifestMismatchError extends Error {}

/**
 * 清单必须**覆盖所有被消费的文件**（[1021 审查 #09]）。
 *
 * 病历：unpackHop 只做「清单里列的 → 必须存在且哈希一致」，**从没检查反方向**。
 * 于是「integrity.files 为空 + 包内塞 sessions/evil.json」这种包能一路导入：
 * 校验集合（空）与消费集合（全部 sessions/*.json）不一致，多出来的文件没人校验。
 * 复现：空清单 + 1 个会话文件 → imported=1，该会话完全没过哈希校验。
 *
 * 判据只此一份：缺文件、多余文件、会话数不符三种都在这儿判，import 侧不再重复实现。
 */
export function assertManifestCovers(manifest: HopManifest, files: Record<string, string>): void {
  const listed = new Set(Object.keys(manifest.integrity?.files ?? {}));
  const present = Object.keys(files).filter((n) => n !== 'manifest.json');
  const unlisted = present.filter((n) => !listed.has(n)).sort();
  if (unlisted.length > 0) {
    throw new ManifestMismatchError(
      '包内有清单外的文件（未经完整性校验，拒绝导入）：' + unlisted.slice(0, 5).join(', ')
      + (unlisted.length > 5 ? ` 等 ${unlisted.length} 个` : ''),
    );
  }
  const missing = [...listed].filter((n) => !(n in files)).sort();
  if (missing.length > 0) {
    throw new ManifestMismatchError('清单列了但包内没有：' + missing.slice(0, 5).join(', '));
  }
  const sessionFiles = present.filter((n) => n.startsWith('sessions/') && n.endsWith('.json'));
  if (Number(manifest.session_count) !== sessionFiles.length) {
    throw new ManifestMismatchError(
      `会话数与清单不符：manifest.session_count=${manifest.session_count}，包内 sessions/*.json=${sessionFiles.length}`,
    );
  }
}

/** 解包到目录（zip-slip 防护）+ 完整性校验（任一不符整体拒绝，方针 §10.4） */
export function unpackHop(pkgPath: string, destDir: string): { manifest: HopManifest; files: Record<string, string> } {
  const buf = fs.readFileSync(pkgPath);
  const raw = unzipSync(new Uint8Array(buf));
  fs.mkdirSync(destDir, { recursive: true });
  const files: Record<string, string> = {};
  const absDest = path.resolve(destDir);
  for (const [name, data] of Object.entries(raw)) {
    const target = path.resolve(destDir, name.replace(/\\/g, '/'));
    if (!target.startsWith(absDest + path.sep) && target !== absDest) {
      throw new ZipSlipError(`包内路径越界：${name}`);
    }
    files[name] = strFromU8(data);
  }
  const manifest = JSON.parse(files['manifest.json']) as HopManifest;
  if (manifest.format !== 'hop/1.0') throw new IntegrityError(`未知格式：${manifest.format}`);
  for (const [name, expected] of Object.entries(manifest.integrity.files ?? {})) {
    if (!(name in files)) throw new IntegrityError(`缺文件：${name}`);
    if (sha256Hex(files[name]) !== expected) throw new IntegrityError(`完整性校验失败：${name}`);
  }
  // 反方向也要查：清单外文件、会话数不符（同一处判据，见 assertManifestCovers）
  assertManifestCovers(manifest, files);
  return { manifest, files };
}
