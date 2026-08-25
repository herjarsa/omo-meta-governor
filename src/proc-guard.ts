/**
 * proc-guard — process-zombie safeguards for every subprocess the plugin spawns.
 *
 * v0.22.0. Root cause of the Bun/OpenChamber crashes (user-confirmed 14/08/2026):
 * on Windows, `child.kill()`/`SIGKILL` kills only the DIRECT child — with
 * `shell: true` that is `cmd.exe`, leaving the python/node grandchild orphaned.
 * The ONLY reliable way to kill a process tree on Windows is
 * `taskkill /pid <pid> /T /F`.
 *
 * This module guarantees every spawned process dies after use — on success,
 * on error, AND on timeout — including its descendant tree. It also sweeps
 * orphans left by previous crashed runs.
 *
 * Design invariants:
 *   - NEVER throws. All failures surface as `code: null` results.
 *   - Tracks every spawned pid in a module-level Set so a crash can't leak.
 *   - Covers the tools the plugin spawns (graphify/codegraph/npx/python).
 */
import { spawn, spawnSync } from "node:child_process"

// ─── Types ──────────────────────────────────────────────────────────

export interface GuardedResult {
  stdout: string
  stderr: string
  code: number | null
  timedOut: boolean
}

export interface GuardedOptions {
  cwd?: string
  timeoutMs: number
  env?: NodeJS.ProcessEnv
}

// ─── Process-tree kill ──────────────────────────────────────────────

/**
 * Recursively kill all descendants of a POSIX pid via `pgrep -P` walk.
 * Never throws.
 */
function killDescendants(pid: number): void {
  try {
    const out = spawnSync("pgrep", ["-P", String(pid)], { encoding: "utf8" })
    for (const line of out.stdout.trim().split(/\s+/)) {
      const child = Number(line)
      if (!child) continue
      killDescendants(child)
      try { process.kill(child, "SIGKILL") } catch { /* already gone */ }
    }
  } catch {
    // pgrep unavailable — best-effort
  }
}

/**
 * Kill a process AND its entire descendant tree. Never throws.
 *
 * - win32: `taskkill /pid <pid> /T /F` — the only reliable tree kill on Windows.
 * - POSIX: group kill (`kill(-pid)`) as fast path when the child is a group
 *   leader (spawned detached), then a recursive `pgrep -P` descendant walk,
 *   then a direct SIGKILL. The plain `kill(-pid)` fallback ALONE leaves
 *   grandchildren orphaned when the child is not a group leader (CI-verified).
 */
export function killProcessTree(pid: number): void {
  if (!pid || pid <= 0) return
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" })
    } else {
      try {
        process.kill(-pid, "SIGKILL")
      } catch {
        // not a group leader — fall through to the descendant walk
      }
      killDescendants(pid)
      try { process.kill(pid, "SIGKILL") } catch { /* already gone */ }
    }
  } catch {
    // Never throw — best-effort kill
  }
}

/**
 * Check whether a process is alive. `process.kill(pid, 0)` throws ESRCH when
 * the process does not exist; any other outcome means it exists.
 */
export function isProcessAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === "ESRCH") return false
    // EPERM (exists but not ours) / EINVAL → treat as alive
    return true
  }
}

// ─── Tracked pids ───────────────────────────────────────────────────

const trackedPids = new Set<number>()

/** Register a pid so a crash can't leak it. */
export function trackPid(pid: number): void {
  if (pid && pid > 0) trackedPids.add(pid)
}

/** Remove a pid from the tracked set (after it exited). */
export function untrackPid(pid: number): void {
  trackedPids.delete(pid)
}

/**
 * Kill every alive tracked pid via killProcessTree, clear the set, and
 * return how many were killed. Used as a last-resort sweep.
 */
export function killTrackedProcesses(): number {
  let count = 0
  for (const pid of trackedPids) {
    if (isProcessAlive(pid)) {
      killProcessTree(pid)
      count++
    }
  }
  trackedPids.clear()
  return count
}

// ─── Async guarded spawn ────────────────────────────────────────────

/**
 * Spawn a process with a guaranteed tree-kill on timeout. Never throws.
 *
 * - Tracks the pid immediately.
 * - On timeout: killProcessTree(pid), set timedOut, then WAIT for the close
 *   event with a 2s guard race — if close doesn't fire in 2s, resolve anyway.
 * - On close/error: untrack; if still alive after close (rare), tree-kill.
 */
