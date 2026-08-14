/**
 * Regression tests for the dual-shape default export (v0.19.4).
 *
 * Background: opencode 1.18.16 npm-package plugins load the module but
 * don't reliably invoke the factory under `opencode serve`. Some
 * opencode builds call `default(input, options)` (Plugin function path);
 * others read `module.server(input, options)` (PluginModule path). The
 * v0.19.4 fix makes the default export satisfy BOTH shapes
 * simultaneously:
 *
 *   const _plugin = createMetaGovernorPlugin()
 *   _plugin.id = "omo-meta-governor"
 *   _plugin.server = _plugin
 *   export default _plugin
 *
 * These tests lock down that contract so future refactors of src/index.ts
 * can't silently regress the opencode serve invocation path.
 */
import { describe, expect, test } from "bun:test"
import pluginModule from "./index"
import { createMetaGovernorPlugin } from "./lib"

describe("default export (v0.19.4 dual-shape)", () => {
  test("is a callable function (Plugin path)", () => {
    expect(typeof pluginModule).toBe("function")
  })

  test("has .server pointing to itself (PluginModule path)", () => {
    expect((pluginModule as unknown as { server: unknown }).server).toBe(pluginModule)
  })

  test("has .id matching the plugin name", () => {
    expect((pluginModule as unknown as { id: string }).id).toBe("omo-meta-governor")
  })


})

describe("named exports still work", () => {
  test("createMetaGovernorPlugin is exported from lib", () => {
    expect(typeof createMetaGovernorPlugin).toBe("function")
  })

  test("calling the default fires the factory and returns hooks", async () => {
    const hooks = await pluginModule(
      { client: null, project: null, directory: "", worktree: "", experimental_workspace: { register: () => {} }, serverUrl: new URL("http://localhost"), $: null } as never,
      // Hermetic: the plugin defaults to enabled=false WITHOUT a user config
      // file (~/.config/opencode/omo-meta-governor.jsonc) — CI has none, so
      // the early-return would strip tool.execute.after (env-dependent test,
      // exposed when the CI workflow YAML was fixed on 14/08/2026).
      { meta_governor: { enabled: true, graphSync: { enabled: false } } } as never,
    )
    expect(typeof hooks["tool.execute.after"]).toBe("function")
    expect(typeof hooks["experimental.session.compacting"]).toBe("function")
  })
})