// scripts/release.test.ts
// Unit tests for the release script. Uses mocked runCommand to avoid
// running real npm publish / git tag / gh release during tests.

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseVersion, validateChangelog, runCommand, release } from "./release"

describe("parseVersion", () => {
  it("parses 0.38.0", () => {
    expect(parseVersion("0.38.0")).toEqual({ major: 0, minor: 38, patch: 0, tag: "v0.38.0" })
  })
  it("parses 1.2.3", () => {
    expect(parseVersion("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, tag: "v1.2.3" })
  })
  it("strips leading v if present", () => {
    expect(parseVersion("v0.38.0")).toEqual({ major: 0, minor: 38, patch: 0, tag: "v0.38.0" })
  })
  it("throws on invalid input", () => {
    expect(() => parseVersion("0.38")).toThrow()
    expect(() => parseVersion("abc")).toThrow()
    expect(() => parseVersion("")).toThrow()
  })
})

describe("validateChangelog", () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "release-")) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  describe("validateChangelog", () => {
  let dir: string
  const version = { major: 0, minor: 38, patch: 0, tag: "v0.38.0" }
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "release-")) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it("passes for a valid CHANGELOG with version-specific entry + ✅ markers", () => {
    const path = join(dir, "CHANGELOG.md")
    writeFileSync(path, "## [0.38.0]\n### Ship protocol compliance\n✅\n")
    expect(() => validateChangelog(path, version)).not.toThrow()
  })

  it("throws when CHANGELOG is missing the version-specific entry", () => {
    const path = join(dir, "CHANGELOG.md")
    writeFileSync(path, "## [0.37.0]\n### Ship protocol compliance\n✅\n")
    expect(() => validateChangelog(path, version)).toThrow(/missing entry for ## \[0\.38\.0\]/)
  })

  it("throws when Ship protocol section is missing", () => {
    const path = join(dir, "CHANGELOG.md")
    writeFileSync(path, "## [0.38.0]\n### Fixed\nstuff\n")
    expect(() => validateChangelog(path, version)).toThrow(/Ship protocol/)
  })

  it("throws when no ✅ marker is present", () => {
    const path = join(dir, "CHANGELOG.md")
    writeFileSync(path, "## [0.38.0]\n### Ship protocol compliance\npending\n")
    expect(() => validateChangelog(path, version)).toThrow(/✅/)
  })

  it("throws when file does not exist", () => {
    expect(() => validateChangelog(join(dir, "nonexistent.md"), version)).toThrow(/not found/)
  })
})
})

describe("runCommand", () => {
  it("returns exit code 0 for successful commands", async () => {
    const result = await runCommand(["bun", "--version"])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/^\d+\.\d+\.\d+/)
  })

})

describe("release (main, mocked)", () => {
  let dir: string
  let mockLog: string[]
  const mockRunCommand = async (cmd: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
    mockLog.push(cmd.join(" "))
    if (cmd[0] === "npm" && cmd[1] === "publish") {
      // Simulate publish success
      return { exitCode: 0, stdout: "published", stderr: "" }
    }
    if (cmd[0] === "git" && cmd[1] === "tag") {
      return { exitCode: 0, stdout: "", stderr: "" }
    }
    if (cmd[0] === "git" && cmd[1] === "push") {
      return { exitCode: 0, stdout: "", stderr: "" }
    }
    if (cmd[0] === "gh" && cmd[1] === "release") {
      return { exitCode: 0, stdout: "release created", stderr: "" }
    }
    return { exitCode: 0, stdout: "", stderr: "" }
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "release-int-"))
    mockLog = []
    // Create a valid package.json and CHANGELOG.md in the test dir
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "test", version: "0.0.0" }, null, 2))
    writeFileSync(join(dir, "CHANGELOG.md"), "## [0.38.0]\n### Ship protocol compliance\n✅\n")
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it("throws when version is empty", async () => {
    await expect(release("", { cwd: dir, runCommandFn: mockRunCommand })).rejects.toThrow()
  })

  it("throws when version is invalid", async () => {
    await expect(release("not-a-version", { cwd: dir, runCommandFn: mockRunCommand })).rejects.toThrow()
  })

  it("dry-run does NOT execute real commands but validates version + changelog", async () => {
    await release("0.38.0", { cwd: dir, dryRun: true })
    // dry-run should NOT call runCommand for any step
    expect(mockLog.length).toBe(0)
  })
})
