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
