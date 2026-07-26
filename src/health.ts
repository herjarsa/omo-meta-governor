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
