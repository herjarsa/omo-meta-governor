/**
 * project-signals.ts — F5: the project's history as scoring input (v0.60.0).
 *
 * WHY this exists: every signal the judge uses today describes the CURRENT
 * session (Oracle verified? no progress? deviation right now? iteration
 * count?). None of them knows what keeps happening in this project across
 * sessions. agentmemory already knows:
 *
 *   - /patterns   → error_repeat ("this error happened N times"), co_change
 *                   ("when you touch X, you also touch Y")
 *   - /profile    → commonErrors, conventions, top concepts
 *   - /insights   → higher-order patterns
 *
 * The difference matters: with a per-turn signal, the judge reacts AFTER the
 * agent repeats the mistake. With these, the score can already be low
 * BEFORE it happens — the agent is warned in advance, with the concrete
 * remedy attached.
 *
 * DESIGN CONSTRAINTS:
 * - NO LLM CALL. These are local HTTP reads; the cost is ~50ms once per
 *   project (cached), not a model invocation.
 * - CACHED per project (TTL 5 min). Never read on every tool call.
 * - CONSERVATIVE by default. A signal only counts when it clears a
 *   frequency threshold — a single occurrence of anything is noise.
 * - The first version is INFORMATIVE: the signals are surfaced in the
 *   judge's digest. They only gain scoring weight once the config enables
 *   it (`scoring.projectSignals.weight`), because a signal nobody has
 *   validated should not silently move the score.
 */

import type {
  AgentmemoryClient,
  AgentmemoryInsight,
  AgentmemoryPattern,
  AgentmemoryProfile,
} from "./agentmemory-client.js"

export interface ProjectSignalConfig {
  /** Master switch. Default true. */
  readonly enabled?: boolean
  /**
   * Minimum frequency for a pattern to count. Default 3 — the same bar the
   * skill synthesis uses ("an anecdote is not a pattern").
   */
  readonly minFrequency?: number
  /**
   * Weight of the project-signal contribution. Default 0 = INFORMATIVE
   * ONLY (surfaced in the digest, no score effect). Raise it once the
   * signals are validated on real sessions.
   */
  readonly weight?: number
  /** Cache TTL in ms. Default 300000 (5 min). */
  readonly cacheTtlMs?: number
}

export interface ProjectSignals {
  /**
   * Recurring error patterns (error_repeat) with their frequency.
   *
   * CAVEAT: agentmemory's pattern detection runs across ALL sessions, so a
   * pattern may describe a DIFFERENT project than the one being judged.
   * The `projectScoped` flag below tells the caller whether the pattern
   * actually mentions this project's files. Until agentmemory exposes a
   * per-project pattern index, treat unscoped patterns as project-wide
   * context (still useful — "this error class keeps happening on this
   * machine") rather than a verdict on this repo.
   */
  readonly recurringErrors: readonly { description: string; frequency: number }[]
  /** Co-change patterns: files that change together. */
  readonly coChanges: readonly { description: string; frequency: number }[]
  /** Rules agentmemory derived from the patterns. */
  readonly derivedRules: readonly string[]
  /** The project's common errors (from /profile). */
  readonly commonErrors: readonly string[]
  /** The project's conventions (from /profile). */
  readonly conventions: readonly string[]
  /** Higher-order insights. */
  readonly insights: readonly string[]
  /** True when nothing was found (empty project / fresh project). */
  readonly empty: boolean
  /**
   * True when the patterns explicitly mention THIS project's files.
   * False = the patterns are machine-wide, not project-specific.
   */
  readonly projectScoped: boolean
}

export const EMPTY_PROJECT_SIGNALS: ProjectSignals = {
  recurringErrors: [],
  coChanges: [],
  derivedRules: [],
  commonErrors: [],
  conventions: [],
  insights: [],
  empty: true,
  projectScoped: false,
}

/**
 * Turn agentmemory's raw payloads into the judge's view. Pure — testable
 * without a server.
 */
export function buildProjectSignals(
  patterns: readonly AgentmemoryPattern[],
  profile: AgentmemoryProfile | null,
  insights: readonly AgentmemoryInsight[],
  minFrequency = 3,
  projectScope = "",
): ProjectSignals {
  const recurringErrors: { description: string; frequency: number }[] = []
  const coChanges: { description: string; frequency: number }[] = []
  const derivedRules: string[] = []

  for (const pattern of patterns) {
    const frequency = typeof pattern.frequency === "number" ? pattern.frequency : 0
    if (frequency < minFrequency) continue
    const description = (pattern.description ?? pattern.rule ?? "").trim()
    if (description.length === 0) continue
    if (pattern.type === "co_change") {
      coChanges.push({ description, frequency })
    } else if (pattern.type === "error_repeat") {
      recurringErrors.push({ description, frequency })
    }
  }

  // agentmemory can emit ready-made rules (mem::generate-rules).
  for (const pattern of patterns) {
    const rule = (pattern.rule ?? "").trim()
    if (rule.length > 0 && !derivedRules.includes(rule)) derivedRules.push(rule)
  }

  const commonErrors = (profile?.commonErrors ?? []).filter((e) => e.trim().length > 0)
  const conventions = (profile?.conventions ?? []).filter((c) => c.trim().length > 0)
  const insightTexts = insights
    .map((i) => (i.text ?? i.insight ?? i.title ?? "").trim())
    .filter((t) => t.length > 0)

  // A pattern is project-scoped when it mentions a file of this project.
  const scope = projectScope.toLowerCase()
  const mentionsProject = (text: string): boolean => {
    if (scope.length === 0) return false
    return text.toLowerCase().includes(scope)
  }
  const projectScoped =
    recurringErrors.some((e) => mentionsProject(e.description)) ||
    coChanges.some((c) => mentionsProject(c.description))

  return {
    recurringErrors: recurringErrors.sort((a, b) => b.frequency - a.frequency),
    coChanges: coChanges.sort((a, b) => b.frequency - a.frequency),
    derivedRules,
    commonErrors,
    conventions,
    insights: insightTexts,
    projectScoped,
    empty:
      recurringErrors.length === 0 &&
      coChanges.length === 0 &&
      derivedRules.length === 0 &&
      commonErrors.length === 0 &&
      conventions.length === 0 &&
      insightTexts.length === 0,
  }
}

