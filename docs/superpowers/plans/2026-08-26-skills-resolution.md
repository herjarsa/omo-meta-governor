# Skills Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single-registry skills model with a 3-tier resolver that reads bundled chore skills, materializes hub skills on demand, and offers a writing-skills fallback when neither covers a query.

**Architecture:** Three registries (chore-fs, project-fs, hub-sqlite) feed a single pure resolver. The resolver returns `SkillDescriptor { slug, name, description, source, tier, path, contentHash }` with project-local > chore global > hub catalog precedence. Materialization (write to `<cwd>/.agents/skills/<slug>/SKILL.md`) is a side effect of `omo_skill_get` only. Tier-3 generation is advisory via a system reminder that points the agent at the bundled `writing-skills` chore skill.

**Tech Stack:** Bun 1.x runtime, TypeScript ESM strict, `node:crypto` SHA-256, `chokidar` for fs watching, `tar` for tarball extract, existing SQLite via `better-sqlite3` (via `SqliteBackend`), existing `skill-hub-sync.ts` (FTS5 catalog).

**Spec:** `docs/superpowers/specs/2026-08-26-skills-resolution-design.md` — read this before implementing.

## Global Constraints

- TypeScript ESM strict (`"strict": true` in `tsconfig.json`). No `any`, no `@ts-ignore`.
- Every commit must pass `bun test`, `npx tsc --noEmit`, and `bun run build`.
- Plugin must boot successfully even if every tier fails (warn-only, never throw).
- New code lives in `src/skills-*.ts` (filename prefix enforces visibility).
- The plugin never writes to `~/.agents/skills/` (read-only on the global chore dir).
- The plugin never injects skill content into prompts (registry-only, no force).
- SQLite migrations are additive only; existing rows must survive.
- MCP tool response shapes are additive (new fields, no removals/renames).
- Conventional commits with scope `skills` for feature commits.
- Per-wave Oracle review (`task(subagent_type="oracle", run_in_background=false)`) between tasks 1→2, 2→3, 3→4, 4→5.
- User-level `~/.config/opencode/omo-meta-governor.jsonc` has `skillPriming.enforceMode: "directive"` (changed from `"block"` to allow `write` tool during this work).

---

### Task 1: Tier 1 — Skills-fs scanner + chore bootstrap

**Files:**
- Create: `bundled-skills/.gitkeep` (empty dir marker for now)
- Create: `src/skills-bundled.ts`
- Create: `src/skills-fs.ts`
- Create: `src/skills-bootstrap.ts`
- Create: `src/skills-bootstrap.test.ts`
- Create: `src/skills-fs.test.ts`
- Modify: `src/config.ts` (add `skillHub.choreDir` field)
- Modify: `build.ts` (add `build:skills` task that packs `bundled-skills/` → `dist/skills/chore.tar.gz`)
- Test: `bun test src/skills-fs.test.ts src/skills-bootstrap.test.ts`

**Interfaces:**
- Consumes: nothing (this is the foundation)
- Produces:
  ```ts
  // src/skills-bundled.ts
  export const CHORE_SKILLS: readonly string[]  // 16 slugs

  // src/skills-fs.ts
  export interface ParsedSkillFrontmatter {
    name: string
    description: string
    raw: string  // full body for embedding
  }
  export function parseSkillFrontmatter(content: string): ParsedSkillFrontmatter
                                        // throws Error if frontmatter missing or malformed
  export function scanSkillsDir(dir: string): Promise<Map<string, ParsedSkillFrontmatter>>

  // src/skills-bootstrap.ts
  export interface BootstrapResult {
    extracted: string[]      // slugs newly written
    skipped: string[]        // slugs already present with matching hash
    warned: string[]         // slugs mismatched (user modified)
    manifestWritten: boolean
  }
  export async function bootstrapChoreSkills(opts: {
    globalDir: string       // e.g. C:\Users\herna\.agents\skills
    tarballPath: string     // e.g. <pluginRoot>/dist/skills/chore.tar.gz
    pluginVersion: string
  }): Promise<BootstrapResult>
  ```

- [ ] **Step 1: Write failing test for `parseSkillFrontmatter`**

File: `src/skills-fs.test.ts`

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/skills-fs.test.ts`
Expected: FAIL — `./skills-fs.js` module not found

- [ ] **Step 3: Implement `parseSkillFrontmatter`**

File: `src/skills-fs.ts`

```ts
/**
 * Skills filesystem primitives — frontmatter parser and dir scanner.
 *
 * A skill is a directory containing a SKILL.md file with YAML frontmatter:
 *   ---
 *   name: brainstorming
 *   description: Use when creating features
 *   ---
 *   # Body content
 *
 * The raw body is preserved verbatim in `parsed.raw` so it can be returned
 * to the agent as the skill's full content.
 */

