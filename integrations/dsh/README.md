# SessionRelay × DeepSeek Harness (DSH) integration

A native DSH plugin that brings SessionRelay project memory into DSH's system
prompt — the equivalent of the SessionStart hook that CLI-shaped clients
(ZCode, Claude Code) get for free.

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
   unresolved questions. Bounded to 1200 chars.
2. **Project resolution.** A four-step fallback chain that works without any
   configuration in the common case.
3. **Two-stage project binding.** A pair of native tools for the case where
   automatic resolution cannot decide.

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
  --D--agent1super--          ← D:\agent1super
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
is not a decision the model may make on its own. If a model in project B
session mis-resolved and bound itself to project A, every decision it then
recorded would be written into A's SQLite — irreversibly.

This mirrors SessionRelay's own rule that AI never gets delete tools; the same
constraint extends to "which store do writes go to":

- `srelay_bind_project({ path })` — **proposes only**. Records a pending bind and
  returns text explicitly asking the user to confirm. Nothing changes.
- `srelay_confirm_bind_project()` — **applies**, and only after the user has
  said so. The pending proposal expires after 5 minutes; a second confirm is
  rejected.

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
`@deepseek-ai/dsh-tools` and `@deepseek-ai/dsh-system-prompt` as peers; DSH
resolves both from its own installation.

## Development notes

Three things bit us during development and are worth knowing before editing:

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

## Self-test

```
node selftest.mjs
```

Covers slug decoding against real DSH directory names, the resolution chain,
the section registration contract (deliberately not awaiting the provider), and
the two-stage binding. It does not require DSH to be running.
