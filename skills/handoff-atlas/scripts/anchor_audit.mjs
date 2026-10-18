#!/usr/bin/env node
// anchor_audit.mjs — 交接文档锚点审计（handoff-atlas 技能 §5 / progress-anchor 配套）
// 新会话开场跑一遍：抽查入口交接里引用的文件路径 / git commit 是否真实存在。
// 红 = 锚失效（证据缺失或笔误），先处置再开工。
//
// 用法: node anchor_audit.mjs <入口交接.md> [项目根目录]
//       node anchor_audit.mjs --chain <交接所在目录>      # 枚举交接链全清单（B1 必写项，不用手抄）
// 退出码: 0=全部锚点通过  1=存在失效锚点  2=用法错误
//
// v3（2026-10-15）起因：一次真实交接实测 **6/53 报红全是解析口径**，不是证据缺失。
// 四类口径误报自动降级（⚪ 提示、不计入退出码），一类真问题增强：
//   ① 占位符写法（<项目>/v<版本>-<时间>.json + 同句里的 latest.json）→ ⚪
//   ② 通配符写法（docs/1015-*.md）→ 真去盘上展开：有匹配=⚪（附匹配数）；零匹配=❌
//   ③ 项目外工具（技能目录里的 anchor_audit.mjs 等）→ ⚪ 并给出真实路径
//   ④ 被误当 commit 的哈希（16/32 位 md5、整行带"指纹/sha"字样）→ 不当 commit
//   增强：commit 在**嵌套仓库**（如 core/X/.git）里也能命中（旧版只查 root 一个仓库）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const BT = String.fromCharCode(96); // 反引号（避免模板/转义把脚本自己写坏）

const [handoffArg, rootArg] = process.argv.slice(2);

// ── --chain：按目录实测枚举交接链 ──────────────────────────────────────────
if (handoffArg === "--chain") {
  const dir = path.resolve(rootArg || ".");
  if (!fs.existsSync(dir)) { console.error("❌ 目录不存在: " + dir); process.exit(2); }
  const HIT = /(交接|handoff)/i;
  const found = [];
  const walkc = (d, depth) => {
    if (depth > 3) return;
    let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!/^(node_modules|\.git|dist|build|\.pnpm)$/i.test(e.name)) walkc(p, depth + 1); continue; }
      if (e.name.toLowerCase().endsWith(".md") && HIT.test(e.name)) {
        const st = fs.statSync(p);
        found.push({ rel: path.relative(dir, p).replace(/\\/g, "/"), mtime: st.mtime.toISOString().slice(0, 10), size: st.size });
      }
    }
  };
  walkc(dir, 0);
  found.sort((a, b) => a.mtime.localeCompare(b.mtime) || a.rel.localeCompare(b.rel));
  console.log("| # | 文件 | 最后修改 | 字节 |");
  console.log("|---|---|---|---|");
  found.forEach((f, i) => console.log("| " + (i + 1) + " | " + BT + f.rel + BT + " | " + f.mtime + " | " + f.size + " |"));
  console.log("");
  console.log("共 " + found.length + " 份交接件（口径：" + dir + " 下深度≤3 的 .md，文件名含「交接」/handoff）。");
  console.log("把本表贴进入口交接的「交接链全清单」——以盘上枚举为准，别凭记忆列。");
  process.exit(0);
}

if (!handoffArg) {
  console.error("用法: node anchor_audit.mjs <入口交接.md> [项目根目录]");
  console.error("      node anchor_audit.mjs --chain <交接所在目录>");
  process.exit(2);
}
const handoff = path.resolve(handoffArg);
if (!fs.existsSync(handoff)) {
  console.error("❌ 交接文档不存在: " + handoff);
  process.exit(1);
}
const root = rootArg ? path.resolve(rootArg) : path.dirname(handoff);
const candidateRoots = [
  root,
  path.dirname(handoff),
  path.join(root, ".scratch"),
  path.join(root, ".scratch/handoff"),
  path.join(root, "docs"),
  path.join(root, "docs/specs"),
  path.join(root, "docs/sandbox"),
  path.join(root, "tools"),
].filter((p, i, a) => a.indexOf(p) === i);

