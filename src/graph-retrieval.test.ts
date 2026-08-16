/**
 * Tests for GraphRetrieval — the layer that actually invokes codegraph/graphify
 * and caches results for injection into the agent's context. This is the
 * v0.13.0 fix for C2 (plugin never invokes graph tools).
 *
 * Design constraints:
 * - Must NOT block tool.execute.before (async with timeout)
 * - Must cache results per (sessionID, queryHash) with 5min TTL
 * - Must fix the race condition (re-detect graph dirs on every invocation)
 * - Must degrade gracefully when graphify/codegraph CLIs are unavailable
 */

import { describe, test, expect, beforeEach } from "bun:test"
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  GraphRetrieval,
  hashQuery,
  selectGraphTool,
  type GraphToolKind,
  type GraphInvocationResult,
} from "./graph-retrieval"

let workDir: string
let retrieval: GraphRetrieval

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "graph-retrieval-"))
  retrieval = new GraphRetrieval({ timeoutMs: 2000 })
})

describe("GraphRetrieval", () => {
  describe("#hasCodegraphDir / #hasGraphifyDir", () => {
    test("returns false when no graph dirs exist", () => {
      expect(retrieval.hasCodegraphDir(workDir)).toBe(false)
      expect(retrieval.hasGraphifyDir(workDir)).toBe(false)
    })

    test("returns true when .codegraph/ exists", () => {
      mkdirSync(join(workDir, ".codegraph"))
      expect(retrieval.hasCodegraphDir(workDir)).toBe(true)
    })

    test("returns true when graphify-out/ exists", () => {
      mkdirSync(join(workDir, "graphify-out"))
      expect(retrieval.hasGraphifyDir(workDir)).toBe(true)
    })

    test("re-detects on each call (fixes the race condition)", () => {
      // First call: no dirs
      expect(retrieval.hasCodegraphDir(workDir)).toBe(false)
      // Create dir after the call
      mkdirSync(join(workDir, ".codegraph"))
      // Second call: detects the new dir
      expect(retrieval.hasCodegraphDir(workDir)).toBe(true)
    })
  })

  describe("#hashQuery", () => {
    test("returns same hash for same query", () => {
      expect(hashQuery("find auth handlers")).toBe(hashQuery("find auth handlers"))
    })

    test("returns different hash for different queries", () => {
      expect(hashQuery("auth")).not.toBe(hashQuery("database"))
    })

    test("trims whitespace before hashing", () => {
      expect(hashQuery("  auth  ")).toBe(hashQuery("auth"))
    })
  })

  describe("#cacheContext / #getCachedContext", () => {
    test("returns null on cache miss", () => {
      expect(retrieval.getCachedContext("sess-1")).toBeNull()
    })

    test("returns cached content on hit", () => {
      retrieval.cacheContext("sess-1", "find auth", "Found 3 auth handlers")
      const cached = retrieval.getCachedContext("sess-1", "find auth")
      expect(cached).toBe("Found 3 auth handlers")
    })

    test("returns most recent cached content when no query provided", () => {
      retrieval.cacheContext("sess-1", "q1", "content-1")
      retrieval.cacheContext("sess-1", "q2", "content-2")
      const cached = retrieval.getCachedContext("sess-1")
      expect(cached).toBe("content-2")
    })

    test("isolates cache by sessionID", () => {
      retrieval.cacheContext("sess-1", "q", "content-1")
      retrieval.cacheContext("sess-2", "q", "content-2")
      expect(retrieval.getCachedContext("sess-1", "q")).toBe("content-1")
      expect(retrieval.getCachedContext("sess-2", "q")).toBe("content-2")
    })

    test("clear() removes all cached entries", () => {
      retrieval.cacheContext("sess-1", "q", "content")
      retrieval.clear()
      expect(retrieval.getCachedContext("sess-1", "q")).toBeNull()
    })

    test("clearSession() removes only that session's entries", () => {
      retrieval.cacheContext("sess-1", "q", "content-1")
      retrieval.cacheContext("sess-2", "q", "content-2")
      retrieval.clearSession("sess-1")
      expect(retrieval.getCachedContext("sess-1", "q")).toBeNull()
      expect(retrieval.getCachedContext("sess-2", "q")).toBe("content-2")
    })
  })

  describe("#invoke (real subprocess calls)", () => {
    // We test against a fake graph tool script that responds deterministically.
    test("returns timedOut=false when subprocess succeeds", async () => {
      const fakeBin = join(workDir, "fake-graphify")
      writeFileSync(
        fakeBin,
        `#!/bin/sh
if [ "$1" = "query" ]; then
  echo "fake graphify result for $2"
  exit 0
fi
exit 1
`,
      )
      // Make executable (no-op on Windows but harmless)
      try {
        require("node:fs").chmodSync(fakeBin, 0o755)
      } catch {}

      mkdirSync(join(workDir, "graphify-out"))
      const result = await retrieval.invoke(workDir, "test query", {
        graphifyBin: fakeBin,
      })
      // On Windows the shell script may not run; allow that outcome
      if (process.platform === "win32") {
        expect(result).toBeDefined()
        return
      }
      expect(result.kind).toBe("graphify")
      expect(result.timedOut).toBe(false)
      expect(result.result).toContain("fake graphify result")
    })

    test("returns null result when no graph tools available", async () => {
      const result = await retrieval.invoke(workDir, "test", {
        codegraphBin: "/nonexistent/path/codegraph",
        graphifyBin: "/nonexistent/path/graphify",
      })
      expect(result.timedOut).toBe(false)
      expect(result.result).toBeNull()
    })

    test("returns timedOut=true when subprocess exceeds timeout", async () => {
      // Skip on Windows (shell script hang detection differs)
      if (process.platform === "win32") {
        return
      }
      const fakeBin = join(workDir, "fake-slow-graphify")
      writeFileSync(
        fakeBin,
        `#!/bin/sh
sleep 10
echo "should not reach here"
`,
      )
      try {
        require("node:fs").chmodSync(fakeBin, 0o755)
      } catch {}

      mkdirSync(join(workDir, "graphify-out"))
      const result = await retrieval.invoke(workDir, "test", {
        graphifyBin: fakeBin,
        timeoutMs: 200,
      })
      expect(result.timedOut).toBe(true)
      expect(result.result).toBeNull()
    })
  })

  describe("cache TTL", () => {
    test("entry expires after TTL", () => {
      const shortTtl = new GraphRetrieval({ cacheTtlMs: 50 })
      shortTtl.cacheContext("sess-1", "q", "content")
      expect(shortTtl.getCachedContext("sess-1", "q")).toBe("content")

      // Wait for expiry
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          expect(shortTtl.getCachedContext("sess-1", "q")).toBeNull()
          resolve()
        }, 100)
      })
    })
  })

  describe("#selectGraphTool (explicit routing, v0.25.0)", () => {
    test("auto: codegraph wins when both exist (codegraph-first)", () => {
      const s = selectGraphTool("auto", true, true)
      expect(s?.kind).toBe("codegraph")
    })

    test("auto: falls back to graphify when only graphify exists", () => {
      const s = selectGraphTool("auto", false, true)
      expect(s?.kind).toBe("graphify")
    })

    test("auto: returns null when neither exists", () => {
      expect(selectGraphTool("auto", false, false)).toBeNull()
    })

    test("graphify: prefers graphify even when both exist", () => {
      const s = selectGraphTool("graphify", true, true)
      expect(s?.kind).toBe("graphify")
    })

    test("codegraph: prefers codegraph even when both exist", () => {
      const s = selectGraphTool("codegraph", true, true)
      expect(s?.kind).toBe("codegraph")
    })

    test("graphify: returns null when graphify missing even if codegraph exists", () => {
      expect(selectGraphTool("graphify", true, false)).toBeNull()
    })

    test("alternate: distributes deterministically by query hash parity", () => {
      // Both dirs exist; same query must map to the SAME tool every time.
      const a1 = selectGraphTool("alternate", true, true, "find auth")
      const a2 = selectGraphTool("alternate", true, true, "find auth")
      expect(a1?.kind).toBe(a2?.kind)
      // And across enough queries both tools are reachable.
      const seen = new Set<string>()
      for (const q of ["a", "b", "c", "d", "e", "f", "g", "h"]) {
        const s = selectGraphTool("alternate", true, true, q)
        if (s?.kind) seen.add(s.kind)
      }
      expect(seen.size).toBe(2)
    })

    test("alternate: single available tool is always used", () => {
      const s = selectGraphTool("alternate", false, true, "any query")
      expect(s?.kind).toBe("graphify")
    })
  })
})

// Cleanup
afterEach(() => {
  if (workDir && existsSync(workDir)) rmSync(workDir, { recursive: true, force: true })
})

// Bun test uses describe/test from bun:test. We use a module-level
// afterEach via the afterEach from bun:test.
import { afterEach } from "bun:test"
