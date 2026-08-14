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
 *   - AFT integration is untouched; this module only ADDS safeguards.
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
 * Kill a process AND its entire descendant tree. Never throws.
 *
 * - win32: `taskkill /pid <pid> /T /F` — the only reliable tree kill on Windows.
 * - POSIX: `process.kill(-pid, "SIGKILL")` (negative = process group, works
 *   when the child was spawned detached). Falls back to `process.kill(pid, ...)`.
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
        process.kill(pid, "SIGKILL")
      }
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
 *   `/IM aft.exe /F` (each try/catch — "not found" is fine), then a
 *   PowerShell one-liner that stops any process whose CommandLine matches
 *   `OMO_MG_WATCH|OMO_MG_SPAWN`.
 * - POSIX: `pkill -x graphify`, `pkill -x codegraph`, `pkill -x aft`,
 *   `pkill -f "OMO_MG_WATCH|OMO_MG_SPAWN"` (each try/catch).
 *
 * MUST NOT kill the current process or the bun test runner — exact-name
 * matching on graphify/codegraph/aft makes this safe (the runner is
 * `bun`/`node`, never those names).
 *
 * Returns a best-effort count (may be 0 — counting via taskkill/pkill is
 * unreliable). Never throws.
 */
export function killOrphanedToolProcesses(): number {
  let count = 0
  try {
    if (process.platform === "win32") {
      for (const name of ["graphify.exe", "codegraph.exe", "aft.exe"]) {
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
      for (const name of ["graphify", "codegraph", "aft"]) {
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