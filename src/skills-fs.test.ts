import { describe, expect, test } from "bun:test"
import { parseSkillFrontmatter } from "./skills-fs.js"

describe("parseSkillFrontmatter", () => {
  test("parses valid frontmatter", () => {
    const md = `---
name: brainstorming
description: Use when creating features
---
# Body content here`
    const result = parseSkillFrontmatter(md)
    expect(result.name).toBe("brainstorming")
    expect(result.description).toBe("Use when creating features")
    expect(result.raw).toContain("Body content here")
  })

  test("throws on missing frontmatter", () => {
    const md = `# No frontmatter here`
    expect(() => parseSkillFrontmatter(md)).toThrow(/frontmatter/)
  })

  test("throws on malformed YAML", () => {
    const md = `---
name: [invalid
---`
    expect(() => parseSkillFrontmatter(md)).toThrow(/frontmatter/)
  })

  test("handles empty description", () => {
    const md = `---
name: foo
description:
---
# body`
    const result = parseSkillFrontmatter(md)
    expect(result.name).toBe("foo")
    expect(result.description).toBe("")
  })
})
