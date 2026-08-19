/**
 * Tests for cli-anything-sync.ts (v0.28.0).
 * Mirrors upgrade-autofix.test.ts strategy: full DI runner + temp cache files.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runCliAnythingSync, type Runner } from "./cli-anything-sync"

let tmpDir: string
let cachePath: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "omo-cli-anything-sync-"))
  cachePath = join(tmpDir, "upgrade-cache.json")
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

function makeRunner(map: Record<string, string>): Runner {
  return (cmd: string) => {
    for (const [pattern, response] of Object.entries(map)) {
      if (cmd.startsWith(pattern)) return response
    }
    throw new Error(`unhandled: ${cmd}`)
  }
}

describe("runCliAnythingSync — disabled", () => {
  it("returns early with codes=skipped when enabled=false", async () => {
    const result = await runCliAnythingSync({ enabled: false, cachePath })
    expect(result.attempted).toBe(false)
    expect(result.codes).toContain("cli-anything-upgrade-skipped")
  })
})

describe("runCliAnythingSync — auto-install", () => {
it("installs cli-anything-hub when missing and autoInstall=true", async () => {
    // First 3 version probes fail (pip show / pip3 show / python -m pip show).
    // Then install attempt succeeds. The post-install re-probe also fails —
    // sync still treats cliHub as installed because the install step reported success.
    let installCalled = false
    const smart: Runner = (cmd: string) => {
      if (cmd.startsWith("pip show") || cmd.startsWith("pip3 show"))
        throw new Error("not installed")
      if (cmd.startsWith("python -m pip show"))
        throw new Error("not installed (post-install re-probe)")
      if (cmd.startsWith("uv tool install")) {
        installCalled = true
        return "Installed cli-anything-hub-0.4.1"
      }
      if (cmd.startsWith("npx skills list"))
        return ""
      if (cmd.startsWith("npx skills add"))
        return "skill installed"
      throw new Error(`unhandled: ${cmd}`)
    }
    void installCalled
    const result = await runCliAnythingSync({
      enabled: true,
      autoInstall: true,
      autoUpgrade: false,
      cachePath,
      runner: smart,
    })
    expect(result.attempted).toBe(true)
    expect(installCalled).toBe(true)
    expect(result.codes).toContain("cli-anything-install-succeeded")
  })

  it("skips install when already present and autoInstall=true", async () => {
    const smart: Runner = (cmd: string) => {
      if (cmd.startsWith("pip show cli-anything-hub"))
        return "Name: cli-anything-hub\nVersion: 0.4.1\n"
      if (cmd.startsWith("npx skills list"))
        return ""
      throw new Error(`unhandled: ${cmd}`)
    }
    const result = await runCliAnythingSync({
      enabled: true,
      autoInstall: true,
      autoUpgrade: false,
      cachePath,
      runner: smart,
    })
    expect(result.codes).toContain("cli-anything-already-installed")
    expect(result.codes).not.toContain("cli-anything-install-succeeded")
  })
})

describe("runCliAnythingSync — auto-upgrade cache TTL", () => {
  it("skips PyPI probe when the cache is fresh", async () => {
    // Pre-write a fresh cache
    const { writeFileSync } = await import("node:fs")
    writeFileSync(
      cachePath,
      JSON.stringify({
        cliHubLatestVersion: "0.4.1",
        updatedAtISO: new Date().toISOString(),
      }),
    )
    let pipIndexCalled = false
    const runner: Runner = (cmd: string) => {
      if (cmd.startsWith("pip index")) {
        pipIndexCalled = true
        return "cli-anything-hub (0.5.0)"
      }
      if (cmd.startsWith("pip show")) return "Name: cli-anything-hub\nVersion: 0.4.1\n"
      if (cmd.startsWith("npx skills list")) return ""
      throw new Error(`unhandled: ${cmd}`)
    }
    await runCliAnythingSync({
      enabled: true,
      autoInstall: false,
      autoUpgrade: true,
      cachePath,
      upgradeCheckTtlMs: 24 * 60 * 60 * 1000,
      runner,
    })
    expect(pipIndexCalled).toBe(false)
  })

  it("probes PyPI when the cache is stale", async () => {
    // Pre-write a stale cache
    const { writeFileSync } = await import("node:fs")
    writeFileSync(
      cachePath,
      JSON.stringify({
        cliHubLatestVersion: "0.4.1",
        updatedAtISO: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
      }),
    )
    let pipIndexCalled = false
    let uvCalled = false
    const runner: Runner = (cmd: string) => {
      if (cmd.startsWith("pip index")) {
        pipIndexCalled = true
        return "cli-anything-hub (0.5.0)"
      }
      if (cmd.startsWith("pip show")) return "Name: cli-anything-hub\nVersion: 0.4.1\n"
      if (cmd.startsWith("uv tool upgrade")) {
        uvCalled = true
        return "Upgraded cli-anything-hub"
      }
      if (cmd.startsWith("npx skills list")) return ""
      throw new Error(`unhandled: ${cmd}`)
    }
    await runCliAnythingSync({
      enabled: true,
      autoInstall: false,
      autoUpgrade: true,
      cachePath,
      upgradeCheckTtlMs: 24 * 60 * 60 * 1000,
      runner,
    })
    expect(pipIndexCalled).toBe(true)
    expect(uvCalled).toBe(true)
  })
})

describe("runCliAnythingSync — meta-skill install", () => {
  it("installs cli-hub-meta-skill when missing", async () => {
    let installCalled = false
    const runner: Runner = (cmd: string) => {
      if (cmd.startsWith("pip show cli-anything-hub"))
        return "Name: cli-anything-hub\nVersion: 0.4.1\n"
      if (cmd.startsWith("npx skills list"))
        return "some-other-skill  x/y  0.1.0  global\n"
      if (cmd.startsWith("npx skills add")) {
        installCalled = true
        return "skill installed"
      }
      throw new Error(`unhandled: ${cmd}`)
    }
    const result = await runCliAnythingSync({
      enabled: true,
      autoInstall: true,
      autoUpgrade: false,
      cachePath,
      runner,
    })
    expect(installCalled).toBe(true)
    expect(result.codes).toContain("skill-install-succeeded")
    expect(result.availability.metaSkill).toBe(true)
  })
})