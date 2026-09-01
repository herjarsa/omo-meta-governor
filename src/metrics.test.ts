/**
 * Tests for MetricsCollector — counters, per-session isolation, snapshot.
 */
import { describe, expect, test } from "bun:test"
import { createMetricsCollector, type MetricEvent } from "./metrics"

describe("createMetricsCollector", () => {
  describe("counters", () => {
    test("incrementing an unknown counter leaves initialized counters at 0", () => {
      const m = createMetricsCollector({ sessionID: "sess" })
      // @ts-expect-error intentionally invalid event name
      m.inc("not_a_real_event")
      const snap = m.getMetrics()
      // Unknown event must not increment anything; initialized counters stay at 0
      expect(snap.counters.decisions_taken?.count ?? 0).toBe(0)
      expect(snap.counters.interventions_delivered?.count ?? 0).toBe(0)
    })

    test("all 26 MetricEvent types can be incremented", () => {
      const m = createMetricsCollector({ sessionID: "sess" })
      const events: MetricEvent[] = [
        "decisions_taken",
        "decisions_skipped_continue",
        "decisions_skipped_no_decision",
        "decisions_skipped_no_message",
        "decisions_skipped_below_threshold",
        "interventions_delivered",
        "interventions_disabled_done",
        "interventions_disabled_cap",
        "decisions_stored",
        "plan_reminders_injected",
        "bot_feedback_injected",
        "violations_injected",
        "protocol_audits_passed",
        "protocol_violations_detected",
        "git_commit_reindex",
        "orchestrator_runs",
        "orchestrator_errors",
        // v0.35.0 (skills-resolution): new counters from 3-tier resolver
        "tier3_reminders_sent",
        "tier3_skills_created",
        "materialization_failures",
        // v0.39.6: hook observation counter
        "tool_calls_observed",
        // v0.41.0: governance counters
        "governance_blocks",
        "governance_asks",
        "governance_tools_hidden",
        "governance_tools_rewritten",
        "governance_commands_blocked",
      ]
      for (const e of events) m.inc(e)
      const snap = m.getMetrics()
      for (const e of events) {
        expect(snap.counters[e]?.count).toBe(1)
      }
      expect(Object.keys(snap.counters).length).toBe(events.length)
    })

    test("lastOccurrenceISO is set and ISO 8601 formatted", () => {
      const m = createMetricsCollector({ sessionID: "sess" })
      m.inc("decisions_taken")
      const snap = m.getMetrics()
      expect(snap.counters.decisions_taken?.lastOccurrenceISO).toMatch(
        /^\d{4}-\d{2}-\d{2}T/,
      )
    })
  })

  describe("per-session tracking", () => {
    test("two collectors track independently", () => {
      const m1 = createMetricsCollector({ sessionID: "sess-1" })
      const m2 = createMetricsCollector({ sessionID: "sess-2" })
      m1.inc("decisions_taken")
      m1.inc("decisions_taken")
      m2.inc("decisions_taken")
      expect(m1.getMetrics().counters.decisions_taken?.count).toBe(2)
      expect(m2.getMetrics().counters.decisions_taken?.count).toBe(1)
    })
  })
})