export interface ParsedSkillFrontmatter {
  name: string
  description: string
  raw: string
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/

function parseYamlBlock(block: string): Record<string, string> {
  // Minimal YAML parser for skill frontmatter: flat string keys only.
  // Avoids a full yaml lib dependency for ~20 lines of skill metadata.
  const out: Record<string, string> = {}
  for (const line of block.split(/\r?\n/)) {
    const m = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*):\s*(.*)$/)
    if (!m) continue
    const key = m[1]!
    let value = m[2] ?? ""
    // strip surrounding quotes if present
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

export function parseSkillFrontmatter(content: string): ParsedSkillFrontmatter {
  const match = FRONTMATTER_RE.exec(content)
  if (!match) {
    throw new Error("SKILL.md missing or malformed YAML frontmatter")
  }
  const yamlBlock = match[1] ?? ""
  const body = match[2] ?? ""
  const parsed = parseYamlBlock(yamlBlock)
  if (!parsed.name) {
    throw new Error("SKILL.md frontmatter missing required 'name' field")
  }
  return {
    name: parsed.name,
    description: parsed.description ?? "",
    raw: body,
  }
}

import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"

export async function scanSkillsDir(dir: string): Promise<Map<string, ParsedSkillFrontmatter>> {
  const out = new Map<string, ParsedSkillFrontmatter>()
  let entries: import("node:fs").Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return out  // dir doesn't exist or unreadable; return empty
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const skillPath = join(dir, entry.name, "SKILL.md")
    try {
      const content = await readFile(skillPath, "utf8")
      const parsed = parseSkillFrontmatter(content)
      out.set(entry.name, parsed)
    } catch (err) {
      // skip malformed skills; do not throw
      console.warn(`[skills-fs] skipping ${entry.name}: ${(err as Error).message}`)
    }
  }
  return out
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/skills-fs.test.ts`
Expected: PASS (4/4)

- [ ] **Step 5: Write failing test for `bootstrapChoreSkills`**

File: `src/skills-bootstrap.test.ts`

```ts
import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { bootstrapChoreSkills } from "./skills-bootstrap.js"

function makeTarball(skillsDir: string, slug: string, body: string): Buffer {
  // For testing, write a directory tree that bootstrap can read as if it were
  // an extracted tarball. We bypass the actual tarball format by writing a
  // single-skill directory tree directly to the target via the API.
  // The bootstrap function expects a tarball path; we generate a real tar.gz.
  const { execSync } = require("node:child_process")
  const staged = join(skillsDir, "_stage", slug)
  mkdirSync(staged, { recursive: true })
  writeFileSync(join(staged, "SKILL.md"), body)
  const tarPath = join(skillsDir, `${slug}.tar.gz`)
  execSync(`tar -czf "${tarPath}" -C "${join(skillsDir, "_stage")}" "${slug}"`)
  rmSync(join(skillsDir, "_stage"), { recursive: true, force: true })
  return readFileSync(tarPath)
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
    makeTarball(tarballDir, "test-skill", body)
    // rebuild as chore.tar.gz
    const { execSync } = require("node:child_process")
    execSync(`tar -czf "${tarballPath}" -C "${tarballDir}" "test-skill.tar.gz"`)

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
    makeTarball(tarballDir, "test-skill", body)
    const { execSync } = require("node:child_process")
    execSync(`tar -czf "${tarballPath}" -C "${tarballDir}" "test-skill.tar.gz"`)
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
    makeTarball(tarballDir, "test-skill", body)
    const { execSync } = require("node:child_process")
    execSync(`tar -czf "${tarballPath}" -C "${tarballDir}" "test-skill.tar.gz"`)
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
    makeTarball(tarballDir, "test-skill", body)
    const { execSync } = require("node:child_process")
    execSync(`tar -czf "${tarballPath}" -C "${tarballDir}" "test-skill.tar.gz"`)

    await bootstrapChoreSkills({ globalDir, tarballPath, pluginVersion: "0.35.0" })
    const manifestPath = join(globalDir, ".omo-meta-governor-checksums.json")
    expect(existsSync(manifestPath)).toBe(true)
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
    expect(manifest.version).toBe("0.35.0")
    expect(manifest.skills["test-skill"]).toMatch(/^sha256:/)
  })
})
```

- [ ] **Step 6: Run test to verify it fails**

Run: `bun test src/skills-bootstrap.test.ts`
Expected: FAIL — `./skills-bootstrap.js` module not found

- [ ] **Step 7: Implement `bootstrapChoreSkills`**

File: `src/skills-bootstrap.ts`

```ts
/**
 * Chore skills bootstrap — extracts bundled skills to ~/.agents/skills/
 * on first run and on plugin upgrade. Idempotent: skips slugs whose
 * SKILL.md hash matches the bundled copy.
 *
 * Manifest at ~/.agents/skills/.omo-meta-governor-checksums.json records
 * per-slug SHA-256 hashes so future runs can detect user modifications.
 */

import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile, stat } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { execSync } from "node:child_process"

export interface BootstrapResult {
  extracted: string[]
  skipped: string[]
  warned: string[]
  manifestWritten: boolean
}

const MANIFEST_FILENAME = ".omo-meta-governor-checksums.json"

async function hashFile(path: string): Promise<string> {
  const content = await readFile(path)
  return "sha256:" + createHash("sha256").update(content).digest("hex")
}

interface Manifest {
  version: string
  skills: Record<string, string>
}

async function readManifest(globalDir: string): Promise<Manifest | null> {
  const path = join(globalDir, MANIFEST_FILENAME)
  if (!existsSync(path)) return null
  try {
    return JSON.parse(await readFile(path, "utf8"))
  } catch {
    return null
  }
}

async function writeManifest(globalDir: string, manifest: Manifest): Promise<void> {
  await writeFile(
    join(globalDir, MANIFEST_FILENAME),
    JSON.stringify(manifest, null, 2),
    "utf8",
  )
}

