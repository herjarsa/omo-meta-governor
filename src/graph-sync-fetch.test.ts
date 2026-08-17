/**
 * Tests for the origin-fetch reindex watcher (v0.25.1).
 *
 * detectRemoteNewCommits runs `git fetch origin <branch>` then
 * `git rev-list --count HEAD..origin/<branch>` to count commits the local
 * HEAD is behind. Returns 0 on any error (never throws) so the plugin load
 * path is robust when the repo is offline / not git / no remote.
 *
 * Tests use a mocked execSync (runner DI) to assert command shape and the
 * final count deterministically across platforms (no real git required).
 */

import { describe, test, expect } from "bun:test"
import { detectRemoteNewCommits } from "./graph-sync"

type RunResult = { stdout: string; stderr?: string; status?: number }
type RunFn = (cmd: string, opts?: { cwd?: string; timeout?: number; stdio?: unknown }) => RunResult | string

function makeRunner(responses: Record<string, string>): RunFn & { calls: string[] } {
  const calls: string[] = []
  const fn = ((cmd: string) => {
    calls.push(cmd)
    for (const [pattern, value] of Object.entries(responses)) {
      if (cmd.includes(pattern)) return value
    }
    throw new Error(`unexpected command in test: ${cmd}`)
  }) as RunFn & { calls: string[] }
  fn.calls = calls
  return fn
}

// Compat shim: execSync accepts stdio as string | array; tests just need
// the function to receive a string command and return a string-or-buffer.
function makeExecSync(runner: RunFn): typeof import("node:child_process").execSync {
  return ((cmd: string, _opts?: unknown) => {
    const r = runner(cmd)
    const out = typeof r === "string" ? r : r.stdout
    return out
  }) as typeof import("node:child_process").execSync
}

describe("detectRemoteNewCommits (v0.25.1)", () => {
  test("returns the count from git rev-list after a successful fetch", () => {
    const runner = makeRunner({
      "rev-parse --abbrev-ref HEAD": "main\n",
      "fetch origin main": "",
      "rev-list --count HEAD..origin/main": "7\n",
    })
    const n = detectRemoteNewCommits("D:/repo", "main", makeExecSync(runner))
    expect(n).toBe(7)
  })

  test("returns 0 when rev-list reports up to date", () => {
    const runner = makeRunner({
      "rev-parse --abbrev-ref HEAD": "main\n",
      "fetch origin main": "",
      "rev-list --count HEAD..origin/main": "0\n",
    })
    expect(detectRemoteNewCommits("D:/repo", "main", makeExecSync(runner))).toBe(0)
  })

  test("returns 0 when rev-parse fails (not a git repo)", () => {
    const runner = makeRunner({})
    runner.calls.length = 0
    // Force rev-parse to throw.
    const runner2 = ((cmd: string) => {
      if (cmd.includes("rev-parse")) throw new Error("not a git repository")
      return ""
    }) as RunFn & { calls: string[] }
    runner2.calls = []
    expect(detectRemoteNewCommits("D:/repo", "main", makeExecSync(runner2))).toBe(0)
  })

  test("returns 0 when fetch fails (offline / no remote)", () => {
    const runner = ((cmd: string) => {
      if (cmd.includes("rev-parse")) return "main\n"
      if (cmd.includes("fetch")) throw new Error("Could not resolve host origin")
      throw new Error(`unexpected: ${cmd}`)
    }) as RunFn & { calls: string[] }
    runner.calls = []
    expect(detectRemoteNewCommits("D:/repo", "main", makeExecSync(runner))).toBe(0)
  })

  test("returns 0 when rev-list fails (branch missing on remote)", () => {
    const runner = ((cmd: string) => {
      if (cmd.includes("rev-parse")) return "main\n"
      if (cmd.includes("fetch")) return ""
      if (cmd.includes("rev-list")) throw new Error("unknown revision")
      throw new Error(`unexpected: ${cmd}`)
    }) as RunFn & { calls: string[] }
    runner.calls = []
    expect(detectRemoteNewCommits("D:/repo", "main", makeExecSync(runner))).toBe(0)
  })

  test("invokes git fetch with the configured branch", () => {
    const runner = makeRunner({
      "rev-parse --abbrev-ref HEAD": "develop\n",
      "fetch origin develop": "",
      "rev-list --count HEAD..origin/develop": "3\n",
    })
    detectRemoteNewCommits("D:/repo", "develop", makeExecSync(runner))
    expect(runner.calls.some((c) => c === "git fetch origin develop")).toBe(true)
  })

  test("uses current branch when no branch arg given", () => {
    const runner = makeRunner({
      "rev-parse --abbrev-ref HEAD": "feature/x\n",
      "fetch origin feature/x": "",
      "rev-list --count HEAD..origin/feature/x": "0\n",
    })
    detectRemoteNewCommits("D:/repo", undefined, makeExecSync(runner))
    expect(runner.calls.some((c) => c === "git fetch origin feature/x")).toBe(true)
  })

  test("parses whitespace and trims around the count", () => {
    const runner = makeRunner({
      "rev-parse --abbrev-ref HEAD": "main\n",
      "fetch origin main": "",
      "rev-list --count HEAD..origin/main": "  42 \n",
    })
    expect(detectRemoteNewCommits("D:/repo", "main", makeExecSync(runner))).toBe(42)
  })
})