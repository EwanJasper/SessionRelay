// 脱敏引擎（方针 §10.4/D9：导出默认开启；--no-redact 显式关闭）
//
// 覆盖范围（**如实界定，不声称覆盖一切**——这是"默认脱敏"，不是安全边界）：
//   · 已知厂商密钥格式：AWS AccessKey、PEM 私钥块、Bearer 令牌、裸 JWT
//   · **键值型凭据**：password/passwd/pwd/secret/*secret/api_key/apikey/access_key/access_token/
//     auth_token/refresh_token/token/private_key，值支持三种形态：
//     双引号（JSON）、单引号（Python dict / JS 对象）、裸值（env 赋值 / YAML / URL 查询串）
//   · 带凭据的数据库连接串（mysql/postgres/redis/mongodb/amqp 的 user:pass@）
// 明确**不覆盖**：任意非上述键名的自定义凭据（如 SAUCE_CRED、my_weird_key）、被切成多段的密钥、
//   图片/二进制里的内容、以及"看起来不像密钥"的口令。需要更强的保证就别导出，或用 forget 抹掉。
// 每次导出的命中条目会写进 summary/redaction-report.txt（pattern×次数），可复核。
import { createHash } from 'node:crypto';

export interface RedactHit { pattern: string; count: number }
export interface RedactResult { text: string; hits: RedactHit[] }

interface Pattern { name: string; re: RegExp; replacement: string }

/**
 * 密钥类字段的**键名清单**（判据只许有一份：下面三条正则共用它，别各写一套）。
 * 增删只改这里。
 */
const SECRET_KEYS = [
  'password', 'passwd', 'pwd', 'secret', 'client[_-]?secret', 'api[_-]?key', 'apikey',
  'access[_-]?key', 'access[_-]?token', 'auth[_-]?token', 'refresh[_-]?token', 'token', 'private[_-]?key',
].join('|');
/** 键名（可带 JSON 的引号）+ 分隔符；后面的值由三条正则分别处理 */
const SECRET_HEAD = String.raw`\b(?:${SECRET_KEYS})\b["']?\s*[:=]\s*`;

const PATTERNS: Pattern[] = [
  { name: 'aws-access-key', re: /AKIA[0-9A-Z]{16}/g, replacement: '[已脱敏:aws-key]' },
  { name: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, replacement: '[已脱敏:private-key]' },
  { name: 'bearer-token', re: /\bBearer\s+[A-Za-z0-9\-._~+/=]{8,}/g, replacement: '[已脱敏:bearer]' },
  // [1021 审查 #08] 结构化键值格式（JSON / 单引号 dict / YAML）漏检修复：
  //   病历：原正则把键名与分隔符写成 `key\s*[:=]`，要求 key 后**紧跟**冒号；而 JSON 是
  //   {"api_key":"值"} —— key 后面还隔着**收尾引号**，于是整类 JSON 一条都不命中
  //   （复现：api_key=SYNTHETIC 命中 1；{"api_key":"SYNTHETIC"} 命中 0）。
  //   修法：键名后允许一个可选引号（SECRET_HEAD），值按**引号种类**分三条正则，
  //   前缀整体保留（$1），只把值换掉 —— 这样报告里还能看出是哪一行的哪个键。
  { name: 'secret-json-dq', re: new RegExp('(' + SECRET_HEAD + ')"(?:[^"\\\\]|\\\\.){4,}"', 'gi'), replacement: '$1"[已脱敏]"' },
  { name: 'secret-json-sq', re: new RegExp("(" + SECRET_HEAD + ")'(?:[^'\\\\]|\\\\.){4,}'", 'gi'), replacement: "$1'[已脱敏]'" },
  // 裸值（= / : 之后不带引号）：负向断言排除引号开头，避免把上面两条已处理的值再啃一半
  { name: 'secret-assign', re: new RegExp('(' + SECRET_HEAD + ')(?!["\'])[^\\s,;，；}\\]]{4,}', 'gi'), replacement: '$1[已脱敏]' },
  { name: 'db-conn', re: /\b(mysql|postgres(ql)?|redis|mongodb(\+srv)?|amqp):\/\/[^\s@]+@[^\s"']+/gi, replacement: '$1://[已脱敏]@…' },
  // 裸 JWT（Bearer 前缀之外的粘贴形态）：三段 base64url，头段恒为 eyJ
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, replacement: '[已脱敏:jwt]' },
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
