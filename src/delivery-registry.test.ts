import { describe, test, expect } from "bun:test"
import { PendingDeliveryRegistry, type PendingDelivery } from "./delivery-registry"

describe("PendingDeliveryRegistry", () => {
  describe("#register", () => {
    test("returns a non-empty id", () => {
      const reg = new PendingDeliveryRegistry()
      const id = reg.register({
        sessionID: "ses-1",
        mcpTool: "agentmemory_memory_save",
        mcpArgs: { content: "test", concepts: ["a"] },
      })
      expect(id).toMatch(/^deliv-/)
    })

    test("increments pending count", () => {
      const reg = new PendingDeliveryRegistry()
      reg.register({ sessionID: "ses-1", mcpTool: "tool_a", mcpArgs: {} })
      reg.register({ sessionID: "ses-1", mcpTool: "tool_b", mcpArgs: {} })
      expect(reg.getStats().pending).toBe(2)
    })
  })

  describe("#markDelivered", () => {
    test("returns the id when session+mcpTool matches", () => {
      const reg = new PendingDeliveryRegistry()
      const id = reg.register({
        sessionID: "ses-1",
        mcpTool: "agentmemory_memory_save",
        mcpArgs: { content: "test" },
      })
      const found = reg.markDelivered({
        sessionID: "ses-1",
        mcpTool: "agentmemory_memory_save",
        mcpArgs: { content: "test" },
      })
      expect(found).toBe(id)
      expect(reg.getStats().pending).toBe(0)
      expect(reg.getStats().delivered).toBe(1)
    })

    test("returns null when no matching pending", () => {
      const reg = new PendingDeliveryRegistry()
      reg.register({ sessionID: "ses-1", mcpTool: "tool_a", mcpArgs: {} })
      const found = reg.markDelivered({ sessionID: "ses-2", mcpTool: "tool_a" })
      expect(found).toBeNull()
    })

    test("matches by mcpTool alone when mcpArgs not provided", () => {
      const reg = new PendingDeliveryRegistry()
      reg.register({
        sessionID: "ses-1",
        mcpTool: "tool_a",
        mcpArgs: { x: 1 },
      })
      const found = reg.markDelivered({ sessionID: "ses-1", mcpTool: "tool_a" })
      expect(found).not.toBeNull()
    })
  })

  describe("#awaitDelivery", () => {
    test("returns 'delivered' when markDelivered fires before timeout", async () => {
      const reg = new PendingDeliveryRegistry()
      reg.register({ sessionID: "ses-1", mcpTool: "tool_a", mcpArgs: {} })

      // Simulate delivery after 100ms
      setTimeout(() => {
        reg.markDelivered({ sessionID: "ses-1", mcpTool: "tool_a" })
      }, 100)

      const status = await reg.awaitDelivery({
        sessionID: "ses-1",
        mcpTool: "tool_a",
        timeoutMs: 1000,
      })
      expect(status).toBe("delivered")
    })

    test("returns 'expired' when timeout elapses without delivery", async () => {
      const reg = new PendingDeliveryRegistry()
      reg.register({ sessionID: "ses-1", mcpTool: "tool_a", mcpArgs: {} })

      const status = await reg.awaitDelivery({
        sessionID: "ses-1",
        mcpTool: "tool_a",
        timeoutMs: 200,
      })
      expect(status).toBe("expired")
    })

    test("returns 'delivered' immediately if already delivered", async () => {
      const reg = new PendingDeliveryRegistry()
      reg.register({ sessionID: "ses-1", mcpTool: "tool_a", mcpArgs: {} })
      reg.markDelivered({ sessionID: "ses-1", mcpTool: "tool_a" })

      const status = await reg.awaitDelivery({
        sessionID: "ses-1",
        mcpTool: "tool_a",
        timeoutMs: 100,
      })
      expect(status).toBe("delivered")
    })
  })

  describe("#clearSession", () => {
    test("removes all entries for the session", () => {
      const reg = new PendingDeliveryRegistry()
      reg.register({ sessionID: "ses-1", mcpTool: "tool_a", mcpArgs: {} })
      reg.register({ sessionID: "ses-1", mcpTool: "tool_b", mcpArgs: {} })
      reg.register({ sessionID: "ses-2", mcpTool: "tool_a", mcpArgs: {} })
      reg.clearSession("ses-1")
      expect(reg.getStats().pending).toBe(1)
    })
  })

  describe("TTL expiration", () => {
    test("entries expire after ttlMs", async () => {
      const reg = new PendingDeliveryRegistry()
      reg.register({
        sessionID: "ses-1",
        mcpTool: "tool_a",
        mcpArgs: {},
        ttlMs: 50,
      })
      expect(reg.getStats().pending).toBe(1)
      await new Promise((r) => setTimeout(r, 100))
      // cleanup runs on next register/mark
      reg.register({ sessionID: "ses-2", mcpTool: "tool_b", mcpArgs: {} })
      expect(reg.getStats().pending).toBe(1)
      expect(reg.getStats().expired).toBeGreaterThanOrEqual(1)
    })
  })
})
