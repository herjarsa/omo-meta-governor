/**
 * Tests for the graphify check-update ordering inside runGraphSync.
 *
 * S2 contract (Plan W3-TEST):
 * - runner DI records invocation order in a fresh mkdtemp tmpdir;
 *   graphify absent → installed via pip → `graphify check-update` exits 1 →
 *   `pip install` MUST precede `check-update`, and codes MUST include
 *   `graphify-reextract-triggered`.
 * - Real runner in an empty tmpdir: never throws, codes carry
 *   unavailable/skipped markers.
 *
 * Hermetic: the DI runner replaces execSync so no real npx/pip/graphify
 * spawns in the ordering test. Only the never-throws test uses the real
 * runner (autoInstall:false + autoUpgrade:false + checkGraphifyNeedsUpdate:false
 * so it performs availability probes only, no installs).
 */

import { describe, expect, it, beforeEach } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { execSync } from "node:child_process"
import {
  runGraphSync,
  resetInitializedProjects,
} from "./graph-sync"

beforeEach(() => {
  resetInitializedProjects()
})

describe("S2 graphify check-update ordering (runner DI)", () => {
  it("pip install precedes check-update and codes include graphify-reextract-triggered", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "omo-s2-order-"))
    try {
      const order: string[] = []
      const runner = ((cmd: string) => {
        order.push(cmd)
        // Availability probes: every tool absent.
        if (cmd.startsWith("pip install --upgrade graphifyy")) return Buffer.from("ok")
        if (cmd.startsWith("graphify check-update ")) throw new Error("semantic update pending (exit 1)")
        if (cmd.startsWith("graphify update ")) return Buffer.from("re-extracted")
        throw new Error(`not available: ${cmd}`)
      }) as unknown as typeof execSync

      const result = await runGraphSync({
        enabled: true,
        watch: false,
        projectDir: tmp,
        autoInstall: true,
        autoUpgrade: false,
        checkGraphifyNeedsUpdate: true,
        installTimeoutMs: 1_000,
        runner,
      })

      expect(result.attempted).toBe(true)
      expect(result.availability.graphify).toBe(true)
      expect(result.codes).toContain("graphify-reextract-triggered")

      const pipIdx = order.findIndex((c) => c.startsWith("pip install --upgrade graphifyy"))
      const checkIdx = order.findIndex((c) => c.startsWith("graphify check-update "))
      const updateIdx = order.findIndex((c) => c.startsWith("graphify update "))
      expect(pipIdx).toBeGreaterThanOrEqual(0)
      expect(checkIdx).toBeGreaterThanOrEqual(0)
      expect(updateIdx).toBeGreaterThanOrEqual(0)
      // pip install lands BEFORE `graphify check-update` (fresh installs
      // report stale otherwise) and the re-extract follows the failed check.
      expect(pipIdx).toBeLessThan(checkIdx)
      expect(checkIdx).toBeLessThan(updateIdx)
    } finally {
      await rm(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {})
    }
  }, 30000)

  it("real runner in an empty tmpdir never throws and reports unavailable/skipped codes", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "omo-s2-real-"))
    try {
      // No runner DI: real availability probes only (no installs, no
      // upgrade network calls, no check-update spawn).
      const result = await runGraphSync({
        enabled: true,
        watch: false,
        projectDir: tmp,
        autoInstall: false,
        autoUpgrade: false,
        checkGraphifyNeedsUpdate: false,
        installTimeoutMs: 1_000,
      })
      expect(result.attempted).toBe(true)
      expect(result.codes.length).toBeGreaterThan(0)
      // Every unavailable tool surfaces BOTH markers under autoInstall:false.
      if (!result.availability.codegraph) {
        expect(result.codes).toContain("codegraph-unavailable")
        expect(result.codes).toContain("codegraph-install-skipped")
      }
      if (!result.availability.graphify) {
        expect(result.codes).toContain("graphify-unavailable")
        expect(result.codes).toContain("graphify-install-skipped")
      }
    } finally {
      await rm(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {})
    }
  }, 30000)
})
