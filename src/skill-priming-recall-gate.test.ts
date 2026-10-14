/**
 * C (recall gate) TDD RED test.
 *
 * S1: block write with skill-found but NO recall still blocks
 * (message names omo_recall). The gate must require BOTH the
 * skill-find family AND the recall family (omo_recall/mcp).
 *
 * RED: omoRecallCalled tracking (plugin.ts) is not consulted by the
 * skill block gate, so this currently PASSES the write (test FAILS).
 */
import { describe, expect, it } from "bun:test"
import type { PluginInput, PluginOptions } from "@opencode-ai/plugin"
import { createHermeticPlugin } from "./__test-helpers__/hermetic-plugin"
import { clearAll } from "./decision-store"

const mockPluginInput = {
  client: null as unknown as PluginInput["client"],
  project: null as unknown as PluginInput["project"],
  directory: "",
  worktree: "",
  experimental_workspace: { register: () => {} },
  serverUrl: new URL("http://localhost"),
  $: null as unknown as PluginInput["$"],
}

const blockOptions: PluginOptions = {
  meta_governor: {
    enabled: true,
    protocolEnforcement: { enabled: true, auditToolCalls: false },
    skillPriming: { enabled: true, trigger: "sessionStart", router: "registry", enforceMode: "block" },
    // Isolate the skill-priming gate: the requirePlan workflow gate also
    // mentions omo_recall in its message and would mask this test.
    workflowGates: { enabled: false, requirePlan: false },
  },
}

describe("skill-priming recall gate (C)", () => {
  it("S1: blocks non-trivial write when skill-find ran but omo_recall did NOT", async () => {
    clearAll()
    const plugin = createHermeticPlugin()
    const hooks = await plugin(mockPluginInput, blockOptions)
    const before = hooks["tool.execute.before"]!
    const after = hooks["tool.execute.after"]!
    // Agent queried the skill catalog, but never consulted memory.
    await after(
      { tool: "omo_skill_find", sessionID: "recall-gate-s1", callID: "c1", args: { query: "x" } },
      { title: "", output: "ok", metadata: {} },
    )
    // Non-trivial write (not a tmp/test/scratch path, large content).
    await expect(
      before(
        { tool: "write", sessionID: "recall-gate-s1", callID: "c2" },
        { args: { filePath: "/app/src/core/widget.ts", content: Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n") } },
      ),
    ).rejects.toThrow(/omo_recall/)
  })
})
