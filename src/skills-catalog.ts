/**
 * skills-catalog-paths.ts - path constants + slug helper.
 * v0.35.8 global catalog model.
 */
import { join } from "node:path"
import { homedir } from "node:os"
import { existsSync, mkdirSync, readlinkSync, symlinkSync, cpSync, readdirSync, lstatSync } from "node:fs"

/** Test seam: override the global skills root (e.g. HOMEDIR=/tmp/...). */
let _globalSkillsRootOverride: string | null = null
/**
 * Set a temporary override for the global skills root.
 * Pass the parent of `.agents/skills/` (i.e. what `homedir()` would return)
 * OR the full `.agents/skills` path; both are normalised.
 */
export function setGlobalSkillsRootOverride(p: string | null): void {
  if (p === null) {
    _globalSkillsRootOverride = null
    return
  }
  // Normalise: if caller passed the parent dir, append .agents/skills
  if (p.endsWith(".agents") || p.endsWith(".agents\\")) {
    _globalSkillsRootOverride = join(p, "skills")
  } else if (
    !p.endsWith("skills") &&
    !p.endsWith("skills\\") &&
    !p.includes(".agents")
  ) {
    _globalSkillsRootOverride = join(p, ".agents", "skills")
  } else {
    _globalSkillsRootOverride = p
  }
}
export function resolveGlobalSkillsRoot(): string {
  return _globalSkillsRootOverride ?? globalSkillsRoot()
}

export function globalSkillsRoot(): string {
  // Honour the test override seam so unit tests can redirect the cache.
  return _globalSkillsRootOverride ?? join(homedir(), ".agents", "skills")
}

export function projectSkillsRoot(projectCwd: string): string {
  return join(projectCwd, ".agents", "skills")
}

export function skillSlugFromId(id: string): string {
  const cleaned = id.replace(/\/+$/, "")
  const parts = cleaned.split("/")
  return parts[parts.length - 1] || cleaned
}

export interface LinkResult {
  ok: boolean
  mechanism: "symlink" | "copy" | "noop-already-exists"
  globalPath: string
  localPath: string
  reason?: string
}

function existsLocal(p: string): boolean {
  try { lstatSync(p); return true } catch { return false }
}

/**
 * Ensure a project-local entry exists for the given skill id, pointing at
 * the global cache. Tries symlink first (junction on Windows), falls back to
 * recursive copy if symlink creation fails (e.g. Developer Mode disabled).
 * Idempotent.
 */
export function ensureProjectLocalLink(skillId: string, projectCwd: string): LinkResult {
  const slug = skillSlugFromId(skillId)
  const globalPath = join(globalSkillsRoot(), slug)
  const localRoot = projectSkillsRoot(projectCwd)
  const localPath = join(localRoot, slug)

  if (!existsSync(globalPath)) {
    return { ok: false, mechanism: "noop-already-exists", globalPath, localPath,
      reason: `Global cache miss: ${globalPath} does not exist. Run omo_skill_add first.` }
  }
  if (existsLocal(localPath)) {
    return { ok: true, mechanism: "noop-already-exists", globalPath, localPath,
      reason: "Local entry already exists" }
  }
  mkdirSync(localRoot, { recursive: true })
  try {
    symlinkSync(globalPath, localPath, "junction")
    return { ok: true, mechanism: "symlink", globalPath, localPath }
  } catch (symErr) {
    try {
      cpSync(globalPath, localPath, { recursive: true, dereference: false })
      return { ok: true, mechanism: "copy", globalPath, localPath,
        reason: `Symlink failed (${(symErr as NodeJS.ErrnoException).code ?? "unknown"}); fell back to recursive copy.` }
    } catch (copyErr) {
      return { ok: false, mechanism: "copy", globalPath, localPath,
        reason: `Symlink failed (${(symErr as NodeJS.ErrnoException).code ?? "unknown"}) and copy failed (${(copyErr as NodeJS.ErrnoException).code ?? "unknown"}).` }
    }
  }
}

export function listGlobalSkills(): string[] {
  const root = globalSkillsRoot()
  if (!existsSync(root)) return []
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() || d.isSymbolicLink())
      .map((d) => d.name)
  } catch { return [] }
}

export function isSymlink(p: string): boolean {
  try { return lstatSync(p).isSymbolicLink() } catch { return false }
}

export function readSymlinkTarget(p: string): string | null {
  if (!isSymlink(p)) return null
  try { return readlinkSync(p) } catch { return null }
}