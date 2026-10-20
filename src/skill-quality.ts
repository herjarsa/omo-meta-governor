/**
 * skill-quality.ts — the quality gate for autonomous skill synthesis (v0.59.0).
 *
 * WHY this module exists: the agent must create its own skills WITHOUT human
 * approval, so the gate has to carry all the judgment a human would. Two
 * observed failure modes drive the rules:
 *
 * 1. PROTOCOL RULES ARE NOT SKILLS. A lesson saying "no `as any` in
 *    TypeScript" is worth nothing as a skill: the rule is already in the
 *    system prompt. A skill must carry project-specific knowledge the
 *    agent does not already have.
 *
 * 2. A SKILL NEEDS EVIDENCE. One occurrence is an anecdote. Three
 *    independent occurrences of the SAME rule in the SAME place is a
 *    pattern worth encoding.
 *
 * The gate is pure and deterministic: given lessons, it returns the skills
 * that are worth writing and the reasons the others were rejected. Every
 * rejection has a machine-readable reason so the behaviour is auditable.
 */

import { parseLessonContent } from "./agentmemory-bridge.js"

/**
 * Protocol rules that are ALREADY enforced by the system prompt / rule
 * injection. A skill that repeats them adds tokens and no knowledge.
 */
export const PROTOCOL_RULE_CATEGORIES: ReadonlySet<string> = new Set([
  "no-type-suppression",
  "no-empty-catch",
  "memory-first",
  "empty-result-escalation",
  "codebase-graph-first",
  "continuation-discipline",
  "save-discovery-to-memory",
  "no-batch-todo-completion",
  "oracle-verification",
])

export interface LessonInput {
  readonly id: string
  readonly content: string
  readonly confidence: number
  readonly tags: readonly string[]
  /**
   * v0.59.0: how many times agentmemory REINFORCED this lesson. A lesson
   * that occurred once has reinforcements=0; three occurrences of the SAME
   * rule collapse into ONE row with reinforcements=2. The row count is
   * therefore NOT the evidence count — reinforcements are.
   */
  readonly reinforcements?: number
}

export interface SkillGateOptions {
  /** Minimum independent lessons required. Default 3. */
  readonly minLessons?: number
  /** Minimum aggregated confidence. Default 0.6. */
  readonly minConfidence?: number
  /** Minimum confidence for autonomous promotion (stricter). Default 0.7. */
  readonly minPromotionConfidence?: number
  /** Existing skill slugs (already written). */
  readonly existingSkillSlugs?: readonly string[]
  /** Existing skill bodies (for near-duplicate detection). */
  readonly existingSkillBodies?: readonly string[]
}

export type RejectionReason =
  | "protocol-rule"
  | "no-project-scope"
  | "generic-remedy"
  | "low-confidence"
  | "not-enough-evidence"
  | "duplicate-skill"
  | "near-duplicate-skill"
  | "malformed-lesson"

export interface SkillProposal {
  readonly slug: string
  /** The rule / knowledge the skill encodes. */
  readonly title: string
  readonly lessonIds: readonly string[]
  readonly count: number
  readonly confidence: number
  /** Distinct places (file basenames) where the rule fired. */
  readonly places: readonly string[]
  /** Distinct remedies observed (what to do). */
  readonly remedies: readonly string[]
  /** The lessons' mistakes (what went wrong). */
  readonly mistakes: readonly string[]
  /** True when the proposal passes EVERY gate (ready to write). */
  readonly promotable: boolean
  readonly rejections: readonly RejectionReason[]
}

const GENERIC_REMEDIES: ReadonlySet<string> = new Set([
  "re-read the plan and continue with verification",
])

/** True when the "where" names a real place (a file, not just a session). */
function hasProjectScope(whereToGo: string): boolean {
  const trimmed = whereToGo.trim()
  if (trimmed.length === 0) return false
  if (trimmed.startsWith("session:")) return false
  // Must name at least one concrete file-ish token.
  return /[\\/]|[A-Za-z0-9_-]+\.[A-Za-z0-9]{1,6}/.test(trimmed)
}

/** Extract file basenames from a "where" list. */
function placeTokens(whereToGo: string): string[] {
  return whereToGo
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => p.split(/[\\/]/).pop() ?? p)
}

