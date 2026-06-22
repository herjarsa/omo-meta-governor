/**
 * MetaGovernor Plugin Tests — v0.3.0 Intervention Feature.
 *
 * given/when/then style. Tests cover:
 * - Decision store lifecycle
 * - Plugin factory hook registration
 * - messages.transform injection
 * - system.transform injection
 * - Silent mode passthrough
 * - minActionForMessage threshold filtering
 */
import { describe, expect, it, beforeEach } from "bun:test"
import type { PluginInput, PluginOptions } from "@opencode-ai/plugin"
import type { DecisionHandlerOutput } from "./types"
import { createMetaGovernorPlugin } from "./plugin"
import { clearAll, storeDecision, takeAnyDecision, takeDecision, hasDecision } from "./decision-store"

// ─── Mock plugin input ────────────────────────────────────────────

const mockPluginInput = {
  client: null as unknown as PluginInput["client"],
  project: null as unknown as PluginInput["project"],
  directory: "",
  worktree: "",
  experimental_workspace: { register: () => {} },
  serverUrl: new URL("http://localhost"),
  $: null as unknown as PluginInput["$"],
}

// ─── Helpers ─────────────────────────────────────────────────────

function makeDecision(action: DecisionHandlerOutput["action"]): DecisionHandlerOutput {
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
      sessionID: "test-session",
      reasoning: `Test ${action}`,
    },
  }
}

// ─── Decision Store Tests ─────────────────────────────────────────

describe("decision-store", () => {
  beforeEach(() => {
    clearAll()
  })

  describe("#given a stored decision", () => {
    it("then hasDecision returns true", () => {
      storeDecision("session-1", makeDecision("warn"))
      expect(hasDecision("session-1")).toBe(true)
    })

    it("then takeDecision returns the decision and clears it", () => {
      storeDecision("session-1", makeDecision("warn"))
      const result = takeDecision("session-1")
      expect(result).not.toBeUndefined()
      expect(result!.action).toBe("warn")
      expect(hasDecision("session-1")).toBe(false)
    })

    it("then takeAnyDecision returns a pending decision", () => {
      storeDecision("session-1", makeDecision("stop"))
      const result = takeAnyDecision()
      expect(result).not.toBeUndefined()
      expect(result!.action).toBe("stop")
      expect(hasDecision("session-1")).toBe(false)
    })

    it("then takeDecision returns undefined for unknown session", () => {
      const result = takeDecision("nonexistent")
      expect(result).toBeUndefined()
    })
  })
})

// ─── Plugin Factory Tests ─────────────────────────────────────────

describe("createMetaGovernorPlugin", () => {
  describe("#given intervention enabled with message mode", () => {
    const options: PluginOptions = {
      meta_governor: {
        enabled: true,
        intervention: {
          mode: "message",
          includeDecisionHistory: true,
          maxHistoryMessages: 5,
          minActionForMessage: "warn",
        },
      },
    }

    it("then returns hooks with all 3 handlers", async () => {
      clearAll()
      const plugin = createMetaGovernorPlugin()
      const hooks = await plugin(mockPluginInput, options)
      expect(hooks["tool.execute.after"]).toBeDefined()
      expect(hooks["experimental.chat.messages.transform"]).toBeDefined()
      expect(hooks["experimental.chat.system.transform"]).toBeDefined()
    })
  })

  describe("#given intervention disabled (silent)", () => {
    const options: PluginOptions = {
      meta_governor: {
        enabled: true,
        intervention: { mode: "silent" },
      },
    }

    it("then hooks still include all 3 handlers", async () => {
      clearAll()
      const plugin = createMetaGovernorPlugin()
      const hooks = await plugin(mockPluginInput, options)
      expect(hooks["experimental.chat.messages.transform"]).toBeDefined()
      expect(hooks["experimental.chat.system.transform"]).toBeDefined()
    })
  })
})

// ─── Messages Transform Tests ─────────────────────────────────────

