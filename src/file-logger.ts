/**
 * JSONL structured file logger with size-based rotation. v0.13.0 upgrade
 * of the original text-based logger.
 *
 * Output format: one JSON object per line, with fields:
 *   { timestamp, level, event, message, sessionID?, data? }
 *
 * Rotation: when the active log file exceeds MAX_FILE_SIZE_BYTES (10MB),
 * the current file is renamed to .1, .1 to .2, etc. Files past MAX_ROTATED_FILES
 * are deleted. Atomic on POSIX (rename is atomic for same-filesystem moves).
 *
 * Backwards compatibility: the existing `logToFile(level, message, data?)`
 * API is preserved with 14 existing call sites. New code can use
 * `logStructured({ level, event, message, ... })` for structured fields.
 */

import {
  appendFileSync,
  mkdirSync,
  statSync,
  renameSync,
  existsSync,
  unlinkSync,
} from "node:fs"
import { resolve, dirname } from "node:path"
import { homedir } from "node:os"

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const LOG_PATH = resolve(homedir(), ".config", "opencode", "meta-governor.log")
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024 // 10MB
const MAX_ROTATED_FILES = 5

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LogLevel = "info" | "warn" | "error"

export interface LogEntry {
  /** ISO 8601 timestamp. Auto-filled if omitted. */
  timestamp?: string
  level: LogLevel
  /** Optional structured event name (e.g. "plugin_loaded", "intervention_delivered"). */
  event?: string
  message: string
  /** Optional sessionID for correlation across logs. */
  sessionID?: string
  /** Optional structured data (JSON-serializable). */
  data?: unknown
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureLogDir(): void {
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true })
  } catch {
    // best-effort
  }
}

function rotateIfNeeded(): void {
  if (!existsSync(LOG_PATH)) return
  try {
    const stat = statSync(LOG_PATH)
    if (stat.size < MAX_FILE_SIZE_BYTES) return
  } catch {
    return
  }

  // Shift .4 → .5, .3 → .4, ..., .1 → .2 (oldest deleted)
  for (let i = MAX_ROTATED_FILES; i >= 1; i--) {
    const prev = i === 1 ? LOG_PATH : `${LOG_PATH}.${i - 1}`
    const next = `${LOG_PATH}.${i}`
    if (existsSync(prev)) {
      try {
        if (i === MAX_ROTATED_FILES) {
          unlinkSync(prev)
        } else {
          renameSync(prev, next)
        }
      } catch {
        // best-effort
      }
    }
  }
}

function emit(level: LogLevel, message: string, data?: unknown, event?: string, sessionID?: string): void {
  ensureLogDir()
  rotateIfNeeded()
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...(event ? { event } : {}),
    ...(sessionID ? { sessionID } : {}),
    ...(data !== undefined ? { data } : {}),
  }
  let line: string
  try {
    line = JSON.stringify(entry) + "\n"
  } catch {
    // Circular references in data — fall back to minimal entry
    line = JSON.stringify({ timestamp: entry.timestamp, level, message, data: "[unserializable]" }) + "\n"
  }
  try {
    appendFileSync(LOG_PATH, line)
  } catch {
    // best-effort
  }
  // Mirror to console for journald
  if (level === "error") {
    console.error(`[meta-governor] ${message}`)
  } else if (level === "warn") {
    console.warn(`[meta-governor] ${message}`)
  } else {
    console.log(`[meta-governor] ${message}`)
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Legacy API — preserves the signature of the pre-0.13.0 logger so all 14
 * existing call sites in src/plugin.ts continue to work unchanged.
 */
export function logToFile(level: "info" | "warn" | "error", message: string, data?: unknown): void {
  emit(level, message, data)
}

/**
 * Structured API for new code. Adds `event` and `sessionID` fields.
 */
export function logStructured(entry: LogEntry): void {
  emit(entry.level, entry.message, entry.data, entry.event, entry.sessionID)
}

/**
 * Returns the current log file size in bytes (for health monitoring).
 */
export function getLogFileSize(): number {
  try {
    if (existsSync(LOG_PATH)) return statSync(LOG_PATH).size
  } catch {
    // ignore
  }
  return 0
}

/**
 * Returns the number of rotated log files (e.g. 0-5).
 */
export function getRotatedLogCount(): number {
  let count = 0
  for (let i = 1; i <= MAX_ROTATED_FILES; i++) {
    if (existsSync(`${LOG_PATH}.${i}`)) count = i
    else break
  }
  return count
}

export { LOG_PATH }
