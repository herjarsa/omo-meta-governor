/**
 * Skill synthesis — Nivel 2 self-improvement (PLAN-skill-synthesis.md, v0.57).
 *
 * When consolidated lessons converge on the same pattern (N>=3, high
 * confidence), that pattern deserves promotion from "lesson" to "skill".
 * The plugin DRAFTS; the human APPROVES. The plugin NEVER writes SKILL.md
 * directly and NEVER auto-promotes — promoteDraftSkill() requires explicit
 * confirmed=true (the agent calls it only after the user approved).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tool, type ToolResult } from "@opencode-ai/plugin"
import { z } from "zod"
import { projectSkillsRoot } from "./skills-catalog.js"
import type { SqliteBackend } from "./sqlite-backend"

export interface LessonRow {
  readonly id: string
  readonly title: string
  readonly content: string
  readonly tags: readonly string[]
  readonly confidence: number
  readonly created_at: number
}

export interface SkillCandidate {
  readonly slug: string
  readonly tags: readonly string[]
  readonly count: number
  readonly avgConfidence: number
  readonly lessonIds: readonly string[]
  readonly sampleTitles: readonly string[]
}

export interface FindCandidatesOptions {
  readonly minGroupSize?: number
  readonly minAvgConfidence?: number
}

/**
 * Group lessons by identical sorted-tags signature (same grouping as
 * consolidateLessons) and return groups that qualify as skill candidates.
 * Pure function — the caller owns the read (SqliteBackend.listLessons).
 */
export function findSkillCandidates(
  lessons: readonly LessonRow[],
  opts: FindCandidatesOptions = {},
): SkillCandidate[] {
  const minGroupSize = opts.minGroupSize ?? 3
  const minAvgConfidence = opts.minAvgConfidence ?? 0.6
  const bySignature = new Map<string, LessonRow[]>()
  for (const lesson of lessons) {
    const signature = [...new Set(lesson.tags)].sort().join("")
    const group = bySignature.get(signature) ?? []
    group.push(lesson)
    bySignature.set(signature, group)
  }
  const candidates: SkillCandidate[] = []
  for (const group of bySignature.values()) {
    if (group.length < minGroupSize) continue
    const avgConfidence = group.reduce((sum, l) => sum + l.confidence, 0) / group.length
    if (avgConfidence < minAvgConfidence) continue
    const tags = [...new Set(group.flatMap((l) => [...l.tags]))].sort()
    candidates.push({
      slug: synthesizeSlug(tags),
      tags,
      count: group.length,
      avgConfidence,
      lessonIds: group.map((l) => l.id),
      sampleTitles: group.slice(0, 3).map((l) => l.title),
    })
  }
  return candidates.sort((a, b) => b.count - a.count || b.avgConfidence - a.avgConfidence)
}

/** Kebab-case slug from the primary tag; hash fallback when tagless. */
export function synthesizeSlug(tags: readonly string[]): string {
  const primary = tags[0] ?? ""
  const slug = primary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 60)
  if (slug.length >= 3) return slug
  const hash = [...tags.join(",")].reduce((a, c) => ((a << 5) - a + c.charCodeAt(0)) | 0, 0)
  return `lesson-${Math.abs(hash).toString(36)}`
}

/**
 * Draft a SKILL.md body from a candidate + remedy lines (procedure steps).
 * Pure lesson content — no tool routing, no self-references.
 */
export function draftSkillBody(
  candidate: Pick<SkillCandidate, "slug" | "tags" | "count" | "avgConfidence" | "lessonIds">,
  remedies: readonly string[],
): string {
  const description = `Recurring pattern: ${candidate.tags.join(", ")} (seen ${candidate.count}x, confidence ${candidate.avgConfidence.toFixed(2)})`
  const lines: string[] = [
    `---`,
    `name: ${candidate.slug}`,
    `description: "${description.replace(/"/g, "'")}"`,
    `---`,
    ``,
    `# ${candidate.slug}`,
    ``,
    `> DRAFT synthesized from ${candidate.count} consolidated lessons.`,
    `> Review and edit before use. Promote only after human approval.`,
    ``,
    `## When to use`,
    ``,
    `When the task involves: ${candidate.tags.join(", ")}.`,
    ``,
    `## Procedure`,
    ``,
    ...remedies.map((r, i) => `${i + 1}. ${r}`),
    ``,
    `## Source lessons`,
    ``,
    ...candidate.lessonIds.map((id) => `- ${id}`),
    ``,
  ]
  return lines.join("\n")
}

