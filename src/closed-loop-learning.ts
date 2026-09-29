/**
 * Closed-loop learning for MetaGovernor.
 *
 * PR 3 of 8. After every repair/action cycle, observeAndLearn() decides
 * whether to persist a lesson or decision record to agentmemory. Future
 * sessions retrieve these via aggregateRead() (PR 2) and factor them into
 * scoring (PR 5).
 *
 * Design:
 * - Pure function with DI backend (no side effects without backend).
 * - config.enabled=false → returns no-op with reason.
 * - Severity threshold: minSeverityToLearn filters what gets saved.
 * - Session cap: maxLessonsPerSession prevents flooding.
 * - Lessons go to agentmemory_memory_save (type: "pattern").
 * - Decisions go to agentmemory_memory_save (type: "fact").
 * - No file I/O, no MCP calls — just decision logic + DI write.
 */

import type {
  AgentmemoryWriteBackend,
  ClosedLoopConfig,
  Decision,
  Deviation,
  LearnFromOutcomeInput,
  LearnFromOutcomeOutput,
  LessonLearned,
  MemoryDecision,
  MemoryRead,
} from "./types"

/**
 * v0.51.1 (P1 lesson-spam guard, Wave A T-5df16a0e): minimum lesson
 * confidence. Lessons below this are noise: 5311 Action-continue rows at
 * confidence 0.3 flooded recall. Only high-value lessons persist.
 */
export const MIN_LESSON_CONFIDENCE = 0.5

/**
 * Lesson confidence for a decision: the strongest available signal -
 * max(|score|, best evidence confidence) - clamped to [0.3, 0.8].
 * Evidence confidence matters: a warn at -0.4 backed by 0.8-confidence
 * evidence is high-value signal, while a neutral continue near 0 with no
 * evidence collapses to the 0.3 floor (below MIN_LESSON_CONFIDENCE).
 */
export function lessonConfidenceForDecision(decision: Decision): number {
  let evidenceMax = 0
  for (const e of decision.evidence) {
    if (typeof e.confidence === "number" && e.confidence > evidenceMax) {
      evidenceMax = e.confidence
    }
  }
  return Math.max(0.3, Math.min(0.8, Math.max(Math.abs(decision.score), evidenceMax)))
}

/**
 * Neutral continues carry no learnable signal and must never persist as
 * lessons - they were the entire 5311-row Action-continue spam class.
 */
export function isNeutralContinueDecision(decision: Decision): boolean {
  return decision.action === "continue" && Math.abs(decision.score) < MIN_LESSON_CONFIDENCE
}

/** Severity ordering for threshold comparison. */
const SEVERITY_ORDER: Record<string, number> = {
  leve: 0,
  media: 1,
  grave: 2,
}

/**
 * Generate a deterministic lesson ID from session + timestamp.
 */
function generateLessonId(sessionID: string, timestamp: string): string {
  const hash = `${sessionID}-${timestamp}`.split("").reduce((a, c) => ((a << 5) - a + c.charCodeAt(0)) | 0, 0)
  return `L-${Math.abs(hash).toString(36)}`
}

/**
 * Generate a deterministic decision ID from session + action + timestamp.
 */
function generateDecisionId(sessionID: string, action: string, timestamp: string): string {
  const hash = `${sessionID}-${action}-${timestamp}`.split("").reduce((a, c) => ((a << 5) - a + c.charCodeAt(0)) | 0, 0)
  return `D-${Math.abs(hash).toString(36)}`
}

/**
 * Check if the decision's severity meets the threshold.
 */
function severityMeetsThreshold(
  deviations: readonly Deviation[],
  threshold: ClosedLoopConfig["minSeverityToLearn"]
): boolean {
  const minOrder = SEVERITY_ORDER[threshold] ?? 0
  return deviations.some((d) => (SEVERITY_ORDER[d.severity] ?? 0) >= minOrder)
}

/**
 * Extract concepts from deviations for the lesson. Optionally include file
 * basenames from the broader filePaths list so FTS indexing covers all
 * recently changed files (Gap Q completeness, v0.17.2).
 */
function extractConcepts(
  deviations: readonly Deviation[],
  filesChanged: readonly string[] = [],
): string[] {
  const concepts = new Set<string>()
  for (const d of deviations) {
    concepts.add(d.category)
    concepts.add(d.severity)
    if (d.filePath) {
      // Index the basename for FTS lookup by tool/file name
      const basename = d.filePath.split("/").pop() ?? d.filePath
      concepts.add(basename)
    }
  }
  // v0.17.2: also index file basenames from broader file change set
  for (const filePath of filesChanged) {
    const basename = filePath.split("/").pop() ?? filePath
    if (basename) concepts.add(basename)
  }
  return [...concepts]
}

/**
 * Build the lesson content string from a decision and its deviations.
 */
function buildLessonContent(decision: Decision, deviations: readonly Deviation[]): string {
  const deviationSummary = deviations
    .map((d) => `[${d.severity}] ${d.category}: ${d.detail}`)
    .join("; ")
  return `Action "${decision.action}" (score ${decision.score.toFixed(2)}) after deviations: ${deviationSummary}. Reasoning: ${decision.reasoning}`
}

