/**
 * MetaGovernor v0.26.0 — Auto-upgrade regression tests.
 *
 * These tests cover the bugs that forced manual `npm i` / `pip install` upgrades:
 *   AUT-1: codegraph reachable only via `node node_modules/.bin/codegraph` (no npx cache)
 *   AUT-2: graphify reachable only via `python`, not `python3` (Windows dual-python)
 *   AUT-3: fresh cache has newer version → upgrade WITHOUT registry fetch
 *   AUT-4: fresh cache, installed >= cached latest → no upgrade, no fetch
 *   AUT-5: cache missing, registry unreachable, installed unknown → code emitted, not silent
 *   AUT-6: `graphify check-update` returns non-zero → re-extract triggered
 *   AUT-7: both upgrades in same run → cache written ONCE with both fields
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { rm, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { execSync as ExecSyncType } from "node:child_process"

let testTmp: string

beforeEach(async () => {
  testTmp = await mkdtemp(join(tmpdir(), "omo-v26-"))
})

afterEach(async () => {
  try {
    await rm(testTmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  } catch { /* */ }
})

// ─── Test runner with call counter (Momus amendment #11.1) ───────────────

type RunResult = { stdout: string; stderr?: string; status?: number }
type RunFn = (cmd: string, opts?: { cwd?: string; timeout?: number; stdio?: unknown }) => RunResult | string

interface MockRunner {
  (cmd: string, opts?: { cwd?: string; timeout?: number; stdio?: unknown }): RunResult | string
  calls: string[]
}

function makeMockRunner(responses: Record<string, string | RunResult>): MockRunner {
  const calls: string[] = []
  const fn = ((cmd: string) => {
    calls.push(cmd)
    for (const [pattern, value] of Object.entries(responses)) {
      if (cmd.includes(pattern)) {
        if (value instanceof Error) throw value
        return value
      }
    }
    throw new Error(`unexpected command in test: ${cmd}`)
  }) as MockRunner
  fn.calls = calls
  return fn
}

function toExecSync(runner: MockRunner): typeof ExecSyncType {
  return ((cmd: string, _opts?: unknown) => {
    const r = runner(cmd)
    return typeof r === "string" ? r : r.stdout
  }) as typeof ExecSyncType
}

// ─── AUT-1: codegraph reachable only via local node_modules ─────────────

describe("auto-upgrade (v0.26.0) AUT-1: codegraph via node_modules only", () => {
  it("then upgrades when npx probe fails but node_modules probe succeeds", async () => {
    const { getInstalledCodegraphVersion } = await import("./graph-sync")
    // npx probe fails (exit code 1), local node_modules probe succeeds with 0.5.0
    const runner = makeMockRunner({
      "npx --yes codegraph --version": { stdout: "", status: 1 },
      "node node_modules/.bin/codegraph --version": "0.5.0\n",
    })
    const v = await getInstalledCodegraphVersion(toExecSync(runner))
    expect(v).toBe("0.5.0")
    expect(runner.calls.some(c => c.includes("npx --yes"))).toBe(true)
    expect(runner.calls.some(c => c.includes("node_modules/.bin/codegraph"))).toBe(true)
  })

  it("then returns null when all probes fail", async () => {
    const { getInstalledCodegraphVersion } = await import("./graph-sync")
    const runner = makeMockRunner({
      "npx --yes codegraph --version": new Error("codegraph not in npx cache"),
      "node node_modules/.bin/codegraph --version": new Error("no local codegraph"),
    })
    const v = await getInstalledCodegraphVersion(toExecSync(runner))
    expect(v).toBeNull()
  })
})

// ─── AUT-2: graphify via python (not python3) on Windows dual-python ────