export interface DraftResult {
  readonly written: boolean
  readonly reason: "created" | "unchanged" | "blocked-real-skill" | "empty"
  readonly path: string | null
}

/**
 * Write DRAFT-SKILL.md under <project>/.agents/skills/<slug>/. NEVER writes
 * SKILL.md. Refuses when a real SKILL.md exists (human-approved skills are
 * never clobbered by drafts). Idempotent on identical body.
 */
export async function writeDraftSkill(
  projectCwd: string,
  slug: string,
  body: string,
): Promise<DraftResult> {
  if (!body || body.trim().length === 0) return { written: false, reason: "empty", path: null }
  const dir = join(projectSkillsRoot(projectCwd), slug)
  const skillPath = join(dir, "SKILL.md")
  const draftPath = join(dir, "DRAFT-SKILL.md")
  if (existsSync(skillPath)) {
    return { written: false, reason: "blocked-real-skill", path: skillPath }
  }
  mkdirSync(dir, { recursive: true })
  if (existsSync(draftPath)) {
    const existing = readFileSync(draftPath, "utf8")
    if (existing === body) return { written: false, reason: "unchanged", path: draftPath }
  }
  writeFileSync(draftPath, body, "utf8")
  return { written: true, reason: "created", path: draftPath }
}

export interface PromoteResult {
  readonly promoted: boolean
  readonly reason: "promoted" | "not-confirmed" | "no-draft" | "skill-exists" | "io-error"
  readonly path: string | null
}

/**
 * Promote DRAFT-SKILL.md -> SKILL.md. Requires confirmed=true — the agent
 * passes true ONLY after the user explicitly approved the draft. Refuses
 * when no draft exists or a real SKILL.md already does. No auto-promotion.
 */
export async function promoteDraftSkill(
  projectCwd: string,
  slug: string,
  confirmed: boolean,
): Promise<PromoteResult> {
  if (confirmed !== true) return { promoted: false, reason: "not-confirmed", path: null }
  const dir = join(projectSkillsRoot(projectCwd), slug)
  const draftPath = join(dir, "DRAFT-SKILL.md")
  const skillPath = join(dir, "SKILL.md")
  if (!existsSync(draftPath)) return { promoted: false, reason: "no-draft", path: null }
  if (existsSync(skillPath)) return { promoted: false, reason: "skill-exists", path: skillPath }
  try {
    renameSync(draftPath, skillPath)
    return { promoted: true, reason: "promoted", path: skillPath }
  } catch {
    return { promoted: false, reason: "io-error", path: null }
  }
}

// ---------------------------------------------------------------------------
// S3 — omo_skill_propose + omo_skill_promote (MCP-server mode)
// ---------------------------------------------------------------------------

export interface OmoSkillProposeDeps {
  sqlite: SqliteBackend
  cwd: string
  minGroupSize?: number
  minAvgConfidence?: number
}

/**
 * omo_skill_propose: detect recurring lesson patterns and write DRAFTS.
 * Drafts are harmless (DRAFT-SKILL.md is invisible to the resolver);
 * promotion to a real skill ALWAYS requires human approval via
 * omo_skill_promote with confirmed=true. Never throws.
 */