// 兜底索引：直接解析失败时按文件名全库匹配（跳过依赖/构建目录），让脚本不绑死项目结构
let allFiles = null;
const buildIndex = () => {
  if (allFiles) return allFiles;
  allFiles = [];
  const SKIP = /(^|[\\/])(node_modules|\.git|dist|build|coverage|\.pnpm)([\\/]|$)/i;
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP.test(p)) walk(p); }
      else allFiles.push(p);
    }
  };
  walk(root);
  return allFiles;
};

const FILE_EXT = "md|json|jsonl|log|out|txt|cjs|mjs|js|db|pdf|bat|ps1|yaml|yml|zip";
const ALLOWED_EXT = new Set(FILE_EXT.split("|"));
const text = fs.readFileSync(handoff, "utf8").replace(/https?:\/\/\S+/g, " ");

const isFileToken = (t) => {
  if (!t) return false;
  // 反引号里的绝对路径/带分隔符路径允许含空格；其余仍禁空格（防把句子当路径）
  const spaced = /\s/.test(t);
  if (spaced && !/^[A-Za-z]:[\\/]/.test(t)) return false;   // 只有盘符绝对路径允许空格（否则会把 shell 命令当路径）
  if (spaced && !/\.[A-Za-z0-9]{1,6}$/.test(t)) return false;
  if (/^https?:/i.test(t)) return false;
  if (t.startsWith("-") || t.includes("→") || t.includes("&&")) return false;
  const m = /\.([A-Za-z0-9]+)$/.exec(t);
  return !!m && ALLOWED_EXT.has(m[1].toLowerCase());
};

// ── v3 口径辅助 ────────────────────────────────────────────────────────────
const isWildcard = (t) => /[*?]/.test(t);
const isPlaceholder = (t) => /<[^<>]*>/.test(t);
const globToRe = (pat) => new RegExp("^" + pat.replace(/\\/g, "/")
  .replace(/[.+^${}()|[\]]/g, "\\$&")
  .replace(/[*]/g, "[^/]*")
  .replace(/[?]/g, "[^/]") + "$");
const globMatchesRelaxed = (pat) => {
  const parts = pat.split("/");
  if (parts.length < 2 || parts.length > 4) return [];
  const out = new Set();
  const combos = 1 << (parts.length - 1);
  for (let mask = 0; mask < combos; mask++) {
    for (const cut of [0, 1, 2]) {
      let cand = parts[0].slice(0, parts[0].length - cut) || parts[0];
      for (let i = 1; i < parts.length; i++) cand += ((mask >> (i - 1)) & 1) ? parts[i] : "/" + parts[i];
      for (const h of globMatches(cand)) out.add(h);
    }
  }
  return [...out];
};
const globMatches = (pat) => {
  const re = globToRe(pat);
  // 简写兜底：不锚定开头/结尾，只用于 basename 比对
  // （实测：文档写 "复评一/二-*.md"，真名是 "1015-深夜-六方案复评二-….md"——前缀被省掉了）
  const loose = new RegExp(re.source.replace(/^\^/, "").replace(/\$$/, ""));
  const out = [];
  for (const p of buildIndex()) {
    const rel = path.relative(root, p).replace(/\\/g, "/");
    const base = path.basename(rel);
    if (re.test(rel) || re.test(base) || loose.test(base)) out.push(rel);
  }
  return out;
};
// 占位符所在整行里的裸文件名不算独立锚点（它们只是那句模板描述的配角）
const placeholderLineBare = new Set();
for (const line of text.split(/\r?\n/)) {
  const marks = [...line.matchAll(/<[^<>\n]{1,60}>/g)].map((m) => m.index);
  if (!marks.length) continue;
  for (const m of line.matchAll(/[\w.\-一-鿿]+\.(?:[A-Za-z0-9]+)/g)) {
    if (marks.some((i) => Math.abs(i - m.index) <= 40)) placeholderLineBare.add(m[0]);
  }
}
// 技能脚本等工具文件常在项目外（~/.agents/skills、~/.dsh/skills）
const SKILL_ROOTS = [
  path.join(os.homedir(), ".agents/skills"),
  path.join(os.homedir(), ".dsh/skills"),
  path.join(os.homedir(), ".zcode/skills"),
].filter((d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });
const findInSkillRoots = (base) => {
  const hits = [];
  const walk = (d, depth) => {
    if (depth > 4 || hits.length > 3) return;
    let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      if (hits.length > 3) return;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!/^(\.git|node_modules|dist)$/i.test(e.name)) walk(p, depth + 1); }
      else if (e.name === base) hits.push(p);
    }
  };
  for (const r of SKILL_ROOTS) walk(r, 0);
  return hits;
};
// 被误当 commit 的哈希：整行带"指纹/sha"字样的先排除
const hashLikeLines = new Set();
for (const line of text.split(/\r?\n/)) {
  if (!/(指纹|哈希|md5|sha256|sha1|fingerprint)/i.test(line)) continue;
  for (const m of line.matchAll(/[0-9a-f]{7,64}/gi)) hashLikeLines.add(m[0]);
}

