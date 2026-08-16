/**
 * Tests for F3.5 — AsyncLocalStorage per-session client isolation.
 * Verifies that two concurrent runWithClient contexts don't cross-contaminate.
 */
import { describe, expect, it } from "bun:test"
import { _sessionStore, runWithClient, setSessionClient, hasSessionClient } from "./session-bridge"

// Build a fake OpenCode client that records which sessionID it received.
function makeFakeClient(label: string) {
  const seen: string[] = []
  return {
    label,
    seen,
    session: {
      prompt: async (input: { path: { id: string }; body: { parts: unknown[] } }) => {
        seen.push(input.path.id)
        return { data: { info: { id: `msg-${label}-${input.path.id}` } } }
      },
    },
  }
}

describe("AsyncLocalStorage per-session client isolation (F3.5)", () => {
  it("runWithClient binds the client to the async context", () => {
    const client = makeFakeClient("test")
    const seen = runWithClient(client as never, () => _sessionStore.getStore())
    expect(seen).toBe(client)
  })

  it("two concurrent runWithClient contexts are isolated", async () => {
    const a = makeFakeClient("A")
    const b = makeFakeClient("B")
    let seenA: unknown = null
    let seenB: unknown = null
    await Promise.all([
      runWithClient(a as never, async () => {
        await new Promise(r => setTimeout(r, 5))
        seenA = _sessionStore.getStore()
      }),
      runWithClient(b as never, () => {
        seenB = _sessionStore.getStore()
      }),
    ])
    expect(seenA).toBe(a)
    expect(seenB).toBe(b)
  })

  it("setSessionClient updates the legacy fallback for direct callers", () => {
    // clear any prior fallback
    setSessionClient(null)
    expect(hasSessionClient()).toBe(false)
    const client = makeFakeClient("fallback")
    setSessionClient(client as never)
    expect(hasSessionClient()).toBe(true)
    // Cleanup
    setSessionClient(null)
  })
})
