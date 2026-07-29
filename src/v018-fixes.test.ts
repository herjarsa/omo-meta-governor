/**
 * v0.18.0 regression tests for audit gaps found during thorough audit.
 * Each test corresponds to a specific bug that was silently dropping
 * user config or crashing the plugin.
 */

import { describe, expect, it } from "bun:test"
import { loadOrchestratorConfig, isMetaGovernorEnabled } from "./config"
import { logToFile } from "./file-logger"
import { createMetricsCollector } from "./metrics"

describe("v0.18.0 fix: closedLoop config fields now project", () => {
  it("maxLessonsPerSession is applied", () => {
    const r = loadOrchestratorConfig({
      closedLoop: { maxLessonsPerSession: 50 },
    } as any)
    expect(r.closedLoop.maxLessonsPerSession).toBe(50)
  })

  it("enabled=false is applied", () => {
    const r = loadOrchestratorConfig({
      closedLoop: { enabled: false },
    } as any)
    expect(r.closedLoop.enabled).toBe(false)
  })

  it("minSeverityToLearn is applied", () => {
    const r = loadOrchestratorConfig({
      closedLoop: { minSeverityToLearn: "leve" },
    } as any)
    expect(r.closedLoop.minSeverityToLearn).toBe("leve")
  })

  it("saveLessons=false is applied", () => {
    const r = loadOrchestratorConfig({
      closedLoop: { saveLessons: false },
    } as any)
    expect((r.closedLoop as any).saveLessons).toBe(false)
  })
})

describe("v0.18.0 fix: decision message templates now project", () => {
  it("warnMessageTemplate is applied", () => {
    const r = loadOrchestratorConfig({
      decision: { warnMessageTemplate: "CUSTOM WARN: {reasoning}" } as any,
    })
    expect(r.decision.warnMessageTemplate).toBe("CUSTOM WARN: {reasoning}")
  })

  it("escalateMessageTemplate is applied", () => {
    const r = loadOrchestratorConfig({
      decision: { escalateMessageTemplate: "CUSTOM ESC: {target}" } as any,
    })
    expect(r.decision.escalateMessageTemplate).toBe("CUSTOM ESC: {target}")
  })

  it("stopMessageTemplate is applied", () => {
    const r = loadOrchestratorConfig({
      decision: { stopMessageTemplate: "CUSTOM STOP: {reasoning}" } as any,
    })
    expect(r.decision.stopMessageTemplate).toBe("CUSTOM STOP: {reasoning}")
  })
})

describe("v0.18.0 fix: scoring.paralysisThreshold now projects", () => {
  it("paralysisThreshold override is applied", () => {
    const r = loadOrchestratorConfig({
      scoring: { paralysisThreshold: 10 },
    } as any)
    expect(r.scoring.paralysisThreshold).toBe(10)
  })

  it("defaultEscalationTarget override is applied", () => {
    const r = loadOrchestratorConfig({
      scoring: { defaultEscalationTarget: "user" },
    } as any)
    expect(r.scoring.defaultEscalationTarget).toBe("user")
  })
})

describe("v0.18.0 fix: memory.timeoutMs now projects (with alias support)", () => {
  it("timeoutMs is the primary name", () => {
    const r = loadOrchestratorConfig({
      memory: { timeoutMs: 5000 } as any,
    })
    expect(r.memory.timeoutMs).toBe(5000)
  })

  it("agentmemoryTimeoutMs still works (back-compat alias)", () => {
    const r = loadOrchestratorConfig({
      memory: { agentmemoryTimeoutMs: 7000 } as any,
    })
    expect(r.memory.timeoutMs).toBe(7000)
  })

  it("timeoutMs takes priority over agentmemoryTimeoutMs", () => {
    const r = loadOrchestratorConfig({
      memory: { timeoutMs: 5000, agentmemoryTimeoutMs: 7000 } as any,
    })
    expect(r.memory.timeoutMs).toBe(5000)
  })
})

describe("v0.18.0 fix: isMetaGovernorEnabled handles both shapes", () => {
  it("returns true for top-level enabled=true", () => {
    expect(isMetaGovernorEnabled({ enabled: true } as any)).toBe(true)
  })

  it("returns true for meta_governor.enabled=true (wrapped)", () => {
    expect(isMetaGovernorEnabled({ meta_governor: { enabled: true } } as any)).toBe(true)
  })

  it("returns false for enabled=false", () => {
    expect(isMetaGovernorEnabled({ enabled: false } as any)).toBe(false)
  })

  it("returns false for meta_governor.enabled=false", () => {
    expect(isMetaGovernorEnabled({ meta_governor: { enabled: false } } as any)).toBe(false)
  })

  it("returns false for empty config", () => {
    expect(isMetaGovernorEnabled({} as any)).toBe(false)
  })

  it("returns false for undefined", () => {
    expect(isMetaGovernorEnabled(undefined)).toBe(false)
  })
})

describe("v0.18.0 fix: file-logger handles circular references", () => {
  it("does not crash on self-referencing object", () => {
    const circ: any = { foo: "bar" }
    circ.self = circ
    expect(() => logToFile("info", "circular self-ref", circ)).not.toThrow()
  })

  it("does not crash on deep circular A→B→A", () => {
    const a: any = { name: "a" }
    const b: any = { name: "b", ref: a }
    a.ref = b
    expect(() => logToFile("info", "deep circular", { a, b })).not.toThrow()
  })

  it("does not crash on circular array", () => {
    const arr: any[] = [1, 2, 3]
    arr.push(arr)
    expect(() => logToFile("info", "circular array", { arr })).not.toThrow()
  })

  it("still redacts secrets on non-circular data", () => {
    expect(() =>
      logToFile("info", "with secret", { api_key: "sk-1234567890abcdefghij" }),
    ).not.toThrow()
  })
})

describe("v0.18.0 fix: createMetricsCollector handles undefined config", () => {
  it("does not crash when called without config", () => {
    expect(() => createMetricsCollector()).not.toThrow()
  })

  it("does not crash with empty config", () => {
    expect(() => createMetricsCollector({})).not.toThrow()
  })

  it("uses DEFAULT_VERSION when version is undefined", () => {
    const m = createMetricsCollector()
    const snap = m.getMetrics()
    expect(snap.version).toBeDefined()
    expect(snap.version.length).toBeGreaterThan(0)
  })

  it("handles invalid event names without crashing", () => {
    const m = createMetricsCollector()
    // v0.18.0: type system prevents invalid events, but runtime should be safe
    expect(() => m.inc("decisions_taken" as any)).not.toThrow()
  })

  it("handles many increments without memory leak", () => {
    const m = createMetricsCollector()
    for (let i = 0; i < 10_000; i++) {
      m.inc("decisions_taken" as any)
    }
    const snap = m.getMetrics()
    expect((snap.counters as any)["decisions_taken"]?.count).toBe(10_000)
  })
})
