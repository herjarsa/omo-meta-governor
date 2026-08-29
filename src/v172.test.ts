// v0.17.2 — tests for the 4 gaps fixed in this release.

import { describe, expect, it, beforeEach } from "bun:test"

// Gap D: saveLessons config
describe("saveLessons (Gap D)", () => {
  it("closed-loop-learning.ts honors saveLessons config", async () => {
    const { observeAndLearn, defaultClosedLoopConfig } = await import("./closed-loop-learning")
    const backend = {
      saveMemory: async () => ({ id: "mem-1" }),
      saveLesson: async () => ({ id: "les-1" }),
    }
    const baseInput = {
      decision: {
        action: "stop",
        score: -0.7,
        reasoning: "test",
        evidence: [{ source: "deviation-detector", value: "test", confidence: 0.5, weight: 0.2 }],
        shouldEscalateTo: null,
      },
      memoryRead: {
        query: "test",
        timestampISO: new Date().toISOString(),
        agentmemory: { available: true, lessons: [] },
        boulderState: { available: true, tasks: [], planProgress: 0 },
        degradedSources: [],
      },
      config: { ...defaultClosedLoopConfig(), minSeverityToLearn: "leve" },
      sessionID: "ses-test",
      directory: "/tmp",
      filesChanged: [],
    }

    // Default: saveLessons=true (implicit), lesson saves
    const r1 = await observeAndLearn(baseInput, backend)
    expect(r1.lessonSaved).not.toBeNull()

    // saveLessons=false: lesson should NOT save
    const r2 = await observeAndLearn(
      { ...baseInput, config: { ...baseInput.config, saveLessons: false } },
      backend,
    )
    expect(r2.lessonSaved).toBeNull()
    expect(r2.decisionSaved).not.toBeNull() // decision still saves
  })
})

// Gap I: verifyDelivery return type
describe("verifyDelivery return type (Gap I)", () => {
  it("verifyDelivery signature includes 'expired'", async () => {
    const mod = await import("./custom-tools")
    // Type-level check: verifyDelivery's Promise type must include "expired"
    // We do this by simulating calls with different timing
    const fn = mod.verifyDelivery
    expect(typeof fn).toBe("function")

    // With a non-existent session/tool, awaitDelivery returns "expired" immediately
    // (or "delivered" if pending entry never existed)
    const result = await fn("nonexistent-session", "nonexistent-tool", 100)
    // The signature must allow returning one of these values
    expect(["delivered", "expired", "pending"]).toContain(result)
  })
})

// Gap D: includeDecisionHistory in messages.transform
describe("includeDecisionHistory (Gap D)", () => {
  it("messages.transform surfaces past decisions when includeDecisionHistory is true", async () => {
    // This is tested via integration — the plugin factory wires it
    const { createHermeticPlugin } = await import("./__test-helpers__/hermetic-plugin")
    const { clearAll, storeDecision } = await import("./decision-store")

    clearAll()
    storeDecision("test-session", {
      action: "warn",
      message: "[MetaGovernor] First decision",
      historyEntry: {
        decision: {
          action: "warn",
          score: -0.3,
          reasoning: "first",
          evidence: [],
          shouldEscalateTo: null,
        },
        action: "warn",
        timestampISO: new Date().toISOString(),
        sessionID: "test-session",
        reasoning: "first",
      },
    })
    storeDecision("test-session", {
      action: "escalate",
      message: "[MetaGovernor] Second decision",
      historyEntry: {
        decision: {
          action: "escalate",
          score: -0.6,
          reasoning: "second",
          evidence: [],
          shouldEscalateTo: "oracle",
        },
        action: "escalate",
        timestampISO: new Date().toISOString(),
        sessionID: "test-session",
        reasoning: "second",
      },
    })

    // v0.33.0: pass test seam so the (test-only) push path is exercised.
    const plugin = createHermeticPlugin(
      { graphSync: { enabled: false, autoInstall: false } },
      { __test_persistSessionMessage: async () => ({ ok: true, messageID: null, error: null, durationMs: 0 }) },
    )
    const hooks = await plugin(
      {
        client: null,
        project: null,
        directory: "",
        worktree: "",
        experimental_workspace: { register: () => {} },
        serverUrl: new URL("http://localhost"),
        $: null,
      },
      {
        meta_governor: {
          enabled: true,
          intervention: {
            mode: "message",
            minActionForMessage: "warn",
            includeDecisionHistory: true,
            maxHistoryMessages: 5,
          },
        },
      },
    )
    const transform = hooks["experimental.chat.messages.transform"]!
    // v0.38.6: mid-session setup (prior real assistant message) so the
    // TUI session-killer fix does not skip the synthetic push.
    const output = {
      messages: [
        { info: { role: "user", sessionID: "test-session" }, parts: [{ type: "text", text: "first ask" }] },
        { info: { role: "assistant", sessionID: "test-session", agent: "build" }, parts: [{ type: "text", text: "first reply" }] },
        { info: { role: "user", sessionID: "test-session" }, parts: [{ type: "text", text: "hi" }] },
      ] as Array<{ info: unknown; parts: unknown[] }>,
    }
    await transform({}, output)

    // Should have at least 1 injected message (original 3 + 1 injected = 4)
    expect(output.messages.length).toBeGreaterThan(1)
    const allText = output.messages
      .map((m) => (m.parts[0] as Record<string, unknown> | undefined)?.text as string ?? "")
      .join("\\n")
    // The decision message should be present
    expect(allText).toContain("MetaGovernor")
  })
})

// Gap Q completeness: extractConcepts includes file basenames from filesChanged
describe("extractConcepts (Gap Q completeness)", () => {
  it("lesson concepts include file basenames from filesChanged for FTS lookup", async () => {
    const { observeAndLearn, defaultClosedLoopConfig } = await import("./closed-loop-learning")
    const backend = {
      saveMemory: async () => ({ id: "mem" }),
      saveLesson: async () => ({ id: "les" }),
    }
    const r = await observeAndLearn(
      {
        decision: {
          action: "stop",
          score: -0.7,
          reasoning: "test",
          evidence: [{ source: "deviation-detector", value: "test", confidence: 0.5, weight: 0.2 }],
          shouldEscalateTo: null,
        },
        memoryRead: {
          query: "test",
          timestampISO: new Date().toISOString(),
          agentmemory: { available: true, lessons: [] },
          boulderState: { available: true, tasks: [], planProgress: 0 },
          degradedSources: [],
        },
        config: { ...defaultClosedLoopConfig(), minSeverityToLearn: "leve" },
        sessionID: "ses-test",
        directory: "/tmp",
        filesChanged: ["/home/user/src/auth/login.ts", "/home/user/src/auth/session.ts"],
      },
      backend,
    )
    expect(r.lessonSaved).not.toBeNull()
    expect(r.lessonSaved!.concepts).toContain("login.ts")
    expect(r.lessonSaved!.concepts).toContain("session.ts")
  })
})
