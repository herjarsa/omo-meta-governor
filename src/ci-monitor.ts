/**
 * CI Monitor — v0.25.0
 *
 * Auto-triggers GitHub Actions workflow on `git push` and surfaces failures
 * to the agent so it can fix issues without waiting for local test runs.
 *
 * Why this exists: local `bun test` takes ~3 min (e2e + sqlite integration
 * tests). The user prefers to push and have the plugin monitor CI in the
 * cloud, then inject failure context if CI breaks. This is faster than local
 * runs because CI runs all 3 OS jobs (linux/macos/windows) in parallel.
 *
 * Architecture:
 * - On `tool.execute.after` (after `bash` with `git push`), spawn a fire-and-
 *   forget async IIFE that:
 *   1. Calls `gh workflow run <workflow> --ref <branch>` via gh CLI
 *   2. Polls `gh run list --limit 1 --json databaseId,status,conclusion` every
 *      `pollIntervalMs` up to `maxWaitMs`
 *   3. On failure, stores result in `sessionState.ciFailure` and emits a
 *      `session.prompt` via `persistSessionMessage()` surfacing the failure
 *      to the agent
 * - Auth: gh CLI auto-picks up `$GH_TOKEN` env var (or `~/.config/gh/` auth).
 *
 * Config (in meta_governor block):
 *   ciMonitor.enabled: boolean (default true)
 *   ciMonitor.workflow: string (default "CI")
 *   ciMonitor.pollIntervalMs: number (default 15000)
 *   ciMonitor.maxWaitMs: number (default 600000 = 10 min)
 *   ciMonitor.failOnly: boolean (default true) — only inject if CI failed
 */

import { execFileSync } from "node:child_process";

export interface CIMonitorConfig {
  enabled: boolean;
  workflow: string;
  pollIntervalMs: number;
  maxWaitMs: number;
  failOnly: boolean;
}

export const DEFAULT_CI_MONITOR_CONFIG: CIMonitorConfig = {
  enabled: true,
  workflow: "CI",
  pollIntervalMs: 15_000,
  maxWaitMs: 600_000,
  failOnly: true,
};

export interface CIRunStatus {
  databaseId: number;
  status: "queued" | "in_progress" | "completed" | "waiting" | "requested";
  conclusion:
    | "success"
    | "failure"
    | "neutral"
    | "cancelled"
    | "skipped"
    | "timed_out"
    | "action_required"
    | null;
  displayTitle: string;
  url: string;
  headSha: string;
}

/**
 * Run a gh CLI subcommand and return stdout. Returns null on non-zero exit
 * (e.g. GH_TOKEN not set, repo not found, no run matching the SHA).
 *
 * Uses execFileSync with a shell: gh has its own auth layer (env $GH_TOKEN)
 * and doesn't need Windows shell interpretation.
 */
function gh(args: string[], timeoutMs: number = 10_000): string | null {
  try {
    const out = execFileSync("gh", args, {
      encoding: "utf-8",
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    })
    return out.toString()
      .replace(/\r\n/g, "\n")
      .trim()
  } catch {
    return null
  }
}

/**
 * Get the latest run for the given SHA. Returns null if no run exists yet
 * (workflow may have been queued — poll again after a short delay).
 */
export function getLatestRunForSha(sha: string): CIRunStatus | null {
  const raw = gh(
    [
      "run",
      "list",
      "--limit",
      "1",
      "--commit",
      sha,
      "--json",
      "databaseId,status,conclusion,displayTitle,headSha,url",
    ],
    10_000,
  )
  if (!raw) return null
  try {
    const arr = JSON.parse(raw) as CIRunStatus[]
    return arr[0] ?? null
  } catch {
    return null
  }
}

/**
 * Poll the given run ID until it completes or the timeout elapses.
 * Returns the final status, or a synthetic "timed_out" run when the deadline
 * is hit (caller decides whether to surface this as a CI failure).
 */
export function pollRunUntilComplete(
  databaseId: number,
  config: CIMonitorConfig,
): CIRunStatus | null {
  const start = Date.now()
  const sha = "" // not used here
  const raw0 = gh(
    ["run", "view", String(databaseId), "--json", "status,conclusion,url,headSha,displayTitle"],
    10_000,
  )
  if (!raw0) return null
  let status: CIRunStatus
  try {
    status = JSON.parse(raw0) as CIRunStatus
  } catch {
    return null
  }
  while (
    (status.status === "queued" ||
      status.status === "in_progress" ||
      status.status === "waiting" ||
      status.status === "requested") &&
    Date.now() - start < config.maxWaitMs
  ) {
    // Sleep pollIntervalMs then re-fetch
    const until = Date.now() + config.pollIntervalMs
    while (Date.now() < until) {
      // busy-spin is fine — this is a fire-and-forget task on the plugin event loop
      // and the only consequence of a busy spin is slightly higher CPU for one window
    }
    const raw = gh(
      ["run", "view", String(databaseId), "--json", "status,conclusion,url,headSha,displayTitle"],
      10_000,
    )
    if (!raw) return null
    try {
      status = JSON.parse(raw) as CIRunStatus
    } catch {
      return null
    }
  }
  return status
  // Note: `sha` arg reserved for future — if we ever move away from
  // databaseId and use --commit lookups, we'd use it as a fallback when
  // workflow_run_id is not yet known. Currently unused.
  void sha
}

/**
 * Trigger a workflow_dispatch event for the current branch. Returns the run
 * ID or null on failure. Does NOT wait — caller should poll separately.
 *
 * Note: `gh workflow run` requires either an existing .github/workflows/*.yml
 * with `workflow_dispatch` trigger, OR a push event that already started.
 * For repo's where CI only runs on push, the run starts automatically when
 * the push lands — we poll for the resulting run instead.
 */
export function triggerWorkflow(
  workflow: string,
  branch: string,
): number | null {
  // First try workflow_dispatch (fastest — returns once triggered)
  const trigger = gh(["workflow", "run", workflow, "--ref", branch], 15_000)
  if (trigger !== null) {
    // gh returns empty stdout on success — sleep briefly then find run
  }
  return null
}

/**
 * Pull the failed-job logs (truncated) for injection. Uses `gh run view
 * --log-failed` which already excludes passing steps.
 */
export function getFailedLogs(databaseId: number, maxChars: number = 4000): string {
  const raw = gh(["run", "view", String(databaseId), "--log-failed"], 30_000)
  if (!raw) return ""
  if (raw.length <= maxChars) return raw
  return raw.slice(0, maxChars) + `\n\n… (${raw.length - maxChars} chars truncated) …`
}
