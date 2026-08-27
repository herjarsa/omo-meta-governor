/**
 * skills-local-link-tool.test.ts - unit tests for omo_skill_local_link (v0.35.8).
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildOmoSkillLocalLinkTool } from "./skills-local-link-tool"
import { setGlobalSkillsRootOverride } from "./skills-catalog"

const _tmpHomes: string[] = []
function fakeHome(): string {
  const p = mkdtempSync(join(tmpdir(), "omo-linktool-"))
  _tmpHomes.push(p)
  return p
}

afterEach(() => {
  setGlobalSkillsRootOverride(null)
  while (_tmpHomes.length > 0) {
    const p = _tmpHomes.pop()!
    try { rmSync(p, { recursive: true, force: true }) } catch {}
  }
})

describe("omo_skill_local_link", () => {
  it("then returns the global cache listing when no id is given", async () => {
    const home = fakeHome()
    setGlobalSkillsRootOverride(home)
    mkdirSync(join(home, ".agents", "skills", "alpha"), { recursive: true })
    mkdirSync(join(home, ".agents", "skills", "beta"), { recursive: true })
    const t = buildOmoSkillLocalLinkTool({ cwd: "D:\\app" })
    const result = await (t.execute as any)({}, { sessionID: "x" })
    expect(result.metadata.count).toBe(2)
    expect(result.output).toContain("alpha")
    expect(result.output).toContain("beta")
  })

  it("then links global -> project when id is given and global entry exists", async () => {
    const home = fakeHome()
    setGlobalSkillsRootOverride(home)
    const slug = "linkable"
    mkdirSync(join(home, ".agents", "skills", slug), { recursive: true })
    writeFileSync(join(home, ".agents", "skills", slug, "SKILL.md"),
      `---\nname: linkable\n---\n`)
    const project = fakeHome()
    const t = buildOmoSkillLocalLinkTool({ cwd: project })
    const result = await (t.execute as any)(
      { id: "owner/" + slug },
      { sessionID: "x" },
    )
    expect(result.metadata.ok).toBe(true)
    expect(["symlink", "copy"]).toContain(result.metadata.mechanism)
    expect(result.metadata.localPath).toBe(join(project, ".agents", "skills", slug))
  })

  it("then returns ok=false when global entry is missing", async () => {
    const home = fakeHome()
    setGlobalSkillsRootOverride(home)
    const project = fakeHome()
    const t = buildOmoSkillLocalLinkTool({ cwd: project })
    const result = await (t.execute as any)(
      { id: "owner/nonexistent" },
      { sessionID: "x" },
    )
    expect(result.metadata.ok).toBe(false)
    expect(result.metadata.mechanism).toBe("noop-already-exists")
    expect(result.output).toContain("Global cache miss")
  })

  it("then reports noop-already-exists when the local entry already exists", async () => {
    const home = fakeHome()
    setGlobalSkillsRootOverride(home)
    const slug = "preexisting"
    mkdirSync(join(home, ".agents", "skills", slug), { recursive: true })
    const project = fakeHome()
    mkdirSync(join(project, ".agents", "skills", slug), { recursive: true })
    const t = buildOmoSkillLocalLinkTool({ cwd: project })
    const result = await (t.execute as any)(
      { id: "owner/" + slug },
      { sessionID: "x" },
    )
    expect(result.metadata.mechanism).toBe("noop-already-exists")
    expect(result.metadata.ok).toBe(true)
  })
})