// v0.50.2: no console-window flash on Windows.
// Every child_process spawn site in shipped runtime code (src, no tests)
// must pass `windowsHide: true`, otherwise Windows pops a black console
// window on each spawn (user-visible flashing).
// Static scan: for each execSync/execFileSync/spawn/spawnSync call, extract
// the full call text by paren matching and assert it contains `windowsHide`.
// Type references, imports, and injected `runner(...)` DI seams do not match
// and are ignored by construction. `runGuardedSync` sets it internally.
import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

const SRC = join(import.meta.dir)

function listTsFiles(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) {
      out.push(...listTsFiles(p))
    } else if (e.endsWith(".ts") && !e.endsWith(".test.ts")) {
      out.push(p)
    }
  }
  return out
}

/** Extract call text starting at the opening paren index (brace matching). */
function extractCall(src: string, openIdx: number): string | null {
  let depth = 0
  let str: string | null = null
  let esc = false
  let tmplDepth = 0
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i]!
    if (str) {
      if (esc) {
        esc = false
      } else if (ch === "\\") {
        esc = true
      } else if (ch === str && !(str === "`" && tmplDepth > 0)) {
        str = null
      } else if (str === "`" && ch === "$" && src[i + 1] === "{") {
        tmplDepth++
        i++
      } else if (ch === "}" && tmplDepth > 0) {
        tmplDepth--
      }
      continue
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      str = ch
    } else if (ch === "(") {
      depth++
    } else if (ch === ")") {
      depth--
      if (depth === 0) return src.slice(openIdx, i + 1)
    }
  }
  return null
}

// Template `${...}` tracking above is best-effort; the graph-sync watch-loop
// template embeds a nested spawn with balanced parens, which resolves fine.
// If extraction ever fails, the test fails loudly (not silently skipped).

// Comments are blanked (newlines preserved) before scanning so prose like
// "execFileSync (no shell)" inside a comment is never mistaken for a call.
function stripComments(src: string): string {
  let out = ""
  let i = 0
  let str: string | null = null
  let esc = false
  const blank = (s: string) => s.replace(/[^\n]/g, " ")
  while (i < src.length) {
    const ch = src[i]!
    if (str) {
      out += ch
      if (esc) {
        esc = false
      } else if (ch === "\\") {
        esc = true
      } else if (ch === str) {
        str = null
      }
      i++
      continue
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      str = ch
      out += ch
      i++
    } else if (ch === "/" && src[i + 1] === "/") {
      let j = i
      while (j < src.length && src[j] !== "\n") j++
      out += blank(src.slice(i, j))
      i = j
    } else if (ch === "/" && src[i + 1] === "*") {
      let j = i + 2
      while (j < src.length && !(src[j] === "*" && src[j + 1] === "/")) j++
      j = Math.min(src.length, j + 2)
      out += blank(src.slice(i, j))
      i = j
    } else {
      out += ch
      i++
    }
  }
  return out
}

describe("no-console-flash (v0.50.2)", () => {
  it("every child_process spawn site passes windowsHide: true", () => {
    const violations: string[] = []
    const files = listTsFiles(SRC)
    expect(files.length).toBeGreaterThan(10)
    const re = /(execSync|execFileSync|spawn|spawnSync)\s*\(/g
    for (const file of files) {
      const src = stripComments(readFileSync(file, "utf-8"))
      let m: RegExpExecArray | null
      while ((m = re.exec(src)) !== null) {
        const openIdx = m.index + m[0].length - 1
        const call = extractCall(src, openIdx)
        const line = src.slice(0, m.index).split("\n").length
        if (call === null) {
          violations.push(`${file}:${line}: could not extract call text`)
        } else if (!call.includes("windowsHide")) {
          violations.push(`${file}:${line}: ${m[1]} call without windowsHide`)
        }
      }
    }
    expect(violations).toEqual([])
  })
})
