/**
 * Wave B workflowGates.requirePlan tests (explore-before-implement).
 *
 * Hermetic via __test_runGraphSync/__test_runCliAnythingSync seams so the
 * factory never spawns npx/pip (same pattern as plugin-graphsync.test.ts).
 */
import { describe, expect, it } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"

import { createMetaGovernorPlugin, type MetaGovernorPluginDeps } from "./plugin"

const fakeRunGraphSync = (async () => ({
  attempted: false,
  codes: [],
  availability: {
    codegraph: false,
    graphify: false,
    codegraphIndexExists: false,
    graphifyIndexExists: false,
  },
  alreadyInitialized: true,
})) as unknown as NonNullable<MetaGovernorPluginDeps["__test_runGraphSync"]>

const fakeRunCliAnythingSync = (async () => ({
  attempted: false,
  codes: [],
  availability: { cliHub: false, cliHubVersion: null, metaSkill: false },
  alreadyInitialized: true,
})) as unknown as NonNullable<MetaGovernorPluginDeps["__test_runCliAnythingSync"]>
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

function makePlugin(gates: { enabled?: boolean; requirePlan?: boolean }) {
  const deps: MetaGovernorPluginDeps = {
    __test_runGraphSync: fakeRunGraphSync,
    __test_runCliAnythingSync: fakeRunCliAnythingSync,
  }
  return createMetaGovernorPlugin(
    {
      enabled: true,
      graphSync: { enabled: false },
      cliAnything: { enabled: false },
      workflowGates: gates,
    },
    deps,
  )
}

const bigWriteArgs = {
  path: "D:/test/wfg/src/module.ts",
  content: Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n"),
}
describe("workflowGates.requirePlan", () => {
  it("blocks the first non-trivial write without prior exploration", async () => {
    const plugin = makePlugin({ enabled: true, requirePlan: true })
    const hooks = await plugin(makeInput("D:/test/wfg-a"), {})
    let error: unknown = null
    try {
      await hooks["tool.execute.before"]?.(
        { tool: "write", sessionID: "s-wfg-1", callID: "c1", args: bigWriteArgs },
        { title: "", output: "", metadata: {} },
      )
    } catch (err) {
      error = err
    }
    expect(error).not.toBeNull()
    expect(String((error as Error)?.message ?? error)).toContain("requirePlan")
  })

  it("allows the write after a read/search/recall tool ran", async () => {
    const plugin = makePlugin({ enabled: true, requirePlan: true })
    const hooks = await plugin(makeInput("D:/test/wfg-b"), {})
    await hooks["tool.execute.before"]?.(
      { tool: "omo_search", sessionID: "s-wfg-2", callID: "c1", args: {} },
      { title: "", output: "", metadata: {} },
    )
    await hooks["tool.execute.before"]?.(
      { tool: "write", sessionID: "s-wfg-2", callID: "c2", args: bigWriteArgs },
      { title: "", output: "", metadata: {} },
    )
  })

  it("is a no-op when the gate is disabled (default)", async () => {
    const plugin = makePlugin({})
    const hooks = await plugin(makeInput("D:/test/wfg-c"), {})
    await hooks["tool.execute.before"]?.(
      { tool: "write", sessionID: "s-wfg-3", callID: "c1", args: bigWriteArgs },
      { title: "", output: "", metadata: {} },
    )
  })
})

  it("counts a broad grep query as exploration (Oracle note)", async () => {
    const plugin = makePlugin({ enabled: true, requirePlan: true })
    const hooks = await plugin(makeInput("D:/test/wfg-d"), {})
    await hooks["tool.execute.before"]?.(
      { tool: "grep", sessionID: "s-wfg-4", callID: "c1", args: { pattern: "handleDecision" } },
      { title: "", output: "", metadata: {} },
    )
    await hooks["tool.execute.before"]?.(
      { tool: "write", sessionID: "s-wfg-4", callID: "c2", args: bigWriteArgs },
      { title: "", output: "", metadata: {} },
    )
  })