/** Jaccard similarity over normalized word tokens. */
export function jaccard(a: string, b: string): number {
  const tokensOf = (s: string) =>
    new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2))
  const ta = tokensOf(a)
  const tb = tokensOf(b)
  if (ta.size === 0 || tb.size === 0) return 0
  let intersection = 0
  for (const t of ta) if (tb.has(t)) intersection++
  return intersection / (ta.size + tb.size - intersection)
}

/**
 * Stable slug for a skill built from a rule + place. Lowercase kebab-case.
 */
export function slugForSkill(rule: string, places: readonly string[]): string {
  const rulePart = rule
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
  const placePart = places[0]
    ? places[0]
        .toLowerCase()
        .replace(/\.[a-z0-9]{1,6}$/, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 20)
    : ""
  const slug = placePart ? `${rulePart}-${placePart}` : rulePart
  return slug.length >= 3 ? slug : `skill-${rulePart || "rule"}`
}

/**
 * Group lessons into skill proposals and apply every gate.
 *
 * Grouping key = (rule, place-set). The rule comes from the lesson tags
 * (the protocol category) or from the mistake prefix; the place comes from
 * the "Where:" line. Lessons with the same rule but different places are
 * SEPARATE proposals — "always use DI seams in plugin.ts" and "always use
 * DI seams in sqlite.ts" are different skills.
 */
export function proposeSkills(
  lessons: readonly LessonInput[],
  opts: SkillGateOptions = {},
): SkillProposal[] {
  const minLessons = opts.minLessons ?? 3
  const minConfidence = opts.minConfidence ?? 0.6
  const minPromotionConfidence = opts.minPromotionConfidence ?? 0.7
  const existingSlugs = new Set(opts.existingSkillSlugs ?? [])

  interface Bucket {
    rule: string
    places: string[]
    lessons: LessonInput[]
  }
  /** Occurrences of this pattern = distinct rows + agentmemory reinforcements. */
  const occurrencesOf = (bucket: Bucket): number =>
    bucket.lessons.length +
    bucket.lessons.reduce((sum, l) => sum + (l.reinforcements ?? 0), 0)
  const buckets = new Map<string, Bucket>()

  for (const lesson of lessons) {
    const parsed = parseLessonContent(lesson.content)
    if (parsed.mistake.length === 0) continue
    const rule = (lesson.tags[0] ?? parsed.mistake.split(":")[0] ?? "").trim()
    if (rule.length === 0) continue
    const places = placeTokens(parsed.whereToGo)
    const placeKey = places.sort().join(",")
    const key = `${rule}::${placeKey}`
    const bucket = buckets.get(key) ?? { rule, places, lessons: [] }
    bucket.lessons.push(lesson)
    buckets.set(key, bucket)
  }

  const proposals: SkillProposal[] = []
  for (const bucket of buckets.values()) {
    const mistakes: string[] = []
    const remedies: string[] = []
    const places: string[] = []
    for (const lesson of bucket.lessons) {
      const parsed = parseLessonContent(lesson.content)
      if (!mistakes.includes(parsed.mistake)) mistakes.push(parsed.mistake)
      if (parsed.whatToDo && !remedies.includes(parsed.whatToDo)) remedies.push(parsed.whatToDo)
      for (const place of placeTokens(parsed.whereToGo)) {
        if (!places.includes(place)) places.push(place)
      }
    }
    const maxConfidence = Math.max(...bucket.lessons.map((l) => l.confidence))
    const occurrences = occurrencesOf(bucket)
    // Independent confirmations raise confidence: N occurrences of the same
    // rule in the same place is real evidence, capped at 0.9. The occurrence
    // count includes agentmemory reinforcements (three repetitions of the
    // same rule collapse into ONE row with reinforcements=2).
    const confidence = Math.min(0.9, maxConfidence + 0.05 * (occurrences - 1))
    const slug = slugForSkill(bucket.rule, places)

    const rejections: RejectionReason[] = []
    if (PROTOCOL_RULE_CATEGORIES.has(bucket.rule)) rejections.push("protocol-rule")
    if (!hasProjectScope(bucket.lessons.map((l) => parseLessonContent(l.content).whereToGo).join(", "))) {
      rejections.push("no-project-scope")
    }
    if (
      remedies.length === 0 ||
      remedies.every((r) => GENERIC_REMEDIES.has(r.trim().toLowerCase()))
    ) {
      rejections.push("generic-remedy")
    }
    if (confidence < minConfidence) rejections.push("low-confidence")
    if (occurrences < minLessons) rejections.push("not-enough-evidence")
    if (existingSlugs.has(slug)) rejections.push("duplicate-skill")

    const proposal: SkillProposal = {
      slug,
      title: bucket.rule,
      lessonIds: bucket.lessons.map((l) => l.id),
      count: occurrences,
      confidence,
      places,
      remedies,
      mistakes,
      promotable: rejections.length === 0,
      rejections,
    }
    proposals.push(proposal)
  }

  // Near-duplicate detection against existing skill bodies.
  for (let i = 0; i < proposals.length; i++) {
    const proposal = proposals[i]!
    if (!proposal.promotable) continue
    const body = bodySignature(proposal)
    for (const existing of opts.existingSkillBodies ?? []) {
      if (jaccard(body, existing) >= 0.8) {
        proposals[i] = {
          ...proposal,
          promotable: false,
          rejections: [...proposal.rejections, "near-duplicate-skill"],
        }
        break
      }
    }
  }

  return proposals.sort(
    (a, b) => b.confidence - a.confidence || b.count - a.count || a.slug.localeCompare(b.slug),
  )
}

