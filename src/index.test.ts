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
import pluginModule, { createMetaGovernorPlugin, plugin } from "./index"

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
  test("createMetaGovernorPlugin is exported", () => {
    expect(typeof createMetaGovernorPlugin).toBe("function")
  })

  test("named plugin export is the same dual-shape object (v0.19.5)", () => {
    expect(plugin).toBe(pluginModule)
    expect((plugin as unknown as { server: unknown }).server).toBe(pluginModule)
    expect((plugin as unknown as { id: string }).id).toBe("omo-meta-governor")
  })
})