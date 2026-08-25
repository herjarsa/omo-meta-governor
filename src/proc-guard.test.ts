import { readFileSync } from 'node:fs'
/**
 * Tests for src/proc-guard.ts — process-zombie safeguards.
 *
 * Real-process tests: each test spawns a real sleeping node process and
 * verifies that killProcessTree / runGuarded / killTrackedProcesses actually
 * kill it (and its descendants). Every spawned pid is recorded and killed in
 * afterEach so no zombie is left for the Bun runner (memory #991/#995).
 *
 * NOTE: runGuarded uses `shell: true` on win32, so scripts are passed as temp
 * FILES (cmd.exe mangles `-e` inline scripts containing (){} — empirically
 * verified 14/08/2026). Files are cleaned up in afterEach.
 */
import { describe, expect, it, afterEach, beforeEach } from "bun:test"
import { spawn } from "node:child_process"
import { writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  killProcessTree,
  isProcessAlive,
  trackPid,
  killTrackedProcesses,
  runGuarded,
  runGuardedSync,
  killOrphanedToolProcesses,
  installProcessExitHandlers,
  isOrphanSweepInstalled,
  resetOrphanSweepGuardForTests,
} from "./proc-guard"

const SLEEPER = "setTimeout(()=>{},60000)"
const spawnedPids: number[] = []
const tmpFiles: string[] = []

function writeTmpScript(name: string, body: string): string {
  const p = join(tmpdir(), `proc-guard-${process.pid}-${name}.js`)
  writeFileSync(p, body)
  tmpFiles.push(p)
  return p
}

function spawnSleeper(): import("node:child_process").ChildProcess {
  const child = spawn(process.execPath, ["-e", `${SLEEPER}`], { stdio: "ignore" })
  spawnedPids.push(child.pid!)
  return child
}

async function waitForAlive(pid: number, expectAlive: boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (isProcessAlive(pid) === expectAlive) return
    await new Promise((r) => setTimeout(r, 100))
  }
  expect(isProcessAlive(pid)).toBe(expectAlive)
}

afterEach(() => {
  for (const pid of spawnedPids.splice(0)) {
    try {
      killProcessTree(pid)
    } catch {
      // best-effort cleanup
    }
  }
  for (const f of tmpFiles.splice(0)) {
    try {
      rmSync(f, { force: true })
    } catch {
      // best-effort cleanup
    }
  }
})

describe("killProcessTree", () => {
  it("kills a sleeping process", async () => {
    const child = spawnSleeper()
    await new Promise((r) => setTimeout(r, 300))
    expect(isProcessAlive(child.pid!)).toBe(true)

    killProcessTree(child.pid!)
    await waitForAlive(child.pid!, false)
  })

  it("kills the whole descendant tree (parent + grandchild)", async () => {
    const child = spawn(
      process.execPath,
      [
        "-e",
        `const{spawn}=require('child_process');const c=spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{stdio:'ignore'});console.log('CHILD:'+c.pid);setTimeout(()=>{},60000)`,
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    )
    spawnedPids.push(child.pid!)
    let grandchildPid = 0
    child.stdout?.on("data", (chunk: Buffer) => {
      const m = chunk.toString("utf8").match(/CHILD:(\d+)/)
      if (m) grandchildPid = Number(m[1])
    })
    const deadline = Date.now() + 3_000
    while (!grandchildPid && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100))
    }
    expect(grandchildPid).toBeGreaterThan(0)
    spawnedPids.push(grandchildPid)
    await new Promise((r) => setTimeout(r, 200))

    expect(isProcessAlive(child.pid!)).toBe(true)
    expect(isProcessAlive(grandchildPid)).toBe(true)

    killProcessTree(child.pid!)
    await waitForAlive(child.pid!, false)
    await waitForAlive(grandchildPid, false)
  })
})

describe("runGuarded", () => {

  it("resolves stdout + code 0 on success", async () => {
    const okScript = writeTmpScript("ok", "console.log('ok')")
    const res = await runGuarded(process.execPath, [okScript], { timeoutMs: 5_000 })
    expect(res.code).toBe(0)
    expect(res.timedOut).toBe(false)
    expect(res.stdout.trim()).toBe("ok")
  })

  it("reports nonzero exit code with stderr", async () => {
    const boomScript = writeTmpScript("boom", "console.error('boom');process.exit(3)")
    const res = await runGuarded(process.execPath, [boomScript], { timeoutMs: 5_000 })
    expect(res.code).toBe(3)
    expect(res.timedOut).toBe(false)
    expect(res.stderr).toContain("boom")
  })

  it("times out and resolves (does not hang), leaving no tracked pid", async () => {
    const sleeperScript = writeTmpScript("sleeper", "setTimeout(()=>{},60000)")
    const res = await runGuarded(process.execPath, [sleeperScript], { timeoutMs: 500 })
    expect(res.timedOut).toBe(true)
    // win32 taskkill /F (TerminateProcess) yields exit code 1; POSIX yields null.
    expect(res.code === null || res.code === 1).toBe(true)
    // All tracked pids must have been untracked after the timeout kill.
    expect(killTrackedProcesses()).toBe(0)
  })

  it("never throws on spawn failure", async () => {
    const res = await runGuarded("definitely-not-a-real-binary-xyz", [], { timeoutMs: 500 })
    expect(res.timedOut).toBe(false)
    // win32 shell:true turns "not found" into exit 1; POSIX yields code null.
    expect(res.code).not.toBe(0)
  })
})

