// 脱敏引擎（方针 §10.4/D9：导出默认开启；--no-redact 显式关闭）
import { createHash } from 'node:crypto';

export interface RedactHit { pattern: string; count: number }
export interface RedactResult { text: string; hits: RedactHit[] }

interface Pattern { name: string; re: RegExp; replacement: string }

const PATTERNS: Pattern[] = [
  { name: 'aws-access-key', re: /AKIA[0-9A-Z]{16}/g, replacement: '[已脱敏:aws-key]' },
  { name: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, replacement: '[已脱敏:private-key]' },
  { name: 'bearer-token', re: /\bBearer\s+[A-Za-z0-9\-._~+/=]{8,}/g, replacement: '[已脱敏:bearer]' },
  { name: 'secret-assign', re: /\b(password|passwd|secret|api[_-]?key|access[_-]?key|token)\b\s*[:=]\s*("[^"]{4,}"|'[^']{4,}'|[^\s,;，；}]{4,})/gi, replacement: '$1=[已脱敏]' },
  { name: 'db-conn', re: /\b(mysql|postgres(ql)?|redis|mongodb(\+srv)?|amqp):\/\/[^\s@]+@[^\s"']+/gi, replacement: '$1://[已脱敏]@…' },
];

export function redactText(text: string): RedactResult {
  let out = text;
  const hits: RedactHit[] = [];
  for (const p of PATTERNS) {
    const before = out;
    out = out.replace(p.re, p.replacement);
    const count = countMatches(before, p.re);
    if (count > 0) hits.push({ pattern: p.name, count });
  }
  return { text: out, hits };
}

function countMatches(text: string, re: RegExp): number {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  let n = 0;
  while (g.exec(text) !== null) n++;
  return n;
}

export function sha256Hex(data: string | Uint8Array): string {
  return 'sha256:' + createHash('sha256').update(data).digest('hex');
}
