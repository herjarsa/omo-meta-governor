/**
 * In-memory metrics collector — runtime counters for the v0.13.0 visible
 * value layer. Tracks decision injection events, orchestrator runs, protocol
 * audits, and intervention delivery.
 *
 * The plugin writes the snapshot to ~/.config/opencode/meta-governor-health.json
 * on every increment (debounced), so users can `cat` the file to see
 * exactly what the plugin is doing. This closes the C3/C4 invisibility gap.
 *
 * Design:
 * - Per-session collector + global aggregator
 * - 17 typed MetricEvent union (compile-time safe — typos are compile errors)
 * - All counters initialized to 0 on creation
 * - reset() for tests
 * - Pure functions; no I/O; the file write happens in health.ts
 */

// v0.16.0: F2.4 — derive plugin version from package.json instead of
// hardcoded literal. The build copies package.json next to dist/ via
// the bundler (see build.ts). When running from source, we fall back
// to a default.
let _pluginVersion = "0.0.0"
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  _pluginVersion = require("../package.json").version as string
} catch { /* package.json not available at runtime; fall back to literal below */ }
export const DEFAULT_VERSION = _pluginVersion

export type MetricEvent =
  | "decisions_taken"
  | "decisions_skipped_continue"
  | "decisions_skipped_no_decision"
  | "decisions_skipped_no_message"
  | "decisions_skipped_below_threshold"
  | "interventions_delivered"
  | "interventions_disabled_done"
  | "interventions_disabled_cap"
  | "decisions_stored"
  | "plan_reminders_injected"
  | "bot_feedback_injected"
  | "violations_injected"
  | "protocol_audits_passed"
  | "protocol_violations_detected"
  | "git_commit_reindex"
  | "orchestrator_runs"
  | "orchestrator_errors"

export interface MetricBucket {
  count: number
  lastOccurrenceISO: string | null
}

export interface MetricsSnapshot {
  version: string
  sessionID: string
  startedAtISO: string
  uptimeMs: number
  counters: Record<MetricEvent, MetricBucket>
}

export interface MetricsCollectorConfig {
  sessionID: string
  /** When true, counters are registered with a global aggregator. Default: false. */
  global?: boolean
  /** Optional version string. Default: derived from package.json. */
  version?: string
}

const ALL_EVENTS: readonly MetricEvent[] = [
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
] as const

function emptyCounters(): Record<MetricEvent, MetricBucket> {
  const out = {} as Record<MetricEvent, MetricBucket>
  for (const e of ALL_EVENTS) {
    out[e] = { count: 0, lastOccurrenceISO: null }
  }
  return out
}

// ---------------------------------------------------------------------------
// Global aggregator (optional)
// ---------------------------------------------------------------------------

const globalCounters: Record<MetricEvent, MetricBucket> = emptyCounters()
let globalStartedAtISO: string = new Date().toISOString()

/** Returns the global aggregate snapshot (across all sessions). */
export function getGlobalMetrics(): MetricsSnapshot {
  return {
    version: DEFAULT_VERSION,
    sessionID: "__global__",
    startedAtISO: globalStartedAtISO,
    uptimeMs: Date.now() - new Date(globalStartedAtISO).getTime(),
    counters: { ...globalCounters },
  }
}

/** Reset the global aggregator (test-only). */
export function resetGlobalMetrics(): void {
  for (const e of ALL_EVENTS) {
    globalCounters[e] = { count: 0, lastOccurrenceISO: null }
  }
  globalStartedAtISO = new Date().toISOString()
}

// ---------------------------------------------------------------------------
// Per-session collector
// ---------------------------------------------------------------------------

export type MetricsCollector = {
  inc(event: MetricEvent): void
  getMetrics(): MetricsSnapshot
  reset(): void
}

export function createMetricsCollector(config: MetricsCollectorConfig): MetricsCollector {
  const counters: Record<MetricEvent, MetricBucket> = emptyCounters()
  const startedAtISO = new Date().toISOString()
  const version = config.version ?? DEFAULT_VERSION
  const useGlobal = config.global === true

  return {
    inc(event: MetricEvent): void {
      const bucket = counters[event]
      bucket.count++
      bucket.lastOccurrenceISO = new Date().toISOString()
      if (useGlobal) {
        const g = globalCounters[event]
        g.count++
        g.lastOccurrenceISO = bucket.lastOccurrenceISO
      }
    },
    getMetrics(): MetricsSnapshot {
      return {
        version,
        sessionID: config.sessionID,
        startedAtISO,
        uptimeMs: Date.now() - new Date(startedAtISO).getTime(),
        counters: { ...counters },
      }
    },
    reset(): void {
      for (const e of ALL_EVENTS) {
        counters[e] = { count: 0, lastOccurrenceISO: null }
      }
    },
  }
}