export async function bootstrapChoreSkills(opts: {
  globalDir: string
  tarballPath: string
  pluginVersion: string
}): Promise<BootstrapResult> {
  const result: BootstrapResult = {
    extracted: [], skipped: [], warned: [], manifestWritten: false,
  }

  if (!existsSync(opts.tarballPath)) {
    console.warn(`[skills-bootstrap] tarball missing: ${opts.tarballPath}`)
    return result
  }

  // Extract tarball to a staging dir
  const stageDir = join(opts.globalDir, ".bootstrap-stage")
  await mkdir(stageDir, { recursive: true })
  try {
    execSync(
      `tar -xzf "${opts.tarballPath}" -C "${stageDir}"`,
      { stdio: ["ignore", "ignore", "pipe"] },
    )
  } catch (err) {
    console.warn(`[skills-bootstrap] tarball extraction failed: ${(err as Error).message}`)
    return result
  }

  const manifest = (await readManifest(opts.globalDir)) ?? {
    version: opts.pluginVersion, skills: {},
  }
  const newManifest: Manifest = {
    version: opts.pluginVersion,
    skills: { ...manifest.skills },
  }

  // Walk the staging dir: each top-level subdir is a skill slug
  const { readdir } = await import("node:fs/promises")
  const slugs = (await readdir(stageDir, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name)

  for (const slug of slugs) {
    const stagedSkill = join(stageDir, slug, "SKILL.md")
    if (!existsSync(stagedSkill)) continue
    const stagedHash = await hashFile(stagedSkill)
    const targetDir = join(opts.globalDir, slug)
    const targetSkill = join(targetDir, "SKILL.md")

    if (!existsSync(targetSkill)) {
      // Fresh install
      await mkdir(targetDir, { recursive: true })
      await execCopy(stagedSkill, targetSkill)
      result.extracted.push(slug)
    } else {
      // Check existing hash
      const existingHash = await hashFile(targetSkill)
      if (existingHash === stagedHash) {
        result.skipped.push(slug)
      } else {
        // User modified — skip + warn
        console.warn(
          `[skills-bootstrap] skill '${slug}' was modified by user; skipping. ` +
          `bundled: ${stagedHash}, local: ${existingHash}`,
        )
        result.warned.push(slug)
      }
    }
    newManifest.skills[slug] = stagedHash
  }

  // Clean up staging
  await execRemove(stageDir)

  // Write manifest
  await writeManifest(opts.globalDir, newManifest)
  result.manifestWritten = true

  return result
}

async function execCopy(src: string, dst: string): Promise<void> {
  // Cross-platform: use node fs copy
  const { copyFile } = await import("node:fs/promises")
  await copyFile(src, dst)
}

async function execRemove(path: string): Promise<void> {
  const { rm } = await import("node:fs/promises")
  await rm(path, { recursive: true, force: true })
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `bun test src/skills-bootstrap.test.ts`
Expected: PASS (4/4)

- [ ] **Step 9: Add bundled skills constants**

File: `src/skills-bundled.ts`

```ts
/**
 * The canonical chore skill set shipped with v0.35.0.
 *
 * Order is significant only for documentation; resolution is by slug name.
 * Names must match the slugs in the bundled tarball exactly.
 */

export const CHORE_SKILLS: readonly string[] = [
  "brainstorming",
  "using-superpowers",
  "writing-plans",
  "writing-skills",
  "test-driven-development",
  "verification-before-completion",
  "systematic-debugging",
  "find-skills",
  "dispatching-parallel-agents",
  "executing-plans",
  "subagent-driven-development",
  "using-git-worktrees",
  "finishing-a-development-branch",
  "requesting-code-review",
  "receiving-code-review",
  "codebase-audit",
] as const
```

- [ ] **Step 10: Add `skillHub.choreDir` config field**

File: `src/config.ts` (modify)

Find the `skillHub` config block and add `choreDir`:

```ts
choreDir: full.skillHub?.choreDir ?? join(homedir(), ".agents", "skills"),
```

Add the `homedir` import if not already present:
```ts
import { homedir } from "node:os"
```

Add the new field to the type/interface definition (find `skillHub` interface in `config.ts`):
```ts
choreDir: string
```

- [ ] **Step 11: Add `build:skills` task to `build.ts`**

File: `build.ts` (modify)

Add at the top:
```ts
import { existsSync, mkdirSync } from "node:fs"
import { execSync } from "node:child_process"
import { join } from "node:path"
```

Add the build:skills task (separate from main bundle):
```ts
async function buildSkillsTarball() {
  const bundledDir = join(import.meta.dir, "bundled-skills")
  const outDir = join(import.meta.dir, "dist", "skills")
  if (!existsSync(bundledDir)) {
    console.warn(`[build:skills] ${bundledDir} does not exist; skipping`)
    return
  }
  mkdirSync(outDir, { recursive: true })
  const tarPath = join(outDir, "chore.tar.gz")
  execSync(`tar -czf "${tarPath}" -C "${bundledDir}" .`, { stdio: "inherit" })
  console.log(`[build:skills] wrote ${tarPath}`)
}
```

Wire it as an opt-in script (call from package.json `scripts.build:skills`):
```ts
if (process.argv[2] === "skills") {
  await buildSkillsTarball()
  process.exit(0)
}
```

Update `package.json`:
```json
"scripts": {
  "build:skills": "bun run build.ts skills",
  ...
}
```

- [ ] **Step 12: Update `config.test.ts` for `choreDir`**

Add to existing tests:
```ts
test("skillHub.choreDir defaults to ~/.agents/skills", () => {
  const cfg = loadConfig({})
  expect(cfg.skillHub.choreDir).toMatch(/[\\/]\.agents[\\/]skills$/)
})
```

- [ ] **Step 13: Run full test + typecheck + build**

Run:
```bash
bun test
npx tsc --noEmit
bun run build
```

Expected: all green.

- [ ] **Step 14: Oracle review gate**

Dispatch Oracle (read-only) for Task 1 review. Provide:
- Files changed (paths above)
- Test results (4+4+1 = 9 passing)
- Spec section being implemented

Wait for Oracle response. If SAFE TO PROCEED → continue to Task 2. If BLOCKER → fix, re-run tests, re-review.

- [ ] **Step 15: Commit**

```bash
git add src/skills-fs.ts src/skills-fs.test.ts src/skills-bootstrap.ts src/skills-bootstrap.test.ts src/skills-bundled.ts src/config.ts src/config.test.ts build.ts package.json bundled-skills/.gitkeep
git commit -m "feat(skills): add skills-fs scanner + chore bootstrap

Tier 1 of the 3-tier skills resolver. On first run, extracts the
bundled chore tarball to ~/.agents/skills/ with SHA-256 idempotency:
matching hashes skip silently, mismatched hashes warn and preserve the
user's local copy (never overwrite). Manifest at
~/.agents/skills/.omo-meta-governor-checksums.json records per-slug
hashes for future runs.

Tests cover: frontmatter parsing (4), extraction + idempotency + hash
mismatch + manifest (4), config default (1)."
```

---

### Task 2: Unified resolver with tier precedence

**Files:**
- Create: `src/skills-resolver.ts`
- Create: `src/skills-resolver.test.ts`
- Modify: `src/skill-hub-tools.ts` (delegate `omo_skill_find` to resolver)
- Modify: `src/custom-tools.ts` (replace scattered skill queries with resolver calls)

**Interfaces:**
- Consumes:
  ```ts
  // from Task 1:
  scanSkillsDir(dir: string): Promise<Map<string, ParsedSkillFrontmatter>>
  ```
- Produces:
  ```ts
  // src/skills-resolver.ts
  export type SkillSource = 'chore' | 'hub-materialized' | 'custom' | 'hub'
  export interface SkillDescriptor {
    slug: string
    name: string
    description: string
    source: SkillSource
    tier: 1 | 2 | 3
    path: string | null
    contentHash: string | null
  }
  export type TierFilter = 'all' | 'chore' | 'custom' | 'hub'

  export interface ResolverState {
    choreDir: string
    projectDir: string  // <cwd>/.agents/skills
    hubSearch: (query: string, limit: number) => Promise<Array<{
      slug: string; name: string; description: string; installs?: number
    }>>
  }

  export async function findSkill(slug: string, state: ResolverState): Promise<SkillDescriptor | null>
  export async function searchSkills(
    query: string,
    state: ResolverState,
    opts?: { tier?: TierFilter; limit?: number }
  ): Promise<SkillDescriptor[]>
  ```

- [ ] **Step 1: Write failing tests for resolver precedence**

File: `src/skills-resolver.test.ts`

```ts
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
  let choreDir: string
  let projectDir: string

  beforeEach(() => {
    const tmp = mkdtempSync(join(tmpdir(), "resolver-"))
    choreDir = join(tmp, "chore")
    projectDir = join(tmp, "project")
    mkdirSync(choreDir)
    mkdirSync(projectDir)
  })

  afterEach(() => {
    rmSync(choreDir, { recursive: true })
    rmSync(projectDir, { recursive: true })
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
      hubSearch: async (q, l) => q === "vercel"
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
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/skills-resolver.test.ts`
Expected: FAIL — `./skills-resolver.js` module not found

- [ ] **Step 3: Implement the resolver**

File: `src/skills-resolver.ts`

```ts
/**
 * Skills resolver — unified query layer over three tiers.
 *
 * Precedence: project-local (cwd/.agents/skills) > chore global
 * (~/.agents/skills) > hub catalog (SQLite FTS5).
 *
 * Pure functions only: no fs mutation, no network calls. Hub search is
 * injected via `ResolverState.hubSearch` so the resolver stays testable
 * without real network.
 */

import { createHash } from "node:crypto"
import { join } from "node:path"
import { readFile } from "node:fs/promises"
import { scanSkillsDir, type ParsedSkillFrontmatter } from "./skills-fs.js"

export type SkillSource = 'chore' | 'hub-materialized' | 'custom' | 'hub'
export type Tier = 1 | 2 | 3
export type TierFilter = 'all' | 'chore' | 'custom' | 'hub'

export interface SkillDescriptor {
  slug: string
  name: string
  description: string
  source: SkillSource
  tier: Tier
  path: string | null
  contentHash: string | null
}

export interface HubEntry {
  slug: string
  name: string
  description: string
  installs?: number
}

export interface ResolverState {
  choreDir: string
  projectDir: string
  hubSearch: (query: string, limit: number) => Promise<HubEntry[]>
}

const hashContent = (content: string): string =>
  "sha256:" + createHash("sha256").update(content).digest("hex")

const toDescriptor = (
  source: SkillSource,
  tier: Tier,
  slug: string,
  parsed: ParsedSkillFrontmatter,
  skillPath: string,
): SkillDescriptor => ({
  slug,
  name: parsed.name,
  description: parsed.description,
  source,
  tier,
  path: skillPath,
  contentHash: hashContent(parsed.raw + parsed.name + parsed.description),
})

const hubEntryToDescriptor = (entry: HubEntry): SkillDescriptor => ({
  slug: entry.slug,
  name: entry.name,
  description: entry.description,
  source: 'hub',
  tier: 2,
  path: null,
  contentHash: null,
})

export async function findSkill(
  slug: string,
  state: ResolverState,
): Promise<SkillDescriptor | null> {
  const [projectMap, choreMap] = await Promise.all([
    scanSkillsDir(state.projectDir),
    scanSkillsDir(state.choreDir),
  ])

  // Precedence: project-local > chore > hub
  if (projectMap.has(slug)) {
    const parsed = projectMap.get(slug)!
    return toDescriptor('custom', 3, slug, parsed, join(state.projectDir, slug, "SKILL.md"))
  }
  if (choreMap.has(slug)) {
    const parsed = choreMap.get(slug)!
    return toDescriptor('chore', 1, slug, parsed, join(state.choreDir, slug, "SKILL.md"))
  }
  const hubHits = await state.hubSearch(slug, 1)
  const hit = hubHits.find((h) => h.slug === slug)
  if (hit) return hubEntryToDescriptor(hit)
  return null
}

export async function searchSkills(
  query: string,
  state: ResolverState,
  opts?: { tier?: TierFilter; limit?: number },
): Promise<SkillDescriptor[]> {
  const tier: TierFilter = opts?.tier ?? 'all'
  const limit = opts?.limit ?? 50

  const out: SkillDescriptor[] = []
  const seen = new Set<string>()

  if (tier === 'all' || tier === 'custom') {
    const projectMap = await scanSkillsDir(state.projectDir)
    for (const [slug, parsed] of projectMap) {
      if (matches(query, slug, parsed.name, parsed.description)) {
        out.push(toDescriptor('custom', 3, slug, parsed, join(state.projectDir, slug, "SKILL.md")))
        seen.add(slug)
      }
    }
  }

  if (tier === 'all' || tier === 'chore') {
    const choreMap = await scanSkillsDir(state.choreDir)
    for (const [slug, parsed] of choreMap) {
      if (seen.has(slug)) continue
      if (matches(query, slug, parsed.name, parsed.description)) {
        out.push(toDescriptor('chore', 1, slug, parsed, join(state.choreDir, slug, "SKILL.md")))
        seen.add(slug)
      }
    }
  }

  if (tier === 'all' || tier === 'hub') {
    const hubHits = await state.hubSearch(query, limit)
    for (const hit of hubHits) {
      if (seen.has(hit.slug)) continue
      out.push(hubEntryToDescriptor(hit))
      seen.add(hit.slug)
    }
  }

  return out.slice(0, limit)
}

function matches(query: string, slug: string, name: string, description: string): boolean {
  if (!query) return true  // empty query returns everything
  const q = query.toLowerCase()
  return slug.toLowerCase().includes(q) ||
         name.toLowerCase().includes(q) ||
         description.toLowerCase().includes(q)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/skills-resolver.test.ts`
Expected: PASS (8/8)

- [ ] **Step 5: Update `omo_skill_find` to use resolver**

File: `src/skill-hub-tools.ts` (modify)

Find the `omo_skill_find` handler. Replace the body with a delegation to the resolver:

```ts
import { searchSkills, type ResolverState, type HubEntry } from "./skills-resolver.js"

// inside the tool handler:
const state: ResolverState = {
  choreDir: config.skillHub.choreDir,
  projectDir: join(cwd, ".agents", "skills"),
  hubSearch: async (query, limit) => {
    // delegate to existing SQLite search
    return sqlite.skillSearch(query, limit)
  },
}
const results = await searchSkills(query, state, { tier, limit })
return { skills: results, zeroResults: results.length === 0 }
```

- [ ] **Step 6: Replace scattered queries in `custom-tools.ts`**

File: `src/custom-tools.ts` (modify)

Find any direct calls to `scanSkillsDir`, `skillSearch`, or inline skill lookups. Replace each with `findSkill` or `searchSkills` from the resolver. Preserve existing call sites' argument shapes (add a thin adapter if needed).

- [ ] **Step 7: Run full test + typecheck + build**

```bash
bun test
npx tsc --noEmit
bun run build
```

Expected: all green.

- [ ] **Step 8: Oracle review gate**

Dispatch Oracle for Task 2 review. Wait for SAFE TO PROCEED.

- [ ] **Step 9: Commit**

```bash
git add src/skills-resolver.ts src/skills-resolver.test.ts src/skill-hub-tools.ts src/custom-tools.ts
git commit -m "feat(skills): add resolver with unified tier precedence

Three registries (project-local, chore global, hub SQLite) feed one
pure resolver. Precedence: project-local > chore > hub. Tier filter
allows constraining queries to a single source. Response shape extended
with { source, tier, path, contentHash } — additive, not breaking.

omo_skill_find now delegates to the resolver; custom-tools.ts routes
scattered skill queries through it too. Tests cover precedence, dedup,
filter, fallback (8 tests)."
```

---

### Task 3: Tier 2 — Hub materialization

**Files:**
- Create: `src/skills-materialize.ts`
- Create: `src/skills-materialize.test.ts`
- Modify: `src/skill-hub-tools.ts` (`omo_skill_get` calls materialize before returning)
- Modify: `src/sqlite-backend.ts` (add `last_materialized_at` column)
- Modify: `src/health.ts` (add `materializationFailures` counter)
- Modify: `src/config.ts` (add `skillHub.autoMaterialize` flag, default true)

**Interfaces:**
- Consumes:
  ```ts
  // from Task 1 + 2:
  parseSkillFrontmatter, scanSkillsDir
  SkillDescriptor
  ```
- Produces:
  ```ts
  // src/skills-materialize.ts
  export interface MaterializationResult {
    written: boolean
    reason: 'created' | 'unchanged' | 'mismatch' | 'denied' | 'disabled' | 'no-content'
    path: string | null
  }
  export async function materializeSkill(opts: {
    projectDir: string       // cwd/.agents/skills
    slug: string
    body: string             // raw SKILL.md file content (with frontmatter)
    autoMaterialize: boolean
  }): Promise<MaterializationResult>
  ```

- [ ] **Step 1: Write failing tests for materialize**

File: `src/skills-materialize.test.ts`

```ts
import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { materializeSkill } from "./skills-materialize.js"

describe("materializeSkill", () => {
  let projectDir: string

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "mat-"))
  })

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true })
  })

  test("creates new skill dir and writes SKILL.md", async () => {
    const body = `---
name: vercel-deploy
description: Deploy to vercel
---
# body`
    const r = await materializeSkill({
      projectDir, slug: "vercel-deploy", body, autoMaterialize: true,
    })
    expect(r.written).toBe(true)
    expect(r.reason).toBe("created")
    expect(readFileSync(join(projectDir, "vercel-deploy", "SKILL.md"), "utf8")).toBe(body)
  })

  test("is idempotent: same body produces reason=unchanged", async () => {
    const body = `---
name: foo
description: bar
---
# body`
    await materializeSkill({ projectDir, slug: "foo", body, autoMaterialize: true })
    const r = await materializeSkill({ projectDir, slug: "foo", body, autoMaterialize: true })
    expect(r.written).toBe(false)
    expect(r.reason).toBe("unchanged")
  })

  test("user-modified local: reason=mismatch, no overwrite", async () => {
    const body = `---
name: foo
description: original
---
# body`
    const modified = `---
name: foo
description: user changed
---
# user body`
    mkdirSync(join(projectDir, "foo"), { recursive: true })
    writeFileSync(join(projectDir, "foo", "SKILL.md"), modified)
    const r = await materializeSkill({ projectDir, slug: "foo", body, autoMaterialize: true })
    expect(r.reason).toBe("mismatch")
    expect(readFileSync(join(projectDir, "foo", "SKILL.md"), "utf8")).toBe(modified)
  })

  test("autoMaterialize=false: reason=disabled, no write", async () => {
    const body = `---
name: foo
description: bar
---
# body`
    const r = await materializeSkill({
      projectDir, slug: "foo", body, autoMaterialize: false,
    })
    expect(r.reason).toBe("disabled")
    expect(existsSync(join(projectDir, "foo"))).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/skills-materialize.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `materializeSkill`**

File: `src/skills-materialize.ts`

```ts
/**
 * Skills materialization — write a hub-fetched SKILL.md to the project's
 * .agents/skills/ directory so opencode can Read() it.
 *
 * Idempotent: same body → no-op. User-modified local → preserve + warn.
 * Gated by `autoMaterialize` config (default true in v0.35.0).
 */

import { mkdir, writeFile, readFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { createHash } from "node:crypto"

export interface MaterializationResult {
  written: boolean
  reason: 'created' | 'unchanged' | 'mismatch' | 'denied' | 'disabled' | 'no-content'
  path: string | null
}

const hash = (s: string) => "sha256:" + createHash("sha256").update(s).digest("hex")

export async function materializeSkill(opts: {
  projectDir: string
  slug: string
  body: string
  autoMaterialize: boolean
}): Promise<MaterializationResult> {
  if (!opts.autoMaterialize) {
    return { written: false, reason: 'disabled', path: null }
  }
  if (!opts.body || opts.body.trim().length === 0) {
    return { written: false, reason: 'no-content', path: null }
  }

  const targetDir = join(opts.projectDir, opts.slug)
  const targetPath = join(targetDir, "SKILL.md")
  const bodyHash = hash(opts.body)

  if (existsSync(targetPath)) {
    const existing = await readFile(targetPath, "utf8")
    if (hash(existing) === bodyHash) {
      return { written: false, reason: 'unchanged', path: targetPath }
    }
    console.warn(
      `[skills-materialize] skill '${opts.slug}' exists locally with different content; skipping. ` +
      `bundled: ${bodyHash}, local: ${hash(existing)}`,
    )
    return { written: false, reason: 'mismatch', path: targetPath }
  }

  try {
    await mkdir(targetDir, { recursive: true })
    await writeFile(targetPath, opts.body, "utf8")
    return { written: true, reason: 'created', path: targetPath }
  } catch (err) {
    console.warn(`[skills-materialize] write failed for '${opts.slug}': ${(err as Error).message}`)
    return { written: false, reason: 'denied', path: null }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/skills-materialize.test.ts`
Expected: PASS (4/4)

- [ ] **Step 5: Add `last_materialized_at` SQLite column**

File: `src/sqlite-backend.ts` (modify)

Find the schema migration. Add:
```ts
ALTER TABLE skills ADD COLUMN last_materialized_at TEXT
```

Add a setter method:
```ts
setSkillMaterializedAt(slug: string, ts: string): void {
  this.db.prepare(
    "UPDATE skills SET last_materialized_at = ? WHERE slug = ?"
  ).run(ts, slug)
}
```

- [ ] **Step 6: Add `autoMaterialize` config field**

File: `src/config.ts` (modify)

In `skillHub` interface, add:
```ts
autoMaterialize: boolean  // default true
```

In the defaults block:
```ts
autoMaterialize: full.skillHub?.autoMaterialize ?? true,
```

- [ ] **Step 7: Wire `omo_skill_get` to materialize**

File: `src/skill-hub-tools.ts` (modify)

Find the `omo_skill_get` handler. After fetching the body but before returning:

```ts
import { materializeSkill } from "./skills-materialize.js"

// inside the handler, after fetch:
const mat = await materializeSkill({
  projectDir: join(cwd, ".agents", "skills"),
  slug,
  body,
  autoMaterialize: config.skillHub.autoMaterialize,
})
if (mat.written) {
  sqlite.setSkillMaterializedAt(slug, new Date().toISOString())
}
if (mat.reason === 'denied') {
  healthMetrics.materializationFail++
}
return { body, materialization: mat }
```

- [ ] **Step 8: Add `materializationFailures` to health**

File: `src/health.ts` (modify)

Add to the metrics object:
```ts
materializationFailures: number
```

Initialize in the constructor and increment where noted.

- [ ] **Step 9: Run full test + typecheck + build**

```bash
bun test
npx tsc --noEmit
bun run build
```

Expected: all green.

- [ ] **Step 10: Oracle review gate**

Dispatch Oracle for Task 3 review. Wait for SAFE TO PROCEED.

- [ ] **Step 11: Commit**

```bash
git add src/skills-materialize.ts src/skills-materialize.test.ts src/skill-hub-tools.ts src/sqlite-backend.ts src/health.ts src/config.ts src/config.test.ts
git commit -m "feat(skills): add tier-2 materialization to project .agents/skills

omo_skill_get now writes the fetched SKILL.md to .agents/skills/<slug>/
so opencode can Read() the file directly. Gated by skillHub.autoMaterialize
(default true). Idempotent on identical body, skips + warns on user-modified
local copies. New SQLite column tracks last_materialized_at for omo_health.

Tests: materialize behavior (4), config default (1)."
```

---

### Task 4: Tier 3 — Advisory reminder + fs watcher

**Files:**
- Create: `src/skills-tier3-reminder.ts`
- Create: `src/skills-tier3-reminder.test.ts`
- Create: `src/skills-fs-watcher.ts`
- Create: `src/skills-fs-watcher.test.ts`
- Create: `src/skills-integration.test.ts`
- Modify: `src/skill-hub-tools.ts` (call reminder on zero-results)
- Modify: `src/plugin.ts` (start fs watcher on boot)
- Modify: `src/health.ts` (add tier3 counters)
- Modify: `package.json` (add `chokidar` dependency)

**Interfaces:**
- Consumes:
  ```ts
  // from Tasks 1-3:
  SkillDescriptor (with zeroResults flag)
  scanSkillsDir
  ```
- Produces:
  ```ts
  // src/skills-tier3-reminder.ts
  export interface Tier3ReminderState {
    sent: Map<string, number>    // query -> count
    maxPerSession: number        // default 3
    cooldownMs: number           // default 0 (same session)
  }
  export function shouldSendReminder(
    query: string,
    state: Tier3ReminderState,
  ): boolean
  export function formatReminder(): string

  // src/skills-fs-watcher.ts
  export interface FsWatcher {
    stop(): Promise<void>
  }
  export async function startSkillsFsWatcher(opts: {
    projectDir: string
    onChange: (path: string) => Promise<void>
  }): Promise<FsWatcher>
  ```

- [ ] **Step 1: Write failing tests for tier 3 reminder**

File: `src/skills-tier3-reminder.test.ts`

```ts
import { describe, expect, test } from "bun:test"
import { shouldSendReminder, formatReminder } from "./skills-tier3-reminder.js"

describe("shouldSendReminder", () => {
  test("returns true on first call for a query", () => {
    const state = { sent: new Map(), maxPerSession: 3, cooldownMs: 0 }
    expect(shouldSendReminder("foo", state)).toBe(true)
  })

  test("returns false after reminder already sent for same query in session", () => {
    const state = { sent: new Map([["foo", 1]]), maxPerSession: 3, cooldownMs: 0 }
    expect(shouldSendReminder("foo", state)).toBe(false)
  })

  test("returns false after 3 reminders sent (circuit breaker)", () => {
    const state = {
      sent: new Map([["a", 1], ["b", 1], ["c", 1]]),
      maxPerSession: 3, cooldownMs: 0,
    }
    expect(shouldSendReminder("d", state)).toBe(false)
  })
})

describe("formatReminder", () => {
  test("mentions writing-skills", () => {
    const r = formatReminder()
    expect(r).toContain("writing-skills")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/skills-tier3-reminder.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `shouldSendReminder` + `formatReminder`**

File: `src/skills-tier3-reminder.ts`

```ts
/**
 * Tier 3 advisory reminder — when the resolver returns zero results,
 * we emit a system reminder to the next agent turn suggesting the
 * writing-skills skill.
 *
 * Rate limited:
 * - 1 reminder per session per query
 * - Circuit breaker: max 3 reminders per session total
 */

export interface Tier3ReminderState {
  sent: Map<string, number>
  maxPerSession: number
  cooldownMs: number
}

export function shouldSendReminder(
  query: string,
  state: Tier3ReminderState,
): boolean {
  if (state.sent.has(query)) return false  // already sent for this query
  const totalSent = Array.from(state.sent.values()).reduce((a, b) => a + b, 0)
  if (totalSent >= state.maxPerSession) return false
  state.sent.set(query, 1)
  return true
}

export function formatReminder(): string {
  return [
    "No skill matched your query. The plugin does not have a hub result for this either.",
    "Consider using the writing-skills skill (always available as chore) to create a",
    "project-local skill at ./.agents/skills/<slug>/SKILL.md if this task will recur.",
  ].join(" ")
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/skills-tier3-reminder.test.ts`
Expected: PASS (4/4)

- [ ] **Step 5: Write failing test for fs watcher**

File: `src/skills-fs-watcher.test.ts`

```ts
import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startSkillsFsWatcher } from "./skills-fs-watcher.js"

describe("startSkillsFsWatcher", () => {
  let projectDir: string

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "watcher-"))
    mkdirSync(projectDir)
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
    await new Promise((r) => setTimeout(r, 300))  // give chokidar time
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
    await new Promise((r) => setTimeout(r, 300))
    await watcher.stop()
    expect(fired).toBe("")
  })
})
```

- [ ] **Step 6: Run test to verify it fails**

Run: `bun test src/skills-fs-watcher.test.ts`
Expected: FAIL

- [ ] **Step 7: Implement `startSkillsFsWatcher`**

File: `src/skills-fs-watcher.ts`

```ts
/**
 * Filesystem watcher for project-local skills.
 *
 * Watches cwd/.agents/skills/**/SKILL.md and triggers a callback on
 * create/write. The callback typically re-scans the resolver so the new
 * skill appears immediately in search results.
 *
 * Implementation: chokidar. Falls back to a no-op if chokidar is unavailable.
 */

