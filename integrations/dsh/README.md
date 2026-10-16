# SessionRelay × DeepSeek Harness (DSH) integration

A native DSH plugin that brings SessionRelay project memory into DSH's system
prompt — the equivalent of the SessionStart hook that CLI-shaped clients
(ZCode, Claude Code) get for free.

**[中文](./README.zh-CN.md) · [SessionRelay upstream](https://github.com/EwanJasper/SessionRelay)**

## Why this exists

SessionRelay is an MCP server, so it can be *queried* by any MCP client. But an
MCP server cannot *inject* anything into a conversation: the `initialize`
response carries no `instructions`, no `resources`, and no `prompts` (verified
against `srelay serve` directly). Anything that appears in the model's context
without the model asking for it must be placed there by the client.

CLI-shaped clients get this almost for free: their process working directory
*is* the project root, so a SessionStart hook can resolve the project and shell
out to `srelay decisions` / `srelay unresolved`. DSH is a desktop GUI:

| signal | DSH desktop result |
|---|---|
| `process.cwd()` | the **installation directory**, not the project |
| `ctx.cmdlineArgs` | empty array (no argv for a GUI launch) |
| `AssembleContext` | `{ scope?, signal? }` only — no cwd, no project |

All three are dead ends, so this plugin resolves the project a different way
(see below) and registers a `systemPrompt.section()` provider — DSH's official
injection point — that renders the brief before each model step.

## What it does

1. **Brief injection.** A `systemPrompt` section, evaluated on every assembly
   (i.e. before each model step), showing the project's recent decisions and
   unresolved questions, with decisions dated `[MM-DD]`. Bounded to 1200 chars.
   The read path is **SQL-first** (`node:sqlite`, read-only) with the CLI as a
   fallback: cold path ~5 ms, warm path ~1 ms, versus ~310–360 ms for shelling
   out to the CLI. `SRELAY_BRIEF_FORCE_CLI=1` forces the old path for A/B
   comparison.
2. **Project resolution.** A fallback chain that needs no configuration in the
   common case (below).
3. **Auto-init.** Open a real folder in DSH and a memory library is created for
   it — no "please set this up" round trip. Temp directories, DSH's own
   installation, the npm global root and drive roots are excluded by a
   blacklist shared with the ZCode hook, so the rule lives in exactly one place.
   `init` is cheap (~190 ms, 166 KB) and reversible (delete `.sessionrelay/`).
4. **Seven native tools.** `srelay_search` / `srelay_show` / `srelay_record`
   for querying, `srelay_init` for creating a library, and
   `srelay_bind_project` / `srelay_confirm_bind_project` /
   `srelay_cancel_bind_project` for the two-stage binding.

## Project resolution

```
① agent.session.header.cwd      → DSH's own validated absolute cwd (per-agent)
② env SRELAY_PROJECT_ROOT       → if it points at a directory containing .sessionrelay
③ DSH session inference         → most recent session group under ~/.dsh/sessions
④ registry single survivor      → exactly one project registered and alive
⑤ dangling                      → do not guess; list candidates for the user
```

Step ① is the primary signal. DSH hands the plugin the working directory the
session was created in, so there is nothing to infer. Steps ③–⑤ are the
fallbacks, and step ③ is the interesting one.

DSH groups its own session storage by working directory slug:

```
~/.dsh/sessions/
  --E-music~0020player--      ← E:\music player
  --D-agent1super--           ← D:\agent1super
```

That slug is DSH's own record of which directory a session belongs to, so it is
the most reliable "which project am I in" signal available to a plugin. The
encoding (mirrored from `src/adapters/dsh/format.ts`) is:

| input | slug |
|---|---|
| `:` | *(dropped)* |
| `\` `/` | `-` |
| space | `~0020` |
| non-ASCII | `~` + 4 uppercase hex |

Because `-` is ambiguous (a real directory may contain a hyphen), decoding is
**not** a pure string operation. The plugin walks the segments depth-first and
prunes on real filesystem existence — only prefixes that actually exist are
explored. This recovers paths like `D:\agent1super\tmp\docx-build` correctly.

Step ⑤ deliberately refuses to guess. Injecting the wrong project's brief is
worse than injecting nothing: it would show project A's decisions inside a
project B conversation, and the model has no way to tell they are unrelated.

## Auto-init: what gets a library automatically

The rule is a **blacklist**, not a whitelist. Every real directory qualifies;
only directories that are never a project are excluded:

| Excluded | Why |
|---|---|
| `os.tmpdir()` and anything under it | scratch space; a stale registry of test sandboxes is exactly the mess this avoids |
| DSH's own installation and `~/.dsh` | the tool, not a project |
| the npm global root | same |
| drive roots (`D:\`) | a drive is not a project |

Consequences worth knowing: a `git clone` gets a library immediately; a folder
you just opened in a file manager gets one too; a monorepo subdirectory binds
at the repository root; a mis-created library self-heals because the global
registry prunes entries whose project has been dead for 30 days.

The ZCode hook (`~/.zcode/hooks/statebrief/brief.mjs`) applies the same
blacklist, so both clients behave identically. **When you change the rule,
change it in both places** — they are separate files by necessity (different
runtimes) but must not drift.

`srelay_init` exists as a tool so that "set this up" is something the model can
actually do rather than a sentence it can only promise. It is single-step, not
two-stage, because creating a library is reversible while *binding to* an
existing one is not.

## Two-stage binding

`srelay_bind_project` decides **which database decisions get written to**, so it
is not a decision the model may make on its own. If a model in a project B
session mis-resolved and bound itself to project A, every decision it then
recorded would be written into A's SQLite — irreversibly.

This mirrors SessionRelay's own rule that AI never gets delete tools; the same
constraint extends to "which store do writes go to":

- `srelay_bind_project({ projectPath })` — **proposes only**. Records a pending
  proposal and returns text explicitly asking the user to confirm.
- `srelay_confirm_bind_project()` — **applies**, and only after the user has
  said so.
- `srelay_cancel_bind_project()` — drops a pending proposal.

Proposals are tracked per scope, so multiple concurrent conversations do not
share binding state. A target path is only accepted if it already contains a
`.sessionrelay` database — otherwise binding a fresh directory would report
success and then fail silently on every subsequent call.

## Self-contained runtime (vendor/)

The plugin ships its own SessionRelay runtime under `vendor/` and prefers it
over any globally installed copy:

```
① SRELAY_CLI_PATH env   → development escape hatch (point at a working copy)
② vendor/ (bundled)     → default; works with no npm install and no network
③ global npm location   → fallback only
```

⚠️ **`vendor/` is a build artifact and is NOT in this git repository.** It is
~62 MB and carries `better-sqlite3` native bindings for every platform plus the
Chinese word-segmentation dictionaries, so committing it would permanently
bloat the history. Three ways to get it:

| 途径 | 命令 | 需要联网 | 适合 |
|---|---|---|---|
| **Release asset** (easiest) | Download the `vendor-*.tar.gz` asset from [Releases](https://github.com/rui08984-dot/sessionrelay-eco/releases) and extract it into this directory | No (one-time) | Anyone who just wants a working offline copy |
| 从 npm 拉取 | `node vendor-srelay.mjs` | 是 | 想要最新构建 |
| 从本地已装副本复制 | `node vendor-srelay.mjs --from <path>` | 否 | 本机已有 srelay |

**没有 vendor 时会发生什么**：插件不会报错，它会静默回落到全局 npm 安装的
srelay。如果那台机器上装的是**上游原版**（没有 DSH 采集源探测、没有本仓库的
修复），你会得到一个"看起来正常、简报却永远空"的半失效状态——这正是本项目花
了最多力气修的那类静默故障。所以要么装 vendor，要么确认全局那份是我们的版本。

验证 vendor 就位：

```sh
node -e "console.log(require('fs').existsSync('vendor/dist/srelay.js'))"   # 必须 true
```

## ⚠️ Prerequisite: the SessionRelay daemon must be running

This plugin **reads** the memory database; it does not collect anything by itself.
Collection is done by SessionRelay's `watch` daemon, which polls each adapter's
source files every ~30 s. If the daemon is not running:

- your ZCode / Claude Code sessions are **never captured**
- the brief will be empty or stale, and it will look like a plugin bug

Install the plugin **after** the daemon is up, and verify with:

```bash
cd "<your project>"
node "<srelay>/dist/srelay.js" status      # 守护 line must not say 未运行
```

`status` prints `auto-capture 未运行` when the daemon is down. Register it with
`srelay watch --install-service` (recommended) or run `srelay sync` as a one-off.

## Install

The plugin is a DSH *bundle*: a package whose manifest declares
`dsh.bundle.patch`, listed in the profile's `dsh.profile.bundles`.

**Step 0 — get `vendor/`** (see the section above). Without it the plugin
degrades silently instead of failing loudly.

**Step 1 — install the bundle:**

```jsonc
// ~/.dsh/profiles/<profile>/package.json
{
  "dependencies": { "dsh-srelay-brief": "file:/path/to/this/directory" },
  "dsh": { "profile": { "bundles": ["…", "dsh-srelay-brief"] } }
}
```

Then `pnpm install` in the profile directory. The plugin needs
`@deepseek-ai/dsh-tools` as a peer; DSH resolves it from its own installation.

**Step 2 — verify it actually registered.** "It started without errors" is not
evidence; a plugin whose registration silently fails looks exactly like a
working one:

```sh
node selftest.mjs                 # 90 assertions, must print SELFTEST PASS
node realboot.mjs                 # boots the real dsh-system-prompt service
```

**Step 3 — make sure the daemon is running** (see the prerequisite section
above). The plugin only *reads*; without the daemon the brief is empty.

**Upgrading from a `file:` install:** pnpm *physically copies* `file:`
dependencies into `node_modules/.pnpm/<pkg>@file+local_<hash>/`, so editing
this directory afterwards has no effect. Re-run `pnpm install`, or point the
`.pnpm` copy at this directory with a junction.

## Development notes

Seven things bit us during development and are worth knowing before editing:
1. **`apply` must be synchronous.** Cordis calls `apply` and expects a fiber;
   an `async apply` returns a Promise, and DSH reports
   `failed to import` and silently skips the plugin. Resolve optional peers with
   `createRequire(import.meta.url)` rather than `await import(...)`.
2. **The section `text` provider must return a string, not a Promise.**
   `renderPrompt` calls `text.indexOf('{{')` directly; a Promise throws
   `text.indexOf is not a function`. Use `execFileSync`, never an async wrapper.
3. **`SRELAY_PROJECT_ROOT` only affects `serve`.** Every CLI subcommand
   (`search`, `show`, `list`, `decisions`) resolves the project from **cwd**
   alone. When shelling out, pass `cwd: root`; setting the env var does nothing.
4. **The two-stage bind needs all three tools.** Proposing without a confirm
   tool means the user can say "yes" and nothing can act on it.
5. **Resolve paths with `fileURLToPath`, never `new URL(...).pathname`.**
   `.pathname` percent-encodes non-ASCII characters, so a plugin installed under
   a directory like `D:\dsh插件  记忆\` resolves to
   `D:/dsh%E6%8F%92%E4%BB%B6%20%20%E8%AE%B0%E5%BF%86/...` and every `existsSync`
   fails. The vendored runtime is then silently skipped and the plugin falls back
   to a global install — a 62 MB payload carried for nothing. When you test this,
   test under a **non-ASCII** path: an ASCII-only path hides the bug completely
   (that is exactly how it survived one round of "verified offline" testing).
   Also build the path in one step; `dirname(fileURLToPath(url))` followed by
   `join(..., 'dist')` yields `vendor/dist/dist/...`.
6. **Windows path literals need doubled backslashes.** `'E:\music player'`
   silently becomes `E:music player` — `\d`, `\c`, `\S` are consumed as escape
   sequences, leaving a separator-less *drive-relative* string that
   `path.resolve` anchors to the **process cwd**. Six such literals in
   `selftest.mjs` made one assertion pass in the author copy and fail in the
   integrations copy, purely because of which directory the test ran from.
   Section 0 of `selftest.mjs` now asserts every literal still looks like `X:\`
   and still exists on disk, so a regression turns the suite red first.
7. **`node:sqlite` must be loaded lazily.** It exists only on Node ≥ 22.5 and
   still needs `--experimental-sqlite` on 22.x, while `engines` allows
   `^22.19.0`. A top-level `import { DatabaseSync } from 'node:sqlite'` makes the
   **whole plugin** fail to load on Node 22 (no brief at all, no error) instead
   of just disabling the fast path. Use `createRequire` inside a `try/catch` —
   see `src/brief-sql.mjs`.

## Data path: SQL first, CLI as fallback

Briefs are read straight out of `relay.sqlite` with the built-in `node:sqlite`
module (`src/brief-sql.mjs`) — no subprocess, no dependency, ~5 ms cold. The
queries, ordering, dedup and freshness windows are copied verbatim from
SessionRelay's `listDecisions`/`listUnresolved` and `cli/meta.ts`; **if you
change those, change `brief-sql.mjs` too**, or the two paths will drift apart.

`selftest.mjs` section 8b asserts the two paths agree field-for-field on a real
database, and 8c additionally asserts the SQL path is actually taken: the CLI
fallback measures ~336 ms against SQL's ~5 ms, and both must render a
byte-identical brief.

The CLI subprocess remains as a fallback for: Node without `node:sqlite`, a
database schema older than the plugin, or a WAL `-shm` that cannot be written.
Force it for comparison with `SRELAY_BRIEF_FORCE_CLI=1`.

## Compatibility

| Component | Tested | Notes |
|---|---|---|
| DeepSeek Harness | `0.2.0-rc.2` | The plugin's `text` provider depends on `systemPrompt.section()` and reads `assembly.agent.session.header.cwd`. Both are internal APIs — a DSH minor bump can change them, and the failure mode is **silent** (no brief, no error). |
| Node.js | `^22.19.0 \|\| >=24.0.0` | Declared in `engines`, aligned with DSH's own constraint. The fast SQL path needs ≥ 22.5 (flag-free on 24); older runtimes fall back to the CLI subprocess and still work. |
| SessionRelay | `0.5.1`+ (fork builds included) | Vendored by default; a global install is only a fallback. |

**If the brief stops appearing after a DSH upgrade**, check in this order:
1. `srelay status` — is the daemon alive?
2. Does the project directory contain `.sessionrelay/relay.sqlite`?
3. Set `SRELAY_BRIEF_DEBUG=1` and look for `[dsh-srelay-brief]` lines on stderr.

## Self-test

```sh
node selftest.mjs        # 90 assertions, prints SELFTEST PASS
node realboot.mjs        # boots the real dsh-system-prompt service
```

`selftest.mjs` covers slug decoding against real DSH directory names, the
resolution chain, the section registration contract (deliberately not awaiting
the provider), tool registration via a stub collector, the full two-stage
binding flow, decision pinning end-to-end on a real library, the SQL brief
channel against the CLI channel, date rendering, and the auto-init blacklist.
It does not require DSH to be running.

Section 0 is a **self-check of the test file itself**: it asserts that every
path literal still looks like `X:\` and still exists on disk, and that the
verdict line appears only at the end of the file. Both were real defects that
produced green output while testing nothing (see Development notes 5 and 6).