export function runGuarded(
  cmd: string,
  args: string[],
  opts: GuardedOptions,
): Promise<GuardedResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
    child = spawn(cmd, args, {
        cwd: opts.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        shell: process.platform === "win32",
        windowsHide: true,  // v0.23.1: prevent cmd.exe window on Windows
        env: { ...process.env, OMO_MG_SPAWN: "1", ...opts.env },
      })
    } catch {
      resolve({ stdout: "", stderr: "", code: null, timedOut: false })
      return
    }

    trackPid(child.pid!)

    let stdout = ""
    let stderr = ""
    let timedOut = false
    let settled = false
    let closeGuard: ReturnType<typeof setTimeout> | undefined

    const finish = (result: GuardedResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (closeGuard) clearTimeout(closeGuard)
      untrackPid(child.pid!)
      resolve(result)
    }

    const timer = setTimeout(() => {
      timedOut = true
      killProcessTree(child.pid!)
      // Wait for close with a 2s guard — never leave the promise hanging.
      closeGuard = setTimeout(() => {
        finish({ stdout, stderr, code: null, timedOut: true })
      }, 2_000)
    }, opts.timeoutMs)

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8")
    })
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8")
    })

    child.on("error", () => {
      finish({ stdout, stderr, code: null, timedOut })
    })

    child.on("close", (code) => {
      // If still alive after close (rare), tree-kill as last resort.
      if (child.exitCode === null) {
        killProcessTree(child.pid!)
      }
      finish({ stdout, stderr, code, timedOut })
    })
  })
}


// ─── Sync guarded spawn ─────────────────────────────────────────────

/**
 * spawnSync twin of runGuarded with the same kill-tree-on-timeout guarantee.
 * spawnSync's `timeout` kills only the direct child; we tree-kill after.
 * Never throws.
 */
