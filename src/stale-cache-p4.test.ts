/**
 * P4 STALE_CACHE polarity (v0.51.x Wave A).
 *
 * - Equal versions (incl. "v"-prefix / whitespace variants) → silent.
 * - npm strictly newer → warn.
 * - Loaded newer than npm (local dev ahead) → silent.
 * - Fresh upgrade cache → no registry re-fetch, file left untouched.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { rm, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

let testTmp: string

beforeEach(async () => {
  testTmp = await mkdtemp(join(tmpdir(), "omo-p4-"))
})

afterEach(async () => {
  try {
    await rm(testTmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  } catch { /* best-effort */ }
})
describe("shouldWarnStaleCache polarity (P4)", () => {
  it("stays silent when loaded === npm latest", async () => {
    const { shouldWarnStaleCache } = await import("./graph-sync")
    expect(shouldWarnStaleCache("0.51.0", "0.51.0")).toBe(false)
  })

  it("stays silent on v-prefix / whitespace variants of the same version", async () => {
    const { shouldWarnStaleCache } = await import("./graph-sync")
    expect(shouldWarnStaleCache("0.51.0", "v0.51.0")).toBe(false)
    expect(shouldWarnStaleCache("v0.51.0", "0.51.0")).toBe(false)
    expect(shouldWarnStaleCache("0.51.0", "  0.51.0  ")).toBe(false)
  })

  it("warns when npm latest is strictly newer", async () => {
    const { shouldWarnStaleCache } = await import("./graph-sync")
    expect(shouldWarnStaleCache("0.50.2", "0.51.0")).toBe(true)
    expect(shouldWarnStaleCache("0.51.0", "v0.51.1")).toBe(true)
  })

  it("stays silent when loaded is newer than npm (local dev ahead)", async () => {
    const { shouldWarnStaleCache } = await import("./graph-sync")
    expect(shouldWarnStaleCache("0.51.0", "0.50.2")).toBe(false)
  })

  it("stays silent on missing / malformed input", async () => {
    const { shouldWarnStaleCache } = await import("./graph-sync")
    expect(shouldWarnStaleCache(null, "0.51.0")).toBe(false)
    expect(shouldWarnStaleCache("0.51.0", null)).toBe(false)
    expect(shouldWarnStaleCache("unknown", "0.51.0")).toBe(false)
  })
})
describe("isNewerVersion v-prefix normalization (P4)", () => {
  it("treats v-prefixed equals as equal", async () => {
    const { isNewerVersion } = await import("./graph-sync")
    expect(isNewerVersion("v1.0.0", "1.0.0")).toBe(false)
    expect(isNewerVersion("1.0.0", "v1.0.0")).toBe(false)
    expect(isNewerVersion("V2.0.0", "v2.0.0")).toBe(false)
  })

  it("still detects newer across v-prefix", async () => {
    const { isNewerVersion } = await import("./graph-sync")
    expect(isNewerVersion("1.0.0", "v1.0.1")).toBe(true)
    expect(isNewerVersion("v2.0.0", "1.0.0")).toBe(false)
  })
})
describe("fresh upgrade cache implies no re-fetch (P4)", () => {
  it("leaves a fresh cache byte-identical and triggers no upgrade", async () => {
    const { runGraphSync, resetInitializedProjects } = await import("./graph-sync")
    resetInitializedProjects()

    const cachePath = join(testTmp, "upgrade-check.json")
    await writeFile(cachePath, JSON.stringify({ checkedAtMs: Date.now(), codegraphLatest: "1.2.3" }))
    const before = await readFile(cachePath, "utf-8")

    const seen: string[] = []
    const runner = ((cmd: string, _opts?: unknown) => {
      seen.push(cmd)
      if (cmd.startsWith("npx --yes codegraph --version")) return "1.2.3"
      throw new Error(`unavailable: ${cmd}`)
    }) as typeof import("node:child_process").execSync

    const result = await runGraphSync({
      enabled: true,
      watch: false,
      autoInstall: false,
      autoUpgrade: true,
      checkGraphifyNeedsUpdate: false,
      projectDir: testTmp,
      installTimeoutMs: 500,
      upgradeCachePath: cachePath,
      upgradeCheckTtlMs: 24 * 60 * 60 * 1000,
      runner,
    })

    expect(result.attempted).toBe(true)
    expect(seen.some((c) => c.includes("npm view") || c.includes("pip index"))).toBe(false)
    expect(result.codes).not.toContain("codegraph-upgraded")
    expect(result.codes).not.toContain("upgrade-cache-written")
    expect(await readFile(cachePath, "utf-8")).toBe(before)
  }, 30_000)
})
