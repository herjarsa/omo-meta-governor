/**
 * Regression tests for the default export shape (v0.19.4, v0.50.0, v0.50.1).
 *
 * Background: opencode 1.18.16 npm-package plugins load the module but
 * don't reliably invoke the factory under `opencode serve`. Some
 * opencode builds call `default(input, options)` (Plugin function path);
 * others read `module.server(input, options)` (PluginModule path).
 *
 * v0.50.1: object-spread dual shape (per the official V1→V2 migration
 * guide) — the default export is a PLAIN OBJECT `{ id, setup, server }`:
 * the V2 host reads `.setup`, V1 (>=1.18.29) reads `.server`. The v0.50.0
 * function-attach shape kept V1 green but the V2 host never invoked
 * `.setup` off a function export (import ran, setup never fired).
 *
 * These tests lock down that contract so future refactors of src/index.ts
 * can't silently regress either invocation path.
 */
import { describe, expect, test } from "bun:test"
import pluginModule from "./index"
import { createMetaGovernorPlugin, type MetaGovernorPluginDeps } from "./lib"

// v0.28.0: hermetic no-op so the default export's factory invocation never
// spawns real pip/uv/npx under bun:test (matches __test_runGraphSync pattern).
const fakeRunCliAnythingSync = (async () => ({
  attempted: false,
  codes: ["cli-anything-upgrade-skipped"],
  availability: { cliHub: false, cliHubVersion: null, metaSkill: false },
  alreadyInitialized: true,
})) as unknown as NonNullable<MetaGovernorPluginDeps["__test_runCliAnythingSync"]>

describe("default export (v0.50.1 object-spread dual-shape)", () => {
  test("is a plain object (V2 host shape), not a function", () => {
    expect(typeof pluginModule).toBe("object")
  })

  test("has .server function (V1 PluginModule path)", () => {
    expect(typeof (pluginModule as unknown as { server: unknown }).server).toBe("function")
  })

  test("has .setup function (V2 host path)", () => {
    expect(typeof (pluginModule as unknown as { setup: unknown }).setup).toBe("function")
  })

  test("has .id matching the plugin name", () => {
    expect((pluginModule as unknown as { id: string }).id).toBe("omo-meta-governor")
  })


})

describe("named exports still work", () => {
  test("createMetaGovernorPlugin is exported from lib", () => {
    expect(typeof createMetaGovernorPlugin).toBe("function")
  })

  test("calling .server fires the factory and returns hooks", async () => {
    const server = (pluginModule as unknown as {
      server: (
        input: never,
        options?: never,
      ) => Promise<Record<string, unknown>>
    }).server
    const hooks = await server(
      { client: null, project: null, directory: "", worktree: "", experimental_workspace: { register: () => {} }, serverUrl: new URL("http://localhost"), $: null } as never,
      // Hermetic: the plugin defaults to enabled=false WITHOUT a user config
      // file (~/.config/opencode/omo-meta-governor.jsonc) — CI has none, so
      // the early-return would strip tool.execute.after (env-dependent test,
      // exposed when the CI workflow YAML was fixed on 14/08/2026).
      // v0.28.0: cli-anything MUST also be opted out, otherwise the
      // index.ts default-export factory invokes runCliAnythingSync which
      // spawns pip/uv/npx and blocks bun:test's 5s runner.
      { meta_governor: { enabled: true, graphSync: { enabled: false }, cliAnything: { enabled: false } } } as never,
    )
    expect(typeof hooks["tool.execute.after"]).toBe("function")
    expect(typeof hooks["experimental.session.compacting"]).toBe("function")
  })
})