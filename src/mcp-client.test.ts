/**
 * Tests for MCPClient — the wrapper that gives omo-meta-governor programmatic
 * access to OpenCode's server API (sessions, tools, config) for calling
 * MCP tools like agentmemory, magic-context, and AFT directly.
 */

import { describe, test, expect, beforeEach } from "bun:test"
import {
  MCPClient,
  getMCPClient,
  resetMCPClient,
  type OpencodeServerClient,
  type CallToolResult,
} from "./mcp-client"

describe("MCPClient", () => {
  let client: MCPClient

  beforeEach(() => {
    client = new MCPClient()
  })

  describe("#setClient / #isReady", () => {
    test("isReady returns false when no client set", () => {
      expect(client.isReady()).toBe(false)
    })

    test("isReady returns true after setClient", () => {
      client.setClient({} as OpencodeServerClient)
      expect(client.isReady()).toBe(true)
    })

    test("setClient(null) clears the client", () => {
      client.setClient({} as OpencodeServerClient)
      expect(client.isReady()).toBe(true)
      client.setClient(null)
      expect(client.isReady()).toBe(false)
    })
  })

  describe("#callTool", () => {
    test("returns error when client not initialized", async () => {
      const result = await client.callTool("agentmemory_memory_save", { content: "x" })
      expect(result.data).toBeNull()
      expect(result.error).toBe("MCP client not initialized")
      expect(result.timedOut).toBe(false)
    })

    test("returns data on successful call", async () => {
      const mockClient: OpencodeServerClient = {
        tool: {
          list: async () => ({ data: [] }),
          invoke: async () => ({ data: { id: "mem-123", content: "test" } }),
        },
      }
      client.setClient(mockClient)
      const result = await client.callTool("agentmemory_memory_save", { content: "test" })
      expect(result.data).toEqual({ id: "mem-123", content: "test" })
      expect(result.error).toBeNull()
      expect(result.timedOut).toBe(false)
      expect(result.durationMs).toBeGreaterThanOrEqual(0)
    })

    test("normalizes array result to null data", async () => {
      const mockClient: OpencodeServerClient = {
        tool: {
          list: async () => ({ data: [] }),
          invoke: async () => ({ data: [1, 2, 3] }),
        },
      }
      client.setClient(mockClient)
      const result = await client.callTool("list_things")
      // Arrays are not normalized to objects — returns null data
      expect(result.data).toBeNull()
    })

    test("catches error and returns structured result", async () => {
      const mockClient: OpencodeServerClient = {
        tool: {
          list: async () => ({ data: [] }),
          invoke: async () => {
            throw new Error("tool execution failed")
          },
        },
      }
      client.setClient(mockClient)
      const result = await client.callTool("failing_tool")
      expect(result.data).toBeNull()
      expect(result.timedOut).toBe(false)
      expect(result.error).toBe("tool execution failed")
    })

    test("returns timedOut=true when call exceeds timeout", async () => {
      const mockClient: OpencodeServerClient = {
        tool: {
          list: async () => ({ data: [] }),
          invoke: async () => {
            // Simulate a slow tool
            await new Promise((resolve) => setTimeout(resolve, 200))
            return { data: { ok: true } }
          },
        },
      }
      client.setClient(mockClient)
      const result = await client.callTool("slow_tool", {}, 50)
      expect(result.timedOut).toBe(true)
      expect(result.data).toBeNull()
      expect(result.error).toMatch(/timed out/i)
    })

    test("uses default timeout from config", async () => {
      const customClient = new MCPClient({ defaultTimeoutMs: 50 })
      const mockClient: OpencodeServerClient = {
        tool: {
          list: async () => ({ data: [] }),
          invoke: async () => {
            await new Promise((resolve) => setTimeout(resolve, 200))
            return { data: { ok: true } }
          },
        },
      }
      customClient.setClient(mockClient)
      const result = await customClient.callTool("slow_tool")
      expect(result.timedOut).toBe(true)
    })
  })

  describe("#isAvailable", () => {
    test("returns false when client not set", async () => {
      expect(await client.isAvailable("any_tool")).toBe(false)
    })

    test("returns true when tool is in the list", async () => {
      const mockClient: OpencodeServerClient = {
        tool: {
          list: async () => ({
            data: [
              { id: "agentmemory_memory_save" },
              { id: "ctx_memory" },
              { id: "aft_outline" },
            ],
          }),
          invoke: async () => ({ data: null }),
        },
      }
      client.setClient(mockClient)
      expect(await client.isAvailable("agentmemory_memory_save")).toBe(true)
      expect(await client.isAvailable("ctx_memory")).toBe(true)
      expect(await client.isAvailable("aft_outline")).toBe(true)
    })

    test("returns false for unknown tool", async () => {
      const mockClient: OpencodeServerClient = {
        tool: {
          list: async () => ({ data: [{ id: "known_tool" }] }),
          invoke: async () => ({ data: null }),
        },
      }
      client.setClient(mockClient)
      expect(await client.isAvailable("unknown_tool")).toBe(false)
    })

    test("caches tool list across calls", async () => {
      let listCallCount = 0
      const mockClient: OpencodeServerClient = {
        tool: {
          list: async () => {
            listCallCount++
            return { data: [{ id: "tool_a" }] }
          },
          invoke: async () => ({ data: null }),
        },
      }
      client.setClient(mockClient)
      await client.isAvailable("tool_a")
      await client.isAvailable("tool_a")
      await client.isAvailable("tool_b")
      expect(listCallCount).toBe(1) // only called once due to cache
    })

    test("invalidates cache when client changes", async () => {
      let listCallCount = 0
      const mockClient: OpencodeServerClient = {
        tool: {
          list: async () => {
            listCallCount++
            return { data: [{ id: "tool_a" }] }
          },
          invoke: async () => ({ data: null }),
        },
      }
      client.setClient(mockClient)
      await client.isAvailable("tool_a")
      client.invalidateCache()
      await client.isAvailable("tool_a")
      expect(listCallCount).toBe(2)
    })

    test("returns false when list() throws", async () => {
      const mockClient: OpencodeServerClient = {
        tool: {
          list: async () => {
            throw new Error("server unavailable")
          },
          invoke: async () => ({ data: null }),
        },
      }
      client.setClient(mockClient)
      expect(await client.isAvailable("any_tool")).toBe(false)
    })
  })

  describe("#availableTools", () => {
    test("returns empty array when client not set", async () => {
      expect(await client.availableTools()).toEqual([])
    })

    test("returns list of available tool ids", async () => {
      const mockClient: OpencodeServerClient = {
        tool: {
          list: async () => ({
            data: [
              { id: "agentmemory_memory_save" },
              { id: "ctx_memory" },
            ],
          }),
          invoke: async () => ({ data: null }),
        },
      }
      client.setClient(mockClient)
      const tools = await client.availableTools()
      expect(tools.sort()).toEqual(["agentmemory_memory_save", "ctx_memory"].sort())
    })
  })

  describe("singleton via getMCPClient", () => {
    test("returns same instance on repeated calls", () => {
      resetMCPClient()
      const a = getMCPClient()
      const b = getMCPClient()
      expect(a).toBe(b)
    })

    test("resetMCPClient creates new instance", () => {
      const a = getMCPClient()
      resetMCPClient()
      const b = getMCPClient()
      expect(a).not.toBe(b)
    })
  })
})
