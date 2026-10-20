/**
 * autonomous-skills.ts — the agent creates its own skills, gated (v0.59.0).
 *
 * DESIGN (answer to "the agent must be autonomous, but the skills must be
 * worth something, not garbage"):
 *
 *   garbage sources            →  the gate
 *   ─────────────────────────────────────────────────────────────────
 *   protocol rules repeated    →  PROTOCOL_RULE_CATEGORIES rejection
 *   no project scope           →  "no-project-scope" rejection
 *   generic remedy             →  "generic-remedy" rejection
 *   one-off anecdote           →  "not-enough-evidence" (needs 3+)
 *   low confidence             →  "low-confidence" rejection
 *   skill already exists       →  "duplicate-skill" / "near-duplicate-skill"
 *
 * The gate is the WHOLE safety story: promotion is automatic, but a skill
 * that fails any gate is never written. The gates are conservative by
 * design — a missed skill is recoverable, a pile of garbage skills is not.
 *
 * Every proposal carries its rejection reasons, so the behaviour is
 * auditable (`omo_skill_status` reports what was rejected and why).
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { projectSkillsRoot } from "./skills-catalog.js"
import {
  isRenderableSkillBody,
  proposeSkills,
  renderSkillBody,
  type LessonInput,
  type SkillProposal,
} from "./skill-quality.js"

export interface AutonomousSkillConfig {
  /** Master switch for autonomous promotion. Default true. */
  readonly enabled?: boolean
  /** Minimum independent lessons. Default 3. */
  readonly minLessons?: number
  /** Minimum confidence to consider. Default 0.6. */
  readonly minConfidence?: number
  /** Minimum confidence to auto-promote. Default 0.7. */
  readonly minPromotionConfidence?: number
  /** Write skills to the project (.agents/skills) — default true. */
  readonly writeProjectSkills?: boolean
  /** Write skills to the global chore dir (~/.agents/skills) — default false. */
  readonly writeGlobalSkills?: boolean
  /** Also mirror to global when writing project skills — default false. */
  readonly mirrorGlobal?: boolean
}

export interface ExistingSkill {
  readonly slug: string
  readonly body: string
}

/** Read the skills already present in a directory (slug + body). */
export function readExistingSkills(dir: string): ExistingSkill[] {
  if (!existsSync(dir)) return []
  const out: ExistingSkill[] = []
  let entries: string[] = []
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  for (const entry of entries) {
    const skillPath = join(dir, entry, "SKILL.md")
    if (!existsSync(skillPath)) continue
    try {
      out.push({ slug: entry, body: readFileSync(skillPath, "utf8") })
    } catch {
      // Unreadable skill — skip, never crash the scan.
    }
  }
  return out
}

export interface WriteSkillResult {
  readonly written: boolean
  readonly reason: "created" | "unchanged" | "not-renderable" | "not-promotable" | "io-error"
  readonly path: string | null
}

/**
 * Write a skill body to <dir>/<slug>/SKILL.md. Refuses to overwrite an
 * existing skill with different content (the human's / another skill's
 * version wins) and refuses to write a body that fails isRenderableSkillBody.
 */
export function writeSkill(dir: string, slug: string, body: string): WriteSkillResult {
  if (!isRenderableSkillBody(body)) return { written: false, reason: "not-renderable", path: null }
  const skillDir = join(dir, slug)
  const skillPath = join(skillDir, "SKILL.md")
  if (existsSync(skillPath)) {
    let existing = ""
    try {
      existing = readFileSync(skillPath, "utf8")
    } catch {
      existing = ""
    }
    if (existing === body) return { written: false, reason: "unchanged", path: skillPath }
    return { written: false, reason: "not-promotable", path: skillPath }
  }
  try {
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(skillPath, body, "utf8")
    return { written: true, reason: "created", path: skillPath }
  } catch {
    return { written: false, reason: "io-error", path: null }
  }
}

export interface AutonomousSynthesisInput {
  readonly lessons: readonly LessonInput[]
  readonly cwd: string
  readonly config?: AutonomousSkillConfig
  /** Global skills dir override (tests). */
  readonly globalDir?: string
  /** Project skills dir override (tests). */
  readonly projectDir?: string
}

