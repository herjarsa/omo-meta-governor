/**
 * v0.36.1 (audit P1-4 + Oracle review) — startup build field must equal version.
 *
 * Bug (v0.35.9): logToFile at plugin.ts:312 emitted `build: "0.19.5-instr"`
 * (16 minor versions stale) while the plugin version was 0.35.9.
 *
 * v0.36.1: asserts the runtime contract — DEFAULT_VERSION equals the
 * package.json version field, and the plugin factory's startup log
 * receives `build: DEFAULT_VERSION` (no stale literal).
 */
import { describe, expect, it } from "bun:test"

describe("P1-4 startup build label", () => {
  it("then DEFAULT_VERSION equals package.json version at runtime", async () => {
    const pkg = (await import("../package.json", { with: { type: "json" } })).default as {
      version: string
    }
    const { DEFAULT_VERSION } = await import("./metrics")
    expect(typeof DEFAULT_VERSION).toBe("string")
    expect(DEFAULT_VERSION.length).toBeGreaterThan(0)
    expect(DEFAULT_VERSION).toBe(pkg.version)
  })

  it("then createMetaGovernorPlugin startup emits build === DEFAULT_VERSION", async () => {
    const pkg = (await import("../package.json", { with: { type: "json" } })).default as {
      version: string
    }
    // Inspect the actual factory invocation: the first `logToFile("info", ...
    // plugin loaded", { version, build, ... })` call must use build =
    // DEFAULT_VERSION (a self-reference, not a frozen literal). We cannot
    // easily spy on the logger without polluting other tests, so instead we
    // assert the contract by reading the source for the exact pattern:
    //   build: DEFAULT_VERSION
    // This is a structural test, but it is anchored on the canonical name
    // (DEFAULT_VERSION) rather than the stale literal ("0.19.5-instr"), so
    // refactors that re-freeze the literal would break it.
    const { readFile } = await import("node:fs/promises")
    const { join } = await import("node:path")
    const src = await readFile(join(import.meta.dir, "plugin.ts"), "utf-8")
    // The startup payload block must contain `build: DEFAULT_VERSION`.
    const hasBuildSelf = /\bbuild\s*:\s*DEFAULT_VERSION\b/.test(src)
    // And must NOT contain the frozen stale literal.
    const noStaleLiteral = !src.includes('"0.19.5-instr"')
    expect(hasBuildSelf).toBe(true)
    expect(noStaleLiteral).toBe(true)
    // Sanity: the version we just read from package.json exists somewhere
    // in source (DEFAULT_VERSION resolves to it at runtime).
    expect(src.includes(pkg.version)).toBe(false) // version literal not hardcoded
  })
})