import { describe, expect, it, beforeEach } from "bun:test"
import { createHermeticPlugin } from "./__test-helpers__/hermetic-plugin"
import { clearAll, storeDecision } from "./decision-store"

describe("v0.17.3 Gap D — decision history in system.transform", () => {
  beforeEach(() => clearAll())

  it("then includes prior interventions in text when includeDecisionHistory is true", async () => {
    const plugin = createHermeticPlugin(
      { graphSync: { enabled: false, autoInstall: false } },
      { __test_persistSessionMessage: async () => ({ ok: true, messageID: null, error: null, durationMs: 0 }) }
    )
    const hooks = await plugin(
      {
        client: null as any,
        project: null as any,
        directory: "",
        worktree: "",
        experimental_workspace: { register: () => {} },
        serverUrl: new URL("http://localhost"),
        $: null as any,
      },
      {
        meta_governor: {
          enabled: true,
          intervention: {
            mode: "message",
            minActionForMessage: "escalate",
            includeDecisionHistory: true,
            maxHistoryMessages: 5,
          },
          // v0.49.0 FASE 11: system.transform requires audit state.
          protocolEnforcement: { enabled: true, auditToolCalls: true },
          skillPriming: { enabled: false },
        },
      },
    )
    const before = hooks["tool.execute.before"]!
    const systemTransform = hooks["experimental.chat.system.transform"] as unknown as (
      input: unknown,
      output: { system: string[] },
    ) => Promise<void>
    const sysIn = { sessionID: "ses-D-1", model: { providerID: "test", modelID: "test" } }

    // First intervention: store warn decision + surface it (11f peek).
    // v0.49.0 FASE 11: seed audit state, then surface via system.transform.
    await before({ tool: "read", sessionID: "ses-D-1", callID: "call-1" }, { args: {} })
    storeDecision("ses-D-1", {
      action: "escalate",
      message: "First warn: initial detection",
      historyEntry: {
        decision: { action: "escalate", score: -0.3, reasoning: "first", evidence: [], shouldEscalateTo: null },
        action: "escalate",
        timestampISO: "2026-01-01T00:00:00Z",
        sessionID: "ses-D-1",
        reasoning: "first",
      },
    })
    const sysOut1 = { system: [] as string[] }
    await systemTransform(sysIn, sysOut1)
    const firstInjection = sysOut1.system.join("\n")
    expect(firstInjection).toContain("MetaGovernor")
    expect(firstInjection).toContain("First warn")

    // Second intervention: store escalate decision + surface it.
    storeDecision("ses-D-1", {
      action: "escalate",
      message: "Second: escalation triggered",
      historyEntry: {
        decision: { action: "escalate", score: -0.6, reasoning: "second", evidence: [], shouldEscalateTo: "oracle" },
        action: "escalate",
        timestampISO: "2026-01-01T00:01:00Z",
        sessionID: "ses-D-1",
        reasoning: "second",
      },
    })
    const sysOut2 = { system: [] as string[] }
    await systemTransform(sysIn, sysOut2)
    const secondInjection = sysOut2.system.join("\n")
    expect(secondInjection).toContain("MetaGovernor")
    // v0.49.0 FASE 11: the 11f block surfaces the latest pending decision with
    // the informational marker (the messages.transform "Recent decisions"
    // history block was retired with the push site).
    expect(secondInjection).toContain("META-GOVERNOR INFORMATIONAL")
    expect(secondInjection).toContain("Second: escalation")
  })

  it("then does NOT include history when includeDecisionHistory is false", async () => {
    const plugin = createHermeticPlugin(
      { graphSync: { enabled: false, autoInstall: false } },
      { __test_persistSessionMessage: async () => ({ ok: true, messageID: null, error: null, durationMs: 0 }) }
    )
    const hooks = await plugin(
      {
        client: null as any,
        project: null as any,
        directory: "",
        worktree: "",
        experimental_workspace: { register: () => {} },
        serverUrl: new URL("http://localhost"),
        $: null as any,
      },
      {
        meta_governor: {
          enabled: true,
          intervention: {
            mode: "message",
            minActionForMessage: "escalate",
            includeDecisionHistory: false,
          },
          // v0.49.0 FASE 11: system.transform requires audit state.
          protocolEnforcement: { enabled: true, auditToolCalls: true },
          skillPriming: { enabled: false },
        },
      },
    )
    const before = hooks["tool.execute.before"]!
    const systemTransform = hooks["experimental.chat.system.transform"] as unknown as (
      input: unknown,
      output: { system: string[] },
    ) => Promise<void>
    const sysIn = { sessionID: "ses-D-2", model: { providerID: "test", modelID: "test" } }

    // v0.49.0 FASE 11: seed audit state, then surface via system.transform.
    await before({ tool: "read", sessionID: "ses-D-2", callID: "call-1" }, { args: {} })
    // First injection
    storeDecision("ses-D-2", {
      action: "escalate",
      message: "Only decision",
      historyEntry: {
        decision: { action: "escalate", score: -0.3, reasoning: "test", evidence: [], shouldEscalateTo: null },
        action: "escalate",
        timestampISO: "2026-01-01T00:00:00Z",
        sessionID: "ses-D-2",
        reasoning: "test",
      },
    })
    const sysOut1 = { system: [] as string[] }
    await systemTransform(sysIn, sysOut1)
    expect(sysOut1.system.join("\n")).toContain("Only decision")

    // Second injection
    storeDecision("ses-D-2", {
      action: "escalate",
      message: "Second decision",
      historyEntry: {
        decision: { action: "escalate", score: -0.3, reasoning: "test2", evidence: [], shouldEscalateTo: null },
        action: "escalate",
        timestampISO: "2026-01-01T00:01:00Z",
        sessionID: "ses-D-2",
        reasoning: "test2",
      },
    })
    const sysOut2 = { system: [] as string[] }
    await systemTransform(sysIn, sysOut2)

    const secondInjection = sysOut2.system.join("\n")
    expect(secondInjection).toContain("MetaGovernor")
    expect(secondInjection).toContain("Second decision")
    expect(secondInjection).not.toContain("Recent decisions")
  })
})
