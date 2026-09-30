/**
 * P5 (ENOENT sisyphus-mandatory) — missing-file behaviour of loadProtocol.
 *
 * given/when/then style. Covers:
 * - (a) loadProtocol on a nonexistent path returns "" and does NOT throw
 * - (b) buildSystemInjection("") still emits the embedded rules
 * - (c) loadProtocol on an existing file returns its content
 * - (d) loadProtocol on a directory (EISDIR, a REAL error) still throws
 */
import { describe, expect, it, afterEach } from "bun:test"
import { mkdir, writeFile, rm } from "node:fs/promises"
import { resolve } from "node:path"
import { tmpdir } from "node:os"
import { loadProtocol, buildSystemInjection } from "./protocol-enforcer"

let tempDir = ""

async function makeTempDir(): Promise<string> {
  const dir = resolve(tmpdir(), `proto-missing-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await mkdir(dir, { recursive: true })
  tempDir = dir
  return dir
}

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true })
    tempDir = ""
  }
})

describe("protocol-missing-file (P5)", () => {
  it("(a) then returns empty string without throwing for a nonexistent path", async () => {
    // given — a path that was never created
    const dir = await makeTempDir()
    const missing = resolve(dir, "does-not-exist.md")

    // when
    const result = await loadProtocol(missing)

    // then — graceful degradation, no ENOENT propagation
    expect(result).toBe("")
  })

  it("(b) then still emits the embedded rules for empty protocol text", async () => {
    // given — the "" fallback loadProtocol returns when the file is missing
    // when
    const result = buildSystemInjection("")

    // then — the hardcoded embedded rules still inject. Rule 4 (Oracle) is
    // conditional on /\boracle\b/i so it is absent for "" by design; every
    // other rule (1,2,3,5,6,7,8,9) must be present.
    expect(result).toContain("Tool Routing Table")
    expect(result).toContain("Pre-response Memory Check")
    expect(result).toContain("Codebase Graph First")
    expect(result).toContain("Parallel Query Rule")
    expect(result).toContain("Empty-Result Escalation")
    expect(result).toContain("Hard Rules")
    expect(result).toContain("Self-Check Before Responding")
    expect(result).toContain("CI Verification Loop")
    expect(result).not.toContain("Post-task Oracle Verification")
  })

  it("(c) then returns file content when the file exists", async () => {
    // given
    const dir = await makeTempDir()
    const filePath = resolve(dir, "protocol.md")
    await writeFile(filePath, "# Custom Protocol\n\nExtra context with oracle keyword.", "utf-8")

    // when
    const result = await loadProtocol(filePath)

    // then
    expect(result).toContain("Custom Protocol")
  })

  it("(d) then propagates non-ENOENT errors such as EISDIR", async () => {
    // given — a directory as path: readFile fails with EISDIR, a REAL error
    const dir = await makeTempDir()

    // when/then — must NOT be swallowed
    let thrown: unknown
    try {
      await loadProtocol(dir)
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeDefined()
    expect((thrown as NodeJS.ErrnoException).code).not.toBe("ENOENT")
  })
})
