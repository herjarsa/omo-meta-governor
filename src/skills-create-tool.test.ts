/**
 * skills-create-tool.test.ts - unit tests for omo_skill_create (v0.35.9).
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildOmoSkillCreateTool } from "../src/skills-create-tool"

const _tmpProjects: string[] = []
function fakeProject(): string {
  const p = mkdtempSync(join(tmpdir(), "omo-create-"))
  _tmpProjects.push(p)
  return p
}

afterEach(() => {
  while (_tmpProjects.length > 0) {
    const p = _tmpProjects.pop()!
    try { rmSync(p, { recursive: true, force: true }) } catch {}
  }
})

describe("omo_skill_create", () => {
  it("then creates SKILL.md with valid frontmatter at <project>/.agents/skills/<slug>/", async () => {
    const cwd = fakeProject()
    const t = buildOmoSkillCreateTool({ cwd })
    const result = await (t.execute as any)(
      {
        id: "owner-or-team/my-skill",
        description: "Does a thing for a purpose",
        body: "## When to use\n\nWhen you need the thing.",
      },
      { sessionID: "x" },
    )
    expect(result.metadata.ok).toBe(true)
    const expected = join(cwd, ".agents", "skills", "my-skill", "SKILL.md")
    expect(result.metadata.path).toBe(expected)
    expect(existsSync(expected)).toBe(true)
    const md = readFileSync(expected, "utf8")
    expect(md.startsWith("---\n")).toBe(true)
    expect(md).toContain('name: my-skill')
    expect(md).toContain('description: "Does a thing for a purpose"')
  })

  it("then refuses to clobber an existing SKILL.md unless overwrite=true", async () => {
    const cwd = fakeProject()
    const t = buildOmoSkillCreateTool({ cwd })
    await (t.execute as any)(
      { id: "team/clobber", description: "first body", body: "first body body body" },
      { sessionID: "x" },
    )
    const result = await (t.execute as any)(
      { id: "team/clobber", description: "second body", body: "second body body body" },
      { sessionID: "x" },
    )
    expect(result.metadata.ok).toBe(false)
    expect(result.metadata.reason).toBe("already-exists")
    const md = readFileSync(join(cwd, ".agents", "skills", "clobber", "SKILL.md"), "utf8")
    expect(md).toContain("first body")
    expect(md).not.toContain("second body")
  })

  it("then overwrites an existing SKILL.md when overwrite=true", async () => {
    const cwd = fakeProject()
    const t = buildOmoSkillCreateTool({ cwd })
    await (t.execute as any)(
      { id: "team/overwrite-me", description: "old", body: "old body body body" },
      { sessionID: "x" },
    )
    const result = await (t.execute as any)(
      {
        id: "team/overwrite-me",
        description: "new",
        body: "new body body body",
        overwrite: true,
      },
      { sessionID: "x" },
    )
    expect(result.metadata.ok).toBe(true)
    expect(result.metadata.existed).toBe(true)
    const md = readFileSync(join(cwd, ".agents", "skills", "overwrite-me", "SKILL.md"), "utf8")
    expect(md).toContain('description: "new"')
    expect(md).toContain("new body body body")
  })

  it("then derives slug from the last path segment of the id", async () => {
    const cwd = fakeProject()
    const t = buildOmoSkillCreateTool({ cwd })
    const result = await (t.execute as any)(
      { id: "company/division/cool-skill", description: "test desc", body: "x".repeat(30) },
      { sessionID: "x" },
    )
    expect(result.metadata.slug).toBe("cool-skill")
    expect(existsSync(join(cwd, ".agents", "skills", "cool-skill", "SKILL.md"))).toBe(true)
  })
})