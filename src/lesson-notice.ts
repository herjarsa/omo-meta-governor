/**
 * Session-end "lesson learned" notice (v0.66.0).
 *
 * The session-end path writes lessons to agentmemory AUTOMATICALLY. Before this
 * module the agent finished the session with no idea what had been learned on
 * its behalf, and the DONE-gate memory nudge ("no memory saved — consider one
 * lesson via omo_remember") was queued in the same hook, contradicting the
 * write that was about to succeed.
 *
 * Two surfaces, never mixed (AGENTS.md §7):
 *   - buildLessonLearnedAgentMessage -> AGENT context (wrapInformational).
 *   - buildLessonLearnedUserStatus   -> USER TUI only (buildUserStatus).
 */

import { buildUserStatus, wrapInformational } from "./agent-notifications"

export interface LearnedLessonNotice {
  readonly mistake: string
  readonly whatToDo: string
  readonly whereToGo: string
}

export interface LearnedLessonCounts {
  readonly saved: number
  readonly strengthened: number
  /** Lessons the backend rejected. Omitted when zero. */
  readonly failed?: number
}

/**
 * Agent surface: tell the agent WHICH lessons were persisted so the next turn
 * is consistent with them, and so it does not re-save them by hand.
 */
export function buildLessonLearnedAgentMessage(
  lessons: readonly LearnedLessonNotice[],
  counts: LearnedLessonCounts,
): string {
  const total = counts.saved + counts.strengthened
  const failedNote = counts.failed && counts.failed > 0 ? `, ${counts.failed} failed` : ""
  const lines = [
    `[LESSON LEARNED] Session end persisted ${total} lesson(s) to agentmemory (${counts.saved} new, ${counts.strengthened} reinforced${failedNote}).`,
  ]
  for (const lesson of lessons.slice(0, 3)) {
    lines.push(`- Mistake: ${lesson.mistake.slice(0, 200)}`)
    if (lesson.whatToDo) lines.push(`  What to do: ${lesson.whatToDo.slice(0, 200)}`)
    if (lesson.whereToGo) lines.push(`  Where: ${lesson.whereToGo.slice(0, 120)}`)
  }
  lines.push("These are ALREADY saved — do NOT re-save them with `omo_remember`.")
  lines.push("Apply them to the remaining work; `omo_recall` retrieves them in later sessions.")
  return wrapInformational(lines.join("\n"), { kind: "memory", context: "session-end" })
}

/**
 * User surface: one brief status line. No actionable agent instructions, no
 * tool names (AGENTS.md §7 / v0.38.2).
 */
export function buildLessonLearnedUserStatus(
  lessons: readonly LearnedLessonNotice[],
  total: number,
): string {
  const first = lessons[0]?.mistake ?? ""
  const detail = first.length > 80 ? `${first.slice(0, 77)}...` : first
  return buildUserStatus("memory", `${total} leccion(es) guardada(s) en agentmemory${detail ? `: ${detail}` : ""}`)
}
