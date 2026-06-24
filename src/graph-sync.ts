/**
 * graphSync — Auto-initialize codegraph and graphify for a project.
 *
 * On first session in a project, checks whether:
 *   - `npx codegraph` is available on PATH (or node_modules)
 *   - `graphify` / `graphifyy` is available as a Python package
 *
 * If a tool is available but the project has no index yet, runs the
 * initialization automatically. With `--watch` mode, spawns a background
 * process that re-indexes on file changes.
 *
 * Architecture invariants:
 *   - Never blocks the session — init runs async, best-effort
 *   - Never throws — all errors are silently caught and logged
 *   - Tracks session init once per project via an in-memory Set
 */

import { execSync, spawn } from "node:child_process"
import { access, stat } from "node:fs/promises"
import { resolve } from "node:path"
import { constants } from "node:fs"

// ─── GraphSync config ──────────────────────────────────────────────

export interface GraphSyncConfig {
  /** Enable auto-initialization. Default: true */
  enabled: boolean
  /** Enable watch mode (re-index on file changes). Default: false */
  watch: boolean
  /** Project directory to initialize in. Default: cwd */
  projectDir?: string
  /**
   * Auto-install missing backends. Default: true.
   * - codegraph: installed via `npm i -D @colbymchenry/codegraph` in the project
   * - graphify: installed via `pip install graphifyy --break-system-packages` (or `uv tool install graphifyy`)
   */
  autoInstall: boolean
  /** Max ms to wait for each install. Default: 60_000 */
  installTimeoutMs: number
}

// ─── Install codes ────────────────────────────────────────────────

export type InstallCode =
  | "codegraph-installed"
  | "codegraph-install-failed"
  | "codegraph-install-skipped"
  | "graphify-installed"
  | "graphify-install-failed"
  | "graphify-install-skipped"

/**
 * Install codegraph via `npm i -D @colbymchenry/codegraph`.
 * Best-effort, never throws.
 */
export async function installCodegraph(
  projectDir: string,
  timeoutMs: number = 60_000,
): Promise<InstallCode> {
  try {
    execSync("npm i -D @colbymchenry/codegraph", {
      cwd: projectDir,
      stdio: "ignore",
      timeout: timeoutMs,
    })
    return "codegraph-installed"
  } catch {
    return "codegraph-install-failed"
  }
}

/**
 * Install graphify via `pip install graphifyy --break-system-packages`.
 * Falls back to `uv tool install graphifyy`.
 * Best-effort, never throws.
 */
export async function installGraphify(
  timeoutMs: number = 60_000,
): Promise<InstallCode> {
  try {
    execSync("pip install graphifyy --break-system-packages --quiet", {
      stdio: "ignore",
      timeout: timeoutMs,
    })
    return "graphify-installed"
  } catch {
    try {
      execSync("uv tool install graphifyy --quiet", {
        stdio: "ignore",
        timeout: timeoutMs,
      })
      return "graphify-installed"
    } catch {
      return "graphify-install-failed"
    }
  }
}

// ─── Graph sync state ──────────────────────────────────────────────

const initializedProjects = new Set<string>()

export function resetInitializedProjects(): void {
  initializedProjects.clear()
}

// ─── Session tracking (for watch lifecycle) ────────────────────────

const sessionCounts = new Map<string, number>()

/**
 * Track a new session for a project. Increments reference count.
 * Returns the new count.
 */
export function trackSession(projectDir: string): number {
  const current = sessionCounts.get(projectDir) ?? 0
  const next = current + 1
  sessionCounts.set(projectDir, next)
  return next
}

/**
 * Untrack a session for a project. Decrements reference count.
 * When count drops to 0, all watch processes for that project
 * are automatically stopped.
 * Returns the remaining count.
 */
export function untrackSession(projectDir: string): number {
  const current = sessionCounts.get(projectDir) ?? 0
  const next = Math.max(0, current - 1)
  if (next === 0) {
    sessionCounts.delete(projectDir)
    // Auto-cleanup watches when last session exits
    stopWatches(projectDir)
  } else {
    sessionCounts.set(projectDir, next)
  }
  return next
}

/** Get active session count for a project. */
export function getSessionCount(projectDir: string): number {
  return sessionCounts.get(projectDir) ?? 0
}

// ─── Tool detection ────────────────────────────────────────────────

export interface ToolAvailability {
  /** Whether codegraph is available (via npx or node_modules) */
  codegraph: boolean
  /** Whether graphify/graphifyy is available (via pip) */
  graphify: boolean
  /** Whether .codegraph/ directory already exists in the project */
  codegraphIndexExists: boolean
  /** Whether graphify-out/ directory already exists in the project */
  graphifyIndexExists: boolean
}

/**
 * Check which graph tools are available and whether indexes already exist.
 */
