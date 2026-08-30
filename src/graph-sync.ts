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
import { resolve, join } from "node:path"
import { constants } from "node:fs"
import { oldPluginPaths, newPluginPaths, migrateOldToNew } from "./utils/migrate"
import { killProcessTree, trackPid, untrackPid, runGuardedSync, runGuarded, killOrphanedToolProcesses } from "./proc-guard"
  try {
  migrateOldToNew({ oldPaths: oldPluginPaths(), newPaths: newPluginPaths() })
  } catch {
  // best-effort: never break plugin load
}

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
  /** v0.12.0: Auto-upgrade codegraph/graphify when new versions are published.
   * On plugin load, queries npm/pip registries and upgrades if newer version
   * exists. Respects upgradeCheckTtlMs to avoid hammering registries. */
  autoUpgrade?: boolean
  /** v0.12.0: Min ms between registry queries for version check. Default 24h. */
  upgradeCheckTtlMs?: number
  /** v0.26.0: Override the upgrade cache file path (default ~/.config/opencode/omo-meta-governor-upgrade-check.json). Tests use this. */
  upgradeCachePath?: string
  /** v0.26.0: also call `graphify check-update` on plugin load and trigger re-extraction when the semantic-update flag is set. Default true. */
  checkGraphifyNeedsUpdate?: boolean
  /** v0.27.0: opt-in. Register the project graph in the global graphify
   * registry after initial install so 'graphify global list' surfaces it. */
  addToGlobalGraph?: boolean
/** v0.21.0: test-only DI seam — replaces execSync so availability probes
   * never spawn real npx/pip/graphify in hermetic tests (CI Windows: the
   * npx download + 4 fallbacks exceeded the 30s test timeout). */
  runner?: typeof execSync
  /** v0.22.0: when true, graph-sync init sweeps orphaned graphify/codegraph
   * processes left by previous crashed runs. Default true. */
  killOrphanedOnInit?: boolean
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
  runner?: typeof execSync,
): Promise<InstallCode> {
  const args = ["i", "-D", "@colbymchenry/codegraph"]
  if (runner) {
    try {
      runner(`npm ${args.join(" ")}`, { cwd: projectDir, stdio: "ignore", timeout: timeoutMs } as never)
      return "codegraph-installed"
    } catch {
      return "codegraph-install-failed"
    }
  }
  const res = runGuardedSync("npm", args, {
    cwd: projectDir,
    timeoutMs,
  })
  return res.code === 0 ? "codegraph-installed" : "codegraph-install-failed"
}
/**
 * Install graphify via `pip install graphifyy --break-system-packages`.
 * Falls back to `uv tool install graphifyy`.
 * Best-effort, never throws.
 */
export async function installGraphify(
  timeoutMs: number = 60_000,
  runner?: typeof execSync,
): Promise<InstallCode> {
  // v0.26.0: added `--upgrade` flag. Without it, `pip install` on an already-
  // installed package returns 0 with "Requirement already satisfied" but does
  // NOT upgrade — that's why the user had to manually run `pip install --upgrade`.
  if (runner) {
    try {
      runner("pip install --upgrade graphifyy --break-system-packages --quiet", { stdio: "ignore", timeout: timeoutMs } as never)
      return "graphify-installed"
    } catch {
      try {
        runner("uv tool install --upgrade graphifyy --quiet", { stdio: "ignore", timeout: timeoutMs } as never)
        return "graphify-installed"
      } catch {
        return "graphify-install-failed"
      }
    }
  }
const pip = runGuardedSync("pip", ["install", "--upgrade", "graphifyy", "--break-system-packages", "--quiet"], {
    timeoutMs,
  })
  if (pip.code === 0) return "graphify-installed"
  const uv = runGuardedSync("uv", ["tool", "install", "--upgrade", "graphifyy", "--quiet"], {
    timeoutMs,
  })
  return uv.code === 0 ? "graphify-installed" : "graphify-install-failed"
}
// ─── Graph sync state ──────────────────────────────────────────────

const initializedProjects = new Set<string>()

export function resetInitializedProjects(): void {
  initializedProjects.clear()
}

// ─── Session tracking (for watch lifecycle) ────────────────────────

const sessionCounts = new Map<string, number>()

