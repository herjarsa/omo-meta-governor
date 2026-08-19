/**
 * cli-anything.ts — pure CLI wrappers for the CLI-Anything ecosystem.
 *
 * Two surfaces:
 * 1. `cli-hub` (the registry/installer from cli-anything-hub)
 * 2. `npx skills` (Vercel Labs' skill installer)
 *
 * Each function is a pure wrapper: takes a `runner` DI seam + timeout,
 * returns a structured result. NEVER throws. All errors are caught and
 * returned as null / failure codes (mirrors graph-sync.ts v0.26.0 pattern).
 */
import { execSync } from "node:child_process"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CliAnythingConfig {
  /** Path to `cli-hub` binary. Default: lookup in PATH. */
  cliHubBin?: string
  /** Path to `pip` binary. Default: auto-probe pip → pip3 → python -m pip → uv. */
  pipBin?: string
  /** Path to `npx skills` invocation. Default: `npx skills`. */
  skillsBin?: string
  /** Default timeoutMs for each subprocess. Default: 60_000. */
  installTimeoutMs?: number
  /** Default timeoutMs for version probes. Default: 10_000. */
  probeTimeoutMs?: number
}

export interface CliAnythingResult<T = unknown> {
  /** True if the operation succeeded. */
  ok: boolean
  /** Parsed payload (when JSON output was requested and the call succeeded). */
  data: T | null
  /** Raw stdout (when JSON was not requested). */
  rawOutput: string | null
  /** Truncated stderr (always populated, even on success, for diagnostics). */
  stderr: string
  /** Wall-clock duration in ms. */
  durationMs: number
  /** Diagnostic code (matches CliAnythingCode union). */
  code: CliAnythingCode
}

export type CliAnythingCode =
  | "cli-anything-install-succeeded"
  | "cli-anything-install-failed"
  | "cli-anything-already-installed"
  | "cli-anything-upgrade-succeeded"
  | "cli-anything-upgrade-failed"
  | "cli-anything-upgrade-skipped"
  | "cli-hub-version-probed"
  | "cli-hub-version-probe-failed"
  | "cli-hub-list-succeeded"
  | "cli-hub-list-failed"
  | "cli-hub-search-succeeded"
  | "cli-hub-search-failed"
  | "cli-hub-info-succeeded"
  | "cli-hub-info-failed"
  | "cli-hub-install-succeeded"
  | "cli-hub-install-failed"
  | "skill-install-succeeded"
  | "skill-install-failed"
  | "skill-upgrade-succeeded"
  | "skill-upgrade-failed"
  | "skill-already-current"

export interface CliHubListEntry {
  name: string
  display_name: string
  version: string
  description: string
  requires: string | null
  homepage: string | null
  install_cmd: string | null
  entry_point: string | null
  category: string
  _source: "harness" | "public" | "npm"
}

export type Runner = (cmd: string, opts?: { timeoutMs?: number }) => string

// ---------------------------------------------------------------------------
// Default runner (real subprocess). Tests inject a fake.
// ---------------------------------------------------------------------------

const defaultRunner: Runner = (cmd, opts) => {
  const result = execSync(cmd, {
    timeout: opts?.timeoutMs ?? 10_000,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })
  return result.toString()
}

// ---------------------------------------------------------------------------
// Internal: safe runner that catches spawn errors
// ---------------------------------------------------------------------------

interface RunResult {
  ok: boolean
  stdout: string
  stderr: string
  timedOut: boolean
}

function safeRun(
  cmd: string,
  runner: Runner,
  timeoutMs: number,
): RunResult {
  try {
    const out = runner(cmd, { timeoutMs })
    return { ok: true, stdout: out, stderr: "", timedOut: false }
  } catch (err) {
    const e = err as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string }
    const stdout = typeof e.stdout === "string"
      ? e.stdout
      : e.stdout instanceof Buffer
        ? e.stdout.toString("utf8")
        : ""
    const stderr = typeof e.stderr === "string"
      ? e.stderr
      : e.stderr instanceof Buffer
        ? e.stderr.toString("utf8")
        : (e.message ?? "")
    const timedOut = /timed out|ETIMEDOUT|timeout/i.test(stderr)
    return { ok: false, stdout, stderr, timedOut }
  }
}

