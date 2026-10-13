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
  // Standalone test runners (no DSH install, no profile node_modules): fall back
  // to an identity function so tool definitions stay inspectable and testable.
  // The real defineTool is only needed when DSH actually registers them.
  defineToolImpl = (spec) => spec
}

export const defineTool = defineToolImpl