/** The canonical text of a proposal — used for near-duplicate comparison. */
export function bodySignature(proposal: SkillProposal): string {
  return [
    proposal.title,
    ...proposal.mistakes,
    ...proposal.remedies,
    ...proposal.places,
  ].join(" ")
}

/**
 * Build a deterministic SKILL.md body (the FALLBACK when the LLM
 * synthesizer is unavailable). Never throws; never emits an empty
 * procedure.
 */
export function renderSkillBody(proposal: SkillProposal): string {
  const lines: string[] = [
    "---",
    `name: ${proposal.slug}`,
    `description: "Project rule '${proposal.title}' learned from ${proposal.count} occurrences in ${proposal.places.join(", ") || "this project"}."`,
    "---",
    "",
    `# ${proposal.title}`,
    "",
    `> Learned from ${proposal.count} independent occurrences (confidence ${proposal.confidence.toFixed(2)}).`,
    "",
    "## When to use",
    "",
    `When working in: ${proposal.places.join(", ") || "this project"}.`,
    "",
    "## Procedure",
    "",
    ...(proposal.remedies.length > 0
      ? proposal.remedies.map((r, i) => `${i + 1}. ${r}`)
      : ["1. Follow the project rule described above."]),
    "",
    "## Pitfalls observed",
    "",
    ...proposal.mistakes.map((m) => `- ${m}`),
    "",
  ]
  return lines.join("\n")
}

/**
 * Validate a rendered body before it is written. A body that fails this
 * is NOT written — a half-formed skill is worse than no skill.
 *
 * NOTE ON STEP COUNT: the quality of a skill comes from the GATE (protocol
 * rules excluded, project scope required, 3+ independent occurrences, real
 * remedy), not from a minimum number of steps. Three occurrences of the
 * SAME rule legitimately produce ONE procedure step; demanding three would
 * reject the most common (and most valuable) case.
 */
export function isRenderableSkillBody(body: string): boolean {
  if (body.trim().length < 120) return false
  if (!/^---\n/.test(body)) return false
  if (!/name:\s*\S+/.test(body)) return false
  if (!/description:\s*".+"/.test(body)) return false
  if (!/## When to use/.test(body)) return false
  if (!/## Pitfalls observed/.test(body)) return false
  // Section extraction by HEADING LINES. Splitting on "##" broke the
  // Procedure section (the next heading's "##" truncated it) and silently
  // produced zero steps for every body.
  const section = (heading: string): string => {
    const lines = body.split("\n")
    const start = lines.findIndex((l) => l.trim() === heading)
    if (start < 0) return ""
    const rest = lines.slice(start + 1)
    const end = rest.findIndex((l) => l.trim().startsWith("## "))
    return (end < 0 ? rest : rest.slice(0, end)).join("\n")
  }
  // A step is "N. <text>" with real text. The old regex demanded 10
  // CONSECUTIVE non-space characters, which no English sentence has —
  // it rejected every valid body. Length of the whole line is the right
  // measure.
  const steps = section("## Procedure")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^\d+\.\s+\S/.test(l) && l.length >= 20)
  if (steps.length < 1) return false
  const pitfalls = section("## Pitfalls observed")
  return pitfalls.split("\n").some((l) => l.trim().startsWith("- ") && l.trim().length > 12)
}