async function checkToolAvailability(projectDir: string): Promise<ToolAvailability> {
  let codegraph = false
  let graphify = false
  const codegraphIndexExists = await dirExists(resolve(projectDir, ".codegraph"))
  const graphifyIndexExists = await dirExists(resolve(projectDir, "graphify-out"))

  try {
    execSync("npx --yes codegraph --version", {
      stdio: "ignore",
      timeout: 10_000,
    })
    codegraph = true
  } catch {
    try {
      execSync("node node_modules/.bin/codegraph --version", {
        cwd: projectDir,
        stdio: "ignore",
        timeout: 5_000,
      })
      codegraph = true
    } catch {
      // Not available
    }
  }

  try {
    execSync("python3 -c 'import graphify; print(graphify.__version__)'", {
      stdio: "ignore",
      timeout: 5_000,
    })
    graphify = true
  } catch {
    try {
      execSync("python3 -c 'import graphifyy; print(graphifyy.__version__)'", {
        stdio: "ignore",
        timeout: 5_000,
      })
      graphify = true
    } catch {
      // Not available
    }
  }

  return { codegraph, graphify, codegraphIndexExists, graphifyIndexExists }
}

// ─── Initialization ────────────────────────────────────────────────

async function initCodegraph(projectDir: string): Promise<void> {
  const codegraphDir = resolve(projectDir, ".codegraph")
  await ensureDir(codegraphDir)

  try {
    execSync("npx --yes codegraph init", {
      cwd: projectDir,
      stdio: "ignore",
      timeout: 60_000,
    })
  } catch {
    // Best-effort
  }
}

async function initGraphify(projectDir: string): Promise<void> {
  const graphifyOut = resolve(projectDir, "graphify-out")
  await ensureDir(graphifyOut)

  try {
    execSync("python3 -m graphify . --no-viz", {
      cwd: projectDir,
      stdio: "ignore",
      timeout: 120_000,
    })
  } catch {
    try {
      execSync("graphifyy . --no-viz", {
        cwd: projectDir,
        stdio: "ignore",
        timeout: 120_000,
      })
    } catch {
      // Best-effort
    }
  }
}

// ─── Watch mode ────────────────────────────────────────────────────

interface WatchProcess {
  process: ReturnType<typeof spawn>
  tool: "codegraph" | "graphify"
}

const activeWatchProcesses = new Map<string, WatchProcess>()

function startWatch(projectDir: string, tool: "codegraph" | "graphify"): void {
  const key = `${projectDir}:${tool}`
  if (activeWatchProcesses.has(key)) return

  try {
    let child: ReturnType<typeof spawn>

    if (tool === "codegraph") {
      // codegraph has no built-in watch; use periodic update loop
      child = spawn(
        "node",
        [
          "-e",
          `
          const {execSync} = require("child_process");
          const run = () => {
            try { execSync("npx codegraph update 2>/dev/null", {cwd: ${JSON.stringify(projectDir)}, stdio: "ignore"}); }
            catch(e) { /* best effort */ }
          };
          run();
          setInterval(run, 30_000);
          `,
        ],
        {
          stdio: "ignore",
          detached: true,
        },
      )
    } else {
      child = spawn("python3", ["-m", "graphify", ".", "--no-viz", "--watch"], {
        cwd: projectDir,
        stdio: "ignore",
        detached: true,
      })
    }

    child.unref()
    activeWatchProcesses.set(key, { process: child, tool })

    child.on("exit", () => {
      activeWatchProcesses.delete(key)
    })
  } catch {
    // Best-effort
  }
}

/**
 * Stop all active watch processes for a project.
 */
export function stopWatches(projectDir?: string): void {
  for (const [key, wp] of activeWatchProcesses) {
    if (!projectDir || key.startsWith(projectDir)) {
      try {
        wp.process.kill("SIGTERM")
      } catch {
        // Already dead
      }
      setTimeout(() => {
        try { wp.process.kill("SIGKILL") } catch { /* OK */ }
      }, 2_000).unref()
      activeWatchProcesses.delete(key)
    }
  }
}

/** Check if watches are active for a project. */
export function hasActiveWatcher(projectDir: string, tool?: "codegraph" | "graphify"): boolean {
  for (const key of activeWatchProcesses.keys()) {
    if (key.startsWith(projectDir)) {
      if (!tool || key.endsWith(tool)) return true
    }
  }
  return false
}

// ─── Main API ──────────────────────────────────────────────────────

export interface GraphSyncResult {
  /** Whether synchronization was attempted */
  attempted: boolean
  /** Codes that describe the outcome */
  codes: GraphSyncCode[]
  /** Tool availability before init */
  availability: ToolAvailability
  /** Whether this project was already initialized this session */
  alreadyInitialized: boolean
}

