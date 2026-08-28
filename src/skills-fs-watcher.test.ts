import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startSkillsFsWatcher } from "./skills-fs-watcher.js"

// v0.37.2 quarantine: pre-existing Windows CI flake — chokidar/readdirp
// scans D:\ on Windows runners, raising EINVAL on D:\DumpStack.log.tmp /
// D:\pagefile.sys. This test invokes startSkillsFsWatcher directly (not
// through the plugin's __test_startSkillsFsWatcher DI seam), so the v0.37.1
// hermetic stub does NOT cover it. The hermetic stub is wired through
// MetaGovernorPluginDeps for plugin-mode tests, not for direct calls.
// Tests pass on Linux + macOS runners.
// TODO(#skills-fs-watcher-windows): refactor to use a mock watcher (the
// same DI seam the plugin uses) instead of real chokidar.
// v0.38.0 un-quarantine: the global error handler (src/error-handler.ts) catches
// chokidar/readdirp EINVAL errors on D:\ system paths, so this test no longer
// crashes the bun test runner. The 1.5s setTimeout gives chokidar enough time
// to scan the project dir and fire events.
describe("startSkillsFsWatcher", () => {
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
