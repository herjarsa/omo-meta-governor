/**
 * v0.31.3 Health freshness — RED tests.
 *
 * Bug: ~/.config/opencode/meta-governor-health.json was only written when
 * omo_health was invoked, so `cat`-ing the file showed stale zero-metrics
 * snapshots left by days-old MCP-server runs. Users concluded the plugin
 * was dead while the log proved it was actively auditing every tool call.
 *
 * Fix under test:
 * 1. buildPluginHealth() — shared pure composer extracted from
 *    custom-tools.ts so plugin-side periodic writes and omo_health emit
 *    an identical PluginHealth schema (single source of truth).
 * 2. createThrottledHealthWriter() — rate-limited writer the plugin's
 *    tool.execute.after hook uses to refresh the snapshot on audit events
 *    without hammering the disk.
 *
 * These tests SHOULD FAIL until the fix lands (RED), then pass (GREEN).
 */
import { describe, expect, it } from "bun:test"
import { mkdtempSync, writeFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildPluginHealth,
  createThrottledHealthWriter,
  type PluginHealth,
} from "./health"

// ─── Shared fixtures ────────────────────────────────────────────

const baseSnapshot = {
  startedAtISO: "2026-01-01T00:00:00.000Z",
  uptimeMs: 1234,
  counters: {
    decisions_taken: { count: 2, lastOccurrenceISO: "2026-01-01T00:01:00.000Z" },
    decisions_stored: { count: 2 },
    interventions_delivered: {
      count: 1,
      lastOccurrenceISO: "2026-01-01T00:02:00.000Z",
    },
    orchestrator_runs: { count: 5 },
    orchestrator_errors: {},
    decisions_skipped_continue: { count: 3 },
    decisions_skipped_no_decision: { count: 1 },
    decisions_skipped_no_message: {},
    decisions_skipped_below_threshold: { count: 2 },
  },
}

function tempLogPath(): string {
  return join(mkdtempSync(join(tmpdir(), "omo-hb-")), "meta-governor.log")
}

function build(
  overrides: Record<string, unknown> = {},
): PluginHealth {
  return buildPluginHealth({
    version: "0.31.3",
    enabled: true,
    sessionID: "ses_test",
    snapshot: baseSnapshot,
    logFilePath: tempLogPath(),
    ...(overrides as object),
  })
}

// ─── buildPluginHealth ──────────────────────────────────────────

describe("buildPluginHealth", () => {
  it("maps metric counters into the PluginHealth schema", () => {
    const h = build()
    expect(h.version).toBe("0.31.3")
    expect(h.enabled).toBe(true)
    expect(h.startedAtISO).toBe(baseSnapshot.startedAtISO)
    expect(h.uptimeMs).toBe(1234)
    expect(h.metrics.decisionsTaken).toBe(2)
    expect(h.metrics.decisionsStored).toBe(2)
    expect(h.metrics.interventionsDelivered).toBe(1)
    expect(h.metrics.orchestratorRuns).toBe(5)
    expect(h.metrics.lastDecisionISO).toBe("2026-01-01T00:01:00.000Z")
    expect(h.metrics.lastInterventionISO).toBe("2026-01-01T00:02:00.000Z")
  })

  it("sums the four skip counters into session.interventionsSkipped", () => {
    const h = build()
    // 3 + 1 + 0 + 2
    expect(h.session.interventionsSkipped).toBe(6)
    expect(h.session.id).toBe("ses_test")
    expect(h.session.toolCallsObserved).toBe(5)
  })

  it("reports healthy when there are no orchestrator errors", () => {
    expect(build().status).toBe("healthy")
  })

  it("reports degraded when orchestrator errors exist", () => {
    const snap = {
      ...baseSnapshot,
      counters: {
        ...baseSnapshot.counters,
        orchestrator_errors: { count: 1 },
      },
    }
    expect(build({ snapshot: snap }).status).toBe("degraded")
  })

  it("populates logFile stats from the real file (not hardcoded zeros)", () => {
    const p = tempLogPath()
    writeFileSync(p, "hello", "utf8")
    const h = build({ logFilePath: p })
    expect(h.logFile.path).toBe(p)
    expect(statSync(p).size).toBe(5)
    expect(h.logFile.sizeBytes).toBe(5)
  })

  it("emits a complete graphToolsUsed map and graphSync defaults", () => {
    const h = build()
    const keys = Object.keys(h.graphToolsUsed)
    expect(keys.length).toBeGreaterThanOrEqual(33)
    for (const k of keys) expect(h.graphToolsUsed[k as keyof typeof h.graphToolsUsed]).toBe(0)
    expect(h.graphSync?.lastUpgradeResult).toBe("unknown")
    expect(h.graphSync?.lastUpgradeTarget).toBeNull()
  })
})

// ─── createThrottledHealthWriter ────────────────────────────────

describe("createThrottledHealthWriter", () => {
  it("always writes the first snapshot", () => {
    const writes: PluginHealth[] = []
    let now = 1000
    const w = createThrottledHealthWriter(
      (h) => writes.push(h),
      5000,
      () => now,
    )
    w.write(build())
    expect(writes.length).toBe(1)
  })

  it("skips writes inside the throttle window", () => {
    const writes: PluginHealth[] = []
    let now = 1000
    const w = createThrottledHealthWriter(
      (h) => writes.push(h),
      5000,
      () => now,
    )
    w.write(build())
    now = 4000 // +3s < 5s window
    w.write(build())
    expect(writes.length).toBe(1)
  })

  it("writes again once the throttle window has elapsed", () => {
    const writes: PluginHealth[] = []
    let now = 1000
    const w = createThrottledHealthWriter(
      (h) => writes.push(h),
      5000,
      () => now,
    )
    w.write(build())
    now = 7000 // +6s > 5s window
    w.write(build())
    expect(writes.length).toBe(2)
  })
})