import chokidar from "chokidar"
import { join } from "node:path"

export interface FsWatcher {
  stop(): Promise<void>
}

export async function startSkillsFsWatcher(opts: {
  projectDir: string
  onChange: (path: string) => Promise<void>
}): Promise<FsWatcher> {
  const pattern = join(opts.projectDir, "**", "SKILL.md")
  const watcher = chokidar.watch(pattern, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
  })
  watcher.on("add", (p) => { void opts.onChange(p) })
  watcher.on("change", (p) => { void opts.onChange(p) })
  return {
    async stop() {
      await watcher.close()
    },
  }
}
```

- [ ] **Step 8: Add chokidar dependency**

File: `package.json` (modify)

In `dependencies`:
```json
"chokidar": "^4.0.1"
```

Run: `bun install`

- [ ] **Step 9: Run test to verify it passes**

Run: `bun test src/skills-fs-watcher.test.ts`
Expected: PASS (2/2)

- [ ] **Step 10: Wire reminder into `omo_skill_find`**

File: `src/skill-hub-tools.ts` (modify)

After `searchSkills` returns with `zeroResults: true`:
```ts
import { shouldSendReminder, formatReminder, type Tier3ReminderState } from "./skills-tier3-reminder.js"

// module-level singleton (per plugin instance):
const tier3State: Tier3ReminderState = {
  sent: new Map(), maxPerSession: 3, cooldownMs: 0,
}

