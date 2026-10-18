// define-tool.js — Resilient @deepseek-ai/dsh-tools loader
//
// dsh-tools is provided by the DSH host at runtime, so inside DSH the plain
// createRequire below already resolves it. That path is enough for real use.
//
// The fallbacks exist only so the plugin's own selftest can run under a bare
// `node` outside DSH. They deliberately contain **no absolute paths** — a
// hardcoded `C:/Users/<someone>/...` works on exactly one machine and breaks
// everywhere else, which is worse than not having the fallback at all.
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'

let defineToolImpl

// Candidate anchors, in order: the host's own module resolution, then the two
// profile locations a DSH install uses. homedir() keeps this portable.
const CANDIDATES = [
  import.meta.url,
  join(homedir(), '.dsh', 'profiles', 'web', 'local-plugins', 'dsh-reach', 'index.js'),
  join(homedir(), '.dsh', 'profiles', 'desktop', 'local-plugins', 'dsh-reach', 'index.js'),
]

for (const anchor of CANDIDATES) {
  try {
    defineToolImpl = createRequire(anchor)('@deepseek-ai/dsh-tools').defineTool
    break
  } catch { /* try the next anchor */ }
}

// Last resort: pass the spec through untouched. Only reachable outside DSH,
// where nothing will call the tool anyway — but note this means the returned
// object is NOT a normalized tool. Do not treat a successful import of this
// module as proof that defineTool is the real one.
if (!defineToolImpl) defineToolImpl = (spec) => spec

export const defineTool = defineToolImpl
