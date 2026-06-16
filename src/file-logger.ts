import { appendFileSync, mkdirSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { homedir } from "node:os"

/**
 * Persistent file-based logger so the user can tail the plugin's activity.
 * Logs to ~/.config/opencode/meta-governor.log with rotation hints.
 */
const LOG_PATH = resolve(homedir(), ".config", "opencode", "meta-governor.log")

function ensureLogDir(): void {
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true })
  } catch {
    // ignore
  }
}

export function logToFile(level: "info" | "warn" | "error", message: string, data?: unknown): void {
  ensureLogDir()
  const ts = new Date().toISOString()
  const dataStr = data !== undefined ? ` | ${JSON.stringify(data)}` : ""
  const line = `[${ts}] [${level.toUpperCase()}] ${message}${dataStr}\n`
  try {
    appendFileSync(LOG_PATH, line)
  } catch {
    // ignore
  }
  // Also emit to console so journald captures it
  if (level === "error") {
    console.error(`[meta-governor] ${message}`)
  } else if (level === "warn") {
    console.warn(`[meta-governor] ${message}`)
  } else {
    console.log(`[meta-governor] ${message}`)
  }
}