// ── 抓锚点 ────────────────────────────────────────────────────────────────
const fileAnchors = new Set();
// 1) 反引号 token：完整路径（含 C:/ 盘符、中文名）或纯文件名
for (const m of text.matchAll(/`([^`\n]+)`/g)) {
  const t = m[1].trim();
  if (isFileToken(t)) fileAnchors.add(t);
}
// 2) markdown 链接目标
for (const m of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
  if (!/^https?:|^#/.test(m[1])) fileAnchors.add(m[1]);
}
// 3) 裸路径（**只扫代码外文本**：反引号里的整段已由规则 1 收取，再扫只会把带空格的路径切成半截）
//（防把 C:/x、.zcode/x 切成半截路径）
const textPlain = text.replace(/`[^`\n]*`/g, " ");
for (const m of textPlain.matchAll(/(?:^|[\s（(｜|>])((?:[A-Za-z]:)?[^\s`|>()\[\]，。；、:：]*[/\\][^\s`|>()\[\]，。；、:：]*)/gm)) {
  const t = m[1].trim().replace(/^[（(｜|>:]+/, "");
  if (isFileToken(t)) fileAnchors.add(t);
}
// 4) 无斜杠纯文件名（断点锚/收据常用写法：p17-PROGRESS.md；点开头=.truth.md 伴生约定，跳过）
for (const m of textPlain.matchAll(new RegExp("(?<![\\w`/\\\\一-鿿.\\-])[\\w\\-一-鿿][\\w.\\-一-鿿]*\\.(" + FILE_EXT + ")(?![\\w.])", "gi"))) {
  const t = m[0].trim();
  if (!t.startsWith(".")) fileAnchors.add(t);
}
// 5) git commit 锚（v3：backtick 里的 hex 只在像 git 哈希时才当 commit——7~12 位短哈希或 40 位全哈希）
const commitAnchors = new Set();
for (const m of text.matchAll(/`([0-9a-f]{7,12}|[0-9a-f]{40})`/g)) {
  if (!hashLikeLines.has(m[1])) commitAnchors.add(m[1]);
}
for (const m of text.matchAll(/(?:commit|链=)\s*([0-9a-f]{7,40})/gi)) commitAnchors.add(m[1]);

// ── 判定 ──────────────────────────────────────────────────────────────────
const resolveExists = (f) => {
  if (f.includes("|")) {
    const parts = f.split("|").map((p) => p.trim()).filter(Boolean);
    const dir = path.dirname(parts[0]);
    let prev = parts[0];
    const okAll = parts.every((p) => {
      let cand;
      if (p.startsWith(".")) cand = prev.replace(/\.[^.\/\\]+$/, "") + p;
      else if (p.includes("/") || p.includes("\\")) cand = p;
      else cand = dir === "." ? p : dir + "/" + p;
      prev = cand;
      return resolveExists(cand) === "ok";
    });
    if (!okAll) console.log("   ↳ 简写展开后仍有缺件: " + f);
    return okAll ? "ok" : "missing";
  }
  const f2 = f.replace(/\\/g, "/");
  if (path.isAbsolute(f2)) return fs.existsSync(f2) ? "ok" : "missing";
  for (const r of candidateRoots) {
    if (fs.existsSync(path.join(r, f2))) return "ok";
  }
  const base = path.basename(f2);
  const hits = buildIndex().filter((p) => path.basename(p) === base);
  if (hits.length === 1) { console.log("   ↳ " + f2 + " 实际位于 " + path.relative(root, hits[0])); return "ok"; }
  if (hits.length > 1) { console.log("   ↳ " + f2 + " 多处命中（歧义，请写明相对路径）: " + hits.slice(0, 3).map((h) => path.relative(root, h)).join(" | ")); return "ambiguous"; }
  return "missing";
};

// 嵌套仓库：root 只有一个 .git 的仓库，以及子目录里的仓库——commit 可能落在子仓库
let repoList = null;
const buildRepos = () => {
  if (repoList) return repoList;
  repoList = [root];
  const SKIP = /(^|[\\/])(node_modules|\.pnpm|dist|build|coverage)([\\/]|$)/i;
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const p = path.join(dir, e.name);
      if (SKIP.test(p)) continue;
      if (e.name === ".git") { if (p !== path.join(root, ".git")) repoList.push(path.dirname(p)); continue; }
      walk(p, depth + 1);
    }
  };
  walk(root, 0);
  return repoList;
};
const commitExists = (c) => {
  for (const r of buildRepos()) {
    try { execFileSync("git", ["-C", r, "cat-file", "-e", c + "^{commit}"], { stdio: "ignore" }); return r; } catch {}
  }
  return null;
};

