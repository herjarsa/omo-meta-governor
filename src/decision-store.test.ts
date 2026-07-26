/**
 * Tests for decision-store.ts (H8 — 61 lines, no test file).
 */
import { describe, expect, it, beforeEach } from "bun:test"
import { storeDecision, takeDecision, hasDecision, takeAnyDecision, clearAll } from "./decision-store"
import type { DecisionHandlerOutput } from "./types"

function makeDecision(
  sessionID: string,
  action: DecisionHandlerOutput["action"] = "warn",
): DecisionHandlerOutput {
  return {
    action,
    message: `[MetaGovernor] Test ${action}`,
    historyEntry: {
      decision: {
        action,
        score: action === "continue" ? 0.5 : -0.5,
        reasoning: "test",
        evidence: [],
        shouldEscalateTo: null,
      },
      action,
      timestampISO: new Date().toISOString(),
      sessionID,
      reasoning: "test",
    },
  }
}

describe("decision-store", () => {
  beforeEach(() => clearAll())

  describe("storeDecision", () => {
    it("stores a decision and hasDecision returns true", () => {
      storeDecision("s1", makeDecision("s1"))
      expect(hasDecision("s1")).toBe(true)
    })

    it("overwrites a previous decision for the same session", () => {
      storeDecision("s1", makeDecision("s1", "warn"))
      storeDecision("s1", makeDecision("s1", "stop"))
      const d = takeDecision("s1")
      expect(d?.action).toBe("stop")
    })

    it("does not interfere with other sessions", () => {
      storeDecision("s1", makeDecision("s1", "warn"))
      storeDecision("s2", makeDecision("s2", "stop"))
      expect(takeDecision("s1")?.action).toBe("warn")
      expect(takeDecision("s2")?.action).toBe("stop")
    })
  })

  describe("takeDecision", () => {
    it("returns the decision and removes it", () => {
      storeDecision("s1", makeDecision("s1"))
      const d = takeDecision("s1")
      expect(d?.action).toBe("warn")
      expect(hasDecision("s1")).toBe(false)
    })

    it("returns undefined for a session with no decision", () => {
      expect(takeDecision("nope")).toBeUndefined()
    })

    it("returns undefined on second call (decision already consumed)", () => {
      storeDecision("s1", makeDecision("s1"))
      takeDecision("s1")
      expect(takeDecision("s1")).toBeUndefined()
    })
  })

  describe("hasDecision", () => {
    it("returns false for an empty store", () => {
      expect(hasDecision("any")).toBe(false)
    })

    it("returns true after store, false after take", () => {
      storeDecision("s1", makeDecision("s1"))
      expect(hasDecision("s1")).toBe(true)
      takeDecision("s1")
      expect(hasDecision("s1")).toBe(false)
    })
  })

  describe("takeAnyDecision (deprecated but still functional)", () => {
    it("returns one decision and removes it (arbitrary session)", () => {
      storeDecision("s1", makeDecision("s1", "warn"))
      storeDecision("s2", makeDecision("s2", "stop"))
      const d = takeAnyDecision()
      expect(d).toBeDefined()
      // Some session still has a decision remaining
      expect(hasDecision("s1") || hasDecision("s2")).toBe(true)
    })

    it("returns undefined when store is empty", () => {
      expect(takeAnyDecision()).toBeUndefined()
    })
  })

  describe("clearAll", () => {
    it("removes all decisions", () => {
      storeDecision("s1", makeDecision("s1"))
      storeDecision("s2", makeDecision("s2"))
      clearAll()
      expect(hasDecision("s1")).toBe(false)
      expect(hasDecision("s2")).toBe(false)
    })
  })

  describe("cross-session safety (C2 fix)", () => {
    it("takeDecision(s1) does NOT consume s2's decision", () => {
      // C2 finding: takeAnyDecision could leak across sessions.
      // The messages.transform hook now derives sessionID from the last
      // outgoing message and uses takeDecision. Verify the per-session
      // boundary is preserved.
      storeDecision("s1", makeDecision("s1", "warn"))
      storeDecision("s2", makeDecision("s2", "stop"))
      takeDecision("s1")
      // s2's decision is untouched
      expect(takeDecision("s2")?.action).toBe("stop")
    })
  })
})