// ---------------------------------------------------------------------------
// cli-anything-hub version probes
// ---------------------------------------------------------------------------

/**
 * Get the installed cli-anything-hub version.
 * Returns null when not installed.
 */
export function getInstalledCliHubVersion(
  runner: Runner = defaultRunner,
): string | null {
  // Tier 1: `pip show cli-anything-hub`
  let res = safeRun("pip show cli-anything-hub", runner, 10_000)
  if (!res.ok) {
    // Tier 2: `pip3 show cli-anything-hub`
    res = safeRun("pip3 show cli-anything-hub", runner, 10_000)
  }
  if (!res.ok) {
    // Tier 3: `python -m pip show cli-anything-hub`
    res = safeRun("python -m pip show cli-anything-hub", runner, 10_000)
  }
  if (!res.ok) return null
  // Parse `Version: 0.4.1`
  const match = res.stdout.match(/^Version:\s*([\d.]+[^\s]*)/m)
  return match ? match[1].trim() : null
}

/**
 * Fetch the latest cli-anything-hub version from PyPI.
 * Returns null on any failure.
 */
export function fetchCliHubLatestVersion(
  runner: Runner = defaultRunner,
): string | null {
  // pip index versions is non-interactive and returns just the version.
  let res = safeRun("pip index versions cli-anything-hub", runner, 10_000)
  if (!res.ok) {
    res = safeRun("pip3 index versions cli-anything-hub", runner, 10_000)
  }
  if (!res.ok) {
    res = safeRun("python -m pip index versions cli-anything-hub", runner, 10_000)
  }
  if (!res.ok) return null
  // Parse `cli-anything-hub (0.4.1)` or `cli-anything-hub (0.4.1, ...)`
  const match = res.stdout.match(/^\S+\s+\(([\d.]+[^\s,)]*)/m)
  return match ? match[1].trim() : null
}

/**
 * Compare two semver strings. Returns -1 / 0 / 1.
 * Treats "latest" / empty as newer than anything (defensive).
 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  if (a === b) return 0
  if (!a) return -1
  if (!b) return 1
  const pa = a.split(/[.+-]/).map((s) => Number.parseInt(s, 10) || 0)
  const pb = b.split(/[.+-]/).map((s) => Number.parseInt(s, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x < y) return -1
    if (x > y) return 1
  }
  return 0
}

// ---------------------------------------------------------------------------
// cli-anything-hub install / upgrade
// ---------------------------------------------------------------------------

/**
 * Install cli-anything-hub. Tries the safer methods first to avoid
 * PEP 668 conflicts:
 *  1. uv tool install (clean isolated env)
 *  2. uv pip install --system (PEP 668-safe with --break-system-packages)
 *  3. pip install --user (older fallback, no system pollution)
 *  4. pip install (last resort; uses --break-system-packages on PEP 668 systems)
 */
export function installCliHub(
  runner: Runner = defaultRunner,
  timeoutMs = 60_000,
): CliAnythingResult {
  const start = Date.now()
  const attempts = [
    // 1. uv tool install — clean isolated environment, no PEP 668 conflict
    "uv tool install cli-anything-hub",
    // 2. uv pip install --system — PEP 668-safe with --break-system-packages
    "uv pip install --system --break-system-packages cli-anything-hub",
    // 3. pip install --user — older fallback, avoids system pollution
    "pip install --user cli-anything-hub",
    // 4. pip install — last resort
    "pip install cli-anything-hub",
  ]
  let lastStderr = ""
  for (const cmd of attempts) {
    const res = safeRun(cmd, runner, timeoutMs)
    if (res.ok) {
      return {
        ok: true,
        data: null,
        rawOutput: res.stdout,
        stderr: res.stderr,
        durationMs: Date.now() - start,
        code: "cli-anything-install-succeeded",
      }
    }
    lastStderr = res.stderr
  }
  return {
    ok: false,
    data: null,
    rawOutput: null,
    stderr: lastStderr.slice(0, 500),
    durationMs: Date.now() - start,
    code: "cli-anything-install-failed",
  }
}

/**
 * Upgrade cli-anything-hub. Same tier order as installCliHub.
 */
