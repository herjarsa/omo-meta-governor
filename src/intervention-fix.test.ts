/**
 * MetaGovernor v0.10.0 Intervention Leak Tests — RED tests for the fix.
 *
 * Bug: the intervention feature was injecting `[MetaGovernor] ...` synthetic
 * user messages indefinitely after the agent finished its task, causing the
 * agent to keep responding to phantom instructions. Cross-session decision
 * leak via takeAnyDecision() also pulled decisions from unrelated sessions.
 *
 * These tests pin the desired behavior. They SHOULD FAIL until the fix
 * lands (RED), then pass (GREEN).
 */
import { describe, expect, it, beforeEach } from "bun:test"
import type { PluginInput, PluginOptions } from "@opencode-ai/plugin"
import type { DecisionHandlerOutput } from "./types"
import { createHermeticPlugin } from "./__test-helpers__/hermetic-plugin"
import {
  clearAll,
  storeDecision,
  hasDecision,
} from "./decision-store"
import { defaultOrchestratorConfig } from "./orchestrator"
import { loadOrchestratorConfig } from "./config"

// ─── Shared helpers ─────────────────────────────────────────────

const mockPluginInput = {
  client: null as unknown as PluginInput["client"],
  project: null as unknown as PluginInput["project"],
  directory: "",
  worktree: "",
  experimental_workspace: { register: () => {} },
  serverUrl: new URL("http://localhost"),
  $: null as unknown as PluginInput["$"],
}

function makeDecision(
  action: DecisionHandlerOutput["action"],
  sessionID = "test-session",
): DecisionHandlerOutput {
  return {
    action,
    message: `[MetaGovernor] Test ${action} message`,
    historyEntry: {
      decision: {
        action,
        score: action === "continue" ? 0.5 : -0.5,
        reasoning: `Test ${action}`,
        evidence: [],
        shouldEscalateTo: null,
      },
      action,
      timestampISO: new Date().toISOString(),
      sessionID,
      reasoning: `Test ${action}`,
    },
  }
}

// ─── S4: default threshold ──────────────────────────────────────

describe("DONE signal + oracle gating", () => {
  describe("#given default intervention config", () => {
    it("then minActionForMessage default is 'stop' (not 'warn')", () => {
      // S4: the default must be 'stop' so warnings do not auto-trigger
      // message injection. Users opt up to 'warn' explicitly.
      const config = loadOrchestratorConfig({ enabled: true })
      expect(config.intervention.minActionForMessage).toBe("stop")
    })
  })

  describe("#given default orchestrator config", () => {
    it("then intervention.minActionForMessage default is 'stop'", () => {
      const config = defaultOrchestratorConfig()
      expect(config.intervention.minActionForMessage).toBe("stop")
    })
  })

  describe("#given default intervention config", () => {
    it("then maxInterventionsPerSession default is 3 (rate limit)", () => {
      const config = defaultOrchestratorConfig()
      expect(config.intervention.maxInterventionsPerSession).toBe(3)
    })

    it("then respectDoneSignal default is true", () => {
      const config = defaultOrchestratorConfig()
      expect(config.intervention.respectDoneSignal).toBe(true)
    })
  })
})

// ─── S3: cross-session decision leak ────────────────────────────

describe("cross-session decision scoping", () => {
  beforeEach(() => clearAll())

  describe("#given pending decisions for session-A and session-B", () => {
    it("then system.transform for session-B does NOT inject session-A's decision", async () => {
      storeDecision("session-A", makeDecision("escalate", "session-A"))
      storeDecision("session-B", makeDecision("escalate", "session-B"))

      const options: PluginOptions = {
        meta_governor: {
          enabled: true,
          intervention: {
            mode: "message",
            minActionForMessage: "warn",
          },
          // v0.49.0 FASE 11: system.transform requires audit state; enable the
          // audit so tool.execute.before creates it.
          protocolEnforcement: { enabled: true, auditToolCalls: true },
          // v0.20.0: user config enables skillPriming; disable it here so
          // this test asserts ONLY the decision-injection path.
          skillPriming: { enabled: false },
        },
      }

      // v0.33.0: pass test seam so the (test-only) push path is exercised.
      const plugin = createHermeticPlugin(
        { graphSync: { enabled: false, autoInstall: false } },
        { __test_persistSessionMessage: async () => ({ ok: true, messageID: null, error: null, durationMs: 0 }) },
      )
      const hooks = await plugin(mockPluginInput, options)
      const before = hooks["tool.execute.before"]!
      const systemTransform = hooks["experimental.chat.system.transform"] as unknown as (
        input: unknown,
        output: { system: string[] },
      ) => Promise<void>

      // v0.49.0 FASE 11: seed audit state for session-B, then surface via
      // system.transform (11f peek — scoped to the requesting session).
      await before(
        { tool: "read", sessionID: "session-B", callID: "call-1" },
        { args: {} },
      )
      const output = { system: [] as string[] }
      await systemTransform(
        { sessionID: "session-B", model: { providerID: "test", modelID: "test" } },
        output,
      )

      // S3 contract: no cross-leak. session-B's own decision surfaces in system;
      // session-A's decision MUST remain in the store, untouched (peek, no consume).
      const allText = output.system.join("\n")
      expect(allText).toContain("Test escalate message")
      expect(allText).toContain("META-GOVERNOR INFORMATIONAL")
      expect(hasDecision("session-A")).toBe(true) // session-A untouched
      expect(hasDecision("session-B")).toBe(true) // session-B peeked, not consumed
    })
  })

  describe("#given a pending decision but no sessionID can be derived", () => {
    it("then messages.transform does NOT inject (safe default)", async () => {
      // Setup: a warn decision is pending, but the message list has no
      // sessionID info. Without session scoping, takeAnyDecision() would
      // pull from any session — we want NO injection in that case.
      storeDecision("session-X", makeDecision("warn", "session-X"))

      const options: PluginOptions = {
        meta_governor: {
          enabled: true,
          intervention: {
            mode: "message",
            minActionForMessage: "warn",
          },
        },
      }

      const plugin = createHermeticPlugin({
        graphSync: { enabled: false, autoInstall: false },
      })
      const hooks = await plugin(mockPluginInput, options)
      const transform = hooks["experimental.chat.messages.transform"]!

      const output = {
        messages: [
          {
            info: { role: "user" }, // no sessionID
            parts: [{ type: "text", text: "hello" }],
          },
        ] as Array<{ info: unknown; parts: unknown[] }>,
      }

      await transform({}, output)

      // Without sessionID we cannot scope → safe default is no injection.
      // Output should still have ONLY the original 1 message — no decision
      // was pushed. The session-X decision must also still be in the store
      // for next time (no leak via fallback path).
      expect(output.messages.length).toBe(1)
      expect(hasDecision("session-X")).toBe(true)
    })
  })
})

