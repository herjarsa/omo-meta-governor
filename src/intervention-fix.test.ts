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
import { createMetaGovernorPlugin } from "./plugin"
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
    it("then messages.transform for session-B does NOT inject session-A's decision", async () => {
      storeDecision("session-A", makeDecision("warn", "session-A"))
      storeDecision("session-B", makeDecision("warn", "session-B"))

      const options: PluginOptions = {
        meta_governor: {
          enabled: true,
          intervention: {
            mode: "message",
            minActionForMessage: "warn",
          },
        },
      }

      const plugin = createMetaGovernorPlugin()
      const hooks = await plugin(mockPluginInput, options)
      const transform = hooks["experimental.chat.messages.transform"]!

      // Original input has 1 msg; session-B's own decision adds 1 more → total 2.
      const output = {
        messages: [
          {
            info: { role: "user", sessionID: "session-B" },
            parts: [{ type: "text", text: "hello" }],
          },
        ] as Array<{ info: unknown; parts: unknown[] }>,
      }

      await transform({}, output)

      // S3 contract: no cross-leak. session-B's own decision is consumed
      // (1 message added on top of the original input); session-A's decision
      // MUST remain in the store, untouched.
      expect(output.messages.length).toBe(2)
      expect(hasDecision("session-A")).toBe(true) // session-A untouched
      expect(hasDecision("session-B")).toBe(false) // session-B consumed
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

      const plugin = createMetaGovernorPlugin()
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
      storeDecision("session-1", makeDecision("warn", "session-1"))

      const options: PluginOptions = {
        meta_governor: {
          enabled: true,
          intervention: {
            mode: "message",
            minActionForMessage: "warn", // explicit opt-in
          },
        },
      }

      const plugin = createMetaGovernorPlugin()
      const hooks = await plugin(mockPluginInput, options)
      const transform = hooks["experimental.chat.messages.transform"]!

      const output = {
        messages: [
          {
            info: { role: "user", sessionID: "session-1" },
            parts: [{ type: "text", text: "hello" }],
          },
        ] as Array<{ info: unknown; parts: unknown[] }>,
      }

      await transform({}, output)

      // Original input 1 msg + injected decision 1 msg = 2 total.
      expect(output.messages.length).toBe(2)
      const lastPart = output.messages[output.messages.length - 1]!
        .parts[0] as Record<string, unknown>
      expect(lastPart.text).toContain("Test warn message")
    })
  })
})

// ─── Max intervention budget ────────────────────────────────────

describe("max interventions per session", () => {
  beforeEach(() => clearAll())

  describe("#given a session has reached max intervention count", () => {
    it("then further messages.transform injects are blocked", async () => {
      // S6: even with active intervention, after N injections the plugin
      // must stop. The transform must refuse to push once the cap is hit.
      const options: PluginOptions = {
        meta_governor: {
          enabled: true,
          intervention: {
            mode: "message",
            minActionForMessage: "warn",
            maxInterventionsPerSession: 1,
          },
        },
      }

      const plugin = createMetaGovernorPlugin()
      const hooks = await plugin(mockPluginInput, options)
      const transform = hooks["experimental.chat.messages.transform"]!

      // First injection: store a decision; transform should consume it.
      storeDecision("s-1", makeDecision("warn", "s-1"))
      const out1 = {
        messages: [
          {
            info: { role: "user", sessionID: "s-1" },
            parts: [{ type: "text", text: "hello" }],
          },
        ] as Array<{ info: unknown; parts: unknown[] }>,
      }
      await transform({}, out1)
      expect(out1.messages.length).toBe(2) // original + injected

      // Second injection attempt: even with a fresh decision, the cap (1)
      // must block injection. We simulate "cap already hit" by storing a
      // second decision and checking the cap is enforced.
      storeDecision("s-1", makeDecision("warn", "s-1"))
      const out2 = {
        messages: [
          {
            info: { role: "user", sessionID: "s-1" },
            parts: [{ type: "text", text: "hello" }],
          },
        ] as Array<{ info: unknown; parts: unknown[] }>,
      }
      await transform({}, out2)
      // After the cap, even though a decision is pending, the transform
      // MUST NOT push (otherwise we get the instruction loop).
      expect(out2.messages.length).toBe(1) // only the original
    })
  })
})