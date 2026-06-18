/**
 * Tests for the graphSync module.
 *
 * given/when/then style covering:
 * - runGraphSync with disabled config
 * - runGraphSync when already initialized
 * - Auto-install behavior
 * - Stop watches
 * - resetInitializedProjects
 */

import { describe, expect, it, beforeEach } from "bun:test"
import {
  runGraphSync,
  stopWatches,
  resetInitializedProjects,
  type GraphSyncConfig,
} from "./graph-sync"

const testProjectDir = "/tmp/omo-test-project"

beforeEach(() => {
  resetInitializedProjects()
  stopWatches(testProjectDir)
})

describe("runGraphSync", () => {
  describe("#given disabled config", () => {
    const config: GraphSyncConfig = { enabled: false, watch: false }

    it("then returns attempted=false with disabled code", async () => {
      const result = await runGraphSync(config)
      expect(result.attempted).toBe(false)
      expect(result.codes).toContain("disabled")
      expect(result.alreadyInitialized).toBe(false)
    })
  })

  describe("#given enabled config with no tools available", () => {
    const config: GraphSyncConfig = {
      enabled: true,
      watch: false,
      projectDir: "/dev/null-test",
      autoInstall: false,
      installTimeoutMs: 100,
    }

    it("then returns attempted=true with some codes", async () => {
      const result = await runGraphSync(config)
      expect(result.attempted).toBe(true)
      // Result must contain at least one code describing the outcome
      expect(result.codes.length).toBeGreaterThan(0)
    })
  })

  describe("#given autoInstall=true and tools missing", () => {
    it("then attempts to install in a fresh tmpdir", async () => {
      const os = await import("node:os")
      const path = await import("node:path")
      const fs = await import("node:fs/promises")
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omo-graphsync-"))
      const config: GraphSyncConfig = {
        enabled: true,
        watch: false,
        projectDir: tmp,
        autoInstall: true,
        installTimeoutMs: 500,
      }
      const result = await runGraphSync(config)
      expect(result.attempted).toBe(true)
      expect(result.codes.length).toBeGreaterThan(0)
      try {
        await fs.rm(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      } catch {
        // Best effort cleanup - Windows may hold file handles briefly
      }
    })
  })

  describe("#given already initialized project", () => {
    it("then returns alreadyInitialized=true on second call", async () => {
      const config: GraphSyncConfig = {
        enabled: true,
        watch: false,
        projectDir: testProjectDir,
        autoInstall: false,
        installTimeoutMs: 100,
      }

      // First call
      const first = await runGraphSync(config)
      expect(first.attempted).toBe(true)
      expect(first.alreadyInitialized).toBe(false)

      // Second call
      const second = await runGraphSync(config)
      expect(second.alreadyInitialized).toBe(true)
      expect(second.attempted).toBe(false)
    })
  })

  describe("#given disabled config after prior init", () => {
    it("then returns disabled code", async () => {
      const result = await runGraphSync({ enabled: false, watch: false })
      expect(result.codes).toContain("disabled")
    })
  })
})

describe("resetInitializedProjects", () => {
  describe("#after initialization", () => {
    it("then allows re-initialization", async () => {
      const config: GraphSyncConfig = {
        enabled: true,
        watch: false,
        projectDir: "/tmp/test-reset",
        autoInstall: false,
        installTimeoutMs: 100,
      }

      const first = await runGraphSync(config)
      expect(first.attempted).toBe(true)

      resetInitializedProjects()

      const second = await runGraphSync(config)
      expect(second.alreadyInitialized).toBe(false)
      expect(second.attempted).toBe(true)
    })
  })
})
