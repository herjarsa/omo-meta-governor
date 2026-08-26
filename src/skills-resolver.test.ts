import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { findSkill, searchSkills } from "./skills-resolver.js"

function makeSkill(dir: string, slug: string, name: string, description: string) {
  const skillDir = join(dir, slug)
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n# body`)
}

describe("resolver precedence", () => {
  let tmpRoot: string
  let choreDir: string
  let projectDir: string

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "resolver-"))
    choreDir = join(tmpRoot, "chore")
    projectDir = join(tmpRoot, "project")
    mkdirSync(choreDir)
    mkdirSync(projectDir)
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  test("project-local beats chore global for same slug", async () => {
    makeSkill(choreDir, "brainstorming", "Chore Brainstorming", "from chore")
    makeSkill(projectDir, "brainstorming", "Project Brainstorming", "from project")
    const state = {
      choreDir, projectDir,
      hubSearch: async () => [],
    }
    const r = await findSkill("brainstorming", state)
    expect(r?.source).toBe("custom")
    expect(r?.tier).toBe(3)
    expect(r?.name).toBe("Project Brainstorming")
  })

  test("chore global used when project-local missing", async () => {
    makeSkill(choreDir, "brainstorming", "Chore Only", "from chore")
    const state = {
      choreDir, projectDir,
      hubSearch: async () => [],
    }
    const r = await findSkill("brainstorming", state)
    expect(r?.source).toBe("chore")
    expect(r?.tier).toBe(1)
  })

  test("hub catalog used when neither fs tier matches", async () => {
    const state = {
      choreDir, projectDir,
      hubSearch: async (q, l) => q === "vercel-deploy"
        ? [{ slug: "vercel-deploy", name: "Vercel Deploy", description: "deploy to vercel" }]
        : [],
    }
    const r = await findSkill("vercel-deploy", state)
    expect(r?.source).toBe("hub")
    expect(r?.tier).toBe(2)
    expect(r?.path).toBeNull()
    expect(r?.contentHash).toBeNull()
  })

  test("searchSkills dedupes by slug with higher tier winning", async () => {
    makeSkill(choreDir, "foo", "Foo Chore", "chore foo")
    makeSkill(projectDir, "foo", "Foo Project", "project foo")
    const state = {
      choreDir, projectDir,
      hubSearch: async () => [],
    }
    const results = await searchSkills("foo", state)
    expect(results.length).toBe(1)
    expect(results[0]?.source).toBe("custom")
  })

  test("tier filter restricts to chore only", async () => {
    makeSkill(choreDir, "a", "A", "alpha")
    makeSkill(projectDir, "b", "B", "beta")
    const state = {
      choreDir, projectDir,
      hubSearch: async () => [{ slug: "c", name: "C", description: "gamma" }],
    }
    const results = await searchSkills("", state, { tier: "chore" })
    expect(results.length).toBe(1)
    expect(results[0]?.source).toBe("chore")
  })

  test("tier filter 'hub' only returns catalog matches", async () => {
    makeSkill(choreDir, "a", "A", "alpha")
    const state = {
      choreDir, projectDir,
      hubSearch: async () => [{ slug: "hub-skill", name: "H", description: "hub desc" }],
    }
    const results = await searchSkills("", state, { tier: "hub" })
    expect(results.length).toBe(1)
    expect(results[0]?.source).toBe("hub")
  })

  test("returns empty array when no tier has matches", async () => {
    const state = {
      choreDir, projectDir,
      hubSearch: async () => [],
    }
    const results = await searchSkills("nothing", state)
    expect(results).toEqual([])
  })

  test("path field reflects absolute file location for fs tiers", async () => {
    makeSkill(choreDir, "x", "X", "test")
    const state = {
      choreDir, projectDir,
      hubSearch: async () => [],
    }
    const r = await findSkill("x", state)
    expect(r?.path).toBe(join(choreDir, "x", "SKILL.md"))
  })

  test("isMaterialized=true labels project-local as hub-materialized", async () => {
    makeSkill(projectDir, "hub-skill", "Hub Skill", "from hub")
    const state = {
      choreDir, projectDir,
      hubSearch: async () => [],
      isMaterialized: async (s: string) => s === "hub-skill",
    }
    const r = await findSkill("hub-skill", state)
    expect(r?.source).toBe("hub-materialized")
    expect(r?.tier).toBe(3)
  })
})