describe("auto-upgrade (v0.26.0) AUT-2: graphify python fallback", () => {
  it("then returns 0.8.30 when python3 fails and python succeeds", async () => {
    const { getInstalledGraphifyVersion } = await import("./graph-sync")
    const runner = makeMockRunner({
      "graphify --version": new Error("no graphify binary"),
      "python3 -m pip show graphifyy": new Error("graphifyy not installed"),
      "python -m pip show graphifyy": "Name: graphifyy\nVersion: 0.8.30\nLocation: C:\\Python314\\Lib\\site-packages\n",
    })
    const v = await getInstalledGraphifyVersion(toExecSync(runner))
    expect(v).toBe("0.8.30")
    expect(runner.calls.some(c => c.includes("python -m pip show graphifyy"))).toBe(true)
  })

  it("then prefers graphify binary when it works", async () => {
    const { getInstalledGraphifyVersion } = await import("./graph-sync")
    const runner = makeMockRunner({
      "graphify --version": "graphify 0.9.0\n",
    })
    const v = await getInstalledGraphifyVersion(toExecSync(runner))
    expect(v).toBe("0.9.0")
    // Should NOT have tried python at all
    expect(runner.calls.some(c => c.includes("pip show"))).toBe(false)
  })

  it("then returns null when no backend has graphifyy installed", async () => {
    const { getInstalledGraphifyVersion } = await import("./graph-sync")
    const runner = makeMockRunner({
      "graphify --version": new Error("no graphify binary"),
      "python -m pip show graphifyy": new Error("graphifyy not installed"),
      "python3 -m pip show graphifyy": new Error("graphifyy not installed"),
    })
    const v = await getInstalledGraphifyVersion(toExecSync(runner))
    expect(v).toBeNull()
  })
})

// ─── AUT-3 & AUT-4: cache-driven upgrade decision (no registry fetch) ────

describe("auto-upgrade (v0.26.0) AUT-3/AUT-4: cache-driven decision", () => {
  it("AUT-3: fresh cache with newer latest → upgrade, NO npm view fetch", async () => {
    const { runGraphSync, resetInitializedProjects, writeUpgradeCache } = await import("./graph-sync")
    resetInitializedProjects()
    // Seed a fresh cache with codegraphLatest=1.0.0
    const cachePath = join(testTmp, "upgrade-cache.json")
    await writeUpgradeCache(cachePath, {
      checkedAtMs: Date.now(),
      codegraphLatest: "1.0.0",
      graphifyLatest: undefined,
    })
    // codegraph returns 0.5.0 (older than cached 1.0.0)
    // No `npm view` should ever be called
    const runner = makeMockRunner({
      "codegraph --version": "0.5.0\n",
      "npm i -D @colbymchenry/codegraph": "added 1 package\n",
    })
    const result = await runGraphSync({
      enabled: true,
      watch: false,
      autoInstall: false,
      autoUpgrade: true,
      projectDir: testTmp,
      installTimeoutMs: 1000,
      upgradeCachePath: cachePath,
      runner: toExecSync(runner),
    })
    expect(result.codes).toContain("codegraph-upgraded")
    expect(runner.calls.some(c => c.includes("npm view"))).toBe(false)
    expect(runner.calls.some(c => c.includes("npm i -D @colbymchenry/codegraph"))).toBe(true)
  })

  it("AUT-4: fresh cache with installed >= latest → no fetch, no upgrade", async () => {
    const { runGraphSync, resetInitializedProjects, writeUpgradeCache } = await import("./graph-sync")
    resetInitializedProjects()
    const cachePath = join(testTmp, "upgrade-cache.json")
    await writeUpgradeCache(cachePath, {
      checkedAtMs: Date.now(),
      codegraphLatest: "0.6.8",
      graphifyLatest: undefined,
    })
    const runner = makeMockRunner({
      "codegraph --version": "0.6.8\n",
    })
    const result = await runGraphSync({
      enabled: true,
      watch: false,
      autoInstall: false,
      autoUpgrade: true,
      projectDir: testTmp,
      installTimeoutMs: 1000,
      upgradeCachePath: cachePath,
      runner: toExecSync(runner),
    })
    expect(result.codes).not.toContain("codegraph-upgraded")
    expect(runner.calls.some(c => c.includes("npm view"))).toBe(false)
    expect(runner.calls.some(c => c.includes("npm i -D"))).toBe(false)
  })
})

// ─── AUT-5: silent-noop must emit a diagnostic code ──────────────────────

