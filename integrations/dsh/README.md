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
   unresolved questions. Bounded to 1200 chars, with an mtime-keyed cache so a
   repeat evaluation costs ~1 ms instead of ~310 ms.
2. **Project resolution.** A four-step fallback chain that needs no
   configuration in the common case.
3. **Six native tools.** `srelay_search` / `srelay_show` / `srelay_record`
   for querying, plus `srelay_bind_project` / `srelay_confirm_bind_project` /
   `srelay_cancel_bind_project` for the two-stage binding.

## Project resolution

```
① env SRELAY_PROJECT_ROOT   → if it points at a directory containing .sessionrelay
② DSH session inference     → most recent session group under ~/.dsh/sessions
③ registry single survivor  → exactly one project registered and alive
④ dangling                  → do not guess; list candidates for the user
```

Step ② is the interesting one. DSH groups its own session storage by working
directory slug:

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

Step ④ deliberately refuses to guess. Injecting the wrong project's brief is
worse than injecting nothing: it would show project A's decisions inside a
project B conversation, and the model has no way to tell they are unrelated.

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

The plugin ships its own SessionRelay runtime under `vendor/` and prefers it over
any globally installed copy:

```
① SRELAY_CLI_PATH env   → development escape hatch (point at a working copy)
② vendor/ (bundled)     → default; works with no npm install and no network
③ global npm location   → fallback only
```

`vendor/` is a **build artifact**, not tracked in git — it is ~67 MB and carries
`better-sqlite3` native bindings for every platform, which would bloat the
repository (the whole repo is ~13 MB). Generate it with:

```sh
node vendor-srelay.mjs                 # fetch from npm
node vendor-srelay.mjs --from <path>   # copy from an existing install (offline)
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

```jsonc
// ~/.dsh/profiles/<profile>/package.json
{
  "dependencies": { "dsh-srelay-brief": "file:/path/to/integrations/dsh" },
  "dsh": { "profile": { "bundles": ["…", "dsh-srelay-brief"] } }
}
```

Then `pnpm install` in the profile directory. The plugin needs
`@deepseek-ai/dsh-tools` as a peer; DSH resolves it from its own installation.

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
   to a global install — a 67 MB payload carried for nothing. When you test this,
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
node selftest.mjs
```

Covers slug decoding against real DSH directory names, the resolution chain,
the section registration contract (deliberately not awaiting the provider),
tool registration via a stub collector, and the full two-stage binding flow. It
does not require DSH to be running.