/**
 * Core learning function. Decides whether to save a lesson and/or decision
 * to agentmemory based on the outcome of a repair/action cycle.
 *
 * Returns LearnFromOutcomeOutput describing what was saved (or why nothing was saved).
 */
export async function observeAndLearn(
  input: LearnFromOutcomeInput,
  backend: AgentmemoryWriteBackend
): Promise<LearnFromOutcomeOutput> {
  const { decision, config, sessionID, directory, filesChanged } = input
  const now = new Date().toISOString()

  // Config disabled → no-op
  if (!config.enabled) {
    return { lessonSaved: null, decisionSaved: null, reason: "closed-loop learning disabled" }
  }

  // No deviations → nothing to learn from
  if (decision.evidence.length === 0 && decision.action === "continue") {
    return { lessonSaved: null, decisionSaved: null, reason: "no deviations to learn from" }
  }

  let lessonSaved: LessonLearned | null = null
  let decisionSaved: MemoryDecision | null = null

  // Save decision record if enabled
  if (config.saveDecisions) {
    const decisionRecord: MemoryDecision = {
      id: generateDecisionId(sessionID, decision.action, now),
      timestampISO: now,
      action: decision.action,
      score: decision.score,
      reasoning: decision.reasoning,
      sessionID,
      directory,
      deviations: decision.evidence
        .filter((e) => e.source === "deviation-detector")
        .map((e) => ({
          severity: "media" as const,
          category: e.source,
          detail: e.value,
        })),
    }

    try {
      await backend.saveMemory({
        content: `Decision: ${decision.action} (score ${decision.score.toFixed(2)}). ${decision.reasoning}`,
        concepts: ["meta-governor", "decision", decision.action],
        type: "fact",
        files: [...filesChanged],
      })
      decisionSaved = decisionRecord
    } catch {
      // Backend failure is non-fatal — degrade silently
    }
  }

  // Save lesson if deviations meet severity threshold
  const deviationsFromEvidence = decision.evidence
    .filter((e) => e.source === "deviation-detector")
    .map<Deviation>((e) => ({
      severity: "media",
      category: e.source,
      detail: e.value,
    }))

  // v0.17.0 (F5.4): enforce maxLessonsPerSession cap.
  // Cap is inclusive — when currentLessonCount >= cap, skip the lesson save.
  const currentLessonCount = input.currentLessonCount ?? 0
  if (currentLessonCount >= config.maxLessonsPerSession) {
    return {
      lessonSaved: null,
      decisionSaved,
      reason: `maxLessonsPerSession cap reached (${currentLessonCount} >= ${config.maxLessonsPerSession})`,
    }
  }

  // v0.17.2 (Gap D): when saveLessons is explicitly false, skip lesson save.
  // Default is true (lesson saves unless explicitly disabled).
  const saveLessonsEnabled = config.saveLessons !== false
  // v0.51.1 (P1 spam guard): WHY a lesson was skipped. Surfaced in reason.
  let lessonSkipReason: string | null = null
  if (
    saveLessonsEnabled &&
    severityMeetsThreshold(deviationsFromEvidence, config.minSeverityToLearn)
  ) {
    if (isNeutralContinueDecision(decision)) {
      // Neutral continues carry no learnable signal - persisting them
      // produced the 5311-row Action-continue noise class (Wave A P1).
      lessonSkipReason = "neutral continue carries no learnable signal (action=continue score=" + decision.score.toFixed(2) + ")"
    } else {
      const lessonConfidence = lessonConfidenceForDecision(decision)
      if (lessonConfidence < MIN_LESSON_CONFIDENCE) {
        lessonSkipReason = "confidence below threshold (" + lessonConfidence.toFixed(2) + " < " + MIN_LESSON_CONFIDENCE.toFixed(2) + ")"
      } else {
        const concepts = extractConcepts(deviationsFromEvidence, filesChanged)
        const content = buildLessonContent(decision, deviationsFromEvidence)
        // v0.51.1: stable dedupe key - backends dedupe on this (real dedupe
        // in save, not just the autoRemember cooldown). Score floats are
        // excluded so jitter cannot defeat it.
        const dedupeKey = conscienceDedupeKey({
          action: decision.action,
          evidenceSources: decision.evidence.map((e) => e.source),
          deviationCategories: deviationsFromEvidence.map((d) => d.category),
        })

        try {
          const result = await backend.saveLesson({
            content,
            context: `session:${sessionID} dir:${directory}`,
            confidence: lessonConfidence,
            tags: concepts,
            dedupeKey,
          })

          if (result.deduped === true) {
            lessonSkipReason = "duplicate suppressed (dedupeKey=" + dedupeKey + ")"
          } else {
            lessonSaved = {
              id: result.id,
              title: `${decision.action} after ${deviationsFromEvidence[0]?.category ?? "deviation"}`,
              content,
              type: "pattern",
              concepts,
              confidence: lessonConfidence,
              files: [...filesChanged],
              sessionID,
            }
          }
        } catch {
          // Backend failure is non-fatal — degrade silently
        }
      }
    }
  }

  // Determine reason
  const reasons: string[] = []
  if (decisionSaved) reasons.push("decision saved")
  if (lessonSaved) {
    reasons.push("lesson saved")
  } else if (lessonSkipReason) {
    reasons.push(lessonSkipReason)
  } else if (!saveLessonsEnabled) {
    reasons.push("saveLessons disabled")
  } else if (!severityMeetsThreshold(deviationsFromEvidence, config.minSeverityToLearn)) {
    reasons.push("severity below threshold")
  } else {
    reasons.push("no saveable content")
  }

  return {
    lessonSaved,
    decisionSaved,
    reason: reasons.join("; ") || "no action taken",
  }
}