/**
 * The score contribution of the project signals. Negative when the project
 * has a recurring error the agent is likely to hit again; zero otherwise.
 *
 * The magnitude is deliberately small (max -0.6 raw) because these signals
 * describe the PROJECT, not the agent's current behaviour — a project with a
 * known recurring error is not by itself a reason to stop the agent.
 */
export function scoreProjectSignals(signals: ProjectSignals): number {
  if (signals.empty) return 0
  const recurring = signals.recurringErrors.length
  const coChange = signals.coChanges.length
  // Each distinct recurring error contributes; the total is capped.
  const raw = -Math.min(0.6, 0.2 * recurring + 0.1 * coChange)
  return raw
}

/**
 * Render the signals for the judge's digest. Capped so a noisy project
 * cannot flood the context window.
 */
export function formatProjectSignals(signals: ProjectSignals, maxLines = 8): string {
  if (signals.empty) return ""
  const lines: string[] = ["PROJECT HISTORY (agentmemory):"]
  let count = 0
  const scopeTag = signals.projectScoped ? "" : " (machine-wide)"
  for (const err of signals.recurringErrors.slice(0, 3)) {
    if (count >= maxLines) break
    lines.push(`  - [recurs x${err.frequency}]${scopeTag} ${err.description.slice(0, 140)}`)
    count++
  }
  for (const rule of signals.derivedRules.slice(0, 2)) {
    if (count >= maxLines) break
    lines.push(`  - [rule] ${rule.slice(0, 140)}`)
    count++
  }
  for (const err of signals.commonErrors.slice(0, 2)) {
    if (count >= maxLines) break
    lines.push(`  - [known error] ${err.slice(0, 140)}`)
    count++
  }
  for (const co of signals.coChanges.slice(0, 2)) {
    if (count >= maxLines) break
    lines.push(`  - [co-change x${co.frequency}] ${co.description.slice(0, 140)}`)
    count++
  }
  if (lines.length === 1) return ""
  return lines.join("\n")
}

// ─── Cached reader ────────────────────────────────────────────────

export interface ProjectSignalCacheEntry {
  readonly signals: ProjectSignals
  readonly fetchedAtMs: number
}

/**
 * Per-project cache. The signals describe the project's HISTORY — they do
 * not change within a session, so one read per project per TTL is enough.
 */
export class ProjectSignalCache {
  private readonly entries = new Map<string, ProjectSignalCacheEntry>()
  constructor(
    private readonly ttlMs = 300_000,
    private readonly maxEntries = 50,
  ) {}

  get(project: string): ProjectSignals | null {
    const entry = this.entries.get(project)
    if (!entry) return null
    if (Date.now() - entry.fetchedAtMs > this.ttlMs) {
      this.entries.delete(project)
      return null
    }
    return entry.signals
  }

  set(project: string, signals: ProjectSignals): void {
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value
      if (oldest !== undefined) this.entries.delete(oldest)
    }
    this.entries.set(project, { signals, fetchedAtMs: Date.now() })
  }

  /** Read the signals for a project, fetching them if the cache is cold. */
  async getOrFetch(
    client: AgentmemoryClient,
    project: string,
    config: ProjectSignalConfig = {},
  ): Promise<ProjectSignals> {
    if (config.enabled === false) return EMPTY_PROJECT_SIGNALS
    const cached = this.get(project)
    if (cached) return cached
    const [patterns, profile, insights] = await Promise.all([
      // GLOBAL read. agentmemory's POST /patterns scopes by the `project`
      // field of each SESSION (the directory it ran in: "opencode",
      // "hermes", ...), NOT by the repo name the plugin resolves. Scoping
      // the read by the plugin's project name scanned 14 observations and
      // found nothing; the unscoped read scanned 1130 and found a
      // recurring error with frequency 16.
      client.patterns({ limit: 200 }).catch(() => []),
      client.projectProfile(project).catch(() => null),
      client.projectInsights(project).catch(() => []),
    ])
    const signals = buildProjectSignals(
      patterns,
      profile,
      insights,
      config.minFrequency ?? 3,
      project,
    )
    this.set(project, signals)
    return signals
  }
}
