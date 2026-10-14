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

// B+C hermetic pattern (mirrors skill-priming-recall-gate.test.ts): args travel
// via the 2nd-param `{ args }` channel (the only channel the before-hook
// reads) on a non-trivial /app/src path with >TRIVIAL_MAX_LINES content.
const bigWriteArgs = {
  filePath: "/app/src/core/widget.ts",
  content: Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n"),
}
describe("workflowGates.requirePlan", () => {
  it("blocks the first non-trivial write without prior exploration", async () => {
    const plugin = makePlugin({ enabled: true, requirePlan: true })
    // Hermetic B+C isolation (options inline > file config > factory arg):
    // disable the skill-priming gate, whose default block fires first on the
    // same write and would mask this requirePlan assertion.
    const hooks = await plugin(makeInput("D:/test/wfg-a"), {
      meta_governor: {
        skillPriming: { enabled: false },
        workflowGates: { enabled: true, requirePlan: true },
      },
    })
    let error: unknown = null
    try {
      await hooks["tool.execute.before"]?.(
        { tool: "write", sessionID: "s-wfg-1", callID: "c1" },
        { args: bigWriteArgs },
      )
    } catch (err) {
      error = err
    }
    expect(error).not.toBeNull()
    expect(String((error as Error)?.message ?? error)).toContain("requirePlan")
  })

  it("allows the write after a read/search/recall tool ran", async () => {
    const plugin = makePlugin({ enabled: true, requirePlan: true })
    const hooks = await plugin(makeInput("D:/test/wfg-b"), {
      meta_governor: { workflowGates: { enabled: true, requirePlan: true } },
    })
    const before = hooks["tool.execute.before"]!
    const after = hooks["tool.execute.after"]!
    // B+C: the default-block skill gate requires BOTH skill-find AND recall
    // before a non-trivial write. Satisfy it via the after-hook (the sole
    // writer of the skill/recall session sets), then explore via omo_search.
    await after(
      { tool: "omo_skill_find", sessionID: "s-wfg-2", callID: "c0a", args: { query: "code write" } },
      { title: "", output: "ok", metadata: {} },
    )
    await after(
      { tool: "omo_recall", sessionID: "s-wfg-2", callID: "c0b", args: { context: "widget plan" } },
      { title: "", output: "ok", metadata: {} },
    )
    await before(
      { tool: "omo_search", sessionID: "s-wfg-2", callID: "c1" },
      { args: {} },
    )
    await before(
      { tool: "write", sessionID: "s-wfg-2", callID: "c2" },
      { args: bigWriteArgs },
    )
  })

  it("is a no-op when the gate is disabled (default)", async () => {
    // Pin workflowGates off inline: factory-direct config loses to the real dev
    // file config (file > factory-arg), so only options.meta_governor inline
    // keeps this hermetic test from throwing the requirePlan gate.
    const plugin = makePlugin({ enabled: false, requirePlan: false })
    const hooks = await plugin(makeInput("D:/test/wfg-c"), {
      meta_governor: {
        workflowGates: { enabled: false, requirePlan: false },
        // B+C: the skill-priming gate is independent of workflowGates and
        // still blocks under default block; disable it too for a total no-op.
        skillPriming: { enabled: false },
      },
    })
    await hooks["tool.execute.before"]?.(
      { tool: "write", sessionID: "s-wfg-3", callID: "c1" },
      { args: bigWriteArgs },
    )
  })

  it("bypasses requirePlan for trivial edits (tiny single-hunk diff)", async () => {
    // Pin: a tiny-diff edit bypasses the gate via isTrivialWrite even with
    // no prior exploration in the session (B-contract: edit-family needs a
    // tiny diff or trivial path; a bare filePath alone is NOT trivial).
    // No skill/recall preconditions: trivial writes bypass BOTH gates.
    const plugin = makePlugin({ enabled: true, requirePlan: true })
    const hooks = await plugin(makeInput("D:/test/wfg-e"), {
      meta_governor: { workflowGates: { enabled: true, requirePlan: true } },
    })
    await hooks["tool.execute.before"]?.(
      { tool: "edit", sessionID: "s-wfg-5", callID: "c1" },
      { args: { filePath: "/app/src/core/widget.ts", oldString: "line 1", newString: "line 1 fixed" } },
    )
  })
})

  it("counts a broad grep query as exploration (Oracle note)", async () => {
    const plugin = makePlugin({ enabled: true, requirePlan: true })
    const hooks = await plugin(makeInput("D:/test/wfg-d"), {
      meta_governor: { workflowGates: { enabled: true, requirePlan: true } },
    })
    const before = hooks["tool.execute.before"]!
    const after = hooks["tool.execute.after"]!
    // B+C: satisfy the skill gate via after-hooks only (after never marks
    // exploration), so the requirePlan pass below is owed solely to the grep.
    await after(
      { tool: "omo_skill_find", sessionID: "s-wfg-4", callID: "c0a", args: { query: "code write" } },
      { title: "", output: "ok", metadata: {} },
    )
    await after(
      { tool: "omo_recall", sessionID: "s-wfg-4", callID: "c0b", args: { context: "handleDecision plan" } },
      { title: "", output: "ok", metadata: {} },
    )
    await before(
      { tool: "grep", sessionID: "s-wfg-4", callID: "c1" },
      { args: { pattern: "handleDecision" } },
    )
    await before(
      { tool: "write", sessionID: "s-wfg-4", callID: "c2" },
      { args: bigWriteArgs },
    )
  })