let orphanSweepDone = false

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
/**
 * Check which graph tools are available and whether indexes already exist.
 *
 * Index existence requires the marker file, not just the directory:
 * - codegraph: `.codegraph/codegraph.db`
 * - graphify: `graphify-out/graph.json`
 * An empty dir created by a failed init must NOT count as initialized.
 */
export async function checkToolAvailability(
  projectDir: string,
  runner: typeof execSync = execSync,
): Promise<ToolAvailability> {
  let codegraph = false
  let graphify = false
  const codegraphIndexExists = await fileExists(resolve(projectDir, ".codegraph", "codegraph.db"))
  const graphifyIndexExists = await fileExists(resolve(projectDir, "graphify-out", "graph.json"))

  // v0.23.1: use runGuardedSync for windowsHide:true on Windows when no custom runner
  const execProbe = (cmd: string, opts?: { cwd?: string; timeout?: number }) => {
    if (runner !== execSync) return runner(cmd, { stdio: "ignore", ...opts } as never)
    const parts = cmd.split(" ")
    const c = parts[0]!
    const a = parts.slice(1)
    const res = runGuardedSync(c, a, { cwd: opts?.cwd ?? projectDir, timeoutMs: opts?.timeout ?? 10_000 })
    if (res.code !== 0) throw new Error(`exit ${res.code}`)
  }

  try {
    execProbe("npx --yes codegraph --version", { timeout: 10_000 })
    codegraph = true
  } catch {
    try {
      execProbe("node node_modules/.bin/codegraph --version", { cwd: projectDir, timeout: 5_000 })
      codegraph = true
    } catch {
      // Not available
    }
  }

  try {
    execProbe("graphify --version", { timeout: 5_000 })
    graphify = true
  } catch {
    try {
      execProbe("graphifyy --version", { timeout: 5_000 })
      graphify = true
    } catch {
      try {
        execProbe('python -c "import graphifyy"', { timeout: 5_000 })
        graphify = true
      } catch {
        try {
          execProbe('python3 -c "import graphifyy"', { timeout: 5_000 })
          graphify = true
        } catch {
          // Not available
        }
      }
    }
  }

  return { codegraph, graphify, codegraphIndexExists, graphifyIndexExists }
}

// ─── Initialization ────────────────────────────────────────────────

/**
 * Initialize codegraph in the project. Returns true only when the init
 * command exited successfully (no throw). Does NOT pre-create the dir —
 * a failed init must not leave an empty dir that later counts as
 * "already exists".
 */
export async function initCodegraph(
  projectDir: string,
  timeoutMs: number = 60_000,
  runner: typeof execSync = execSync,
): Promise<boolean> {
  try {
    if (runner !== execSync) {
      runner("npx --yes codegraph init", {
        cwd: projectDir,
        stdio: "ignore",
        timeout: timeoutMs,
      } as never)
    } else {
      const res = runGuardedSync("npx", ["--yes", "codegraph", "init"], {
        cwd: projectDir,
        timeoutMs,
      })
      if (res.code !== 0) throw new Error(`exit ${res.code}`)
    }
    return true
  } catch {
    return false
  }
}

/**
 * Initialize graphify in the project. Returns true only when one of the
 * candidate commands exited successfully.
 *
 * v0.21.0 candidate order: `graphify` binary first (the real CLI installed
 * by the pip package `graphifyy` on Windows), then `python -m graphify`
 * (real interpreter — `python3` may be a WindowsApps stub), then
 * `python3 -m graphify`. The `graphifyy` binary is NOT attempted — it does
 * not exist; the package's binary is named `graphify`.
 */
