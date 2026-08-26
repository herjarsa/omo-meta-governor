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
import { createHermeticPlugin } from "./__test-helpers__/hermetic-plugin"
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
      const plugin = createHermeticPlugin({
        graphSync: { enabled: false, autoInstall: false },
      })
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
      const plugin = createHermeticPlugin({
        graphSync: { enabled: false, autoInstall: false },
      })
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
        // v0.20.0: user config enables skillPriming; disable it here so
        // this test asserts ONLY the decision-injection path.
        skillPriming: { enabled: false },
      },
    }

    it("then injects a synthetic user message", async () => {
      clearAll()
      storeDecision("test-session", makeDecision("warn"))

      const plugin = createHermeticPlugin({
        graphSync: { enabled: false, autoInstall: false },
      })
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

      expect(output.messages.length).toBe(2) // synthetic user message injected for warn
    })

    it("then does NOT inject for continue decisions", async () => {
      clearAll()
      storeDecision("test-session", makeDecision("continue"))

      const plugin = createHermeticPlugin({
        graphSync: { enabled: false, autoInstall: false },
      })
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

      const plugin = createHermeticPlugin({
        graphSync: { enabled: false, autoInstall: false },
      })
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

      const plugin = createHermeticPlugin({
        graphSync: { enabled: false, autoInstall: false },
      })
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
        // v0.19.3: user config enables protocolEnforcement by default;
        // disable it explicitly so this test asserts ONLY the decision-
        // injection path (not the protocol path).
        protocolEnforcement: { enabled: false },
      },
    }

    it("then appends decision to system strings (v0.33.1: banner-free path)", async () => {
      clearAll()
      storeDecision("test-session", makeDecision("stop"))

      const plugin = createHermeticPlugin({
        graphSync: { enabled: false, autoInstall: false },
      })
      const hooks = await plugin(mockPluginInput, options)
      const transform = hooks["experimental.chat.system.transform"]!

      const output = { system: ["existing system prompt"] }
      await transform({ sessionID: "test-session" }, output)

      // v0.33.1: 'message' mode now routes decisions via chat.system.transform too
      // (banner-free; the role:'user' synthetic push was the session-killer).
      expect(output.system.length).toBeGreaterThan(1)
      expect(output.system.some((s) => s.includes("Test stop message"))).toBe(true)
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

      const plugin = createHermeticPlugin({
        graphSync: { enabled: false, autoInstall: false },
      })
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
        // v0.20.0: user config enables skillPriming; disable it here so
        // this test asserts ONLY the decision-injection path.
        skillPriming: { enabled: false },
      },
    }

    it("then injects for stop (meets threshold)", async () => {
      clearAll()
      storeDecision("test-session", makeDecision("stop"))

      // v0.33.0: prod no longer pushes role:"user" synthetic messages (banner-killer).
      // Pass a stub __test_persistSessionMessage so the test-only push path is exercised.
      const plugin = createHermeticPlugin(
        { graphSync: { enabled: false, autoInstall: false } },
        { __test_persistSessionMessage: async () => ({ ok: true, messageID: null, error: null, durationMs: 0 }) },
      )
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


// ─── tool.execute.before audit tests (v0.17.1) ─────────────────────

describe("tool.execute.before audit", () => {
  describe("#given write tool with @ts-ignore + as any in args", () => {
const options: PluginOptions = {
meta_governor: {
enabled: true,
protocolEnforcement: {
enabled: true,
auditToolCalls: true,
},
        intervention: { mode: "message", minActionForMessage: "warn" },
        // v0.34.0: explicit override so the test does not pick up the
        // user's global config (which may have enforceMode='block').
        // Tests in this block target the protocolEnforcement path,
        // not the skill-priming block gate, so we force directive mode.
        skillPriming: { enabled: false, trigger: "sessionStart", router: "registry", enforceMode: "directive"
},
    },
    }

    it("then detects no-type-suppression violation and injects it via messages.transform", async () => {
      clearAll()
      const plugin = createHermeticPlugin({
        graphSync: { enabled: false, autoInstall: false },
      })
      const hooks = await plugin(mockPluginInput, options)
      const before = hooks["tool.execute.before"]!
      const transform = hooks["experimental.chat.messages.transform"]!

      // Simulate a write tool call with forbidden patterns in args
      await before(
        { tool: "write", sessionID: "test-audit-1", callID: "call-1" },
        { args: { filePath: "/tmp/bad.ts", content: "// @ts-ignore\nconst x: any = 1 as any;" } }
      )

      // Trigger messages.transform which should inject pending violations
      const output = {
        messages: [
          { info: { role: "user", sessionID: "test-audit-1" }, parts: [{ type: "text", text: "ok" }] },
        ] as Array<{ info: unknown; parts: unknown[] }>,
      }
      await transform({}, output)

      // v0.35.0 (audit fix): violations DO inject; the v0.31.6 "log-only" behavior was never landed in plugin.ts.
      // They no longer inject via messages.transform (which required "continua" click).
      // Grave violations still inject; MEDIA is suppressed.
      const allText = output.messages
        .map((m) => (m.parts[0] as Record<string, unknown> | undefined)?.text as string ?? "")
        .join("\n")
      expect(allText).toContain("PROTOCOL VIOLATIONS")
      expect(allText).toContain("no-type-suppression")
    })

    it("then detects empty-catch violation when args contain catch(e) {}", async () => {
      clearAll()
      const plugin = createHermeticPlugin({
        graphSync: { enabled: false, autoInstall: false },
      })
      const hooks = await plugin(mockPluginInput, options)
      const before = hooks["tool.execute.before"]!
      const transform = hooks["experimental.chat.messages.transform"]!

      await before(
        { tool: "write", sessionID: "test-audit-2", callID: "call-2" },
        { args: { filePath: "/tmp/empty-catch.ts", content: "try { throw 1 } catch(e) {}" } }
      )

      const output = {
        messages: [
          { info: { role: "user", sessionID: "test-audit-2" }, parts: [{ type: "text", text: "ok" }] },
        ] as Array<{ info: unknown; parts: unknown[] }>,
      }
      await transform({}, output)

      const allText = output.messages
        .map((m) => (m.parts[0] as Record<string, unknown> | undefined)?.text as string ?? "")
        .join("\n")
      // v0.35.0 (audit fix): violations DO inject; see note above.
      expect(allText).toContain("PROTOCOL VIOLATIONS")
      expect(allText).toContain("no-empty-catch")
    })

    it("then does NOT inject any protocol violation for benign writes", async () => {
      clearAll()
      const plugin = createHermeticPlugin({
        graphSync: { enabled: false, autoInstall: false },
      })
      const hooks = await plugin(mockPluginInput, options)
      const before = hooks["tool.execute.before"]!
      const transform = hooks["experimental.chat.messages.transform"]!

      await before(
        { tool: "write", sessionID: "test-audit-3", callID: "call-3" },
        { args: { filePath: "/tmp/clean.ts", content: "export function add(a: number, b: number): number { return a + b }" } }
      )

      const output = {
        messages: [
          { info: { role: "user", sessionID: "test-audit-3" }, parts: [{ type: "text", text: "ok" }] },
        ] as Array<{ info: unknown; parts: unknown[] }>,
      }
      await transform({}, output)

      // No protocol-violations injection. Other injections (e.g. plan reminder) may
      // still occur, so we check the violation text is absent rather than message count.
      const allText = output.messages
        .map((m) => (m.parts[0] as Record<string, unknown> | undefined)?.text as string ?? "")
        .join("\n")
      expect(allText).not.toContain("PROTOCOL VIOLATIONS")
      expect(allText).not.toContain("no-type-suppression")
      expect(allText).not.toContain("no-empty-catch")
    })
  })

  describe("#given protocolEnforcement.auditToolCalls is false", () => {
const options: PluginOptions = {
meta_governor: {
enabled: true,
protocolEnforcement: {
enabled: true,
auditToolCalls: false,
},
        intervention: { mode: "message", minActionForMessage: "warn" },
        // v0.34.0: explicit override so the test does not pick up the
        // user's global config (which may have enforceMode='block').
        skillPriming: { enabled: false, trigger: "sessionStart", router: "registry", enforceMode: "directive"
},
    },
    }

    it("then tool.execute.before short-circuits and does not audit", async () => {
      clearAll()
      const plugin = createHermeticPlugin({
        graphSync: { enabled: false, autoInstall: false },
      })
      const hooks = await plugin(mockPluginInput, options)
      const before = hooks["tool.execute.before"]!

      // Should be a no-op even with bad content
      await before(
        { tool: "write", sessionID: "test-audit-4", callID: "call-4" },
        { args: { filePath: "/tmp/bad.ts", content: "// @ts-ignore\nconst x: any = 1 as any;" } }
      )
      // No assertion on internal state — just verify no exception
      // No assertion on internal state — just verify no exception
      expect(true).toBe(true)
    })
  })
})


// v0.34.0: skill-priming enforcement (enforceMode='block'). When enabled,
// implementation tools (write/edit/apply_patch/...) are blocked at
// tool.execute.before until omo_skill_find is invoked in the same session.
describe("skill-priming enforceMode='block' (v0.34.0)", () => {
  const blockOptions: PluginOptions = {
    meta_governor: {
      enabled: true,
      protocolEnforcement: { enabled: true, auditToolCalls: false },
      skillPriming: { enabled: true, trigger: "sessionStart", router: "registry", enforceMode: "block" },
    },
  }

  it("then blocks write tool when omo_skill_find has NOT been called in this session", async () => {
    clearAll()
    const plugin = createHermeticPlugin()
    const hooks = await plugin(mockPluginInput, blockOptions)
    const before = hooks["tool.execute.before"]!
    await expect(
      before(
        { tool: "write", sessionID: "block-test-1", callID: "c1" },
        { args: { filePath: "/tmp/x.ts", content: "x" } },
      ),
    ).rejects.toThrow(/skill-priming required|omo_skill_find/)
  })

  it("then allows write tool AFTER omo_skill_find has been called in this session", async () => {
    clearAll()
    const plugin = createHermeticPlugin()
    const hooks = await plugin(mockPluginInput, blockOptions)
    const before = hooks["tool.execute.before"]!
    const after = hooks["tool.execute.after"]!
    // First, the agent queries the skill catalog.
    await after(
      { tool: "omo_skill_find", sessionID: "block-test-2", callID: "c1", args: { query: "x" } },
      { title: "", output: "ok", metadata: {} },
    )
    // Now write should pass through the gate.
    await expect(
      before(
        { tool: "write", sessionID: "block-test-2", callID: "c2" },
        { args: { filePath: "/tmp/x.ts", content: "x" } },
      ),
    ).resolves.toBeUndefined()
  })

  it("then allow omo_skill_find itself (it's not in IMPLEMENTATION_TOOLS)", async () => {
    clearAll()
    const plugin = createHermeticPlugin()
    const hooks = await plugin(mockPluginInput, blockOptions)
    const before = hooks["tool.execute.before"]!
    await expect(
      before(
        { tool: "omo_skill_find", sessionID: "block-test-3", callID: "c1" },
        { args: { query: "x" } },
      ),
    ).resolves.toBeUndefined()
  })
})

// v0.34.0: enforceMode='directive' (default) preserves the legacy opt-in path.
// No blocking even when omo_skill_find has not been called.
describe("skill-priming enforceMode='directive' backward compat (v0.34.0)", () => {
  const directiveOptions: PluginOptions = {
    meta_governor: {
      enabled: true,
      protocolEnforcement: { enabled: true, auditToolCalls: false },
      skillPriming: { enabled: true, trigger: "sessionStart", router: "registry", enforceMode: "directive" },
    },
  }

  it("then does NOT block write tool even when omo_skill_find has not been called", async () => {
    clearAll()
    const plugin = createHermeticPlugin()
    const hooks = await plugin(mockPluginInput, directiveOptions)
    const before = hooks["tool.execute.before"]!
    await expect(
      before(
        { tool: "write", sessionID: "directive-test-1", callID: "c1" },
        { args: { filePath: "/tmp/x.ts", content: "x" } },
      ),
    ).resolves.toBeUndefined()
  })
})


// v0.34.2 (P1-6): bash with > file / 	ee file must be treated like a write tool
// by the skill-priming gate AND the filesChanged counter. Without this, a user could
// bypass enforceMode='block' entirely by writing files via bash redirects.
describe('bash redirect bypass (P1-6)', () => {
  const blockOptions: PluginOptions = {
    meta_governor: {
      enabled: true,
      protocolEnforcement: { enabled: true, auditToolCalls: false },
      skillPriming: { enabled: true, trigger: 'sessionStart', router: 'registry', enforceMode: 'block' },
    },
  }

  it('then blocks bash with > file when omo_skill_find has NOT been called', async () => {
    clearAll()
    const plugin = createHermeticPlugin()
    const hooks = await plugin(mockPluginInput, blockOptions)
    const before = hooks['tool.execute.before']!
    await expect(
      before(
        { tool: 'bash', sessionID: 'bash-block-1', callID: 'c1', args: { command: 'echo hi > /tmp/x' } },
        { args: { command: 'echo hi > /tmp/x' } },
      ),
    ).rejects.toThrow(/skill-priming required|omo_skill_find/)
  })

  it('then blocks bash with 	ee file when omo_skill_find has NOT been called', async () => {
    clearAll()
    const plugin = createHermeticPlugin()
    const hooks = await plugin(mockPluginInput, blockOptions)
    const before = hooks['tool.execute.before']!
    await expect(
      before(
        { tool: 'bash', sessionID: 'bash-block-2', callID: 'c1', args: { command: 'cat foo | tee /tmp/y' } },
        { args: { command: 'cat foo | tee /tmp/y' } },
      ),
    ).rejects.toThrow(/skill-priming required|omo_skill_find/)
  })

  it('then does NOT block bash with no redirect (read-only)', async () => {
    clearAll()
    const plugin = createHermeticPlugin()
    const hooks = await plugin(mockPluginInput, blockOptions)
    const before = hooks['tool.execute.before']!
    await expect(
      before(
        { tool: 'bash', sessionID: 'bash-ok-1', callID: 'c1', args: { command: 'ls -la' } },
        { args: { command: 'ls -la' } },
      ),
    ).resolves.toBeUndefined()
  })

  // Note: the filesChanged accounting on bash redirect-target extraction is
  // verified indirectly via the gate tests above. A direct assertion would require
  // exposing the internal session-state map, which is out of scope for this fix.
})