export function runGuardedSync(
  cmd: string,
  args: string[],
  opts: GuardedOptions,
): GuardedResult {
  const start = Date.now()
  let result: ReturnType<typeof spawnSync>
  try {
    result = spawnSync(cmd, args, {
        cwd: opts.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        shell: process.platform === "win32",
        windowsHide: true,  // v0.23.1: prevent cmd.exe window on Windows
        env: { ...process.env, OMO_MG_SPAWN: "1", ...opts.env },
        timeout: opts.timeoutMs,
      })
  } catch {
    return { stdout: "", stderr: "", code: null, timedOut: false }
  }

  // Bun on win32 reports a timed-out spawnSync as status 1 with NO signal/error
  // (empirically verified 14/08/2026) — so detect timeout by elapsed time too.
  const elapsed = Date.now() - start
  const timedOut =
    (result.error != null && (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT") ||
    result.signal === "SIGTERM" ||
    elapsed >= opts.timeoutMs - 50

  // spawnSync with timeout kills the direct child but not the tree.
  if (timedOut && result.pid) {
    killProcessTree(result.pid)
  }

  return {
    stdout: (result.stdout ?? "").toString("utf8"),
    stderr: (result.stderr ?? "").toString("utf8"),
    code: result.status,
    timedOut,
  }
}

// ─── Orphan sweep ───────────────────────────────────────────────────

/**
 * Sweep zombie processes left by previous crashed runs.
 *
 * - win32: `taskkill /IM graphify.exe /F`, `/IM codegraph.exe /F`,
 *   (each try/catch — "not found" is fine), then a
 *   PowerShell one-liner that stops any process whose CommandLine matches
 *   `OMO_MG_WATCH|OMO_MG_SPAWN`.
 * - POSIX: `pkill -x graphify`, `pkill -x codegraph`,
 *   `pkill -f "OMO_MG_WATCH|OMO_MG_SPAWN"` (each try/catch).
 *
 * MUST NOT kill the current process or the bun test runner — exact-name
 * matching on graphify/codegraph makes this safe (the runner is
 * `bun`/`node`, never those names).
 *
 * Returns a best-effort count (may be 0 — counting via taskkill/pkill is
 * unreliable). Never throws.
 */
export function killOrphanedToolProcesses(): number {
  let count = 0
  try {
    if (process.platform === "win32") {
      for (const name of ["graphify.exe", "codegraph.exe"]) {
        try {
          spawnSync("taskkill", ["/IM", name, "/F"], { stdio: "ignore" })
        } catch {
          // not found is fine
        }
      }
      try {
        const ps = spawnSync(
          "powershell",
          [
            "-NoProfile",
            "-Command",
            "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'OMO_MG_WATCH|OMO_MG_SPAWN' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
          ],
          { stdio: "ignore" },
        )
        if (ps.status === 0) count = 1
      } catch {
        // best-effort
      }
    } else {
      for (const name of ["graphify", "codegraph"]) {
        try {
          spawnSync("pkill", ["-x", name], { stdio: "ignore" })
        } catch {
          // not found is fine
        }
      }
      try {
        spawnSync("pkill", ["-f", "OMO_MG_WATCH|OMO_MG_SPAWN"], { stdio: "ignore" })
      } catch {
        // best-effort
      }
    }
  } catch {
    // Never throw
  }
  return count
}
// ─── Process-exit handlers (v0.30 zombie-fix) ──────────────────────

/**
 * When opencode exits, the tracked grandchild processes (graphify.exe /
 * codegraph.exe / python.exe / node.exe) survive because the plugin spawns
 * them with `detached: true` and then calls `c.unref()`. Without a cleanup
 * hook they leak across opencode restarts and pile up as zombies (user
 * reported 30+ python/graphify zombies after closing opencode).
 *
 * v0.30 fixes this by registering `process.on("exit")`, `SIGINT`, `SIGTERM`,
 * and `beforeExit` handlers that:
 *   1. kill every tracked pid via killProcessTree
 *   2. run a final orphan sweep for untracked leftovers (env OMO_MG_SPAWN)
 *
 * Idempotent — calling twice is a no-op. Returns true on first install, false
 * thereafter. `beforeExit` and `exit` MUST be synchronous; the helpers above
 * already are (taskkill / taskkill /F are blocking spawnSync).
 *
 * NEVER throws.
 */
export function installProcessExitHandlers(): boolean {
  if (processExitHandlersInstalled) return false
  processExitHandlersInstalled = true

  const cleanup = (): void => {
    try {
      killTrackedProcesses()
    } catch {
      // best-effort
    }
    try {
      killOrphanedToolProcesses()
    } catch {
      // best-effort
    }
  }

  // v0.30.1 (test-isolation fix): store listeners so test code can
  // uninstall them via resetOrphanSweepGuardForTests. Without this,
  // the first test in a bun test session that calls this function
  // permanently pollutes the runner — process.on("beforeExit") runs
  // cleanup (including a ~5s PowerShell call) between every test file.
  exitHandlerRefs.push({ event: "exit", fn: cleanup })
  process.on("exit", cleanup)

  const onSignal = (signal: NodeJS.Signals): void => {
    cleanup()
    // v0.34.2: replaced process.kill(process.pid, signal) with process.exit(code).
    // v0.34.1 self-targeting kill raced with cleanup() and broke opencode shutdown.
    // Conventional exit codes: SIGINT=130, SIGTERM=143, SIGHUP=129
    const exitCode =
      signal === 'SIGINT'  ? 130 :
      signal === 'SIGTERM' ? 143 :
      signal === 'SIGHUP'  ? 129 : 1
    process.exit(exitCode)
  }
  exitHandlerRefs.push({ event: "SIGINT", fn: onSignal })
  exitHandlerRefs.push({ event: "SIGTERM", fn: onSignal })
  exitHandlerRefs.push({ event: "SIGHUP", fn: onSignal })
  process.on("SIGINT", onSignal)
  process.on("SIGTERM", onSignal)
  process.on("SIGHUP", onSignal)

  const onBeforeExit = (): void => {
    cleanup()
  }
  exitHandlerRefs.push({ event: "beforeExit", fn: onBeforeExit })
  process.on("beforeExit", onBeforeExit)

  return true
}

/** Whether installProcessExitHandlers has run in this process. Test seam. */
export function isOrphanSweepInstalled(): boolean {
  return processExitHandlersInstalled
}

/**
 * Test seam — uninstall listeners AND reset the once-flag so tests can
 * re-install. Without uninstalling, the first test that calls
 * installProcessExitHandlers() permanently pollutes the bun test
 * runner — every beforeExit fires the cleanup (including the ~5s
 * PowerShell sweep), causing subsequent tests to time out.
 * NEVER use in prod.
 */
export function resetOrphanSweepGuardForTests(): void {
  for (const ref of exitHandlerRefs) {
    try { process.removeListener(ref.event, ref.fn) } catch { /* ignore */ }
  }
  exitHandlerRefs.length = 0
  processExitHandlersInstalled = false
}

type ExitHandlerRef = { event: string; fn: (...args: any[]) => void }
const exitHandlerRefs: ExitHandlerRef[] = []

let processExitHandlersInstalled = false