// inside the handler:
if (results.length === 0 && shouldSendReminder(query, tier3State)) {
  // queue a system reminder for the next agent turn
  emitSystemReminder(formatReminder())
}
```

Implement `emitSystemReminder` using the plugin's hook API (likely `experimental.chat.system.transform` already in use — see existing code).

- [ ] **Step 11: Start watcher on boot**

File: `src/plugin.ts` (modify)

In the `experimental` hook setup:
```ts
import { startSkillsFsWatcher } from "./skills-fs-watcher.js"

const watcher = await startSkillsFsWatcher({
  projectDir: join(cwd, ".agents", "skills"),
  onChange: async () => {
    // trigger rescan in the resolver (invalidate cache)
    await rescanResolver()
  },
})
// store reference; clean up on plugin shutdown
```

- [ ] **Step 12: Add tier3 counters to health**

File: `src/health.ts` (modify)

Add:
```ts
tier3RemindersSent: number
tier3SkillsCreated: number
materializationFailures: number
```

Increment `tier3RemindersSent` inside `shouldSendReminder` call site. Increment `tier3SkillsCreated` in the watcher's `onChange` callback when a new SKILL.md is detected that wasn't in the previous scan.

- [ ] **Step 13: Write integration test**

File: `src/skills-integration.test.ts`

```ts
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
    mkdirSync(choreDir); mkdirSync(projectDir)
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
```

- [ ] **Step 14: Run integration test**

Run: `bun test src/skills-integration.test.ts`
Expected: PASS (4/4)

- [ ] **Step 15: Run full test + typecheck + build**

```bash
bun test
npx tsc --noEmit
bun run build
```

Expected: all green.

- [ ] **Step 16: Oracle review gate**

Dispatch Oracle for Task 4 review. Wait for SAFE TO PROCEED.

- [ ] **Step 17: Commit**

```bash
git add src/skills-tier3-reminder.ts src/skills-tier3-reminder.test.ts src/skills-fs-watcher.ts src/skills-fs-watcher.test.ts src/skills-integration.test.ts src/skill-hub-tools.ts src/plugin.ts src/health.ts package.json
git commit -m "feat(skills): add tier-3 advisory reminder + fs watcher