describe("killTrackedProcesses", () => {
  it("kills alive tracked pids and returns the count", async () => {
    const child = spawnSleeper()
    await new Promise((r) => setTimeout(r, 300))
    trackPid(child.pid!)
    expect(isProcessAlive(child.pid!)).toBe(true)

    const killed = killTrackedProcesses()
    expect(killed).toBeGreaterThanOrEqual(1)
    await waitForAlive(child.pid!, false)
  })
})

describe("killOrphanedToolProcesses", () => {
  it("never throws and returns a count >= 0", () => {
    let result = -1
    expect(() => {
      result = killOrphanedToolProcesses()
    }).not.toThrow()
    expect(result).toBeGreaterThanOrEqual(0)
  })

  it("does NOT kill the current process (the test runner)", () => {
    const me = process.pid
    killOrphanedToolProcesses()
    expect(isProcessAlive(me)).toBe(true)
  })
})

describe("runGuardedSync", () => {

  it("resolves stdout + code 0 on success", () => {
    const okScript = writeTmpScript("sync-ok", "console.log('sync-ok')")
    const res = runGuardedSync(process.execPath, [okScript], { timeoutMs: 5_000 })
    expect(res.code).toBe(0)
    expect(res.timedOut).toBe(false)
    expect(res.stdout.trim()).toBe("sync-ok")
  })

  it("times out instead of hanging", () => {
    const sleeperScript = writeTmpScript("sync-sleeper", "setTimeout(()=>{},60000)")
    const res = runGuardedSync(process.execPath, [sleeperScript], { timeoutMs: 300 })
    expect(res.timedOut).toBe(true)
  })
})

describe("installProcessExitHandlers (v0.30 zombie fix)", () => {
  beforeEach(() => {
    // v0.30.1: tear down any leftover listeners from previous test files
    // before resetting the once-flag, otherwise pollutes the bun runner.
    resetOrphanSweepGuardForTests()
  })

  afterEach(() => {
    // v0.30.1: uninstall the listeners we just installed so they do NOT
    // fire between this file and the next — the ~5s PowerShell sweep
    // in cleanup() would exceed the per-test 5s timeout and break isolation.
    resetOrphanSweepGuardForTests()
  })

  it("is idempotent - second call returns false (already installed)", () => {
    expect(isOrphanSweepInstalled()).toBe(false)
    const first = installProcessExitHandlers()
    expect(first).toBe(true)
    const second = installProcessExitHandlers()
    expect(second).toBe(false)
    expect(isOrphanSweepInstalled()).toBe(true)
  })

  it("killOrphanedToolProcesses can be called repeatedly without once-guard", () => {
    // First call should succeed (returns >= 0)
    const first = killOrphanedToolProcesses()
    expect(first).toBeGreaterThanOrEqual(0)
    // Second call should ALSO succeed (the guard is gone)
    const second = killOrphanedToolProcesses()
    expect(second).toBeGreaterThanOrEqual(0)
    // Third call too
    const third = killOrphanedToolProcesses()
    expect(third).toBeGreaterThanOrEqual(0)
  })
})




describe("signal handler self-kill (v0.34.2 P0-1 regression)", () => {
  it("then no handler calls process.kill(process.pid, signal) on itself", () => {
    const src = readFileSync("src/proc-guard.ts", "utf-8")
    // Extract the onSignal arrow body. Strip comments so the v0.34.2
    // changelog mention in a comment does not trip the assertion.
    const blockMatch = src.match(/const\s+onSignal[\s\S]*?\n  \}/)
    const rawBlock = blockMatch ? blockMatch[0] : ""
    const codeOnly = rawBlock
      .split("\n")
      .map((l) => l.replace(/\/\/.*$/, ""))
      .join("\n")
    const hasCall = /process\.kill\(\s*process\.pid\s*,/.test(codeOnly)
    expect(hasCall).toBe(false)
  })

  it("then onSignal body uses process.exit", () => {
    const src = readFileSync("src/proc-guard.ts", "utf-8")
    const blockMatch = src.match(/const\s+onSignal[\s\S]*?\n  \}/)
    const block = blockMatch ? blockMatch[0] : ""
    expect(block).toContain("process.exit")
  })
})