export function buildOmoSkillProposeTool(deps: OmoSkillProposeDeps) {
  return tool({
    description:
      "Detect recurring lesson patterns (3+ similar lessons) and draft candidate " +
      "skills as DRAFT-SKILL.md files under <project>/.agents/skills/<slug>/. " +
      "Drafts are NOT active skills — review each draft with the user, then " +
      "call omo_skill_promote with confirmed=true ONLY after explicit user approval. " +
      "Never promote without approval.",
    args: {
      minGroupSize: z.number().int().min(2).max(20).default(3).describe("Minimum lessons per pattern."),
      minAvgConfidence: z.number().min(0).max(1).default(0.6).describe("Minimum average confidence."),
    },
    async execute(args, _ctx): Promise<ToolResult> {
      try {
        const lessons = await deps.sqlite.listLessons()
        const candidates = findSkillCandidates(lessons, {
          minGroupSize: args.minGroupSize,
          minAvgConfidence: args.minAvgConfidence,
        })
        if (candidates.length === 0) {
          return {
            title: "omo_skill_propose: no candidates",
            output: "No recurring lesson patterns qualify (need 3+ similar lessons at avg confidence >= threshold).",
            metadata: { tool: "omo_skill_propose", ok: true, candidates: 0 },
          }
        }
        const lines: string[] = []
        const drafted: string[] = []
        for (const candidate of candidates) {
          const remedies = candidate.sampleTitles
          const body = draftSkillBody(candidate, remedies)
          const draft = await writeDraftSkill(deps.cwd, candidate.slug, body)
          if (draft.path) drafted.push(draft.path)
          lines.push(
            `- ${candidate.slug}: ${candidate.count} lessons, avg confidence ${candidate.avgConfidence.toFixed(2)} (tags: ${candidate.tags.join(", ")})` +
            (draft.path ? `\n  draft: ${draft.path} [${draft.reason}]` : `\n  draft: not written [${draft.reason}]`),
          )
        }
        return {
          title: `omo_skill_propose: ${candidates.length} candidate(s)`,
          output:
            `Recurring patterns drafted for HUMAN review (nothing is active until promoted):\n` +
            lines.join("\n") +
            `\n\nNext: review each DRAFT-SKILL.md with the user, then omo_skill_promote with confirmed=true.`,
          metadata: { tool: "omo_skill_propose", ok: true, candidates: candidates.length, drafts: drafted },
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return {
          title: "omo_skill_propose: error",
          output: `Candidate detection failed: ${msg}`,
          metadata: { tool: "omo_skill_propose", ok: false, error: msg },
        }
      }
    },
  })
}

export interface OmoSkillPromoteDeps {
  cwd: string
}

/**
 * omo_skill_promote: DRAFT-SKILL.md -> SKILL.md. The agent passes
 * confirmed=true ONLY after the user explicitly approved the draft.
 * confirmed=false (default) always refuses. Never throws.
 */
export function buildOmoSkillPromoteTool(deps: OmoSkillPromoteDeps) {
  return tool({
    description:
      "Promote a reviewed DRAFT-SKILL.md to an active SKILL.md. " +
      "Pass confirmed=true ONLY after the user explicitly approved the draft content. " +
      "Default (confirmed=false) always refuses — there is no auto-promotion path.",
    args: {
      slug: z.string().min(3).describe("Skill slug (directory name under .agents/skills/)."),
      confirmed: z
        .boolean()
        .default(false)
        .describe("User explicitly approved this draft. Must be true to promote."),
    },
    async execute(args, _ctx): Promise<ToolResult> {
      try {
        const result = await promoteDraftSkill(deps.cwd, args.slug, args.confirmed)
        if (result.promoted) {
          return {
            title: `omo_skill_promote: ${args.slug} promoted`,
            output: `Promoted to active skill:\n  ${result.path}\nThe skill is now discoverable by the resolver.`,
            metadata: { tool: "omo_skill_promote", ok: true, slug: args.slug, path: result.path },
          }
        }
        return {
          title: `omo_skill_promote: ${args.slug} refused (${result.reason})`,
          output:
            result.reason === "not-confirmed"
              ? "Refused: confirmed=false. Review the DRAFT-SKILL.md with the user and re-run with confirmed=true after explicit approval."
              : `Refused: ${result.reason}.`,
          metadata: { tool: "omo_skill_promote", ok: false, slug: args.slug, reason: result.reason },
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return {
          title: `omo_skill_promote: ${args.slug} error`,
          output: `Promotion failed: ${msg}`,
          metadata: { tool: "omo_skill_promote", ok: false, slug: args.slug, error: msg },
        }
      }
    },
  })
}