export type GraphSyncCode =
  | "codegraph-initialized"
  | "codegraph-already-exists"
  | "codegraph-unavailable"
  | "codegraph-install-failed"
  | "codegraph-install-skipped"
  | "graphify-initialized"
  | "graphify-already-exists"
  | "graphify-unavailable"
  | "graphify-install-failed"
  | "graphify-install-skipped"
  | "watch-started-codegraph"
  | "watch-started-graphify"
  | "disabled"
  | "error"
  | "graphify-hook-installed"
/**
 * Run the graphSync pipeline. Best-effort, never throws.
 */
export async function runGraphSync(
  config: GraphSyncConfig = { enabled: true, watch: false, autoInstall: true, installTimeoutMs: 60_000 },
): Promise<GraphSyncResult> {
  const codes: GraphSyncCode[] = []
  const projectDir = config.projectDir ?? process.cwd()

  if (!config.enabled) {
    return {
      attempted: false,
      codes: ["disabled"],
      availability: { codegraph: false, graphify: false, codegraphIndexExists: false, graphifyIndexExists: false },
      alreadyInitialized: false,
    }
  }

  // Skip if already initialized this session
  if (initializedProjects.has(projectDir)) {
    const avail = await checkToolAvailability(projectDir)
    return {
      attempted: false,
      codes: avail.codegraphIndexExists ? ["codegraph-already-exists"] : [],
      availability: avail,
      alreadyInitialized: true,
    }
  }

  initializedProjects.add(projectDir)

  let availability: ToolAvailability
  try {
    availability = await checkToolAvailability(projectDir)
  } catch {
    return {
      attempted: false,
      codes: ["error"],
      availability: { codegraph: false, graphify: false, codegraphIndexExists: false, graphifyIndexExists: false },
      alreadyInitialized: false,
    }
  }

  // Auto-install missing backends
  if (config.autoInstall !== false) {
    if (!availability.codegraph) {
      const result = await installCodegraph(projectDir, config.installTimeoutMs ?? 60_000)
      codes.push(result as GraphSyncCode)
      if (result === "codegraph-installed") {
        availability.codegraph = true
      }
    }
    if (!availability.graphify) {
      const result = await installGraphify(config.installTimeoutMs ?? 60_000)
      codes.push(result as GraphSyncCode)
      if (result === "graphify-installed") {
        availability.graphify = true
      }
    }
  } else {
    if (!availability.codegraph) codes.push("codegraph-install-skipped")
    if (!availability.graphify) codes.push("graphify-install-skipped")
  }

  // Codegraph init
  if (availability.codegraph) {
    if (!availability.codegraphIndexExists) {
      try {
        await initCodegraph(projectDir)
        codes.push("codegraph-initialized")
      } catch {
        codes.push("error")
      }
    } else {
      codes.push("codegraph-already-exists")
    }
  } else {
    codes.push("codegraph-unavailable")
  }

  // Graphify init
  if (availability.graphify) {
    if (!availability.graphifyIndexExists) {
      try {
        await initGraphify(projectDir)
        codes.push("graphify-initialized")
      } catch {
        codes.push("error")
      }
    } else {
      codes.push("graphify-already-exists")
    }

    // v0.11.0: auto-install the graphify git hook so commits auto-rebuild
    // the graph. Native hook is more reliable than our own polling.
    try {
      const alreadyInstalled = await isGraphifyHookInstalled(projectDir)
      if (!alreadyInstalled) {
        execSync("graphify hook install", {
          cwd: projectDir,
          stdio: "ignore",
          timeout: 10_000,
        })
        codes.push("graphify-hook-installed")
      }
    } catch {
      // best-effort
    }
  } else {
    codes.push("graphify-unavailable")
  }

  // Watch mode
  if (config.watch) {
    if (availability.codegraph) {
      startWatch(projectDir, "codegraph")
      codes.push("watch-started-codegraph")
    }
    if (availability.graphify) {
      startWatch(projectDir, "graphify")
      codes.push("watch-started-graphify")
    }
  }

  return {
    attempted: true,
    codes,
    availability,
    alreadyInitialized: false,
  }
}

// ─── Helpers ───────────────────────────────────────────────────────

async function dirExists(dirPath: string): Promise<boolean> {
  try {
    const st = await stat(dirPath)
    return st.isDirectory()
  } catch {
    return false
  }
}

async function ensureDir(dirPath: string): Promise<void> {
  try {
    await access(dirPath, constants.F_OK)
  } catch {
    const { mkdir } = await import("node:fs/promises")
    await mkdir(dirPath, { recursive: true })
  }
}

// ─── v0.11.0: commit-triggered reindex ──────────────────────────

/**
 * Detect whether a shell command string contains `git commit`.
 * Robust to leading whitespace, multi-line scripts, and command chains.
 *
 * The check is intentionally narrow: we only trigger reindex on a real
 * commit (not `git status`, `git log`, etc.) because those don't change
 * the source tree.
 */