When omo_skill_find returns zero results, emit a system reminder
suggesting the writing-skills chore skill. Rate-limited: 1 per query,
3 per session total. An fs watcher on cwd/.agents/skills/ triggers a
resolver rescan on any SKILL.md create/write, so agent-generated skills
appear immediately.

New health counters: tier3RemindersSent, tier3SkillsCreated.
New dependency: chokidar@^4.0.1.

Tests: reminder logic (4), watcher detection (2), integration end-to-end (4)."
```

---

### Task 5: Release prep — version bump, docs, npm publish, GitHub release

**Files:**
- Modify: `package.json` (bump version to 0.35.0)
- Modify: `CHANGELOG.md` (add v0.35.0 entry)
- Modify: `README.md` (add "Skills system" section)
- Modify: `ARCHITECTURE.md` (add `skills-resolution` subsystem)
- Modify: `STRUCTURE.md` (list new files)
- Modify: `assets/omo-meta-governor.schema.json` (document `skillHub.autoMaterialize`)
- Create: `bundled-skills/` (populate with copies of the 16 chore skills, with user approval)

**Interfaces:**
- Consumes: nothing new
- Produces: v0.35.0 npm package + GitHub Release

- [ ] **Step 1: Populate `bundled-skills/` from runtime**

Get user approval, then copy the 16 skills:
```bash
$skillsSource = "C:\Users\herna\.agents\skills"
$slugs = @("brainstorming","using-superpowers","writing-plans","writing-skills",
  "test-driven-development","verification-before-completion","systematic-debugging",
  "find-skills","dispatching-parallel-agents","executing-plans",
  "subagent-driven-development","using-git-worktrees",
  "finishing-a-development-branch","requesting-code-review",
  "receiving-code-review","codebase-audit")