export function upgradeCliHub(
  runner: Runner = defaultRunner,
  timeoutMs = 60_000,
): CliAnythingResult {
  const start = Date.now()
  const attempts = [
    "uv tool upgrade cli-anything-hub",
    "uv tool install --upgrade cli-anything-hub",
    "uv pip install --system --upgrade --break-system-packages cli-anything-hub",
    "pip install --user --upgrade cli-anything-hub",
    "pip install --upgrade cli-anything-hub",
  ]
  let lastStderr = ""
  for (const cmd of attempts) {
    const res = safeRun(cmd, runner, timeoutMs)
    if (res.ok) {
      return {
        ok: true,
        data: null,
        rawOutput: res.stdout,
        stderr: res.stderr,
        durationMs: Date.now() - start,
        code: "cli-anything-upgrade-succeeded",
      }
    }
    lastStderr = res.stderr
  }
  return {
    ok: false,
    data: null,
    rawOutput: null,
    stderr: lastStderr.slice(0, 500),
    durationMs: Date.now() - start,
    code: "cli-anything-upgrade-failed",
  }
}

// ---------------------------------------------------------------------------
// cli-hub sub-commands (list / search / info / install)
// ---------------------------------------------------------------------------

export interface ListOptions {
  category?: string
  source?: "harness" | "public" | "npm" | "all"
}

/**
 * List all available CLIs from the CLI-Anything hub registry.
 */
export function listClis(
  options: ListOptions = {},
  runner: Runner = defaultRunner,
  timeoutMs = 30_000,
  cliHubBin = "cli-hub",
): CliAnythingResult<CliHubListEntry[]> {
  const start = Date.now()
  const args = ["list", "--json"]
  if (options.category) args.push("--category", options.category)
  if (options.source) args.push("--source", options.source)
  const res = safeRun(`${cliHubBin} ${args.join(" ")}`, runner, timeoutMs)
  if (!res.ok) {
    return {
      ok: false,
      data: null,
      rawOutput: res.stdout,
      stderr: res.stderr.slice(0, 500),
      durationMs: Date.now() - start,
      code: "cli-hub-list-failed",
    }
  }
  try {
    const parsed = JSON.parse(res.stdout) as CliHubListEntry[]
    return {
      ok: true,
      data: parsed,
      rawOutput: null,
      stderr: res.stderr,
      durationMs: Date.now() - start,
      code: "cli-hub-list-succeeded",
    }
  } catch {
    return {
      ok: false,
      data: null,
      rawOutput: res.stdout,
      stderr: "Failed to parse cli-hub list JSON output",
      durationMs: Date.now() - start,
      code: "cli-hub-list-failed",
    }
  }
}

/**
 * Search CLIs by query string.
 */
export function searchClis(
  query: string,
  runner: Runner = defaultRunner,
  timeoutMs = 30_000,
  cliHubBin = "cli-hub",
): CliAnythingResult<CliHubListEntry[]> {
  const start = Date.now()
  if (!query.trim()) {
    return {
      ok: false,
      data: null,
      rawOutput: null,
      stderr: "empty query",
      durationMs: 0,
      code: "cli-hub-search-failed",
    }
  }
  const res = safeRun(`${cliHubBin} search "${query}" --json`, runner, timeoutMs)
  if (!res.ok) {
    return {
      ok: false,
      data: null,
      rawOutput: res.stdout,
      stderr: res.stderr.slice(0, 500),
      durationMs: Date.now() - start,
      code: "cli-hub-search-failed",
    }
  }
  try {
    const parsed = JSON.parse(res.stdout) as CliHubListEntry[]
    return {
      ok: true,
      data: parsed,
      rawOutput: null,
      stderr: res.stderr,
      durationMs: Date.now() - start,
      code: "cli-hub-search-succeeded",
    }
  } catch {
    return {
      ok: false,
      data: null,
      rawOutput: res.stdout,
      stderr: "Failed to parse cli-hub search JSON output",
      durationMs: Date.now() - start,
      code: "cli-hub-search-failed",
    }
  }
}

/**
 * Show details for a specific CLI by name.
 */
