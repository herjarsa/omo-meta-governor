/**
 * MetaGovernor v0.12.0 — Auto-upgrade tests.
 *
 * Scenario: when a new release of codegraph or graphify is published,
 * the plugin should detect it on next load (subject to cache TTL) and
 * run `npm i -D @colbymchenry/codegraph@latest` / `pip install --upgrade
 * graphifyy`. The check is cached in
 * ~/.config/opencode/omo-meta-governor-upgrade-check.json with TTL
 * (default 24h) to avoid hammering registries.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { rm, mkdtemp, writeFile, readFile } from "node:fs/promises"
import { tmpdir, homedir } from "node:os"
import { join } from "node:path"

let testTmp: string

beforeEach(async () => {
  testTmp = await mkdtemp(join(tmpdir(), "omo-v12-"))
})

afterEach(async () => {
  try {
    await rm(testTmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  } catch { /* */ }
})

// ─── S1: isNewerVersion semver comparator ───────────────────────

describe("isNewerVersion (v0.12.0 S1)", () => {
  it("then returns true when latest > installed", async () => {
    const { isNewerVersion } = await import("./graph-sync")
    expect(isNewerVersion("1.0.0", "1.0.1")).toBe(true)
    expect(isNewerVersion("1.0.0", "1.1.0")).toBe(true)
    expect(isNewerVersion("1.0.0", "2.0.0")).toBe(true)
    expect(isNewerVersion("0.9.0", "1.0.0")).toBe(true)
  })

  it("then returns false when latest <= installed", async () => {
    const { isNewerVersion } = await import("./graph-sync")
    expect(isNewerVersion("1.0.1", "1.0.0")).toBe(false)
    expect(isNewerVersion("1.0.0", "1.0.0")).toBe(false)
    expect(isNewerVersion("2.0.0", "1.0.0")).toBe(false)
  })

  it("then handles pre-release tags", async () => {
    const { isNewerVersion } = await import("./graph-sync")
    expect(isNewerVersion("1.0.0", "1.0.0-rc.1")).toBe(false)
    expect(isNewerVersion("1.0.0-rc.1", "1.0.0")).toBe(true)
  })

  it("then handles malformed input defensively", async () => {
    const { isNewerVersion } = await import("./graph-sync")
    expect(isNewerVersion("", "1.0.0")).toBe(false)
    expect(isNewerVersion("unknown", "1.0.0")).toBe(false)
    expect(isNewerVersion("1.0.0", "")).toBe(false)
    expect(isNewerVersion("not.a.version", "1.0.0")).toBe(false)
  })
})

// ─── S2: upgrade cache read/write with TTL ──────────────────────

describe("upgradeCache (v0.12.0 S2)", () => {
  it("then writeUpgradeCache + readUpgradeCache roundtrip", async () => {
    const { writeUpgradeCache, readUpgradeCache } = await import("./graph-sync")
    const cachePath = join(testTmp, "upgrade-cache.json")
    const payload = {
      checkedAtMs: Date.now(),
      codegraphLatest: "1.2.3",
      graphifyLatest: "2.0.0",
    }
    await writeUpgradeCache(cachePath, payload)
    const read = await readUpgradeCache(cachePath)
    expect(read).toEqual(payload)
  })

  it("then readUpgradeCache returns null when file missing", async () => {
    const { readUpgradeCache } = await import("./graph-sync")
    const result = await readUpgradeCache(join(testTmp, "does-not-exist.json"))
    expect(result).toBeNull()
  })

  it("then readUpgradeCache returns null for corrupt file", async () => {
    const { readUpgradeCache } = await import("./graph-sync")
    const cachePath = join(testTmp, "corrupt.json")
    await writeFile(cachePath, "not json {{{")
    const result = await readUpgradeCache(cachePath)
    expect(result).toBeNull()
  })

  it("then isCacheFresh returns true when within TTL", async () => {
    const { writeUpgradeCache, readUpgradeCache, isCacheFresh } = await import("./graph-sync")
    const cachePath = join(testTmp, "fresh.json")
    await writeUpgradeCache(cachePath, { checkedAtMs: Date.now() })
    const cache = await readUpgradeCache(cachePath)
    // 24h TTL — just-written is always fresh
    expect(isCacheFresh(cache, 24 * 60 * 60 * 1000)).toBe(true)
  })

  it("then isCacheFresh returns false when older than TTL", async () => {
    const { writeUpgradeCache, readUpgradeCache, isCacheFresh } = await import("./graph-sync")
    const cachePath = join(testTmp, "stale.json")
    const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000
    await writeUpgradeCache(cachePath, { checkedAtMs: twoDaysAgo })
    const cache = await readUpgradeCache(cachePath)
    // 24h TTL — 2-day-old is stale
    expect(isCacheFresh(cache, 24 * 60 * 60 * 1000)).toBe(false)
  })

  it("then isCacheFresh returns false when cache is null", async () => {
    const { isCacheFresh } = await import("./graph-sync")
    expect(isCacheFresh(null, 24 * 60 * 60 * 1000)).toBe(false)
  })
})

// ─── S3: shouldUpgrade logic (cache + installed + latest) ────────

