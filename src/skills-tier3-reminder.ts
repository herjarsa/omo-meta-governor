/**
 * Tier 3 advisory reminder — when the resolver returns zero results,
 * we emit a system reminder to the next agent turn suggesting the
 * writing-skills skill.
 *
 * Rate limited:
 * - 1 reminder per session per query
 * - Circuit breaker: max 3 reminders per session total
 */

export interface Tier3ReminderState {
  sent: Map<string, number>
  maxPerSession: number
  cooldownMs: number
}

export function shouldSendReminder(
  query: string,
  state: Tier3ReminderState,
): boolean {
  if (state.sent.has(query)) return false
  const totalSent = Array.from(state.sent.values()).reduce((a, b) => a + b, 0)
  if (totalSent >= state.maxPerSession) return false
  state.sent.set(query, 1)
  return true
}

export function formatReminder(): string {
  return [
    "No skill matched your query. The plugin does not have a hub result for this either.",
    "Consider using the writing-skills skill (always available as chore) to create a",
    "project-local skill at ./.agents/skills/<slug>/SKILL.md if this task will recur.",
  ].join(" ")
}