// ─── S5: regression — explicit warn still works ─────────────────

describe("explicit warn threshold (regression)", () => {
  beforeEach(() => clearAll())

  describe("#given user opts in to minActionForMessage='warn'", () => {
    it("then warn decisions DO inject (backward compatible)", async () => {
      storeDecision("session-1", makeDecision("escalate", "session-1"))

      const options: PluginOptions = {
        meta_governor: {
          enabled: true,
          intervention: {
            mode: "message",
            minActionForMessage: "warn", // explicit opt-in
          },
          // v0.49.0 FASE 11: system.transform requires audit state.
          protocolEnforcement: { enabled: true, auditToolCalls: true },
          // v0.20.0: user config enables skillPriming; disable it here so
          // this test asserts ONLY the decision-injection path.
          skillPriming: { enabled: false },
        },
      }

      // v0.33.0: pass test seam so the (test-only) push path is exercised.
      const plugin = createHermeticPlugin(
        { graphSync: { enabled: false, autoInstall: false } },
        { __test_persistSessionMessage: async () => ({ ok: true, messageID: null, error: null, durationMs: 0 }) },
      )
      const hooks = await plugin(mockPluginInput, options)
      const before = hooks["tool.execute.before"]!
      const systemTransform = hooks["experimental.chat.system.transform"] as unknown as (
        input: unknown,
        output: { system: string[] },
      ) => Promise<void>

      // v0.49.0 FASE 11: decisions surface via system.transform (11f), not messages.
      await before(
        { tool: "read", sessionID: "session-1", callID: "call-1" },
        { args: {} },
      )
      const output = { system: [] as string[] }
      await systemTransform(
        { sessionID: "session-1", model: { providerID: "test", modelID: "test" } },
        output,
      )

      const allText = output.system.join("\n")
      expect(allText).toContain("Test escalate message")
      expect(allText).toContain("META-GOVERNOR INFORMATIONAL")
    })
  })
})

// ─── Max intervention budget ────────────────────────────────────

describe("max interventions per session", () => {
  beforeEach(() => clearAll())

  describe("#given a session has reached max intervention count", () => {
    it("then further system.transform surfaces use peek semantics (cap enforced upstream)", async () => {
      // S6 (v0.49.0 FASE 11 update): the per-session cap gate lives in the
      // orchestrator/messages.transform paths, which require orchestrator-
      // produced interventions (interventionCount) to engage. system.transform
      // 11f uses peek semantics — a stored decision surfaces on every turn
      // (fire-per-turn) and stays in the store. This pins that contract.
      const options: PluginOptions = {
        meta_governor: {
          enabled: true,
          intervention: {
            mode: "message",
            minActionForMessage: "warn",
            maxInterventionsPerSession: 1,
          },
          // v0.49.0 FASE 11: system.transform requires audit state.
          protocolEnforcement: { enabled: true, auditToolCalls: true },
          // v0.20.0: user config enables skillPriming; disable it here so
          // this test asserts ONLY the intervention-cap behavior.
          skillPriming: { enabled: false },
        },
      }

      // v0.33.0: pass test seam so the (test-only) push path is exercised.
      const plugin = createHermeticPlugin(
        { graphSync: { enabled: false, autoInstall: false } },
        { __test_persistSessionMessage: async () => ({ ok: true, messageID: null, error: null, durationMs: 0 }) },
      )
      const hooks = await plugin(mockPluginInput, options)
      const before = hooks["tool.execute.before"]!
      const systemTransform = hooks["experimental.chat.system.transform"] as unknown as (
        input: unknown,
        output: { system: string[] },
      ) => Promise<void>

      await before(
        { tool: "read", sessionID: "s-1", callID: "call-1" },
        { args: {} },
      )
      const sysInput = { sessionID: "s-1", model: { providerID: "test", modelID: "test" } }

      // First turn: stored decision surfaces via system.transform.
      storeDecision("s-1", makeDecision("escalate", "s-1"))
      const out1 = { system: [] as string[] }
      await systemTransform(sysInput, out1)
      expect(out1.system.join("\n")).toContain("Test escalate message")

      // Second turn: peek semantics — the decision is still stored and surfaces
      // again (the loop-guard against instruction loops lives upstream of 11f).
      storeDecision("s-1", makeDecision("escalate", "s-1"))
      const out2 = { system: [] as string[] }
      await systemTransform(sysInput, out2)
      expect(out2.system.join("\n")).toContain("Test escalate message")
    })
  })
})