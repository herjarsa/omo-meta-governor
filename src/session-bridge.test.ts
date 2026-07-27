/**
 * Tests for SessionBridge — the wrapper that bridges omo-meta-governor
 * to MCP servers (AgentMemory, Magic Context) via session.prompt().
 *
 * v0.14.0 pivot: since the OpenCode SDK does NOT expose a way to call
 * MCP tools directly, we use session.prompt() to send a structured
 * message to the LLM, which then calls the MCP tool.
 */

import { describe, test, expect, beforeEach } from "bun:test"
import { buildEscalationPrompt } from "./session-bridge"
import {
  setSessionClient,
  hasSessionClient,
  promptAgent,
  type OpencodeClientLike,
} from "./session-bridge"

describe("SessionBridge", () => {
  describe("#setSessionClient / #hasSessionClient", () => {
    test("hasSessionClient returns false initially (after reset)", () => {
      setSessionClient(null)
      expect(hasSessionClient()).toBe(false)
    })

    test("hasSessionClient returns true after setSessionClient", () => {
      const mockClient: OpencodeClientLike = {
        session: {
          prompt: async () => ({ data: null }),
        },
      }
      setSessionClient(mockClient)
      expect(hasSessionClient()).toBe(true)
      // Reset for other tests
      setSessionClient(null)
    })

    test("setSessionClient(null) clears the client", () => {
      const mockClient: OpencodeClientLike = {
        session: { prompt: async () => ({ data: null }) },
      }
      setSessionClient(mockClient)
      expect(hasSessionClient()).toBe(true)
      setSessionClient(null)
      expect(hasSessionClient()).toBe(false)
    })
  })

  describe("#promptAgent", () => {
    beforeEach(() => {
      setSessionClient(null)
    })

    test("returns ok:false when no client is set", async () => {
      const result = await promptAgent("test-session", {
        toolName: "omo_test",
        mcpTool: "test_mcp",
        mcpArgs: { foo: "bar" },
      })
      expect(result.ok).toBe(false)
      expect(result.messageID).toBeNull()
      expect(result.error).toMatch(/no OpenCode client/)
      expect(result.durationMs).toBe(0)
    })

    test("returns ok:false when sessionID is empty", async () => {
      const mockClient: OpencodeClientLike = {
        session: { prompt: async () => ({ data: null }) },
      }
      setSessionClient(mockClient)
      const result = await promptAgent("", {
        toolName: "omo_test",
        mcpTool: "test_mcp",
        mcpArgs: {},
      })
      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/sessionID/)
    })

    test("returns ok:true when session.prompt succeeds", async () => {
      let capturedArgs: unknown = null
      const mockClient: OpencodeClientLike = {
        session: {
          prompt: async (args) => {
            capturedArgs = args
            return { data: { info: { id: "msg-123" } } }
          },
        },
      }
      setSessionClient(mockClient)
      const result = await promptAgent("sess-abc", {
        toolName: "omo_remember",
        mcpTool: "agentmemory_memory_save",
        mcpArgs: { content: "test fact", concepts: ["a", "b"] },
      })
      expect(result.ok).toBe(true)
      expect(result.messageID).toBe("msg-123")
      expect(result.error).toBeNull()
      expect(result.durationMs).toBeGreaterThanOrEqual(0)
      // Verify the args passed to the SDK include the right MCP tool + args
      const args = capturedArgs as {
        sessionID: string
        body: { parts: Array<{ type: string; text: string }> }
      }
      expect(args.sessionID).toBe("sess-abc")
      expect(args.body.parts.length).toBe(1)
      expect(args.body.parts[0]?.type).toBe("text")
      expect(args.body.parts[0]?.text).toContain("agentmemory_memory_save")
      expect(args.body.parts[0]?.text).toContain('"content": "test fact"')
      expect(args.body.parts[0]?.text).toContain('"a"')
      expect(args.body.parts[0]?.text).toContain('"b"')
    })

    test("returns ok:false when session.prompt throws", async () => {
      const mockClient: OpencodeClientLike = {
        session: {
          prompt: async () => {
            throw new Error("network error")
          },
        },
      }
      setSessionClient(mockClient)
      const result = await promptAgent("sess-abc", {
        toolName: "omo_remember",
        mcpTool: "agentmemory_memory_save",
        mcpArgs: {},
      })
      expect(result.ok).toBe(false)
      expect(result.error).toBe("network error")
    })

    test("returns ok:false when session.prompt times out", async () => {
      const mockClient: OpencodeClientLike = {
        session: {
          prompt: async () => {
            // Simulate a slow prompt that exceeds the timeout
            await new Promise((resolve) => setTimeout(resolve, 200))
            return { data: null }
          },
        },
      }
      setSessionClient(mockClient)
      const result = await promptAgent("sess-abc", {
        toolName: "omo_remember",
        mcpTool: "agentmemory_memory_save",
        mcpArgs: {},
        timeoutMs: 50,
      })
      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/timed out/i)
    })

    test("handles null response from session.prompt gracefully", async () => {
      const mockClient: OpencodeClientLike = {
        session: { prompt: async () => null },
      }
      setSessionClient(mockClient)
      const result = await promptAgent("sess-abc", {
        toolName: "omo_remember",
        mcpTool: "agentmemory_memory_save",
        mcpArgs: {},
      })
      expect(result.ok).toBe(true)
      expect(result.messageID).toBeNull()
    })

    test("includes the preamble in the prompt text", async () => {
      let capturedText = ""
      const mockClient: OpencodeClientLike = {
        session: {
          prompt: async (args) => {
            capturedText = (args as { body: { parts: Array<{ text: string }> } }).body.parts[0]?.text ?? ""
            return { data: null }
          },
        },
      }
      setSessionClient(mockClient)
      await promptAgent("sess-abc", {
        toolName: "omo_rule",
        mcpTool: "ctx_memory",
        mcpArgs: { category: "ARCHITECTURE", content: "use bun:sqlite" },
        preamble: "Save this durable ARCHITECTURE rule to Magic Context.",
      })
      expect(capturedText).toContain("Save this durable ARCHITECTURE rule")
      expect(capturedText).toContain("ctx_memory")
      expect(capturedText).toContain('"category": "ARCHITECTURE"')
    })
  })

  describe("#buildEscalationPrompt (F5.1)", () => {
    test("ESC1: oracle target includes task tool with subagent_type=oracle", () => {
      const prompt = buildEscalationPrompt({
        reasoning: "score -0.65: 2 deviations detected",
        target: "oracle",
        evidenceCount: 2,
        sessionID: "ses-abc",
      })
      expect(prompt).toContain("subagent_type=oracle")
      expect(prompt).toContain("task")
      expect(prompt).toContain("score -0.65")
      expect(prompt).toContain("2 evidence unit")
    })

    test("ESC2: user target asks for user input, not Oracle", () => {
      const prompt = buildEscalationPrompt({
        reasoning: "grave deviation: data loss without backup",
        target: "user",
        evidenceCount: 3,
        sessionID: "ses-xyz",
      })
      expect(prompt).toContain("user")
      expect(prompt).toContain("grave deviation")
      expect(prompt).not.toContain("subagent_type=oracle")
    })

    test("ESC3: includes the reasoning verbatim", () => {
      const prompt = buildEscalationPrompt({
        reasoning: "ESC_TOKEN_REPLACE_ME",
        target: "oracle",
        evidenceCount: 1,
        sessionID: "ses-1",
      })
      expect(prompt).toContain("ESC_TOKEN_REPLACE_ME")
    })

    test("ESC4: handles singular evidence count phrasing", () => {
      const prompt = buildEscalationPrompt({
        reasoning: "1 deviation",
        target: "oracle",
        evidenceCount: 1,
        sessionID: "ses-1",
      })
      expect(prompt).toContain("1 evidence unit")
    })
  })
})
