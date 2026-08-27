/**
 * v0.36.1 (audit P1-3 + Oracle review) — fire-and-forget catches must log.
 *
 * Bug (v0.35.9): runGraphSync() and graphRetrieval.invoke() failures were
 * swallowed by `.catch(() => { /* comment *\/ })` with no logToFile call.
 * A broken graphify upgrade was invisible to the operator.
 *
 * v0.36.1: scanner walks all `.catch(...)` handlers in plugin.ts and asserts
 * each one contains logToFile, throw, or process.exit. Catches with ONLY a
 * comment are caught. Tests in `graph-sync.test.ts` are allowlisted with
 * rationale (test cleanup best-effort).
 */
import { describe, expect, it } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

const PROD_FILES = [
  join(import.meta.dir, "plugin.ts"),
  join(import.meta.dir, "session-bridge.ts"),
] as const

const ALLOWLIST: Array<{ file: string; line: number; rationale: string }> = [
  { file: "src/graph-sync.test.ts", line: 144, rationale: "test cleanup of fs.rm tmpdir; non-production" },
  { file: "src/graph-sync.test.ts", line: 169, rationale: "test cleanup of fs.rm tmpdir; non-production" },
]

interface BareCatch {
  file: string
  startLine: number
  endLine: number
  body: string
}

/**
 * Find every `.catch(...)` handler and report the body lines. Matches
 * balanced parens across newlines (handles async/arrow callbacks).
 */
function findCatchHandlers(src: string, file: string): BareCatch[] {
  const hits: BareCatch[] = []
  const re = /\.catch\s*\(/g
  let match: RegExpExecArray | null
  while ((match = re.exec(src)) !== null) {
    const startIdx = match.index + match[0].length
    let depth = 1
    let i = startIdx
    while (i < src.length && depth > 0) {
      const c = src[i]
      if (c === "(") depth++
      else if (c === ")") depth--
      i++
    }
    if (depth !== 0) continue
    const handlerSrc = src.slice(startIdx, i - 1).trim()
    const before = src.slice(0, match.index)
    const startLine = (before.match(/\n/g) ?? []).length + 1
    const endLine = startLine + (handlerSrc.match(/\n/g) ?? []).length
    hits.push({ file, startLine, endLine, body: handlerSrc })
  }
  return hits
}

/**
 * Body is "bare" if it has no observable side-effect: no logToFile/console,
 * no throw, no process.exit, no rethrow pattern. Allows comments and the
 * error argument to be unused.
 */
function isBare(body: string): boolean {
  const stripped = body
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")
    .trim()
  // Strip the outer brace block to inspect statements.
  const inner = stripped.replace(/^\{|\}$/g, "").trim()
  if (inner.length === 0) return true
  // Any statement that mentions logToFile / console / throw / process.exit / return err.
  const observable = /\b(logToFile|console\.|throw\b|process\.exit|return\s+err|return\s+reject)/
  return !observable.test(stripped)
}

describe("P1-3 production fire-and-forget catches must log", () => {
  for (const file of PROD_FILES) {
    it(`then every .catch in ${file.split(/[/\\]/).pop()} either logs, throws, or is allowlisted`, async () => {
      const src = await readFile(file, "utf-8")
      const handlers = findCatchHandlers(src, file)
      const bare = handlers.filter((h) => isBare(h.body))
      const allowlistForFile = ALLOWLIST.filter((a) => a.file === file)
      const violations = bare.filter(
        (b) => !allowlistForFile.some((a) => a.line >= b.startLine && a.line <= b.endLine),
      )
      expect(violations).toEqual([])
    })
  }
})