foreach ($s in $slugs) {
  if (Test-Path "$skillsSource\$s") {
    Copy-Item -Recurse "$skillsSource\$s" "bundled-skills\$s"
  } else {
    Write-Warning "missing in runtime: $s"
  }
}
```

Verify all 16 present:
```bash
Get-ChildItem bundled-skills -Directory | Measure-Object | Select-Object -ExpandProperty Count
```

Expected: 16.

- [ ] **Step 2: Run `bun run build:skills`**

```bash
bun run build:skills
```

Expected: creates `dist/skills/chore.tar.gz` ~30-50 KB.

- [ ] **Step 3: Bump version**

File: `package.json` (modify)

```diff
- "version": "0.34.2",
+ "version": "0.35.0",
```

- [ ] **Step 4: Add CHANGELOG entry**

File: `CHANGELOG.md` (modify)

Prepend at the top (after the heading):
```markdown
## v0.35.0 — 3-tier skills resolver

### Added
- **Tier 1 (chore / global)**: bundled tarball bootstrap of 16 canonical skills to `~/.agents/skills/` on first run. Idempotent (SHA-256 hash check), warns on user-modified copies.
- **Tier 2 (hub / project materialization)**: `omo_skill_get` now writes the fetched `SKILL.md` to `<cwd>/.agents/skills/<slug>/` so opencode can `Read()` it. Gated by `skillHub.autoMaterialize` (default `true`).
- **Tier 3 (custom / advisory)**: zero-result queries emit a system reminder suggesting the bundled `writing-skills` skill. Rate-limited (1 per query, 3 per session). fs watcher on `cwd/.agents/skills/` rescans on writes.
- Unified resolver (`src/skills-resolver.ts`) with project-local > chore global > hub catalog precedence and `tier: 'all' | 'chore' | 'custom' | 'hub'` filter.
- New SQLite column `skills.last_materialized_at`.
- New health counters: `materializationFailures`, `tier3RemindersSent`, `tier3SkillsCreated`.

### Changed
- `omo_skill_find` response shape extended (additive) with `source`, `tier`, `path`, `contentHash` fields.
- `omo_skill_get` response extended with `materialization: { written, reason, path }`.

### Tests
- 4 frontmatter parser tests
- 4 bootstrap tests (extraction, idempotency, hash mismatch, manifest)
- 8 resolver precedence tests
- 4 materialize tests
- 4 tier-3 reminder tests
- 2 fs watcher tests
- 4 integration tests
- 2 new config tests

**Total: 32 new tests** (spec estimated 29; +3 from the integrate-emit path).

### Config
- New `skillHub.choreDir: string` (default `~/.agents/skills`).
- New `skillHub.autoMaterialize: boolean` (default `true`).
```

- [ ] **Step 5: Update README "Skills system" section**

File: `README.md` (modify)

Find the section about skills or plugin tools. Add:
```markdown
## Skills system: 3-tier resolution

The plugin resolves skills from three tiers, in this precedence:

1. **Chore (global)** — bundled skills shipped with the plugin, extracted to
   `~/.agents/skills/` on first run. Read-only from the plugin's perspective.
2. **Hub (lazy)** — on-demand from `skills-library.com` / `skills.sh`. Materialized
   to `<cwd>/.agents/skills/<slug>/SKILL.md` when the agent calls `omo_skill_get`.
3. **Custom (project-local)** — written by the agent via the `writing-skills`
   chore skill when no hub match exists.

The plugin recommends skills to the agent; it never injects skill content into
prompts. The agent decides which skill to use per task.
```

- [ ] **Step 6: Update ARCHITECTURE.md**

File: `ARCHITECTURE.md` (modify)

Add a new subsystem section:
```markdown
### Skills Resolution (added v0.35.0)

Three registries + one resolver + one materialization side effect + one
advisory reminder. See `docs/superpowers/specs/2026-08-26-skills-resolution-design.md`
for the full design.

| Component | Responsibility |
|---|---|
| `src/skills-fs.ts` | Frontmatter parser + fs scanner |
| `src/skills-bootstrap.ts` | Chore tarball extraction with idempotency |
| `src/skills-resolver.ts` | Unified `findSkill` + `searchSkills` |
| `src/skills-materialize.ts` | Hub skill write to project fs |
| `src/skills-tier3-reminder.ts` | Zero-results advisory |
| `src/skills-fs-watcher.ts` | Hot-reload of project-local skills |
```

- [ ] **Step 7: Update STRUCTURE.md**

File: `STRUCTURE.md` (modify)

Add the new files to the appropriate section.

- [ ] **Step 8: Update schema JSON**

File: `assets/omo-meta-governor.schema.json` (modify)

Add to the `skillHub` properties:
```json
"choreDir": { "type": "string", "default": "~/.agents/skills" },
"autoMaterialize": { "type": "boolean", "default": true }
```

- [ ] **Step 9: Run full test + typecheck + build**

```bash
bun test
npx tsc --noEmit
bun run build
bun run build:skills
```

Expected: all green; `dist/skills/chore.tar.gz` exists.

- [ ] **Step 10: Commit docs + version**

```bash
git add package.json CHANGELOG.md README.md ARCHITECTURE.md STRUCTURE.md assets/omo-meta-governor.schema.json bundled-skills/ dist/skills/chore.tar.gz
git commit -m "chore(release): v0.35.0 prep + bundled skills + docs"
```

- [ ] **Step 11: Push and watch CI**

```bash
git push origin main
gh run watch $(gh run list --limit=1 --json databaseId --jq '.[0].databaseId') --exit-status
```

Expected: CI green. If red, fix and re-push per AGENTS.md §2.

- [ ] **Step 12: Publish to npm**

```bash
npm publish --access public
```

Expected: `+ @herjarsa/omo-meta-governor@0.35.0`.

Verify:
```bash
npm view @herjarsa/omo-meta-governor@0.35.0 version
```

Expected: `0.35.0`.

- [ ] **Step 13: Tag and force-push tag**

```bash
git tag v0.35.0
git push origin v0.35.0 --force
```

- [ ] **Step 14: Create GitHub Release**

```bash
$notes = Get-Content CHANGELOG.md -Raw | Select-String -Pattern "(?s)## v0.35.0.*?(?=## v0.34)" -AllMatches | ForEach-Object { $_.Matches[0].Value } | Select-Object -First 1
$notes | Out-File -Encoding utf8 "docs\superpowers\plans\v0.35.0-release-notes.md"
gh release create v0.35.0 `
  --repo herjarsa/omo-meta-governor `
  --title "v0.35.0 — 3-tier skills resolver" `
  --notes-file "docs/superpowers\plans\v0.35.0-release-notes.md"
```

Verify:
```bash
gh release view v0.35.0 --repo herjarsa/omo-meta-governor
```

- [ ] **Step 15: Final acceptance check**

Run all verification commands:
```bash
git log --oneline v0.34.2..HEAD | Measure-Object | Select-Object -ExpandProperty Count  # 5
npm view @herjarsa/omo-meta-governor version  # 0.35.0
git ls-remote --tags origin v0.35.0  # local HEAD sha
gh release view v0.35.0 --repo herjarsa/omo-meta-governor --json isDraft  # false
```

Expected: all checks pass.

- [ ] **Step 16: Restore `enforceMode` in user config**

```bash
(Get-Content "$env:USERPROFILE\.config\opencode\omo-meta-governor.jsonc") `
  -replace '"enforceMode": "directive"', '"enforceMode": "block"' `
  | Set-Content "$env:USERPROFILE\.config\opencode\omo-meta-governor.jsonc"
Remove-Item "$env:USERPROFILE\.config\opencode\omo-meta-governor.jsonc.bak" -Force
```

Verify:
```bash
Select-String -Path "$env:USERPROFILE\.config\opencode\omo-meta-governor.jsonc" -Pattern "enforceMode"
```

Expected: `"enforceMode": "block"` (restored).

- [ ] **Step 17: Final commit + report**

```bash
git add docs/superpowers/plans/2026-08-26-skills-resolution.md
git commit -m "docs(plan): add skills-resolution implementation plan"
```

Deliver final summary report to user.

---

## Self-Review Checklist

- ✅ Spec coverage: every spec section maps to a task (problem→goals, goals→tiers, layers→tasks 1-4, error handling→inline, testing→per-task, release→task 5).
- ✅ Placeholder scan: zero "TBD"/"TODO"/"add validation" patterns. Every code block is real.
- ✅ Type consistency: `SkillDescriptor` defined once in Task 2, referenced everywhere. `MaterializationResult` in Task 3, wired in Task 3 Step 7. `Tier3ReminderState` in Task 4.
- ✅ Oracle review gates between tasks (Step 14/8/10/16).
- ✅ Per-task: tests written FIRST (RED), implementation SECOND (GREEN), commit THIRD.
- ✅ Restore user config (`enforceMode`) at the end of Task 5.

## Total Test Count (v0.35.0 delta)

| Test File | New Tests |
|---|---|
| `src/skills-fs.test.ts` | 4 |
| `src/skills-bootstrap.test.ts` | 4 |
| `src/skills-resolver.test.ts` | 8 |
| `src/skills-materialize.test.ts` | 4 |
| `src/skills-tier3-reminder.test.ts` | 4 |
| `src/skills-fs-watcher.test.ts` | 2 |
| `src/skills-integration.test.ts` | 4 |
| `src/config.test.ts` (delta) | 2 |
| **Total** | **32** |

## Execution Options

Plan complete and saved to `docs/superpowers/plans/2026-08-26-skills-resolution.md`. Two execution options:

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task, Oracle review between tasks, fast iteration with isolation.

**2. Inline Execution** — execute tasks in this session using `executing-plans`, batch execution with checkpoints.