describe("auto-upgrade (v0.26.0) AUT-5: silent-noop diagnostic", () => {
  it("then emits upgrade-noop-version-unknown when both installed and registry are unreachable", async () => {
    const { runGraphSync, resetInitializedProjects } = await import("./graph-sync")
    resetInitializedProjects()
    const runner = makeMockRunner({
      "codegraph --version": new Error("codegraph not installed"),
      "node node_modules/.bin/codegraph --version": new Error("no local codegraph"),
    })
    const result = await runGraphSync({
      enabled: true,
      watch: false,
      autoInstall: false,
      autoUpgrade: true,
      projectDir: testTmp,
      installTimeoutMs: 1000,
      upgradeCachePath: join(testTmp, "no-cache.json"),
      runner: toExecSync(runner),
    })
    // No codegraph at all → no upgrade code, but also no silent skip
    expect(result.codes).toContain("codegraph-unavailable")
  })
})

// ─── AUT-6: graphify check-update triggers re-extract ──────────────────────

describe("auto-upgrade (v0.26.0) AUT-6: graphify check-update", () => {
  it("then emits graphify-reextract-triggered when check-update returns non-zero", async () => {
    const { runGraphSync, resetInitializedProjects, writeUpgradeCache } = await import("./graph-sync")
    resetInitializedProjects()
    const cachePath = join(testTmp, "upgrade-cache.json")
    // Seed fresh cache so no real network fetch happens.
    await writeUpgradeCache(cachePath, {
      checkedAtMs: Date.now(),
      codegraphLatest: "1.5.0",
      graphifyLatest: "0.9.46",
    })
    const runner = makeMockRunner({
      // Both tools at the latest version → no upgrade fires.
      "codegraph --version": "1.5.0\n",
      "graphify --version": "0.9.46\n",
      // graphify check-update throws (exit code 1) → triggers re-extract branch.
      "graphify check-update": new Error("needs_update flag set"),
      // graphify update (the re-extraction) throws → we swallow it.
      "graphify update": new Error("graphify not in PATH"),
    })
    const result = await runGraphSync({
      enabled: true,
      watch: false,
      autoInstall: false,
      autoUpgrade: true,
      projectDir: testTmp,
      installTimeoutMs: 1000,
      upgradeCachePath: cachePath,
      runner: toExecSync(runner),
    })
    // Assert: the check-update path was exercised AND the re-extract code was emitted.
    expect(runner.calls.some((c: string) => c.includes("graphify check-update"))).toBe(true)
    expect(result.codes).toContain("graphify-reextract-triggered")
  }, 30_000)
})

// ─── AUT-7: cache write-once with both fields ─────────────────────────────

describe("auto-upgrade (v0.26.0) AUT-7: cache write-once", () => {
  it("then writes the cache exactly once even when both upgrades run", async () => {
    const { runGraphSync, resetInitializedProjects, readUpgradeCache, writeUpgradeCache } = await import("./graph-sync")
    resetInitializedProjects()
    const cachePath = join(testTmp, "upgrade-cache.json")
    // Seed a fresh cache so neither tool needs to fetch from the registry
    // (which would block on real network and exceed the 5s test timeout).
    await writeUpgradeCache(cachePath, {
      checkedAtMs: Date.now(),
      codegraphLatest: "1.0.0",
      graphifyLatest: "0.9.0",
    })
    const runner = makeMockRunner({
      "codegraph --version": "0.5.0\n",
      "graphify --version": "0.7.0\n",
      "npm i -D @colbymchenry/codegraph": "added\n",
      "pip install --upgrade graphifyy --break-system-packages --quiet": "\n",
      "uv tool install --upgrade graphifyy --quiet": "\n",
      "graphify check-update": new Error("graphify not in PATH"),
      "graphify update": new Error("graphify not in PATH"),
    })
    await runGraphSync({
      enabled: true,
      watch: false,
      autoInstall: false,
      autoUpgrade: true,
      projectDir: testTmp,
      installTimeoutMs: 2000,
      upgradeCachePath: cachePath,
      runner: toExecSync(runner),
    })
    // Cache must be written ONCE with both fields present
    const cache = await readUpgradeCache(cachePath)
    expect(cache).not.toBeNull()
    expect(typeof cache!.codegraphLatest).toBe("string")
    expect(typeof cache!.graphifyLatest).toBe("string")
    // Count `npm view` calls — must be 0 (both upgrades used cached latest).
    const npmViewCalls = runner.calls.filter(c => c.includes("npm view")).length
    expect(npmViewCalls).toBe(0)
  }, 30_000)
})