/**
 * Tests for the graphSync initialization placement fix.
 *
 * Regression for the main bug: runGraphSync was called ONCE at module-load
 * with `process.cwd()` (the SERVER's cwd under `opencode serve`), so session
 * projects were never initialized. The fix moves the call into the factory
 * invocation using `_input.directory ?? cwd`.
 *
 * These tests use `deps.__test_onGraphSyncInit` (test-only hook, same pattern
 * as `__test_onCommitTrigger`) to assert the projectDir WITHOUT executing real
 * npm/pip/CLI commands.
 */

import { describe, expect, it, mock } from "bun:test"
import { resolve } from "node:path"
import type { PluginInput } from "@opencode-ai/plugin"

// v0.21.0: hermetic placement tests. The factory must invoke runGraphSync
// with the SESSION project dir, but the real runGraphSync spawns npx/graphify
// (blocking execSync that would stall the test event loop). Mock the module:
// keep isGitCommitCommand real (imported via absolute path derived from
// import.meta.dir — portable across machines/CI; mock.module only intercepts
// the relative specifier), spy on runGraphSync/trackSession.
const realGraphSync = await import(
  resolve(import.meta.dir, "graph-sync.ts"),
)
mock.module("./graph-sync", () => ({
  ...realGraphSync,
  runGraphSync: async () => ({ attempted: true, codes: [], availability: {
    codegraph: false, graphify: false, codegraphIndexExists: false, graphifyIndexExists: false,
  }, alreadyInitialized: false }),
  trackSession: () => 1,
  untrackSession: () => 0,
  triggerReindex: async () => ({ attempted: true, codes: [], availability: {
    codegraph: false, graphify: false, codegraphIndexExists: false, graphifyIndexExists: false,
  }, alreadyInitialized: false }),
}))

import { createMetaGovernorPlugin, type MetaGovernorPluginDeps } from "./plugin"

function makeInput(directory: string): PluginInput {
  return {
    client: null as unknown as PluginInput["client"],
    project: null as unknown as PluginInput["project"],
    directory,
    worktree: "",
    experimental_workspace: { register: () => {} },
    serverUrl: new URL("http://localhost"),
    $: null as unknown as PluginInput["$"],
  }
}

describe("graphSync init placement", () => {
  it("fires __test_onGraphSyncInit with _input.directory when present", async () => {
    const seen: string[] = []
    const deps: MetaGovernorPluginDeps = {
      __test_onGraphSyncInit: ({ projectDir }) => {
        seen.push(projectDir)
      },
    }
    const plugin = createMetaGovernorPlugin(
      { graphSync: { enabled: true, autoInstall: false, installTimeoutMs: 100 } },
      deps,
    )
    await plugin(makeInput("D:/test/project-a"), {})
    // resolve() normalizes to OS-native separators.
    expect(seen).toEqual([resolve("D:/test/project-a")])
  })

  it("falls back to cwd when _input.directory is absent", async () => {
    const seen: string[] = []
    const deps: MetaGovernorPluginDeps = {
      __test_onGraphSyncInit: ({ projectDir }) => {
        seen.push(projectDir)
      },
    }
    const plugin = createMetaGovernorPlugin(
      { graphSync: { enabled: true, autoInstall: false, installTimeoutMs: 100 } },
      deps,
    )
    // directory must be undefined (nullish), NOT "" — "" is not nullish and
    // would flow into loadMetaGovernorConfig as projectDir.
    await plugin(makeInput(undefined as unknown as string), {})
    expect(seen.length).toBe(1)
    // Must be an absolute path (resolve() applied), not the empty string.
    // Portable across OSes: Windows drive paths (D:\\...) and POSIX (/home/...).
    expect(seen[0]).toMatch(/^([A-Za-z]:[\\/]|\/)/)
  })

  it("does NOT fire when graphSync.enabled is false", async () => {
    const seen: string[] = []
    const deps: MetaGovernorPluginDeps = {
      __test_onGraphSyncInit: ({ projectDir }) => {
        seen.push(projectDir)
      },
    }
    const plugin = createMetaGovernorPlugin(
      { graphSync: { enabled: false, autoInstall: false } },
      deps,
    )
    await plugin(makeInput("D:/test/project-b"), {})
    expect(seen).toEqual([])
  })

  it("fires even when governance is disabled (graphSync is tool infra)", async () => {
    // graphSync.enabled defaults to true. governance (mergedConfig.enabled)
    // is false, but the graphSync init must still run — and must NOT pick up
    // the user's file config autoInstall (explicit inline config wins).
    const seen: string[] = []
    const deps: MetaGovernorPluginDeps = {
      __test_onGraphSyncInit: ({ projectDir }) => {
        seen.push(projectDir)
      },
    }
    const plugin = createMetaGovernorPlugin(
      {
        enabled: false,
        graphSync: { enabled: true, autoInstall: false, installTimeoutMs: 100 },
      },
      deps,
    )
    await plugin(makeInput("D:/test/project-c"), {})
    expect(seen).toEqual([resolve("D:/test/project-c")])
  })
})
