/**
 * skills-catalog.test.ts - unit tests for the v0.35.8 global catalog model.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  globalSkillsRoot,
  ensureProjectLocalLink,
  listGlobalSkills,
  setGlobalSkillsRootOverride,
  skillSlugFromId,
} from "./skills-catalog"

const _tmpHomes: string[] = []
function fakeHome(): string {
  const p = mkdtempSync(join(tmpdir(), "omo-catalog-"))
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

describe("skillSlugFromId", () => {
  it("then returns the last path segment", () => {
    expect(skillSlugFromId("owner/repo/skill")).toBe("skill")
    expect(skillSlugFromId("owner/repo")).toBe("repo")
    expect(skillSlugFromId("single")).toBe("single")
  })
  it("then strips trailing slashes", () => {
    expect(skillSlugFromId("owner/repo/skill/")).toBe("skill")
    expect(skillSlugFromId("owner/repo///")).toBe("repo")
  })
})

describe("globalSkillsRoot", () => {
  it("then resolves to <homedir>/.agents/skills by default", () => {
    expect(globalSkillsRoot()).toMatch(/[/\\]\.agents[/\\]skills$/)
  })
  it("then respects setGlobalSkillsRootOverride", () => {
    const fake = fakeHome()
    setGlobalSkillsRootOverride(fake)
    expect(globalSkillsRoot()).toBe(join(fake, ".agents", "skills"))
  })
})

describe("ensureProjectLocalLink", () => {
  it("then returns ok=false when global cache has no entry for the slug", () => {
    const home = fakeHome()
    setGlobalSkillsRootOverride(home)
    const project = fakeHome()
    const r = ensureProjectLocalLink("owner/missing-skill", project)
    expect(r.ok).toBe(false)
    expect(r.reason).toContain("Global cache miss")
  })

  it("then returns noop-already-exists when local entry already exists", () => {
    const home = fakeHome()
    setGlobalSkillsRootOverride(home)
    const slug = "exists-skill"
    mkdirSync(join(home, ".agents", "skills", slug), { recursive: true })
    writeFileSync(join(home, ".agents", "skills", slug, "SKILL.md"), "---\nname: x\n---\n")
    const project = fakeHome()
    mkdirSync(join(project, ".agents", "skills", slug), { recursive: true })
    const r = ensureProjectLocalLink("owner/" + slug, project)
    expect(r.mechanism).toBe("noop-already-exists")
    expect(r.ok).toBe(true)
  })

  it("then creates a symlink (junction on Windows) when global entry exists", () => {
    const home = fakeHome()
    setGlobalSkillsRootOverride(home)
    const slug = "linkable-skill"
    mkdirSync(join(home, ".agents", "skills", slug), { recursive: true })
    writeFileSync(join(home, ".agents", "skills", slug, "SKILL.md"), "---\nname: x\n---\n")
    const project = fakeHome()
    const r = ensureProjectLocalLink("owner/" + slug, project)
    expect(r.ok).toBe(true)
    // Accept either symlink or copy depending on platform permissions
    expect(["symlink", "copy"]).toContain(r.mechanism)
  })

  it("then is idempotent (calling twice does not fail)", () => {
    const home = fakeHome()
    setGlobalSkillsRootOverride(home)
    const slug = "idempotent-skill"
    mkdirSync(join(home, ".agents", "skills", slug), { recursive: true })
    writeFileSync(join(home, ".agents", "skills", slug, "SKILL.md"), "---\nname: x\n---\n")
    const project = fakeHome()
    const r1 = ensureProjectLocalLink("owner/" + slug, project)
    const r2 = ensureProjectLocalLink("owner/" + slug, project)
    expect(r1.ok).toBe(true)
    expect(r2.mechanism).toBe("noop-already-exists")
  })
})

describe("listGlobalSkills", () => {
  it("then returns empty when global root is missing", () => {
    const home = fakeHome()
    setGlobalSkillsRootOverride(home)
    expect(listGlobalSkills()).toEqual([])
  })

  it("then lists entries in the global cache", () => {
    const home = fakeHome()
    setGlobalSkillsRootOverride(home)
    mkdirSync(join(home, ".agents", "skills", "alpha"), { recursive: true })
    mkdirSync(join(home, ".agents", "skills", "beta"), { recursive: true })
    const got = listGlobalSkills().sort()
    expect(got).toEqual(["alpha", "beta"])
  })
})