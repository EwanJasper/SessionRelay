// define-tool.js — Resilient @deepseek-ai/dsh-tools loader
//
// Works transparently both when running inside DSH / profile deployment directory
// and when running local selftest suites outside DSH.
import { createRequire } from 'node:module'

let defineToolImpl

try {
  const req = createRequire(import.meta.url)
  defineToolImpl = req('@deepseek-ai/dsh-tools').defineTool
} catch {
  try {
    // Fallback for standalone test runners located in workspace copy
    const fallbackReq = createRequire('C:/Users/crx/.dsh/profiles/web/local-plugins/dsh-reach/index.js')
    defineToolImpl = fallbackReq('@deepseek-ai/dsh-tools').defineTool
  } catch {
    defineToolImpl = (spec) => spec
  }
}

export const defineTool = defineToolImpl