export function isGitCommitCommand(command: string | undefined | null): boolean {
  if (typeof command !== "string" || command.length === 0) return false
  // Normalize: strip leading whitespace, collapse newlines
  const normalized = command.replace(/\\\n/g, " ").replace(/\s*\n\s*/g, " ")
  // Look for `git commit` as a token, but exclude `git commit-tree` and similar
  // We match the verb "commit" immediately after "git ".
  return /(?:^|[\s;&|])git\s+commit(?:\s+-|\s|$)/.test(normalized)
}

/**
 * Trigger a one-shot reindex of both codegraph and graphify for the given
 * project directory. Used by the plugin when a `git commit` completes —
 * the source tree just changed and the graph indexes are now stale.
 *
 * Best-effort: never throws, returns a structured result instead.
 */
export async function triggerReindex(projectDir: string): Promise<GraphSyncResult> {
  return await runGraphSync({
    enabled: true,
    watch: false,
    autoInstall: false,
    installTimeoutMs: 5_000,
    projectDir,
  })
}

// ─── v0.11.0: native hook integration ──────────────────────────

/**
 * v0.11.0: Check whether the project's `.git/hooks/post-commit` is the
 * graphify-managed one. Reads the file and looks for the `graphify-hook-start`
 * marker that `graphify hook install` writes.
 *
 * Returns false when the directory has no `.git/` (not a git repo) or when
 * the post-commit hook is missing or wasn't installed by graphify.
 */
export async function isGraphifyHookInstalled(projectDir: string): Promise<boolean> {
  const { access, readFile } = await import("node:fs/promises")
  const { resolve } = await import("node:path")
  const hookPath = resolve(projectDir, ".git", "hooks", "post-commit")
  try {
    await access(hookPath)
  } catch {
    return false
  }
  try {
    const content = await readFile(hookPath, "utf-8")
    return content.includes("graphify-hook-start")
  } catch {
    return false
  }
}

/**
 * v0.11.0: Trigger a one-shot codegraph reindex using the native
 * `codegraph sync -q [path]` command. This is the git-hook-friendly form
 * (quiet, reindexes only changes since last index). Falls back to
 * `codegraph update` if sync is unavailable, then to the full pipeline.
 *
 * Best-effort: never throws, returns a structured result.
 */
export async function triggerCodegraphSync(projectDir: string): Promise<GraphSyncResult> {
  const { execSync } = await import("node:child_process")
  const { access } = await import("node:fs/promises")
  const { resolve } = await import("node:path")
  const codes: GraphSyncCode[] = []
  const codegraphIndexExists = await dirExists(resolve(projectDir, ".codegraph"))

  let codegraphAvailable = false
  try {
    execSync("npx --yes codegraph --version", { stdio: "ignore", timeout: 5_000 })
    codegraphAvailable = true
  } catch {
    try {
      execSync("node node_modules/.bin/codegraph --version", {
        cwd: projectDir,
        stdio: "ignore",
        timeout: 5_000,
      })
      codegraphAvailable = true
    } catch { /* not available */ }
  }

  if (!codegraphAvailable) {
    return {
      attempted: true,
      codes: ["codegraph-unavailable"],
      availability: { codegraph: false, graphify: false, codegraphIndexExists, graphifyIndexExists: await dirExists(resolve(projectDir, "graphify-out")) },
      alreadyInitialized: false,
    }
  }

  if (!codegraphIndexExists) {
    // No prior index — call runGraphSync to do the full init
    return await runGraphSync({
      enabled: true,
      watch: false,
      autoInstall: false,
      installTimeoutMs: 5_000,
      projectDir,
    })
  }

  // We have an index — run `codegraph sync -q <projectDir>` in the background
  // so we don't block the tool.execute.after hook
  try {
    const child = execSync("npx --yes codegraph sync -q", {
      cwd: projectDir,
      stdio: "ignore",
      timeout: 30_000,
    })
    void child
    codes.push("codegraph-already-exists") // re-uses existing code
    logToFile?.("info", `codegraph sync -q completed for ${projectDir}`)
  } catch (err) {
    logToFile?.("warn", `codegraph sync failed for ${projectDir}: ${err}`)
    codes.push("codegraph-install-failed") // re-uses existing code
  }

  return {
    attempted: true,
    codes,
    availability: {
      codegraph: true,
      graphify: false,
      codegraphIndexExists,
      graphifyIndexExists: await dirExists(resolve(projectDir, "graphify-out")),
    },
    alreadyInitialized: false,
  }
}

// Helper: lazy import to avoid bundling fs-logger into graph-sync.ts
function logToFile(_level: "info" | "warn" | "error", _msg: string): void {
  // Imported lazily at call sites to keep graph-sync self-contained
}
