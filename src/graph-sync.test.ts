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
  initGraphify,
  initCodegraph,
  checkToolAvailability,
  triggerReindex,
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
    // Hermetic: a runner that ALWAYS throws simulates "no tools" without
    // spawning real npx/pip — on CI Windows the real npx download + 4
    // fallback probes exceeded the 30s test timeout (14/08/2026).
    const alwaysFailRunner = (() => {
      throw new Error("tool not available")
    }) as unknown as typeof import("node:child_process").execSync

    const config: GraphSyncConfig = {
      enabled: true,
      watch: false,
      projectDir: "/dev/null-test",
      autoInstall: false,
      installTimeoutMs: 100,
      runner: alwaysFailRunner,
    }

    it("then returns attempted=true with some codes", async () => {
      const result = await runGraphSync(config)
      expect(result.attempted).toBe(true)
      expect(result.codes.length).toBeGreaterThan(0)
    }, 30000)
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
        // best effort cleanup - Windows may hold file handles briefly
      }
    }, 30000)
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

      const first = await runGraphSync(config)
      expect(first.attempted).toBe(true)
      expect(first.alreadyInitialized).toBe(false)

      const second = await runGraphSync(config)
      expect(second.alreadyInitialized).toBe(true)
      expect(second.attempted).toBe(false)
    }, 30000)
  })

  describe("#given disabled config after prior init", () => {
    it("then returns disabled code", async () => {
      const result = await runGraphSync({ enabled: false, watch: false })
      expect(result.codes).toContain("disabled")
    })
  })
})

describe("triggerReindex runner DI (Oracle N2, v0.21.0)", () => {
  // The seam must flow through to the underlying sync/init calls so a
  // hermetic test never spawns real npx/pip.
  it("passes the runner to the underlying runGraphSync", async () => {
    // Spy that always throws → checkToolAvailability reports unavailable for
    // every probe → runGraphSync returns immediately with the unavailability
    // codes, never reaching initCodegraph/initGraphify (which still use the
    // real execSync — out of scope for this seam).
    const calls: string[] = []
    const spyRunner = ((cmd: string) => {
      calls.push(cmd)
      throw new Error("not available")
    }) as unknown as typeof import("node:child_process").execSync
    const os = await import("node:os")
    const path = await import("node:path")
    const fs = await import("node:fs/promises")
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omo-reindex-"))
    try {
      const result = await triggerReindex(tmp, spyRunner)
      expect(result.attempted).toBe(true)
      // The runner flowed into the underlying call.
      expect(calls.length).toBeGreaterThan(0)
      // And the unavailability path was taken (probe threw → no init).
      expect(result.codes).toContain("codegraph-unavailable")
    } finally {
      await fs.rm(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {})
    }
  }, 30000)

  it("skips the availability probe when the codegraph index already exists", async () => {
    // Oracle N1: triggerCodegraphSync re-probes `codegraph --version` (up to
    // 5s) on the commit hot path even though triggerReindex already decided
    // the index exists. The sync must go straight to `codegraph sync -q`.
    const calls: string[] = []
    const spyRunner = ((cmd: string) => {
      calls.push(cmd)
      return Buffer.from("ok")
    }) as unknown as typeof import("node:child_process").execSync
    const os = await import("node:os")
    const path = await import("node:path")
    const fs = await import("node:fs/promises")
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omo-reindex2-"))
    try {
      await fs.mkdir(path.join(tmp, ".codegraph"), { recursive: true })
      const result = await triggerReindex(tmp, spyRunner)
      expect(result.attempted).toBe(true)
      // Straight to sync — NO --version probe, NO init.
      expect(calls.some((c) => c.includes("sync -q"))).toBe(true)
      expect(calls.some((c) => c.includes("--version"))).toBe(false)
    } finally {
      await fs.rm(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {})
    }
  })
})

describe("initGraphify fallback chain (Windows graphify binary)", () => {
  const projectDir = "/tmp/omo-graphify-fallback"

  it("tries the `graphify` BINARY (not just python3 -m graphify)", async () => {
    // Simulate a Windows machine where `graphify` binary exists but
    // `python3 -m graphify` fails (python3 is a WindowsApps stub).
    const seen: string[] = []
    const runner = ((cmd: string) => {
      seen.push(cmd)
      if (cmd.startsWith("graphify ")) return Buffer.from("ok")
      throw new Error("command failed")
    }) as typeof import("node:child_process").execSync

    const ok = await initGraphify(projectDir, 5_000, runner)
    expect(ok).toBe(true)
    // The binary form must be among the attempted commands.
    expect(seen.some((c) => c.startsWith("graphify ."))).toBe(true)
  })

  it("returns false (not undefined) when every candidate fails", async () => {
    const runner = (() => {
      throw new Error("all fail")
    }) as unknown as typeof import("node:child_process").execSync

    const ok = await initGraphify(projectDir, 5_000, runner)
    expect(ok).toBe(false)
  })
})

describe("initCodegraph honest return", () => {
  const projectDir = "/tmp/omo-codegraph-fallback"

  it("returns true when the init command succeeds", async () => {
    const runner = (() => Buffer.from("ok")) as unknown as typeof import("node:child_process").execSync
    const ok = await initCodegraph(projectDir, 5_000, runner)
    expect(ok).toBe(true)
  })

  it("returns false when the init command fails", async () => {
    const runner = (() => {
      throw new Error("init failed")
    }) as unknown as typeof import("node:child_process").execSync
    const ok = await initCodegraph(projectDir, 5_000, runner)
    expect(ok).toBe(false)
  })
})

describe("checkToolAvailability index markers", () => {
  const projectDir = "/tmp/omo-availability-markers"

  it("reports codegraphIndexExists=false when .codegraph dir is EMPTY (no codegraph.db)", async () => {
    const fs = await import("node:fs/promises")
    const path = await import("node:path")
    await fs.rm(projectDir, { recursive: true, force: true })
    await fs.mkdir(path.join(projectDir, ".codegraph"), { recursive: true })

    const runner = (() => {
      throw new Error("not available")
    }) as unknown as typeof import("node:child_process").execSync
    const avail = await checkToolAvailability(projectDir, runner)
    // Empty dir without the marker file must NOT count as initialized.
    expect(avail.codegraphIndexExists).toBe(false)
    expect(avail.graphifyIndexExists).toBe(false)

    await fs.rm(projectDir, { recursive: true, force: true })
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
    }, 30000)
  })
})