export async function initGraphify(
  projectDir: string,
  timeoutMs: number = 120_000,
  runner: typeof execSync = execSync,
): Promise<boolean> {
  const candidates = [
    { bin: "graphify", args: [".", "--no-viz"] },
    { bin: "python", args: ["-m", "graphify", ".", "--no-viz"] },
    { bin: "python3", args: ["-m", "graphify", ".", "--no-viz"] },
  ]
  for (const c of candidates) {
    try {
      if (runner !== execSync) {
        runner(`${c.bin} ${c.args.join(" ")}`, {
          cwd: projectDir,
          stdio: "ignore",
          timeout: timeoutMs,
        } as never)
      } else {
        const res = runGuardedSync(c.bin, c.args, {
          cwd: projectDir,
          timeoutMs,
        })
        if (res.code !== 0) throw new Error(`exit ${res.code}`)
      }
      return true
    } catch {
      // Try next candidate
    }
  }
  return false
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
      // v0.22.0: `OMO_MG_WATCH` marker lets the orphan sweep find this
      // process via its CommandLine even if it outlives a crashed run.
      // v0.24.1: use spawn with windowsHide:true instead of execSync
      // to prevent cmd.exe window on Windows every 30s.
      child = spawn(
        "node",
        [
          "-e",
          `
          const OMO_MG_WATCH = 1;
          const {spawn} = require("child_process");
          const run = () => {
            try {
              const c = spawn("npx", ["codegraph", "update"], {
                cwd: ${JSON.stringify(projectDir)},
                stdio: "ignore",
                windowsHide: true,
                shell: false,
              });
              c.unref();
            } catch(e) { /* best effort */ }
          };
          run();
          setInterval(run, 30_000);
          `,
        ],
        {
          stdio: "ignore",
          detached: true,
          shell: false,
          env: { ...process.env, OMO_MG_SPAWN: "1" },
        },
      )
    } else {
      child = spawn("python3", ["-m", "graphify", ".", "--no-viz", "--watch"], {
        cwd: projectDir,
        stdio: "ignore",
        detached: true,
        shell: false,  // v0.23.1: prevent cmd.exe window on Windows
        env: { ...process.env, OMO_MG_SPAWN: "1" },
      })
    }

    child.unref()
    activeWatchProcesses.set(key, { process: child, tool })
    trackPid(child.pid!)

    child.on("exit", () => {
      activeWatchProcesses.delete(key)
      untrackPid(child.pid!)
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
      const pid = wp.process.pid
      if (pid) untrackPid(pid)
      if (process.platform === "win32") {
        // Windows: taskkill /T /F is the only reliable tree kill.
        killProcessTree(pid!)
      } else {
        // POSIX: SIGTERM first, then tree-kill after 2s grace.
        try {
          wp.process.kill("SIGTERM")
        } catch {
          // Already dead
        }
        setTimeout(() => {
          killProcessTree(pid!)
        }, 2_000).unref()
      }
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
  | "codegraph-init-failed"
  | "codegraph-already-exists"
  | "codegraph-unavailable"
  | "codegraph-install-failed"
  | "codegraph-install-skipped"
  | "graphify-initialized"
  | "graphify-init-failed"
  | "graphify-already-exists"
  | "graphify-unavailable"
  | "graphify-install-failed"
  | "graphify-install-skipped"
  | "watch-started-codegraph"
  | "watch-started-graphify"
  | "disabled"
  | "error"
  | "graphify-hook-installed"
  | "codegraph-upgraded"
  | "graphify-upgraded"
  | "upgrade-check-skipped"
  | "codegraph-upgrade-broken"
  | "graphify-reextract-triggered"
  | "upgrade-cache-written"
  | "graphify-added-to-global"
  | "graphify-global-add-failed"
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

  // v0.22.0: sweep orphaned tool processes (graphify/codegraph) left by
  // previous crashed runs. Once per plugin process, best-effort.
  if (config.killOrphanedOnInit !== false && !orphanSweepDone) {
    orphanSweepDone = true
    const killed = killOrphanedToolProcesses()
    void logToFile("info", "orphan sweep: killed " + killed + " leftover tool processes")
  }

  // Skip if already initialized this session
  if (initializedProjects.has(projectDir)) {
    const avail = await checkToolAvailability(projectDir, config.runner)
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
    availability = await checkToolAvailability(projectDir, config.runner)
  } catch {
    return {
      attempted: false,
      codes: ["error"],
      availability: { codegraph: false, graphify: false, codegraphIndexExists: false, graphifyIndexExists: false },
      alreadyInitialized: false,
    }
  }

  // v0.12.0 (refactored v0.26.0): auto-upgrade check.
  // Bug fixes:
  //   - cache resolution is now inlined into shouldUpgrade() via the cache param.
  //   - cache is written ONCE at the end, not duplicated per-tool.
  //   - getInstalledCodegraphVersion/getInstalledGraphifyVersion use the same
  //     tiered probe as checkToolAvailability and accept a runner DI seam.
  if (config.autoUpgrade !== false) {
    try {
      const cachePath = config.upgradeCachePath ?? getDefaultUpgradeCachePath()
      const cache = await readUpgradeCache(cachePath)
      const ttlMs = config.upgradeCheckTtlMs ?? 24 * 60 * 60 * 1000
      // Track fresh-fetched latests so we only fetch each one ONCE per run.
      const freshLatest = { codegraph: null as string | null, graphify: null as string | null }

      const resolveLatest = async (
        tool: "codegraph" | "graphify",
      ): Promise<string | null> => {
        const field = tool === "codegraph" ? "codegraphLatest" : "graphifyLatest"
        if (isCacheFresh(cache, ttlMs) && cache?.[field]) return cache[field]!
        const fetcher = tool === "codegraph" ? fetchCodegraphLatestVersion : fetchGraphifyLatestVersion
        const latest = await fetcher()
        freshLatest[tool] = latest
        return latest
      }

      if (availability.codegraph) {
        const installed = await getInstalledCodegraphVersion(config.runner)
        const latest = await resolveLatest("codegraph")
        if (shouldUpgrade(installed, latest, cache, ttlMs, "codegraphLatest")) {
          if (latest && isNewerVersion(installed, latest)) {
            const up = await installCodegraph(projectDir, config.installTimeoutMs ?? 60_000, config.runner)
            if (up === "codegraph-installed") {
              codes.push("codegraph-upgraded")
              // Bug fix: detect a broken upgrade immediately.
              // v0.26.0: detect a broken upgrade immediately. If the binary is
              // gone after install, surface `codegraph-upgrade-broken` so the
              // user isn't left with a half-broken toolchain.
              const post = await getInstalledCodegraphVersion(config.runner)
              if (post == null) codes.push("codegraph-upgrade-broken")
            }
          }
        }
      }

      if (availability.graphify) {
        const installed = await getInstalledGraphifyVersion(config.runner)
        const latest = await resolveLatest("graphify")
        if (shouldUpgrade(installed, latest, cache, ttlMs, "graphifyLatest")) {
          if (latest && isNewerVersion(installed, latest)) {
            const up = await installGraphify(config.installTimeoutMs ?? 60_000, config.runner)
            if (up === "graphify-installed") codes.push("graphify-upgraded")
          }
        }
        if (config.checkGraphifyNeedsUpdate !== false) {
          try {
            // v0.26.0: respect the runner DI seam — tests shouldn't spawn real graphify.
            const checkRes = config.runner
              ? (() => {
                  try {
                    config.runner!("graphify check-update " + projectDir, { cwd: projectDir, stdio: "ignore", timeout: 10_000 } as never)
                    return { code: 0, stdout: "", stderr: "" }
                  } catch {
                    return { code: 1, stdout: "", stderr: "runner rejected" }
                  }
                })()
              : runGuardedSync("graphify", ["check-update", projectDir], { cwd: projectDir, timeoutMs: 10_000 })
            if (checkRes.code !== 0) {
              // Semantic re-extraction is pending — trigger it.
              if (config.runner) {
                try {
                  config.runner!("graphify update " + projectDir + " --no-cluster", { cwd: projectDir, stdio: "ignore", timeout: (config.installTimeoutMs ?? 60_000) } as never)
                } catch { /* best-effort */ }
              } else {
                runGuardedSync("graphify", ["update", projectDir, "--no-cluster"], { cwd: projectDir, timeoutMs: config.installTimeoutMs ?? 60_000 })
              }
              codes.push("graphify-reextract-triggered")
            }
          } catch { /* best-effort */ }
        }
      }

      // Write cache ONCE with both latests (Bug #5: was being written with duplicate fetches).
      try {
        await writeUpgradeCache(cachePath, {
          checkedAtMs: Date.now(),
          codegraphLatest: freshLatest.codegraph ?? cache?.codegraphLatest,
          graphifyLatest: freshLatest.graphify ?? cache?.graphifyLatest,
        })
        codes.push("upgrade-cache-written")
      } catch {
        // best-effort
      }
    } catch {
      codes.push("upgrade-check-skipped")
    }
  }

  // Auto-install missing backends
  if (config.autoInstall !== false) {
    if (!availability.codegraph) {
      const result = await installCodegraph(projectDir, config.installTimeoutMs ?? 60_000, config.runner)
      codes.push(result as GraphSyncCode)
      if (result === "codegraph-installed") {
        availability.codegraph = true
      }
    }
    if (!availability.graphify) {
      const result = await installGraphify(config.installTimeoutMs ?? 60_000, config.runner)
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
      const ok = await initCodegraph(projectDir, config.installTimeoutMs ?? 60_000)
      codes.push(ok ? "codegraph-initialized" : "codegraph-init-failed")
    } else {
      codes.push("codegraph-already-exists")
    }
  } else {
    codes.push("codegraph-unavailable")
  }

  // Graphify init
  if (availability.graphify) {
    if (!availability.graphifyIndexExists) {
      const ok = await initGraphify(projectDir, config.installTimeoutMs ?? 120_000)
      codes.push(ok ? "graphify-initialized" : "graphify-init-failed")
    } else {
      codes.push("graphify-already-exists")
    }

    // v0.11.0: auto-install the graphify git hook so commits auto-rebuild
    // the graph. Native hook is more reliable than our own polling.
    // v0.22.0: runGuardedSync so a timeout tree-kills the hook process.
    try {
      const alreadyInstalled = await isGraphifyHookInstalled(projectDir)
      if (!alreadyInstalled) {
        const res = runGuardedSync("graphify", ["hook", "install"], {
          cwd: projectDir,
          timeoutMs: 10_000,
        })
        if (res.code === 0) codes.push("graphify-hook-installed")
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

  // v0.27.0: opt-in global graph registration. Only fires after a successful
  // graphify init AND when the user explicitly opted in. Best-effort — never
  // throws, just logs a diagnostic code on failure.
  if (config.addToGlobalGraph === true && availability.graphify) {
    try {
      await runGuarded(
        "graphify",
        ["global", "add", join(projectDir, "graphify-out")],
        { cwd: projectDir, timeoutMs: 10_000 },
      )
      codes.push("graphify-added-to-global")
    } catch {
      codes.push("graphify-global-add-failed")
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

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const st = await stat(filePath)
    return st.isFile()
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
export async function triggerReindex(
  projectDir: string,
  runner?: typeof execSync,
): Promise<GraphSyncResult> {
  // v0.21.0 (fix): when the codegraph index ALREADY exists, run
  // `codegraph sync -q` to refresh it after commits — runGraphSync alone
  // returns "codegraph-already-exists" without syncing (gap found 14/08/2026:
  // triggerCodegraphSync was orphaned). graphify is refreshed by its native
  // post-commit git hook (`graphify update`).
  const codegraphIndexExists = await dirExists(resolve(projectDir, ".codegraph"))
  if (codegraphIndexExists) {
    return await triggerCodegraphSync(projectDir, runner)
  }
  return await runGraphSync({
    enabled: true,
    watch: false,
    autoInstall: false,
    installTimeoutMs: 5_000,
    projectDir,
    runner,
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
export async function triggerCodegraphSync(
  projectDir: string,
  runner?: typeof execSync,
): Promise<GraphSyncResult> {
  const { resolve } = await import("node:path")
  const codes: GraphSyncCode[] = []
  const codegraphIndexExists = await dirExists(resolve(projectDir, ".codegraph"))

  // Oracle N1 (v0.21.0, 14/08/2026): when the index ALREADY exists, skip the
  // availability probe (`codegraph --version`, up to 5s) — the caller
  // (triggerReindex) already decided the index exists, and the sync itself
  // fails fast if the tool is unavailable. This is the commit hot path.
  if (codegraphIndexExists) {
    try {
      if (runner) {
        runner("npx --yes codegraph sync -q", {
          cwd: projectDir,
          stdio: "ignore",
          timeout: 30_000,
        } as never)
      } else {
        // v0.22.0: real path uses runGuardedSync so a timeout tree-kills
        // the npx tree (execSync only kills the direct shell).
        runGuardedSync("npx", ["--yes", "codegraph", "sync", "-q"], {
          cwd: projectDir,
          timeoutMs: 30_000,
        })
      }
      codes.push("codegraph-already-exists")
      void logToFile("info", `codegraph sync -q completed for ${projectDir}`)
    } catch (err) {
      void logToFile("warn", `codegraph sync failed for ${projectDir}: ${err}`)
      codes.push("codegraph-install-failed")
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

  // No index — probe availability before deciding init vs unavailable.
  let codegraphAvailable = false
  try {
    if (runner) {
      runner("npx --yes codegraph --version", { stdio: "ignore", timeout: 5_000 } as never)
    } else {
      const probe = runGuardedSync("npx", ["--yes", "codegraph", "--version"], { timeoutMs: 5_000 })
      if (probe.code !== 0) throw new Error("codegraph probe failed")
    }
    codegraphAvailable = true
  } catch {
    try {
      if (runner) {
        runner("node node_modules/.bin/codegraph --version", {
          cwd: projectDir,
          stdio: "ignore",
          timeout: 5_000,
        } as never)
      } else {
        const probe = runGuardedSync("node", ["node_modules/.bin/codegraph", "--version"], {
          cwd: projectDir,
          timeoutMs: 5_000,
        })
        if (probe.code !== 0) throw new Error("local codegraph probe failed")
      }
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

  // No prior index — call runGraphSync to do the full init
  return await runGraphSync({
    enabled: true,
    watch: false,
    autoInstall: false,
    installTimeoutMs: 5_000,
    projectDir,
    runner,
  })
}

// v0.16.0: F2.3 — replaced the no-op stub with a lazy proxy to the real
// file-logger. The previous stub silently dropped sync-failure messages
// (H4 in the audit). Now the proxy re-imports logToFile on first call
// to avoid a hard dependency cycle at module load.
// v0.35.0 (audit fix F9): eager static import. file-logger.ts has no
// back-reference to graph-sync, so no cycle exists. Removes the
// `await import("./file-logger")` microtask from every log call.
import { logToFile as _logToFile } from "./file-logger"
export const logToFile = _logToFile

// ─── v0.12.0: auto-upgrade helpers ─────────────────────────────

/**
 * Compare two semver strings. Returns true if `latest` is strictly greater
 * than `installed`. Handles X.Y.Z with optional pre-release suffix (-rc.1,
 * -beta.2). Pre-release is considered LOWER than the same X.Y.Z without it.
 *
 * Defensive: returns false on malformed input (unknown version, empty
 * string, etc.) so callers can default to "don't upgrade" instead of
 * triggering a network call.
 */
export function isNewerVersion(installed: string | null | undefined, latest: string | null | undefined): boolean {
  // v0.18.0: distinguish "not installed" (null/undefined) from
  // "malformed input" (empty string, non-semver).
  //   null/undefined installed → treat as "anything older" → upgrade
  //   empty string installed → malformed → don't upgrade
  if (installed == null && latest) return true
  if (!latest) return false
  const i = installed as string
  const l = latest
  if (!i || i === l) return false
  // Defensive: reject non-semver strings instead of treating them as 0.0.0
  const SEMVER_RE = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/
  if (!SEMVER_RE.test(i) || !SEMVER_RE.test(l)) return false
  // Strip pre-release suffix for base comparison
  const parseBase = (v: string): [number, number, number, string] => {
    const [base = "", pre = ""] = v.split("-", 2)
    const parts = base.split(".").map((n) => {
      const num = Number.parseInt(n, 10)
      return Number.isFinite(num) ? num : 0
    })
    const [maj = 0, min = 0, pat = 0] = parts
    return [maj, min, pat, pre]
  }
  const [iMaj, iMin, iPat, iPre] = parseBase(i)
  const [lMaj, lMin, lPat, lPre] = parseBase(l)
  if (lMaj !== iMaj) return lMaj > iMaj
  if (lMin !== iMin) return lMin > iMin
  if (lPat !== iPat) return lPat > iPat
  // Same base — pre-release ordering: no pre > with pre
  if (iPre && !lPre) return true
  if (!iPre && lPre) return false
  return lPre > iPre
}

/**
 * v0.12.0: persisted cache of latest-version lookups so we don't
 * hammer npm/pip registries on every plugin load.
 *
 * File path defaults to ~/.config/opencode/omo-meta-governor-upgrade-check.json
 */
export interface UpgradeCache {
  checkedAtMs: number
  codegraphLatest?: string
  graphifyLatest?: string
}

export function getDefaultUpgradeCachePath(): string {
  return newPluginPaths().upgradeCheck
}

export async function readUpgradeCache(path: string): Promise<UpgradeCache | null> {
  try {
    const { readFile } = await import("node:fs/promises")
const content = await readFile(path, "utf-8")
const parsed = JSON.parse(content)
if (typeof parsed?.checkedAtMs === "number") {
return parsed as UpgradeCache
}
return null
} catch {
return null
}
}

export async function writeUpgradeCache(path: string, payload: UpgradeCache): Promise<void> {
  const { dirname } = await import("node:path")
  const { mkdir, writeFile } = await import("node:fs/promises")
  const dir = dirname(path)
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(path, JSON.stringify(payload, null, 2))
  } catch {
    // best-effort — cache write failures must NEVER break the plugin
  }
}

/** Returns true if cache exists AND its `checkedAtMs` is within ttlMs of now. */
export function isCacheFresh(cache: UpgradeCache | null, ttlMs: number): boolean {
  if (!cache) return false
  const ageMs = Date.now() - cache.checkedAtMs
  return ageMs >= 0 && ageMs < ttlMs
}

/**
 * v0.12.0: decide whether to upgrade. Pure function over (installed,
 * latest, cache, ttl). Used by runGraphSync before calling out to the
 * registry. Centralizes the upgrade-decision policy.
 *
 * - If cache is fresh AND cache has a known latest version, use cached
 *   latest instead of trusting `latest` (which may be stale). This is
 *   how we avoid hammering npm/pip registries.
 * - If both installed and effective-latest are unknown → false.
 * - If installed >= effective-latest → false.
 * - Otherwise → true.
 */
export function shouldUpgrade(
  installed: string | null | undefined,
  registryLatest: string | null | undefined,
  cache: UpgradeCache | null,
  ttlMs: number,
  latestField: "codegraphLatest" | "graphifyLatest" = "codegraphLatest",
): boolean {
  // Determine the "effective" latest version to compare against.
  // If cache is fresh and has a value, prefer it (avoids extra registry calls).
  let effectiveLatest = registryLatest
  if (isCacheFresh(cache, ttlMs)) {
    effectiveLatest = cache?.[latestField] ?? effectiveLatest
  }
  if (!installed && !effectiveLatest) return false
  if (!effectiveLatest) return false
  if (!installed) return true
  return isNewerVersion(installed, effectiveLatest)
}

/**
 * v0.12.0: fetch the latest version of codegraph from npm registry.
 * Returns null on failure (best-effort, never throws).
 */
export async function fetchCodegraphLatestVersion(): Promise<string | null> {
  try {
    const res = runGuardedSync("npm", ["view", "@colbymchenry/codegraph", "version"], {
      timeoutMs: 10_000,
    })
    const v = res.stdout.trim()
    return v.length > 0 ? v : null
  } catch {
    return null
  }
}

export async function fetchGraphifyLatestVersion(
  runner: typeof execSync = execSync,
): Promise<string | null> {
  // v0.25.2: try `python` first (Windows: `python3` may resolve to a stub
  // without the package — e.g. python3=3.14.4 stub, python=3.14.2 with graphifyy).
  // Use runGuardedSync to get windowsHide:true on Windows.
  for (const py of ["python", "python3"]) {
    try {
      const res = runGuardedSync(py, ["-m", "pip", "index", "versions", "graphifyy"], {
        timeoutMs: 10_000,
      })
      const first = res.stdout.split("\n")[0] ?? ""
      const m = first.match(/graphifyy\s*\(?([0-9]+\.[0-9]+\.[0-9]+[^\s)]*)/)
      if (m) return m[1]!
    } catch { /* try next */ }
  }
  // Last-resort: query PyPI directly via the working interpreter
  for (const py of ["python", "python3"]) {
    try {
      const res = runGuardedSync(py, [
        "-c",
        "import urllib.request, json; d=json.load(urllib.request.urlopen('https://pypi.org/pypi/graphifyy/json')); print(d['info']['version'])",
      ], {
        timeoutMs: 10_000,
      })
      const v = res.stdout.trim()
      if (v.length > 0) return v
    } catch { /* try next */ }
  }
  return null
}

/**
 * v0.12.0: get the installed version of codegraph by running its CLI.
 * Returns null on failure.
 */
export async function getInstalledCodegraphVersion(
  runner?: typeof execSync,
): Promise<string | null> {
  // v0.26.0: tiered probe matching checkToolAvailability — npx first, then
  // local node_modules fallback. Earlier versions only probed npx, which
  // failed on Windows installs that used only the local binary (Bug #1).
  const probes: Array<{ bin: string; args: string[] }> = [
    { bin: "npx", args: ["--yes", "codegraph", "--version"] },
    { bin: "node", args: ["node_modules/.bin/codegraph", "--version"] },
  ]
  for (const { bin, args } of probes) {
    try {
      let stdout: string
      if (runner) {
        // execSync returns string | Buffer; the DI runner matches that shape.
        // The cast to the options overload keeps TS happy without `as never`.
        const r: string | Buffer = runner(
          `${bin} ${args.join(" ")}`,
          { stdio: "ignore", timeout: 10_000 } as Parameters<typeof execSync>[1],
        )
        stdout = typeof r === "string" ? r : r.toString()
      } else {
        stdout = runGuardedSync(bin, args, { timeoutMs: 10_000 }).stdout
      }
      const m = stdout.match(/([0-9]+\.[0-9]+\.[0-9]+[^\s]*)/)
      if (m) return m[1]!
    } catch { /* try next probe */ }
  }
  return null
}

/**
 * v0.12.0: get the installed version of graphify via pip show.
 * Returns null on failure.
 */
export async function getInstalledGraphifyVersion(
  runner?: typeof execSync,
): Promise<string | null> {
  // v0.26.0: tiered probe matching checkToolAvailability so install/version
  // checks align. Order: graphify binary → python → python3.
  const execProbe = (bin: string, args: string[]): string => {
    if (runner) {
      const r: string | Buffer = runner(
        `${bin} ${args.join(" ")}`,
        { stdio: "ignore", timeout: 10_000 } as Parameters<typeof execSync>[1],
      )
      return typeof r === "string" ? r : r.toString()
    }
    return runGuardedSync(bin, args, { timeoutMs: 10_000 }).stdout
  }
  // Probe 1: graphify binary (Windows: pip installs as `graphify`)
  try {
    const stdout = execProbe("graphify", ["--version"])
    const m = stdout.match(/([0-9]+\.[0-9]+\.[0-9]+[^\s]*)/)
    if (m) return m[1]!
  } catch { /* fall through */ }
  // Probe 2: python (Windows dual-python: real interpreter at C:\Python314)
  try {
    const stdout = execProbe("python", ["-m", "pip", "show", "graphifyy"])
    const m = stdout.match(/Version:\s*([0-9]+\.[0-9]+\.[0-9]+[^\s]*)/)
    if (m) return m[1]!
  } catch { /* fall through */ }
  // Probe 3: python3 (POSIX or py launcher)
  try {
    const stdout = execProbe("python3", ["-m", "pip", "show", "graphifyy"])
    const m = stdout.match(/Version:\s*([0-9]+\.[0-9]+\.[0-9]+[^\s]*)/)
    if (m) return m[1]!
  } catch { /* fall through */ }
  return null
}

/**
* v0.25.1: count commits the local HEAD is behind origin/&lt;branch&gt;.
* Best-effort, never throws — returns 0 on any failure (no git, offline, no remote).
* Used by the plugin-load watcher to decide whether to trigger a reindex.
*/
export function detectRemoteNewCommits(
  projectDir: string,
  branch: string | undefined,
  runner?: typeof execSync,
): number {
  // v0.25.1 DI: when runner is provided (tests), use it instead of runGuardedSync.
  // runner is execSync-style: (cmd, opts) => string | Buffer.
  const exec = runner
    ? (cmd: string) => runner(cmd, { cwd: projectDir }).toString()
    : undefined
  let targetBranch: string | undefined = branch
  try {
    if (!targetBranch) {
      if (exec) {
        targetBranch = exec("git rev-parse --abbrev-ref HEAD").trim()
      } else {
        const res = runGuardedSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
          cwd: projectDir,
          timeoutMs: 5_000,
        })
        targetBranch = res.stdout.trim()
      }
    }
    if (exec) {
      exec(`git fetch origin ${targetBranch!}`)
    } else {
      runGuardedSync("git", ["fetch", "origin", targetBranch!], {
        cwd: projectDir,
        timeoutMs: 30_000,
      })
    }
    let count: string
    if (exec) {
      count = exec(`git rev-list --count HEAD..origin/${targetBranch}`)
    } else {
      const res = runGuardedSync("git", ["rev-list", "--count", `HEAD..origin/${targetBranch}`], {
        cwd: projectDir,
        timeoutMs: 10_000,
      })
      count = res.stdout
    }
    const n = Number.parseInt(count.trim(), 10)
    return Number.isFinite(n) && n > 0 ? n : 0
  } catch {
    return 0
  }
}
