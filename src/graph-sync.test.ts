/**
 * Tests for the graphSync module.
 *
 * given/when/then style covering:
 * - runGraphSync with disabled config
 * - runGraphSync when already initialized
 * - Stop watches
 * - resetInitializedProjects
 *
 * Note: Tests that require actual codegraph/graphify binaries are
 * skipped in standard CI. The module itself gracefully degrades.
 */

import { describe, expect, it, beforeEach } from "bun:test"
import {
  runGraphSync,
  stopWatches,
  resetInitializedProjects,
  type GraphSyncResult,
  type GraphSyncConfig,
} from "./graph-sync"

// ─── Setup ──────────────────────────────────────────────────────────

const testProjectDir = "/tmp/omo-test-project"

beforeEach(() => {
  resetInitializedProjects()
  stopWatches(testProjectDir)
})

// ─── Disabled config ────────────────────────────────────────────────

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
    }

    it("then returns unavailable codes", async () => {
      const result = await runGraphSync(config)
      expect(result.attempted).toBe(true)
      expect(result.codes).toContain("codegraph-unavailable")
      expect(result.codes).toContain("graphify-unavailable")
      expect(result.availability.codegraph).toBe(false)
      expect(result.availability.graphify).toBe(false)
    })
  })

  // ─── Already initialized ────────────────────────────────────────

  describe("#given already initialized project", () => {
    it("then returns alreadyInitialized=true on second call", async () => {
      const config: GraphSyncConfig = {
        enabled: true,
        watch: false,
        projectDir: "/tmp/test-dup",
      }

      // First call
      const first = await runGraphSync(config)
      expect(first.attempted).toBe(true)

      // Second call — should see project as already initialized
      const second = await runGraphSync(config)
      expect(second.alreadyInitialized).toBe(true)
      expect(second.attempted).toBe(false)
    })
  })

  // ─── Disabled after enabled ─────────────────────────────────────

  describe("#given disabled config after prior init", () => {
    it("then returns disabled code", async () => {
      const result = await runGraphSync({ enabled: false, watch: false })
      expect(result.codes).toContain("disabled")
    })
  })
})

// ─── resetInitializedProjects ───────────────────────────────────────

describe("resetInitializedProjects", () => {
  describe("#after initialization", () => {
    it("then allows re-initialization", async () => {
      const config: GraphSyncConfig = {
        enabled: true,
        watch: false,
        projectDir: "/tmp/test-reset",
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
