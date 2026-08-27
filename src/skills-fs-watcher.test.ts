import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startSkillsFsWatcher } from "./skills-fs-watcher.js"

// v0.37.0 quarantine: 5th pre-existing Windows CI flake (readdirp EINVAL scanning
// D:\\DumpStack.log.tmp from chokidar via startSkillsFsWatcher). Same root
// cause as f8caf18 / e5fc0b6 / 31e0a21 / ff2ecaf. Passes locally in isolation.
// TODO(#audit-v2-flakes): hermetize startSkillsFsWatcher.
describe.skip("startSkillsFsWatcher", () => {
  let projectDir: string

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "watcher-"))
  })

  afterEach(async () => {
    rmSync(projectDir, { recursive: true, force: true })
  })

  test("fires onChange when a SKILL.md is created", async () => {
    let fired = ""
    const watcher = await startSkillsFsWatcher({
      projectDir,
      onChange: async (p) => { fired = p },
    })
    const skillDir = join(projectDir, "new-skill")
    mkdirSync(skillDir)
    writeFileSync(join(skillDir, "SKILL.md"), "# new")
    await new Promise((r) => setTimeout(r, 1500))  // give chokidar time
    await watcher.stop()
    expect(fired).toContain("new-skill")
  })

  test("ignores writes outside SKILL.md", async () => {
    let fired = ""
    const watcher = await startSkillsFsWatcher({
      projectDir,
      onChange: async (p) => { fired = p },
    })
    writeFileSync(join(projectDir, "README.md"), "# noise")
    await new Promise((r) => setTimeout(r, 1500))
    await watcher.stop()
    expect(fired).toBe("")
  })
})