describe("experimental.chat.messages.transform", () => {
  describe("#given message mode with a stored warn decision", () => {
    const options: PluginOptions = {
      meta_governor: {
        enabled: true,
        intervention: { mode: "message", minActionForMessage: "warn" },
      },
    }

    it("then injects a synthetic user message", async () => {
      clearAll()
      storeDecision("test-session", makeDecision("warn"))

      const plugin = createMetaGovernorPlugin()
      const hooks = await plugin(mockPluginInput, options)
      const transform = hooks["experimental.chat.messages.transform"]!

      // v0.10.0: messages.transform requires sessionID to scope injection.
      const output = {
        messages: [
          { info: { role: "user", sessionID: "test-session" }, parts: [{ type: "text", text: "hi" }] },
        ] as Array<{ info: unknown;
      parts: unknown[] }>,
      }
      await transform({}, output)

      expect(output.messages.length).toBe(2) // original 1 + injected 1
      const msg = output.messages[output.messages.length - 1]!
      expect((msg.info as Record<string, unknown>).role).toBe("user")
      expect((msg.info as Record<string, unknown>).agent).toBe("meta-governor")
      expect(msg.parts.length).toBe(1)
      const part = msg.parts[0] as Record<string, unknown>
      expect(part.type).toBe("text")
      expect(part.text).toContain("Test warn message")
      expect(part.synthetic).toBe(true)
    })

    it("then does NOT inject for continue decisions", async () => {
      clearAll()
      storeDecision("test-session", makeDecision("continue"))

      const plugin = createMetaGovernorPlugin()
      const hooks = await plugin(mockPluginInput, options)
      const transform = hooks["experimental.chat.messages.transform"]!

      const output = { messages: [] as Array<{ info: unknown; parts: unknown[] }> }
      await transform({}, output)

      expect(output.messages.length).toBe(0)
    })
  })

  describe("#given silent mode with a stored decision", () => {
    const options: PluginOptions = {
      meta_governor: {
        enabled: true,
        intervention: { mode: "silent", minActionForMessage: "warn" },
      },
    }

    it("then does NOT inject any message", async () => {
      clearAll()
      storeDecision("test-session", makeDecision("stop"))

      const plugin = createMetaGovernorPlugin()
      const hooks = await plugin(mockPluginInput, options)
      const transform = hooks["experimental.chat.messages.transform"]!

      const output = { messages: [] as Array<{ info: unknown; parts: unknown[] }> }
      await transform({}, output)

      expect(output.messages.length).toBe(0)
    })
  })
})

// ─── System Transform Tests ───────────────────────────────────────

describe("experimental.chat.system.transform", () => {
  describe("#given system mode with a stored stop decision", () => {
    const options: PluginOptions = {
      meta_governor: {
        enabled: true,
        intervention: { mode: "system", minActionForMessage: "warn" },
      },
    }

    it("then appends guidance to system strings", async () => {
      clearAll()
      storeDecision("test-session", makeDecision("stop"))

      const plugin = createMetaGovernorPlugin()
      const hooks = await plugin(mockPluginInput, options)
      const transform = hooks["experimental.chat.system.transform"]!

      const output = { system: ["existing system prompt"] }
      await transform({ sessionID: "test-session" }, output)

      expect(output.system.length).toBeGreaterThan(1)
      expect(output.system[output.system.length - 1]).toBe("---")
      expect(output.system.some((s) => s.includes("Test stop message"))).toBe(true)
    })
  })

  describe("#given message mode (not system)", () => {
    const options: PluginOptions = {
      meta_governor: {
        enabled: true,
        intervention: { mode: "message", minActionForMessage: "warn" },
      },
    }

    it("then does NOT append to system strings", async () => {
      clearAll()
      storeDecision("test-session", makeDecision("stop"))

      const plugin = createMetaGovernorPlugin()
      const hooks = await plugin(mockPluginInput, options)
      const transform = hooks["experimental.chat.system.transform"]!

      const output = { system: ["existing system prompt"] }
      await transform({ sessionID: "test-session" }, output)

      expect(output.system.length).toBe(1)
      expect(output.system[0]).toBe("existing system prompt")
    })
  })
})

// ─── minActionForMessage Threshold Tests ──────────────────────────

describe("minActionForMessage threshold", () => {
  describe("#given escalate threshold with a warn decision", () => {
    const options: PluginOptions = {
      meta_governor: {
        enabled: true,
        intervention: { mode: "message", minActionForMessage: "escalate" },
      },
    }

    it("then does NOT inject for warn (below threshold)", async () => {
      clearAll()
      storeDecision("test-session", makeDecision("warn"))

      const plugin = createMetaGovernorPlugin()
      const hooks = await plugin(mockPluginInput, options)
      const transform = hooks["experimental.chat.messages.transform"]!

      const output = { messages: [] as Array<{ info: unknown; parts: unknown[] }> }
      await transform({}, output)

      expect(output.messages.length).toBe(0)
    })
  })

  describe("#given escalate threshold with a stop decision", () => {
    const options: PluginOptions = {
      meta_governor: {
        enabled: true,
        intervention: { mode: "message", minActionForMessage: "escalate" },
      },
    }

    it("then injects for stop (meets threshold)", async () => {
      clearAll()
      storeDecision("test-session", makeDecision("stop"))

      const plugin = createMetaGovernorPlugin()
      const hooks = await plugin(mockPluginInput, options)
      const transform = hooks["experimental.chat.messages.transform"]!

      // v0.10.0: messages.transform requires sessionID to scope injection.
      const output = {
        messages: [
          { info: { role: "user", sessionID: "test-session" }, parts: [{ type: "text", text: "hi" }] },
        ] as Array<{ info: unknown; parts: unknown[] }>,
      }
      await transform({}, output)

      expect(output.messages.length).toBe(2) // original 1 + injected 1
      const part = output.messages[output.messages.length - 1]!.parts[0] as Record<string, unknown>
      expect(part.text).toContain("Test stop message")
    })
  })
})