export interface AutonomousSynthesisResult {
  readonly proposals: readonly SkillProposal[]
  readonly written: readonly { slug: string; path: string }[]
  readonly rejected: readonly { slug: string; reasons: readonly string[] }[]
  readonly scannedLessons: number
}

/**
 * The autonomous loop: read lessons → apply the gate → write the skills
 * that pass. Nothing else is written.
 */
export async function runAutonomousSynthesis(
  input: AutonomousSynthesisInput,
): Promise<AutonomousSynthesisResult> {
  const cfg = input.config ?? {}
  const enabled = cfg.enabled !== false
  const projectDir = input.projectDir ?? projectSkillsRoot(input.cwd)
  const globalDir = input.globalDir

  const existingProject = readExistingSkills(projectDir)
  const existingGlobal = globalDir ? readExistingSkills(globalDir) : []
  const existingAll = [...existingProject, ...existingGlobal]

  const proposals = proposeSkills(input.lessons, {
    minLessons: cfg.minLessons ?? 3,
    minConfidence: cfg.minConfidence ?? 0.6,
    minPromotionConfidence: cfg.minPromotionConfidence ?? 0.7,
    existingSkillSlugs: existingAll.map((s) => s.slug),
    existingSkillBodies: existingAll.map((s) => s.body),
  })

  const written: { slug: string; path: string }[] = []
  const rejected: { slug: string; reasons: readonly string[] }[] = []

  for (const proposal of proposals) {
    if (!enabled) {
      rejected.push({ slug: proposal.slug, reasons: ["autonomous-disabled"] })
      continue
    }
    if (!proposal.promotable) {
      rejected.push({ slug: proposal.slug, reasons: proposal.rejections })
      continue
    }
    if (proposal.confidence < (cfg.minPromotionConfidence ?? 0.7)) {
      rejected.push({ slug: proposal.slug, reasons: ["below-promotion-confidence"] })
      continue
    }
    const body = renderSkillBody(proposal)
    if (!isRenderableSkillBody(body)) {
      rejected.push({ slug: proposal.slug, reasons: ["not-renderable"] })
      continue
    }
    let didWrite = false
    if (cfg.writeProjectSkills !== false) {
      const res = writeSkill(projectDir, proposal.slug, body)
      if (res.written) {
        written.push({ slug: proposal.slug, path: res.path! })
        didWrite = true
      }
    }
    if (cfg.writeGlobalSkills === true && globalDir) {
      const res = writeSkill(globalDir, proposal.slug, body)
      if (res.written) {
        written.push({ slug: proposal.slug, path: res.path! })
        didWrite = true
      }
    }
    if (cfg.mirrorGlobal === true && globalDir && cfg.writeProjectSkills !== false) {
      const res = writeSkill(globalDir, proposal.slug, body)
      if (res.written) written.push({ slug: proposal.slug, path: res.path! })
    }
    if (!didWrite) {
      rejected.push({ slug: proposal.slug, reasons: ["not-written"] })
    }
  }

  return {
    proposals,
    written,
    rejected,
    scannedLessons: input.lessons.length,
  }
}

/**
 * Format the status report — what became a skill, what did NOT and why.
 * The rejection reasons are the auditable proof that the gate works.
 */
export function formatSynthesisReport(result: AutonomousSynthesisResult): string {
  const lines: string[] = []
  lines.push(`Scanned ${result.scannedLessons} lesson(s) from agentmemory.`)
  if (result.written.length > 0) {
    lines.push("")
    lines.push(`SKILLS CREATED (${result.written.length}):`)
    for (const w of result.written) lines.push(`  - ${w.slug} → ${w.path}`)
  }
  if (result.rejected.length > 0) {
    lines.push("")
    lines.push(`REJECTED (${result.rejected.length}):`)
    for (const r of result.rejected) lines.push(`  - ${r.slug}: ${r.reasons.join(", ")}`)
  }
  if (result.written.length === 0 && result.rejected.length === 0) {
    lines.push("Nothing to synthesize (no recurring patterns yet).")
  }
  return lines.join("\n")
}
