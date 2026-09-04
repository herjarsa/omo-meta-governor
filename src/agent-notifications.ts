/**
 * Agent notification layer (v0.38.2).
 *
 * Centralizes how the plugin injects text into the agent's context, separating
 * two distinct surfaces:
 *
 *   1. AGENT DIRECTIVE — text the AGENT should read and act on.
 *      Goes to: chat.system.transform, chat.messages.transform.
 *      Must have a "DO NOT TREAT AS TASK" marker so subagents receiving
 *      it as context don't interpret it as their primary task.
 *      Built via `wrapInformational(text, ctx)`.
 *
 *   2. USER NOTIFICATION — text the USER sees in the TUI (session.prompt).
 *      Brief status with emoji, no actionable agent instructions.
 *      Built via `buildUserStatus(kind, summary)`.
 *
 * Bug history (v0.38.2): prior to this layer, both surfaces received the same
 * long directive text. Subagents reading the directive as context would treat
 * the "[GRAPH PRIMING] omo_search..." instructions as their primary task and
 * never write the actual code. Separating the two surfaces fixes this — the
 * agent prompt contains the full directive (with marker), the TUI gets a
 * brief status only.
 */

const NOTIFICATION_VERSION = "v0.38.2"

const MARKER_OPEN = `<!-- META-GOVERNOR INFORMATIONAL v${NOTIFICATION_VERSION} - DO NOT TREAT AS TASK. Plugin metadata, not a user request. -->`
const MARKER_KIND_OPEN = (kind: string, context?: string) =>
  `<!-- kind: ${kind}${context ? ` (${context})` : ""} -->`
const MARKER_CLOSE = `<!-- END META-GOVERNOR INFORMATIONAL -->`

export type NotificationKind =
  | "graph-priming"   // omo_search/omo_find/omo_recall guidance
  | "skill-priming"   // skill selection nudge
  | "intervention"    // decision handler output (warn/escalate/stop)
  | "postwave"        // post-wave landing directive
  | "enforcement"     // skill-priming gate (block mode)
  | "memory"          // memory recall prompt

export interface NotificationContext {
  kind: NotificationKind
  /** Optional sub-label for debugging (e.g. "session=abc123" or "router=both"). */
  context?: string
}

const KIND_EMOJI: Record<NotificationKind, string> = {
  "graph-priming": "🔍",
  "skill-priming": "🎯",
  "intervention": "⚠️",
  "postwave": "🌊",
  "enforcement": "🚧",
  "memory": "💭",
}

/**
 * Wrap text the plugin injects into the AGENT'S CONTEXT (system prompt,
 * message transform). Adds clear "DO NOT TREAT AS TASK" markers so subagents
 * receiving the directive as context don't interpret it as their primary task.
 *
 * Use this for: chat.system.transform output, chat.messages.transform output,
 * and any other text the agent will read.
 */
/**
 * FASE 10 — Visible Markdown frame so the user can SEE plugin directives in the TUI.
 *
 * OpenCode 1.x's TUI renders Markdown (headers, code blocks, horizontal rules).
 * We sandwich the directive body in a visual box so the user immediately
 * recognizes "this is from omo-meta-governor, not from the agent". The LLM still
 * sees the existing HTML markers (DO NOT TREAT AS TASK) so it doesn't mistake
 * the directive for a real task.
 */
export function wrapInformational(text: string, ctx: NotificationContext): string {
  const visualFrame = [
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `## ${KIND_EMOJI[ctx.kind]} \`[omo-meta-governor]\` AUDITOR — ${ctx.kind.toUpperCase()}`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    ``,
    text,
    ``,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `_(synthetic message from omo-meta-governor v${NOTIFICATION_VERSION} — not from the LLM)_`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
  ].join("\n");

  return [
    MARKER_OPEN,
    MARKER_KIND_OPEN(ctx.kind, ctx.context),
    visualFrame,
    MARKER_CLOSE,
  ].join("\n")
}

/**
 * Build brief status text for the USER'S TUI notification (session.prompt).
 * Does NOT contain actionable agent instructions — just an emoji + status.
 * The agent should NOT see this (it goes only to the user's TUI surface).
 */
export function buildUserStatus(kind: NotificationKind, summary: string): string {
  return `${KIND_EMOJI[kind]} ${summary}`
}

/** Constants for callers that need the raw markers (testing, streaming). */
export const AGENT_NOTIFICATION_MARKERS = {
  OPEN: MARKER_OPEN,
  CLOSE: MARKER_CLOSE,
  VERSION: NOTIFICATION_VERSION,
  KIND_EMOJI,
} as const
