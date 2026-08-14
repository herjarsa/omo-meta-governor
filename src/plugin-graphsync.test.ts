/**
 * Tests for the graphSync initialization placement fix.
 *
 * Regression for the main bug: runGraphSync was called ONCE at module-load
 * with `process.cwd()` (the SERVER's cwd under `opencode serve`), so session
 * projects were never initialized. The fix moves the call into the factory
 * invocation using `_input.directory ?? cwd`.
 *
 * These tests are hermetic via two deps seams (same pattern as
 * `__test_onCommitTrigger`):
 * - `__test_onGraphSyncInit` asserts the projectDir passed to the init.
 * - `__test_runGraphSync` REPLACES the real runGraphSync so npx/pip/graphify
 *   never spawn. A DI seam is used instead of `mock.module("./graph-sync")`
 *   because that mock leaked across test files sharing a Bun worker
 *   (broke CI on macOS: graph-sync.test.ts imported the mocked module).
 */
import { describe, expect, it } from "bun:test"
import { resolve } from "node:path"
import type { PluginInput } from "@opencode-ai/plugin"

import { createMetaGovernorPlugin, type MetaGovernorPluginDeps } from "./plugin"

// Fake GraphSyncResult — the real runGraphSync would spawn npx/pip.
const fakeRunGraphSync = (async () => ({
  attempted: true,
  codes: [],
  availability: {
    codegraph: false,
    graphify: false,
    codegraphIndexExists: false,
    graphifyIndexExists: false,
  },
  alreadyInitialized: false,
})) as unknown as NonNullable<MetaGovernorPluginDeps["__test_runGraphSync"]>

// Fake where BOTH index tools are available — marks the project ready so
// messages.transform nudges the agent to use codegraph/graphify.
const readyRunGraphSync = (async () => ({
  attempted: true,
  codes: ["codegraph-initialized", "graphify-initialized"],
  availability: {
    codegraph: true,
    graphify: true,
    codegraphIndexExists: true,
    graphifyIndexExists: true,
  },
  alreadyInitialized: false,
})) as unknown as NonNullable<MetaGovernorPluginDeps["__test_runGraphSync"]>

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

function makeDeps(seen: string[]): MetaGovernorPluginDeps {
  return {
    __test_onGraphSyncInit: ({ projectDir }) => {
      seen.push(projectDir)
    },
    __test_runGraphSync: fakeRunGraphSync,
  }
}

describe("graphSync init placement", () => {
  it("fires __test_onGraphSyncInit with _input.directory when present", async () => {
    const seen: string[] = []
    const plugin = createMetaGovernorPlugin(
      { graphSync: { enabled: true, autoInstall: false, installTimeoutMs: 100 } },
      makeDeps(seen),
    )
    await plugin(makeInput("D:/test/project-a"), {})
    // resolve() normalizes to OS-native separators.
    expect(seen).toEqual([resolve("D:/test/project-a")])
  })

  it("falls back to cwd when _input.directory is absent", async () => {
    const seen: string[] = []
    const plugin = createMetaGovernorPlugin(
      { graphSync: { enabled: true, autoInstall: false, installTimeoutMs: 100 } },
      makeDeps(seen),
    )
    // directory must be undefined (nullish), NOT "" — "" is not nullish and
    // would flow into loadMetaGovernorConfig as projectDir.
    await plugin(makeInput(undefined as unknown as string), {})
    expect(seen.length).toBe(1)
    // Must be an absolute path (resolve() applied), not the empty string.
    // Portable across OSes: Windows drive paths (D:\...) and POSIX (/home/...).
    expect(seen[0]).toMatch(/^([A-Za-z]:[\\/]|\/)/)
  })

  it("does NOT fire when graphSync.enabled is false", async () => {
    const seen: string[] = []
    const plugin = createMetaGovernorPlugin(
      { graphSync: { enabled: false, autoInstall: false } },
      makeDeps(seen),
    )
    await plugin(makeInput("D:/test/project-b"), {})
    expect(seen).toEqual([])
  })

  it("fires even when governance is disabled (graphSync is tool infra)", async () => {
    // graphSync.enabled defaults to true. governance (mergedConfig.enabled)
    // is false, but the graphSync init must still run — and must NOT pick up
    // the user's file config autoInstall (explicit inline config wins).
    const seen: string[] = []
    const plugin = createMetaGovernorPlugin(
      { enabled: false, graphSync: { enabled: true, autoInstall: false, installTimeoutMs: 100 } },
      makeDeps(seen),
    )
    await plugin(makeInput("D:/test/project-c"), {})
    expect(seen).toEqual([resolve("D:/test/project-c")])
  })

  it("nudges the agent to use the graph tools once both indexes are ready", async () => {
    const seen: string[] = []
    const deps: MetaGovernorPluginDeps = {
      ...makeDeps(seen),
      __test_runGraphSync: readyRunGraphSync,
    }
    const plugin = createMetaGovernorPlugin(
      { graphSync: { enabled: true, autoInstall: false, installTimeoutMs: 100 } },
      deps,
    )
    const hooks = await plugin(makeInput("D:/test/project-ready"), {
      // Hermetic: governance must be ON for messages.transform to reach the
      // nudge block (it early-returns when mergedConfig.enabled is false).
      meta_governor: { enabled: true, graphSync: { enabled: false } },
    })
    const transform = hooks["experimental.chat.messages.transform"]!

    // The background init resolves asynchronously — let the microtask run.
    await new Promise((r) => setTimeout(r, 10))

    const messages: Array<{ info: unknown; parts: unknown[] }> = [
      { info: { sessionID: "s-ready" }, parts: [{ type: "text", text: "hi" }] },
    ]
    await transform({}, { messages })
    const nudges = messages.filter((m) =>
      JSON.stringify(m.parts).includes("omo_search"),
    )
    expect(nudges.length).toBe(1)

    // Once per session only.
    await transform({}, { messages })
    expect(
      messages.filter((m) => JSON.stringify(m.parts).includes("omo_search")).length,
    ).toBe(1)
  })
})
