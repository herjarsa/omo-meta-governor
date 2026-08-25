import { describe, expect, it, beforeEach } from "bun:test"
import {
  storeDecision,
  getDecisionHistory,
  clearAll,
  takeDecision,
} from "./decision-store"
import { countConsecutiveStops } from "./decision-handler"
import type { DecisionHandlerOutput } from "./types"

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

describe("consecutiveStops threading (v0.34.2 P0-2 regression)", () => {
  beforeEach(() => clearAll())

  it("then getDecisionHistory returns empty array for new session", () => {
    expect(getDecisionHistory("s-new")).toEqual([])
  })

  it("then getDecisionHistory accumulates in order", () => {
    storeDecision("s1", makeDecision("stop"))
    storeDecision("s1", makeDecision("stop"))
    storeDecision("s1", makeDecision("stop"))
    const actions = getDecisionHistory("s1").map((h) => h.action)
    expect(actions).toEqual(["stop", "stop", "stop"])
  })

  it("then history is trimmed at MAX_HISTORY (20)", () => {
    for (let i = 0; i < 25; i++) {
      storeDecision("s1", makeDecision("continue"))
    }
    expect(getDecisionHistory("s1").length).toBe(20)
  })

  it("then countConsecutiveStops on 3-stop history returns 3", () => {
    storeDecision("s1", makeDecision("stop"))
    storeDecision("s1", makeDecision("stop"))
    storeDecision("s1", makeDecision("stop"))
    expect(countConsecutiveStops(getDecisionHistory("s1"))).toBe(3)
  })

  it("then countConsecutiveStops resets when non-stop action appears", () => {
    storeDecision("s1", makeDecision("stop"))
    storeDecision("s1", makeDecision("stop"))
    storeDecision("s1", makeDecision("continue"))
    storeDecision("s1", makeDecision("stop"))
    expect(countConsecutiveStops(getDecisionHistory("s1"))).toBe(1)
  })

  it("then history is per-session (s1 history does not leak to s2)", () => {
    storeDecision("s1", makeDecision("stop"))
    storeDecision("s1", makeDecision("stop"))
    storeDecision("s2", makeDecision("continue"))
    expect(countConsecutiveStops(getDecisionHistory("s1"))).toBe(2)
    expect(countConsecutiveStops(getDecisionHistory("s2"))).toBe(0)
  })

  it("then storeDecision still serves takeDecision (last pending wins)", () => {
    storeDecision("s1", makeDecision("warn"))
    const pending = takeDecision("s1")
    expect(pending?.action).toBe("warn")
    // After takeDecision, the history still has the entry.
    expect(getDecisionHistory("s1").length).toBe(1)
  })

  it("then clearAll wipes history too (not just store)", () => {
    storeDecision("s1", makeDecision("stop"))
    storeDecision("s1", makeDecision("stop"))
    expect(getDecisionHistory("s1").length).toBe(2)
    clearAll()
    expect(getDecisionHistory("s1").length).toBe(0)
  })
})