/**
 * Helper: create a default ClosedLoopConfig.
 */
export function defaultClosedLoopConfig(): ClosedLoopConfig {
  return {
    enabled: true,
    minSeverityToLearn: "media",
    maxLessonsPerSession: 20,
    saveDecisions: true,
    // v0.17.2: saveLessons default true. Set to false to disable lesson writes
    // while keeping decision records.
    saveLessons: true,
    // Conscience fix (D2): auto-remember is opt-in — default disabled to end
    // AgentMemory garbage. Keep 5min cooldown + dedupe defaults.
    autoRemember: { enabled: false, cooldownMs: 300_000, dedupe: true },
  }
}

/**
 * Conscience value-gate (D3). Single gate for all conscience memory writes.
 *
 * Requires ALL of:
 * - action in {escalate, stop} (D1 — warn/continue never persist)
 * - config.enabled
 * - config.saveLessons !== false
 * - severityMeetsThreshold(deviations, config.minSeverityToLearn)
 * - novelty === true (caller-owned novelty check)
 * - lessonCount < config.maxLessonsPerSession
 */
export interface ShouldPersistConscienceMemoryInput {
  readonly action: Decision["action"]
  readonly deviations: readonly Deviation[]
  readonly config: ClosedLoopConfig
  readonly novelty: boolean
  readonly lessonCount: number
}

export function shouldPersistConscienceMemory(input: ShouldPersistConscienceMemoryInput): boolean {
  const { action, deviations, config, novelty, lessonCount } = input
  if (action !== "escalate" && action !== "stop") return false
  if (!config.enabled) return false
  if (config.saveLessons === false) return false
  if (!severityMeetsThreshold(deviations, config.minSeverityToLearn)) return false
  if (novelty !== true) return false
  if (lessonCount >= config.maxLessonsPerSession) return false
  return true
}

/**
 * Stable dedupe key (D5). Hash of stable fields only — action + sorted
 * evidence sources + sorted deviation categories. Score floats are
 * deliberately excluded: float jitter previously defeated dedupe.
 */
export interface ConscienceDedupeKeyInput {
  readonly action: string
  readonly evidenceSources: readonly string[]
  readonly deviationCategories: readonly string[]
}

export function conscienceDedupeKey(input: ConscienceDedupeKeyInput): string {
  const sources = [...input.evidenceSources].sort().join(",")
  const categories = [...input.deviationCategories].sort().join(",")
  const stable = `${input.action}|${sources}|${categories}`
  const hash = stable.split("").reduce((a, c) => ((a << 5) - a + c.charCodeAt(0)) | 0, 0)
  return `C-${Math.abs(hash).toString(36)}`
}

/**
 * Structured conscience memory content (D4/D6). Built via buildLessonContent
 * + extractConcepts — never a raw dump. Delivery route is always the
 * Zod-validated omo_remember tool.
 */
export interface BuildConscienceMemoryContentInput {
  // Oracle note 3: real decision action - stop lessons must read Action stop, not escalate.
  readonly action: "escalate" | "stop"
  readonly mistake: string
  readonly whatToDo: string
  readonly whereToGo: string
  readonly toolRoute: "omo_remember"
  readonly score: number
  readonly files: readonly string[]
}

export interface ConscienceMemoryContent {
  readonly content: string
  readonly concepts: string[]
}

export function buildConscienceMemoryContent(input: BuildConscienceMemoryContentInput): ConscienceMemoryContent {
  const deviations: Deviation[] = [
    { severity: "media", category: "conscience", detail: input.mistake },
  ]
  const decision: Decision = {
    action: input.action,
    score: input.score,
    reasoning: `${input.whatToDo} -> ${input.whereToGo} via ${input.toolRoute}`,
    evidence: [],
    shouldEscalateTo: null,
  }
  const base = buildLessonContent(decision, deviations)
  const content = `${base}\nMistake: ${input.mistake}\nWhatToDo: ${input.whatToDo}\nWhereToGo: ${input.whereToGo}\nToolRoute: ${input.toolRoute}`
  const concepts = extractConcepts(deviations, input.files)
  return { content, concepts }
}

export { SEVERITY_ORDER }
