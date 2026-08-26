/**
 * Chore skills bootstrap — extracts bundled skills to ~/.agents/skills/
 * on first run and on plugin upgrade. Idempotent: skips slugs whose
 * SKILL.md hash matches the bundled copy.
 *
 * Manifest at ~/.agents/skills/.omo-meta-governor-checksums.json records
 * per-slug SHA-256 hashes so future runs can detect user modifications.
 *
 * Per spec §Error Handling: every failure is a warning, never a throw.
 * The plugin must boot successfully even if every layer fails.
 */

import { createHash } from "node:crypto"
import { mkdir, readFile, readdir, writeFile, copyFile, rm } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { execFileSync } from "node:child_process"

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

async function writeManifestSafe(globalDir: string, manifest: Manifest): Promise<boolean> {
  try {
    await writeFile(
      join(globalDir, MANIFEST_FILENAME),
      JSON.stringify(manifest, null, 2),
      "utf8",
    )
    return true
  } catch (err) {
    console.warn(`[skills-bootstrap] manifest write failed: ${(err as Error).message}`)
    return false
  }
}

async function cleanStageSafe(stageDir: string): Promise<void> {
  try {
    await rm(stageDir, { recursive: true, force: true })
  } catch {
    // best-effort; do not throw
  }
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

  // Extract tarball to a staging dir. Clean any leftover from previous run
  // before extracting, so stale slugs never contaminate the new state.
  const stageDir = join(opts.globalDir, ".bootstrap-stage")
  await cleanStageSafe(stageDir)
  try {
    await mkdir(stageDir, { recursive: true })
  } catch (err) {
    console.warn(`[skills-bootstrap] stage dir creation failed: ${(err as Error).message}`)
    return result
  }

  try {
    // Use execFileSync (no shell) to avoid shell injection via paths.
    execFileSync("tar", ["-xzf", opts.tarballPath, "-C", stageDir], { stdio: ["ignore", "ignore", "pipe"] })
  } catch (err) {
    console.warn(`[skills-bootstrap] tarball extraction failed: ${(err as Error).message}`)
    await cleanStageSafe(stageDir)
    return result
  }

  const manifest = (await readManifest(opts.globalDir)) ?? {
    version: opts.pluginVersion, skills: {},
  }
  const newManifest: Manifest = {
    version: opts.pluginVersion,
    skills: { ...manifest.skills },
  }

  let slugs: string[] = []
  try {
    const entries = await readdir(stageDir, { withFileTypes: true })
    slugs = entries.filter((e) => e.isDirectory()).map((e) => e.name)
  } catch (err) {
    console.warn(`[skills-bootstrap] stage dir read failed: ${(err as Error).message}`)
    await cleanStageSafe(stageDir)
    return result
  }

  for (const slug of slugs) {
    try {
      const stagedSkill = join(stageDir, slug, "SKILL.md")
      if (!existsSync(stagedSkill)) continue
      const stagedHash = await hashFile(stagedSkill)
      const targetDir = join(opts.globalDir, slug)
      const targetSkill = join(targetDir, "SKILL.md")

      if (!existsSync(targetSkill)) {
        // Fresh install
        await mkdir(targetDir, { recursive: true })
        await copyFile(stagedSkill, targetSkill)
        result.extracted.push(slug)
      } else {
        // Check existing hash
        const existingHash = await hashFile(targetSkill)
        if (existingHash === stagedHash) {
          result.skipped.push(slug)
        } else {
          // User modified - skip + warn
          console.warn(
            `[skills-bootstrap] skill '${slug}' was modified by user; skipping. ` +
            `bundled: ${stagedHash}, local: ${existingHash}`,
          )
          result.warned.push(slug)
        }
      }
      newManifest.skills[slug] = stagedHash
    } catch (err) {
      // Per-skill errors must not abort the whole bootstrap
      console.warn(`[skills-bootstrap] error processing '${slug}': ${(err as Error).message}`)
    }
  }

  // Clean up staging (try/finally semantics: always remove stageDir before returning)
  await cleanStageSafe(stageDir)

  // Write manifest (also wrapped to never throw)
  result.manifestWritten = await writeManifestSafe(opts.globalDir, newManifest)
  return result
}
