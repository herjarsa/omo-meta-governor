/**
 * v0.36.0 (audit P1-4) — startup log "build" field must be consistent with version.
 *
 * Bug: plugin.ts:312 logged `build: "0.19.5-instr"` while version is 0.35.9.
 * 16 minor versions of stale instrumentation label confuse bundle-fingerprint
 * diagnostics. SHA-256 fingerprint in same log already proves freshness;
 * the human-readable build string must match.
 */
import { describe, expect, it } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { DEFAULT_VERSION } from "./metrics"

const PLUGIN_TS = join(import.meta.dir, "plugin.ts")

describe("P1-4 startup log build label matches DEFAULT_VERSION", () => {
  it("then no literal build label is frozen to an old version", async () => {
    const src = await readFile(PLUGIN_TS, "utf-8")
    // The literal "0.19.5-instr" must no longer appear anywhere.
    expect(src.includes('"0.19.5-instr"')).toBe(false)
  })

  it("then the startup log includes the current DEFAULT_VERSION", async () => {
    const src = await readFile(PLUGIN_TS, "utf-8")
    // The v${DEFAULT_VERSION} factory_invoked log line is the canonical signal.
    // Source contains the template literal `v${DEFAULT_VERSION} factory_invoked`.
    const has = src.includes("factory_invoked") && src.includes("DEFAULT_VERSION")
    expect(has).toBe(true)
  })
})
