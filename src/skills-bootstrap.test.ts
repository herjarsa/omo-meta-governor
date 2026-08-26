import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { execSync } from "node:child_process"
import { bootstrapChoreSkills } from "./skills-bootstrap.js"

async function makeChoreTarball(tarballDir: string, slug: string, body: string): Promise<void> {
  // Pack <slug>/SKILL.md directly into chore.tar.gz so bootstrapChoreSkills
  // sees top-level <slug>/ dirs after `tar -xzf`.
  const staged = join(tarballDir, "_stage", slug)
  mkdirSync(staged, { recursive: true })
  writeFileSync(join(staged, "SKILL.md"), body)
  const tarPath = join(tarballDir, "chore.tar.gz")
  execSync(`tar -czf "${tarPath}" -C "${join(tarballDir, "_stage")}" "${slug}"`)
  rmSync(join(tarballDir, "_stage"), { recursive: true, force: true })
}

describe("bootstrapChoreSkills", () => {
  let tmpRoot: string
  let globalDir: string
  let tarballDir: string
  let tarballPath: string

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "skills-bootstrap-"))
    globalDir = join(tmpRoot, "skills")
    tarballDir = join(tmpRoot, "tarballs")
    mkdirSync(globalDir)
    mkdirSync(tarballDir)
    tarballPath = join(tarballDir, "chore.tar.gz")
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  test("extracts missing skills to global dir", async () => {
    const body = `---
name: test-skill
description: A test
---
# Test body`
    await makeChoreTarball(tarballDir, "test-skill", body)

    const result = await bootstrapChoreSkills({
      globalDir, tarballPath, pluginVersion: "0.35.0",
    })
    expect(result.extracted).toContain("test-skill")
    expect(existsSync(join(globalDir, "test-skill", "SKILL.md"))).toBe(true)
  })

  test("is idempotent: skips existing skills with matching hash", async () => {
    // First run
    const body = `---
name: test-skill
description: A test
---
# Test body`
    await makeChoreTarball(tarballDir, "test-skill", body)
    await bootstrapChoreSkills({ globalDir, tarballPath, pluginVersion: "0.35.0" })

    // Second run
    const result = await bootstrapChoreSkills({
      globalDir, tarballPath, pluginVersion: "0.35.0",
    })
    expect(result.extracted).not.toContain("test-skill")
    expect(result.skipped).toContain("test-skill")
  })

  test("warns and skips user-modified skills (hash mismatch)", async () => {
    const body = `---
name: test-skill
description: Original
---
# Original`
    await makeChoreTarball(tarballDir, "test-skill", body)
    await bootstrapChoreSkills({ globalDir, tarballPath, pluginVersion: "0.35.0" })

    // User modifies the local copy
    const modified = `---
name: test-skill
description: Modified by user
---
# User body`
    writeFileSync(join(globalDir, "test-skill", "SKILL.md"), modified)

    const result = await bootstrapChoreSkills({
      globalDir, tarballPath, pluginVersion: "0.35.0",
    })
    expect(result.warned).toContain("test-skill")
    // Local copy unchanged
    expect(readFileSync(join(globalDir, "test-skill", "SKILL.md"), "utf8"))
      .toContain("Modified by user")
  })

  test("writes manifest with hashes after successful extraction", async () => {
    const body = `---
name: test-skill
description: A test
---
# Test body`
    await makeChoreTarball(tarballDir, "test-skill", body)

    await bootstrapChoreSkills({ globalDir, tarballPath, pluginVersion: "0.35.0" })
    const manifestPath = join(globalDir, ".omo-meta-governor-checksums.json")
    expect(existsSync(manifestPath)).toBe(true)
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
    expect(manifest.version).toBe("0.35.0")
    expect(manifest.skills["test-skill"]).toMatch(/^sha256:/)
  })
})
