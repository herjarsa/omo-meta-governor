import { describe, expect, it, beforeEach } from "bun:test"
import { createMetaGovernorPlugin } from "./plugin"
import { clearAll, storeDecision } from "./decision-store"

describe("v0.17.3 Gap D — decision history in messages.transform", () => {
  beforeEach(() => clearAll())

  it("then includes prior interventions in text when includeDecisionHistory is true", async () => {
    const plugin = createMetaGovernorPlugin({
      graphSync: { enabled: false, autoInstall: false },
    })
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
        },
      },
    )
    const transform = hooks["experimental.chat.messages.transform"]!

    // First intervention: store warn decision + inject it (populates recentInterventionTexts)
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
    const output1 = {
      messages: [{ info: { role: "user", sessionID: "ses-D-1" }, parts: [{ type: "text", text: "step1" }] }],
    } as any
    await transform({}, output1)
    const firstInjection = output1.messages
      .map((m: any) => (m.parts[0] as Record<string, unknown> | undefined)?.text as string ?? "")
      .find((t: string) => t.includes("MetaGovernor"))
    expect(firstInjection).toBeDefined()
    expect(firstInjection).toContain("First warn")

    // Second intervention: store escalate decision + inject it (reads recentInterventionTexts)
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
    const output2 = {
      messages: [{ info: { role: "user", sessionID: "ses-D-1" }, parts: [{ type: "text", text: "step2" }] }],
    } as any
    await transform({}, output2)
    const secondInjection = output2.messages
      .map((m: any) => (m.parts[0] as Record<string, unknown> | undefined)?.text as string ?? "")
      .find((t: string) => t.includes("MetaGovernor"))
    expect(secondInjection).toBeDefined()
    // Second injection should include the first in history
    expect(secondInjection).toContain("Recent decisions")
    expect(secondInjection).toContain("[escalate]")
    expect(secondInjection).toContain("First warn")
    expect(secondInjection).toContain("Second: escalation")
  })

  it("then does NOT include history when includeDecisionHistory is false", async () => {
    const plugin = createMetaGovernorPlugin({
      graphSync: { enabled: false, autoInstall: false },
    })
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
        },
      },
    )
    const transform = hooks["experimental.chat.messages.transform"]!

    // First injection (populates recentInterventionTexts but won't be shown due to includeDecisionHistory=false)
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
    const output1 = {
      messages: [{ info: { role: "user", sessionID: "ses-D-2" }, parts: [{ type: "text", text: "s1" }] }],
    } as any
    await transform({}, output1)

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
    const output2 = {
      messages: [{ info: { role: "user", sessionID: "ses-D-2" }, parts: [{ type: "text", text: "s2" }] }],
    } as any
    await transform({}, output2)

    const secondInjection = output2.messages
      .map((m: any) => (m.parts[0] as Record<string, unknown> | undefined)?.text as string ?? "")
      .find((t: string) => t.includes("MetaGovernor"))
    expect(secondInjection).toBeDefined()
    expect(secondInjection).not.toContain("Recent decisions")
  })
})