// 文档里出现过的绝对目录（跨项目引用：文件在别的项目根下，按目录前缀再试一次）
const absDirs = new Set();
for (const m of text.matchAll(/[A-Za-z]:[\\/][^\s"<>|{},]*[\\/]/g)) absDirs.add(m[0].replace(/\\/g, "/"));
const viaAbsDir = (name) => {
  for (const d of absDirs) if (fs.existsSync(d + name)) return d + name;
  return null;
};

const results = [];
let skipped = 0;
for (const f of fileAnchors) {
  if (isPlaceholder(f)) { skipped++; continue; }
  if (isWildcard(f)) {
    let hits = globMatches(f);
    if (hits.length === 0) hits = globMatchesRelaxed(f);
    if (hits.length > 0) { results.push("⚪ 通配符（匹配 " + hits.length + " 件）: " + f); skipped++; }
    else results.push("❌ 通配符零匹配: " + f);
    continue;
  }
  if (!/[/\\]/.test(f) && placeholderLineBare.has(f)) { results.push("⚪ 占位符句内文件名（不作判定）: " + f); skipped++; continue; }
  const s = resolveExists(f);
  if (s === "missing") {
    const base = path.basename(f.replace(/\\/g, "/"));
    if (!/[/\\]/.test(f)) { const hit = viaAbsDir(base); if (hit) { results.push("✅ " + f + " （跨项目： " + hit + "）"); continue; } }
    const sk = findInSkillRoots(base);
    if (sk.length === 1) { results.push("⚪ 项目外工具（技能目录）: " + base + " → " + sk[0]); skipped++; continue; }
    if (sk.length > 1) { results.push("⚪ 项目外工具（技能目录，多处命中）: " + base); skipped++; continue; }
  }
  results.push(s === "missing" ? "❌ 路径不存在: " + f : "✅ " + f);
}
for (const c of commitAnchors) {
  const where = commitExists(c);
  results.push(where
    ? "✅ commit " + c + (where === root ? "" : " （在子仓库 " + path.relative(root, where) + "）")
    : "❌ commit 不存在（或不在本仓库/子仓库）: " + c);
}

results.forEach((r) => console.log(r));
const fails = results.filter((r) => r.startsWith("❌")).length;
const total = results.length;
if (fails === 0) console.log("\n锚点审计通过（" + total + " 项" + (skipped ? "，" + skipped + " 项为口径提示" : "") + "），可开工。");
else console.log("\n有 " + fails + "/" + total + " 个失效锚点——先处置（路径笔误 or 证据确实缺失）再开工。");
process.exit(fails === 0 ? 0 : 1);