export function infoCli(
  name: string,
  runner: Runner = defaultRunner,
  timeoutMs = 10_000,
  cliHubBin = "cli-hub",
): CliAnythingResult<string> {
  const start = Date.now()
  const res = safeRun(`${cliHubBin} info "${name}"`, runner, timeoutMs)
  if (!res.ok) {
    return {
      ok: false,
      data: null,
      rawOutput: res.stdout,
      stderr: res.stderr.slice(0, 500),
      durationMs: Date.now() - start,
      code: "cli-hub-info-failed",
    }
  }
  return {
    ok: true,
    data: res.stdout,
    rawOutput: null,
    stderr: res.stderr,
    durationMs: Date.now() - start,
    code: "cli-hub-info-succeeded",
  }
}

/**
 * Install a specific CLI by name (e.g. "gimp").
 */
export function installCli(
  name: string,
  runner: Runner = defaultRunner,
  timeoutMs = 120_000,
  cliHubBin = "cli-hub",
): CliAnythingResult {
  const start = Date.now()
  const res = safeRun(`${cliHubBin} install "${name}"`, runner, timeoutMs)
  if (!res.ok) {
    return {
      ok: false,
      data: null,
      rawOutput: res.stdout,
      stderr: res.stderr.slice(0, 500),
      durationMs: Date.now() - start,
      code: "cli-hub-install-failed",
    }
  }
  return {
    ok: true,
    data: null,
    rawOutput: res.stdout,
    stderr: res.stderr,
    durationMs: Date.now() - start,
    code: "cli-hub-install-succeeded",
  }
}

// ---------------------------------------------------------------------------
// Vercel Labs `npx skills` — meta-skill installer
// ---------------------------------------------------------------------------

/**
 * Install the cli-hub-meta-skill via `npx skills add HKUDS/CLI-Anything --skill cli-hub-meta-skill`.
 * scope: 'global' (default) installs to ~/.claude/skills/, 'project' to ./.claude/skills/.
 */
export function installCliHubMetaSkill(
  scope: "global" | "project" = "global",
  runner: Runner = defaultRunner,
  timeoutMs = 60_000,
  skillsBin = "npx skills",
): CliAnythingResult {
  const start = Date.now()
  const scopeFlag = scope === "global" ? "-g" : "-p"
  const cmd = `${skillsBin} add HKUDS/CLI-Anything --skill cli-hub-meta-skill ${scopeFlag} -y`
  const res = safeRun(cmd, runner, timeoutMs)
  if (!res.ok) {
    return {
      ok: false,
      data: null,
      rawOutput: res.stdout,
      stderr: res.stderr.slice(0, 500),
      durationMs: Date.now() - start,
      code: "skill-install-failed",
    }
  }
  return {
    ok: true,
    data: null,
    rawOutput: res.stdout,
    stderr: res.stderr,
    durationMs: Date.now() - start,
    code: "skill-install-succeeded",
  }
}

/**
 * Upgrade the cli-hub-meta-skill via `npx skills update`.
 */
export function upgradeCliHubMetaSkill(
  scope: "global" | "project" = "global",
  runner: Runner = defaultRunner,
  timeoutMs = 60_000,
  skillsBin = "npx skills",
): CliAnythingResult {
  const start = Date.now()
  const scopeFlag = scope === "global" ? "-g" : "-p"
  const cmd = `${skillsBin} update cli-hub-meta-skill ${scopeFlag} -y`
  const res = safeRun(cmd, runner, timeoutMs)
  if (!res.ok) {
    return {
      ok: false,
      data: null,
      rawOutput: res.stdout,
      stderr: res.stderr.slice(0, 500),
      durationMs: Date.now() - start,
      code: "skill-upgrade-failed",
    }
  }
  return {
    ok: true,
    data: null,
    rawOutput: res.stdout,
    stderr: res.stderr,
    durationMs: Date.now() - start,
    code: "skill-upgrade-succeeded",
  }
}

/**
 * Check whether cli-hub-meta-skill is installed by parsing `npx skills list --global`.
 */
export function isCliHubMetaSkillInstalled(
  scope: "global" | "project" = "global",
  runner: Runner = defaultRunner,
  timeoutMs = 10_000,
  skillsBin = "npx skills",
): boolean {
  const scopeFlag = scope === "global" ? "-g" : "-p"
  const res = safeRun(`${skillsBin} list ${scopeFlag}`, runner, timeoutMs)
  if (!res.ok) return false
  return /cli-hub-meta-skill/i.test(res.stdout)
}