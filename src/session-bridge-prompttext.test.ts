/**
 * Characterization coverage for promptAgentText (v0.21.0) — the RED phase was
 * the test gap (helper shipped in W2.1 without tests); these tests pin its
 * transport and delivery semantics. The helper is a thin wrapper over
 * persistSessionMessage that sends a real text part via session.prompt().
 */
import { describe, test, expect, beforeEach } from "bun:test"
import {
  setSessionClient,
  promptAgentText,
  type OpencodeClientLike,
} from "./session-bridge"

describe("SessionBridge #promptAgentText", () => {
  beforeEach(() => {
    setSessionClient(null)
  })

  test("sends a text part with the exact text", async () => {
    let capturedArgs: unknown = null
    const mockClient: OpencodeClientLike = {
      session: {
        prompt: async (args) => {
          capturedArgs = args
          return { data: { info: { id: "msg-456" } } }
        },
      },
    }
    setSessionClient(mockClient)
    await promptAgentText("s1", "push now")

    const args = capturedArgs as {
      sessionID: string
      body: { parts: Array<{ type: string; text: string }> }
    }
    expect(args.sessionID).toBe("s1")
    expect(args.body.parts.length).toBe(1)
    expect(args.body.parts[0]?.type).toBe("text")
    expect(args.body.parts[0]?.text).toBe("push now")
  })

  test("resolves ok:true with messageID when delivered", async () => {
    const mockClient: OpencodeClientLike = {
      session: {
        prompt: async () => ({ data: { info: { id: "msg-789" } } }),
      },
    }
    setSessionClient(mockClient)
    const result = await promptAgentText("s1", "hello")
    expect(result.ok).toBe(true)
    expect(result.messageID).toBe("msg-789")
    expect(result.error).toBeNull()
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  test("returns ok:false when no client is set", async () => {
    const result = await promptAgentText("s1", "push now")
    expect(result.ok).toBe(false)
    expect(result.messageID).toBeNull()
    expect(result.error).toMatch(/no OpenCode client/)
    expect(result.durationMs).toBe(0)
  })

  test("propagates delivery error", async () => {
    const mockClient: OpencodeClientLike = {
      session: {
        prompt: async () => {
          throw new Error("network error")
        },
      },
    }
    setSessionClient(mockClient)
    const result = await promptAgentText("s1", "push now")
    expect(result.ok).toBe(false)
    expect(result.messageID).toBeNull()
    expect(result.error).toBe("network error")
  })
})
