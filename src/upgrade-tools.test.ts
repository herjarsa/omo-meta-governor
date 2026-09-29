/**
 * S3: omo_upgrade_check / omo_upgrade_run are exposed on all three surfaces.
 *
 * - V1 hook: the plugin factory's `tool` map (both governance-disabled and
 *   governance-enabled paths in src/plugin.ts) registers both tools.
 * - V2 editor fake: registerOmoTools() registers both names on a structural
 *   V2ToolEditor fake (no real @opencode/plugin v2 host needed).
 * - getAdapters(): the MCP adapter surface includes both names.
 */

import { describe, expect, it } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"

import { createMetaGovernorPlugin } from "./plugin"
import { registerOmoTools, type V2ToolEditor } from "./v2-tools"
import { getAdapters, MCP_TOOL_NAMES } from "./mcp-tools"

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
})) as unknown as NonNullable<
  Parameters<typeof createMetaGovernorPlugin>[1]
>["__test_runGraphSync"]

const fakeRunCliAnythingSync = (async () => ({
  attempted: false,
  codes: ["cli-anything-upgrade-skipped"],
  availability: { cliHub: false, cliHubVersion: null, metaSkill: false },
  alreadyInitialized: true,
})) as unknown as NonNullable<
  Parameters<typeof createMetaGovernorPlugin>[1]
>["__test_runCliAnythingSync"]

describe("S3 upgrade tools surface", () => {
  it("V1 hook (governance disabled) registers omo_upgrade_check + omo_upgrade_run", async () => {
    const plugin = createMetaGovernorPlugin(
      { enabled: false },
      {
        __test_runGraphSync: fakeRunGraphSync,
        __test_runCliAnythingSync: fakeRunCliAnythingSync,
      },
    )
    const hooks = await plugin(makeInput("D:/test/upgrade-s3"), {
      meta_governor: { enabled: false },
    })
    const toolNames = Object.keys(hooks.tool ?? {})
    expect(toolNames).toContain("omo_upgrade_check")
    expect(toolNames).toContain("omo_upgrade_run")
  })

  it("V2 editor fake receives omo_upgrade_check + omo_upgrade_run", () => {
    const seen: string[] = []
    const editor: V2ToolEditor = {
      add: (tool) => {
        seen.push(tool.name)
      },
    }
    const registered = registerOmoTools(editor)
    expect(registered).toContain("omo_upgrade_check")
    expect(registered).toContain("omo_upgrade_run")
    expect(seen).toContain("omo_upgrade_check")
    expect(seen).toContain("omo_upgrade_run")
  })

  it("getAdapters() + MCP_TOOL_NAMES expose omo_upgrade_check + omo_upgrade_run", () => {
    const adapterNames = getAdapters().map((a) => a.name)
    expect(adapterNames).toContain("omo_upgrade_check")
    expect(adapterNames).toContain("omo_upgrade_run")
    expect(MCP_TOOL_NAMES).toContain("omo_upgrade_check")
    expect(MCP_TOOL_NAMES).toContain("omo_upgrade_run")
  })
})
