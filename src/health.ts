/**
 * Plugin health state — observable proof that omo-meta-governor is doing work.
 * Closes the C3/C4 invisibility gap: the user can `cat` the health JSON to
 * see exactly what the plugin is doing, instead of wondering "is this thing
 * alive?".
 *
 * Design:
 * - Atomic writes (write to .tmp, then rename) — never produces partial reads
 * - Pure functions: writeHealthToFile() and readHealthFromFile() take an
 *   explicit path so they're testable without environment setup
 * - Returns null on missing/malformed file (not throwing) — the health file
 *   is observability, not a control plane; failure is non-fatal
 */

import { renameSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs"
import { dirname } from "node:path"
import { mkdirSync } from "node:fs"

export interface PluginHealth {
  version: string
  status: "healthy" | "degraded" | "error"
  enabled: boolean
  startedAtISO: string
  uptimeMs: number
  metrics: {
    decisionsTaken: number
    decisionsStored: number
    interventionsDelivered: number
    orchestratorRuns: number
    orchestratorErrors: number
    /** v0.35.0 (Tier 2 materialization): count of materializeSkill() calls
     *  that returned reason='denied' (filesystem write failure). */
    materializationFailures: number
    /** v0.35.0 (Tier 3 advisory): count of writing-skills reminders emitted
     *  on zero-result queries. Rate-limited to 1 per query, 3 per session. */
    tier3RemindersSent: number
    /** v0.35.0 (Tier 3 watcher): count of new SKILL.md files detected under
     *  cwd/.agents/skills/. Increments per create/write event from chokidar. */
    tier3SkillsCreated: number
    lastDecisionISO: string | null
    lastInterventionISO: string | null
  }
  logFile: {
    path: string
    sizeBytes: number
    rotatedFiles: number
  }
  session: {
    id: string
    toolCallsObserved: number
    violationsDetected: number
    interventionsSkipped: number
    firstSeenISO: string
    lastSeenISO: string
  }
  // v0.27.0 Wave 4 — observability for graph sync + tool counters.
  graphSync?: {
    lastUpgradeAtISO: string | null
    lastUpgradeResult: "success" | "failed" | "skipped" | "unknown"
    lastUpgradeTarget: "codegraph" | "graphify" | null
    lastUpgradeMs: number | null
  }
  graphToolsUsed: {
    omo_search: number
    omo_recall: number
    omo_health: number
    omo_find: number
    omo_impact: number
    omo_remember: number
    omo_recall_mcp: number
    omo_path: number
    omo_explain: number
    omo_files: number
    omo_callers: number
    omo_node: number
    omo_context: number
    omo_affected_cg: number
    omo_status: number
    omo_unlock: number
    omo_mark_dirty: number
    omo_sync_if_dirty: number
    omo_index: number
    omo_visualize: number
    omo_serve: number
    omo_uninit: number
    omo_diagnose: number
    omo_merge_graphs: number
    omo_save_result: number
    omo_extract: number
    omo_cluster_only: number
    omo_label: number
    omo_tree: number
    omo_clone: number
    omo_add: number
    omo_check_update: number
    omo_hook_status: number
    // v0.34.2 (P2-5): CLI-Anything hub tools registered in plugin.ts:639-642.
    omo_cli_anything_install: number
    omo_cli_anything_list: number
    omo_cli_anything_search: number
    omo_cli_anything_info: number
  }
}

/**
 * Atomically write the health state to the given path. Writes to a
 * .tmp sibling first, then renames. Creates parent directory if needed.
 */
export function writeHealthToFile(health: PluginHealth, path: string): void {
  const dir = dirname(path)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  const tmpPath = `${path}.tmp`
  writeFileSync(tmpPath, JSON.stringify(health, null, 2), "utf8")
  renameSync(tmpPath, path)
}

/**
 * Read the health state from the given path. Returns null on missing or
 * malformed file. Never throws — the health file is observability, not
 * a control plane.
 */
export function readHealthFromFile(path: string): PluginHealth | null {
  if (!existsSync(path)) return null
  try {
    const stat = statSync(path)
    if (!stat.isFile()) return null
    const text = readFileSync(path, "utf8")
    return JSON.parse(text) as PluginHealth
  } catch {
    return null
  }
}

/**
 * Compute the current log file size and rotated file count. Used to
 * populate the `logFile` field in PluginHealth.
 */
export function describeLogFile(logPath: string): { path: string; sizeBytes: number; rotatedFiles: number } {
  let sizeBytes = 0
  if (existsSync(logPath)) {
    try {
      sizeBytes = statSync(logPath).size
    } catch {
      // ignore
    }
  }
  let rotatedFiles = 0
  for (let i = 1; i <= 10; i++) {
    if (existsSync(`${logPath}.${i}`)) {
      rotatedFiles = i
    } else {
      break
    }
  }
  return { path: logPath, sizeBytes, rotatedFiles }
}

// ---------------------------------------------------------------------------
// v0.31.3 — shared health composer + throttled writer
// ---------------------------------------------------------------------------

/** Structural subset of MetricsCollector.getMetrics() the composer needs. */
export interface MetricsSnapshotLike {
  startedAtISO: string
  uptimeMs: number
  counters: Record<
    string,
    { count?: number; lastOccurrenceISO?: string | null } | undefined
  >
}

export interface BuildPluginHealthInput {
  version: string
  enabled: boolean
  sessionID: string
  snapshot: MetricsSnapshotLike
  logFilePath: string
}

/**
 * Compose a PluginHealth snapshot from a metrics snapshot. Single source
 * of truth for BOTH omo_health and the plugin-side periodic writer, so
 * the on-disk schema can never drift between the two paths.
 */
export function buildPluginHealth(input: BuildPluginHealthInput): PluginHealth {
  const c = input.snapshot.counters
  const orchestratorErrors = c.orchestrator_errors?.count ?? 0
  const interventionsSkipped =
    (c.decisions_skipped_continue?.count ?? 0) +
    (c.decisions_skipped_no_decision?.count ?? 0) +
    (c.decisions_skipped_no_message?.count ?? 0) +
    (c.decisions_skipped_below_threshold?.count ?? 0)
  return {
    version: input.version,
    status: orchestratorErrors ? "degraded" : "healthy",
    enabled: input.enabled,
    startedAtISO: input.snapshot.startedAtISO,
    uptimeMs: input.snapshot.uptimeMs,
    metrics: {
      decisionsTaken: c.decisions_taken?.count ?? 0,
      decisionsStored: c.decisions_stored?.count ?? 0,
      interventionsDelivered: c.interventions_delivered?.count ?? 0,
      orchestratorRuns: c.orchestrator_runs?.count ?? 0,
      orchestratorErrors,
      materializationFailures: c.materialization_failures?.count ?? 0,
      tier3RemindersSent: c.tier3_reminders_sent?.count ?? 0,
      tier3SkillsCreated: c.tier3_skills_created?.count ?? 0,
      lastDecisionISO: c.decisions_taken?.lastOccurrenceISO ?? null,
      lastInterventionISO: c.interventions_delivered?.lastOccurrenceISO ?? null,
    },
    logFile: describeLogFile(input.logFilePath),
session: {
id: input.sessionID,
// v0.39.6: derive from dedicated counter (was aliased to orchestrator_runs,
// which is 0 in production because orchestrator never wired inc()).
toolCallsObserved: c.tool_calls_observed?.count ?? 0,
violationsDetected: c.protocol_violations_detected?.count ?? 0,
interventionsSkipped,
firstSeenISO: input.snapshot.startedAtISO,
lastSeenISO: new Date().toISOString(),
    },
    graphSync: {
      lastUpgradeAtISO: null,
      lastUpgradeResult: "unknown",
      lastUpgradeTarget: null,
      lastUpgradeMs: null,
    },
    graphToolsUsed: {
      omo_search: 0,
      omo_recall: 0,
      omo_health: 0,
      omo_find: 0,
      omo_impact: 0,
      omo_remember: 0,
      omo_recall_mcp: 0,
      omo_path: 0,
      omo_explain: 0,
      omo_files: 0,
      omo_callers: 0,
      omo_node: 0,
      omo_context: 0,
      omo_affected_cg: 0,
      omo_status: 0,
      omo_unlock: 0,
      omo_mark_dirty: 0,
      omo_sync_if_dirty: 0,
      omo_index: 0,
      omo_visualize: 0,
      omo_serve: 0,
      omo_uninit: 0,
      omo_diagnose: 0,
      omo_merge_graphs: 0,
      omo_save_result: 0,
      omo_extract: 0,
      omo_cluster_only: 0,
      omo_label: 0,
      omo_tree: 0,
      omo_clone: 0,
      omo_add: 0,
      omo_check_update: 0,
      omo_hook_status: 0,
      // v0.34.2 (P2-5): CLI-Anything hub tool counters.
      omo_cli_anything_install: 0,
      omo_cli_anything_list: 0,
      omo_cli_anything_search: 0,
      omo_cli_anything_info: 0,
    },
  }
}

/**
 * Rate-limited health writer. The first write always passes through;
 * writes inside `minIntervalMs` of the previous accepted write are
 * dropped, so audit-hook callers can invoke it on every event without
 * hammering the disk.
 */
export function createThrottledHealthWriter(
  write: (health: PluginHealth) => void,
  minIntervalMs: number,
  now: () => number = Date.now,
): { write: (health: PluginHealth) => void } {
  let lastWriteAt = -Infinity
  return {
    write(health: PluginHealth): void {
      const t = now()
      if (t - lastWriteAt < minIntervalMs) return
      lastWriteAt = t
      write(health)
    },
  }
}
