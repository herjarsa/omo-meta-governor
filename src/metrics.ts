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
// v0.26.4: read from the directory of the running bundle at RUNTIME
// (not build-time). The previous `require("../package.json")` got
// statically resolved by the bundler and baked the version string
// into the bundle, so when the user updated npm to v0.26.3 the bundle
// still reported v0.26.2 (the version at compile time). Now we
// resolve the package.json next to the bundle file using
// `import.meta.url`, which always points to the actual loaded file.
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

let _pluginVersion = "0.0.0"
try {
  const bundleDir = dirname(fileURLToPath(import.meta.url))
  // Walk up from dist/index.js to find the package.json. The bundle
  // sits at <pkg-root>/dist/index.js, so package.json is one level up.
  const packageJsonPath = resolve(bundleDir, "..", "package.json")
  const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    version?: string
  }
  if (typeof pkg.version === "string" && pkg.version.length > 0) {
    _pluginVersion = pkg.version
  }
} catch {
  // package.json not available at runtime; fall back to literal below
}
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

export function createMetricsCollector(config?: Partial<MetricsCollectorConfig>): MetricsCollector {
  // v0.18.0: accept optional config — defaults are safe.
  const safeConfig = config ?? {}
  const counters: Record<MetricEvent, MetricBucket> = emptyCounters()
  const startedAtISO = new Date().toISOString()
  const version = safeConfig.version ?? DEFAULT_VERSION
  const useGlobal = safeConfig.global === true

  return {
    inc(event: MetricEvent): void {
      // v0.18.0: guard against unknown event names (was crashing on bucket.count++)
      const bucket = counters[event]
      if (!bucket) return
      bucket.count++
      bucket.lastOccurrenceISO = new Date().toISOString()
      if (useGlobal) {
        const g = globalCounters[event]
        if (g) {
          g.count++
          g.lastOccurrenceISO = bucket.lastOccurrenceISO
        }
      }
    },
    getMetrics(): MetricsSnapshot {
      return {
        version,
        // v0.18.0: sessionID is optional — was crashing when config was undefined
        sessionID: safeConfig.sessionID ?? "",
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
