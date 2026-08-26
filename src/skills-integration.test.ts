import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { findSkill, searchSkills } from "./skills-resolver.js"

describe("3-tier resolver integration", () => {
  let tmp: string
  let choreDir: string
  let projectDir: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "int-"))
    choreDir = join(tmp, "chore")
    projectDir = join(tmp, "project")
    mkdirSync(choreDir)
    mkdirSync(projectDir)
  })

  afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

  test("end-to-end: project beats chore beats hub", async () => {
    // chore has "alpha"
    mkdirSync(join(choreDir, "alpha"))
    writeFileSync(join(choreDir, "alpha", "SKILL.md"),
      "---\nname: Alpha Chore\ndescription: chore alpha\n---\n# body")
    // project has "beta"
    mkdirSync(join(projectDir, "beta"))
    writeFileSync(join(projectDir, "beta", "SKILL.md"),
      "---\nname: Beta Project\ndescription: project beta\n---\n# body")
    // hub has "gamma"
    const state = {
      choreDir, projectDir,
      hubSearch: async (q: string) => q === "gamma"
        ? [{ slug: "gamma", name: "Gamma Hub", description: "hub gamma" }]
        : [],
    }
    expect((await findSkill("alpha", state))?.source).toBe("chore")
    expect((await findSkill("beta", state))?.source).toBe("custom")
    expect((await findSkill("gamma", state))?.source).toBe("hub")
  })

  test("hub-materialized skill appears in project after write", async () => {
    const state = {
      choreDir, projectDir,
      hubSearch: async () => [{
        slug: "mat-skill", name: "Mat", description: "materialized",
      }],
    }
    const r1 = await findSkill("mat-skill", state)
    expect(r1?.source).toBe("hub")

    // simulate materialization
    mkdirSync(join(projectDir, "mat-skill"))
    writeFileSync(join(projectDir, "mat-skill", "SKILL.md"),
      "---\nname: Mat\ndescription: materialized\n---\n# body")

    const r2 = await findSkill("mat-skill", state)
    expect(r2?.source).toBe("custom")
  })

  test("tier-3 rescan: new file in project dir becomes discoverable", async () => {
    const state = {
      choreDir, projectDir,
      hubSearch: async () => [],
    }
    expect((await findSkill("custom-foo", state))).toBeNull()

    // simulate agent writing a new skill
    mkdirSync(join(projectDir, "custom-foo"))
    writeFileSync(join(projectDir, "custom-foo", "SKILL.md"),
      "---\nname: Custom Foo\ndescription: a custom skill\n---\n# body")

    const r = await findSkill("custom-foo", state)
    expect(r?.source).toBe("custom")
  })

  test("precedence end-to-end: project overrides hub with same slug", async () => {
    const state = {
      choreDir, projectDir,
      hubSearch: async () => [{
        slug: "conflict", name: "Hub Conflict", description: "hub version",
      }],
    }
    // before any project write: hub wins (no project file)
    expect((await findSkill("conflict", state))?.source).toBe("hub")

    // after agent writes a project-local copy: project wins
    mkdirSync(join(projectDir, "conflict"))
    writeFileSync(join(projectDir, "conflict", "SKILL.md"),
      "---\nname: Project Conflict\ndescription: project version\n---\n# body")

    expect((await findSkill("conflict", state))?.source).toBe("custom")
  })
})
