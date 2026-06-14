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
      child = spawn("npx", ["codegraph", "watch"], {
        cwd: projectDir,
        stdio: "ignore",
        detached: true,
      })
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
        wp.process.kill()
      } catch {
        // Already dead
      }
      activeWatchProcesses.delete(key)
    }
  }
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
