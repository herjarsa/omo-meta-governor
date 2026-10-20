/**
 * oracle-lesson.ts — parse the Oracle's verdict for the LESSON block (v0.61.0 F0).
 *
 * WHY this exists: the LESSON piggyback (v0.56) asks the AGENT to persist the
 * Oracle's lesson via `omo_remember`. But `promptAgent` returns only a
 * messageID — the plugin never reads what the Oracle actually said. So the
 * whole auto-learning path depends on the agent choosing to comply, at the
 * exact right moment, with the exact right format. When it doesn't, the
 * lesson is lost SILENTLY: no error, no log, no memory.
 *
 * This module closes that loop. The Oracle's verdict already flows through
 * the plugin process (the Oracle runs as a `task` subagent, and
 * `tool.execute.after` receives its output), so parsing it costs nothing —
 * no LLM call, no extra network, no new endpoint.
 *
 * The plugin then decides whether to write the lesson, subject to the SAME
 * quality gates as every other lesson. The gate is the filter; this is
 * just a more reliable source.
 */

import { GENERIC_WHAT_TO_DO } from "./closed-loop-learning.js"

export interface OracleLesson {
  /** What rule/process failed. */
  readonly mistake: string
  /** The specific corrective action. */
  readonly whatToDo: string
  /** The file/area the remedy applies to. May be empty. */
  readonly whereToGo: string
}

/** The field labels the Oracle is asked to use, in both wordings. */
const MISTAKE_LABELS = ["Mistake:", "What went wrong:"]
const REMEDY_LABELS = ["WhatToDo:", "What to do:", "WhatToDo :"]
const PLACE_LABELS = ["WhereToGo:", "Where:", "Where to go:"]

/**
 * Cheap pre-filter: does this text even look like it carries a lesson?
 * Lets the caller skip the full parse on the vast majority of tool outputs.
 */
export function looksLikeOracleLesson(text: string | undefined | null): boolean {
  if (!text) return false
  if (text.includes("LESSON |")) return true
  return MISTAKE_LABELS.some((l) => text.includes(l))
}

const ALL_LABELS = [...MISTAKE_LABELS, ...REMEDY_LABELS, ...PLACE_LABELS]

/**
 * Extract one field's value.
 *
 * Returns:
 *   - `null`  → the label is ABSENT (the field was not mentioned).
 *   - `""`    → the label is PRESENT but its value is empty (malformed).
 *   - string  → the value.
 *
 * The distinction matters for the optional `WhereToGo`: a lesson that never
 * mentions a place is fine, but one that writes `WhereToGo:` and leaves it
 * blank is malformed and is rejected.
 */
function extractField(text: string, labels: readonly string[]): string | null {
  for (const label of labels) {
    const idx = text.indexOf(label)
    if (idx === -1) continue
    const after = text.slice(idx + label.length)

    // The value ends at the next known label. This is what splits the
    // PROSE shape ("Mistake: X. What to do: Y. Where: Z.") — there the
    // separator is a period, not a pipe.
    let cut = after.length
    for (const other of ALL_LABELS) {
      const at = after.indexOf(other)
      if (at !== -1 && at < cut) cut = at
    }
    let segment = after.slice(0, cut)

    // The `|` separator is the shape asked of the Oracle.
    const pipe = segment.indexOf("|")
    if (pipe !== -1) segment = segment.slice(0, pipe)

    // A newline also ends the value (the Oracle may put the block on its
    // own line).
    const lineEnd = segment.indexOf("\n")
    if (lineEnd !== -1) segment = segment.slice(0, lineEnd)

    return segment.trim()
  }
  return null
}

/**
 * Parse an Oracle verdict for its LESSON block.
 *
 * Accepts the two shapes in circulation:
 *   - `LESSON | Mistake: X | WhatToDo: Y | WhereToGo: Z`  (asked of the Oracle)
 *   - `Mistake: X. What to do: Y. Where: Z.`              (prose, what the
 *     conscience writer and the enforcement resources use)
 *
 * Returns null when there is no usable lesson: no lesson at all, an empty
 * required field, or the generic remedy (which teaches nothing and would
 * otherwise flood memory with the same useless line).
 */
export function parseOracleLesson(text: string | undefined | null): OracleLesson | null {
  if (!looksLikeOracleLesson(text)) return null
  const source = text!

  const mistake = extractField(source, MISTAKE_LABELS)
  const whatToDo = extractField(source, REMEDY_LABELS)
  const whereToGoRaw = extractField(source, PLACE_LABELS)

  // Mistake and remedy are required: a lesson without them is not a lesson.
  if (!mistake || mistake.length === 0) return null
  if (!whatToDo || whatToDo.length === 0) return null

  // A place label that is present but blank is malformed; a missing place
  // label is fine (the remedy can be general).
  if (whereToGoRaw !== null && whereToGoRaw.length === 0) return null
  const whereToGo = whereToGoRaw ?? ""

  // The generic remedy carries no information — the same line would be
  // stored for every stop ever.
  if (normalizeRemedy(whatToDo) === normalizeRemedy(GENERIC_WHAT_TO_DO)) return null

  return { mistake, whatToDo, whereToGo }
}

function normalizeRemedy(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ")
}

/**
 * The canonical content of an Oracle lesson, in the same shape the
 * conscience writer uses. The content MUST be byte-identical for the same
 * (mistake, remedy, place) triple — agentmemory fingerprints the content
 * with SHA-256, so a varying number in it would split one lesson into many
 * (the v0.59 lesson-spam class).
 */
export function buildOracleLessonContent(lesson: OracleLesson): string {
  const base = `Mistake: ${lesson.mistake}\nWhat to do: ${lesson.whatToDo}`
  return lesson.whereToGo.length > 0 ? `${base}\nWhere: ${lesson.whereToGo}` : base
}

/**
 * A stable dedupe key for an Oracle lesson. Keyed by the CONTENT (not the
 * session), so the same lesson from two sessions is stored once.
 */
export function oracleLessonKey(lesson: OracleLesson): string {
  return `oracle:${buildOracleLessonContent(lesson)}`
}