describe("shouldUpgrade (v0.12.0 S3)", () => {
  it("then returns true when installed < latest and cache is stale", async () => {
    const { shouldUpgrade } = await import("./graph-sync")
    expect(shouldUpgrade("0.9.0", "1.0.0", null, 24 * 60 * 60 * 1000)).toBe(true)
  })

  it("then returns false when installed >= latest", async () => {
    const { shouldUpgrade } = await import("./graph-sync")
    expect(shouldUpgrade("1.0.0", "1.0.0", null, 24 * 60 * 60 * 1000)).toBe(false)
    expect(shouldUpgrade("1.0.1", "1.0.0", null, 24 * 60 * 60 * 1000)).toBe(false)
  })

  it("then returns false when cache is fresh AND installed >= cached latest", async () => {
    const { shouldUpgrade } = await import("./graph-sync")
    const freshCache = { checkedAtMs: Date.now(), codegraphLatest: "1.0.0" }
    // Cache fresh + installed matches cached latest → no need to re-check
    expect(shouldUpgrade("1.0.0", null, freshCache, 24 * 60 * 60 * 1000)).toBe(false)
  })

  it("then returns true when cache is fresh but installed < cached latest", async () => {
    // Stale install, but registry is cached → upgrade is needed
    const { shouldUpgrade } = await import("./graph-sync")
    const freshCache = { checkedAtMs: Date.now(), codegraphLatest: "1.0.0" }
    expect(shouldUpgrade("0.5.0", null, freshCache, 24 * 60 * 60 * 1000)).toBe(true)
  })

  it("then returns true when installed is unknown (null) and latest is known", async () => {
    const { shouldUpgrade } = await import("./graph-sync")
    expect(shouldUpgrade(null, "1.0.0", null, 24 * 60 * 60 * 1000)).toBe(true)
  })

  it("then returns false when both installed and latest are unknown", async () => {
    const { shouldUpgrade } = await import("./graph-sync")
    expect(shouldUpgrade(null, null, null, 24 * 60 * 60 * 1000)).toBe(false)
  })
})

// ─── S4: end-to-end runGraphSync with autoUpgrade=false ─────────

describe("runGraphSync with autoUpgrade=false (v0.12.0 S4)", () => {
  it("then does not query npm/pip registries", async () => {
    const { runGraphSync, resetInitializedProjects } = await import("./graph-sync")
    resetInitializedProjects()

    // With autoUpgrade=false, no network calls to registries
    const result = await runGraphSync({
      enabled: true,
      watch: false,
      autoInstall: false,
      autoUpgrade: false,
      projectDir: testTmp,
      installTimeoutMs: 500,
    })

    expect(result.attempted).toBe(true)
    // No upgrade codes emitted
    expect(result.codes).not.toContain("codegraph-upgraded")
    expect(result.codes).not.toContain("graphify-upgraded")
  }, 30_000)
})

// ─── S5: graphify auto-upgrade fix (v0.25.2) ────────────────────

describe("graphify auto-upgrade fix (v0.25.2)", () => {
  describe("#shouldUpgrade with graphify cache field", () => {
    it("then uses cache.graphifyLatest for the graphify tool (not codegraphLatest)", async () => {
      const { shouldUpgrade } = await import("./graph-sync")
      const freshCache = { checkedAtMs: Date.now(), graphifyLatest: "0.9.45", codegraphLatest: "1.0.0" }
      // installed 0.8.30 < cached graphifyLatest 0.9.45 → upgrade
      expect(shouldUpgrade("0.8.30", null, freshCache, 24 * 60 * 60 * 1000, "graphifyLatest")).toBe(true)
    })

    it("then does NOT use codegraphLatest when evaluating graphify", async () => {
      const { shouldUpgrade } = await import("./graph-sync")
      const freshCache = { checkedAtMs: Date.now(), codegraphLatest: "1.0.0" } // no graphifyLatest
      // No graphifyLatest known → cannot decide → false (no registry hammer)
      expect(shouldUpgrade("0.8.30", null, freshCache, 24 * 60 * 60 * 1000, "graphifyLatest")).toBe(false)
    })
  })

  describe("#getInstalledGraphifyVersion python fallback", () => {
    it.skip("then falls back to `python` when `python3` lacks the package (Windows dual-python bug)", async () => {
      // TODO: implement runner DI for getInstalledGraphifyVersion
      // const { getInstalledGraphifyVersion } = await import("./graph-sync")
      // const runner = ((cmd: string) => {
      //   if (cmd.startsWith("python3")) throw new Error("python3 has no graphifyy")
      //   if (cmd.startsWith("python -m pip show graphifyy")) return "Version: 0.8.30\nLocation: C:\\Python314\\Lib\\site-packages\n"
      //   throw new Error(`unexpected: ${cmd}`)
      // }) as typeof import("node:child_process").execSync
      // const v = await getInstalledGraphifyVersion(runner as never)
      // expect(v).toBe("0.8.30")
    })
  })

  describe("#fetchGraphifyLatestVersion python fallback", () => {
    it.skip("then falls back to `python` when `python3` pip index fails (uses runGuardedSync now)", async () => {
      // TODO: fetchGraphifyLatestVersion now uses runGuardedSync directly,
      // not the runner parameter. Need to mock runGuardedSync for this test.
    })
  })
})