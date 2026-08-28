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
  decisions: Array<{ text: string; seq: number; at?: string }>;
  questions: Array<{ q: string; seq: number; at?: string; unresolved: boolean }>;
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
  return { manifest, files };
}
