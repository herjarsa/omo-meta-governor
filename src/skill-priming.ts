/**
 * Skill priming module (v0.20.0, v0.33.1: skill-hub routing).
 *
 * Pure functions only — no I/O, no MCP calls. The plugin's
 * messages.transform hook uses these to build and gate the once-per-session
 * skill-selection nudge: a single synthetic directive prompting the agent
 * to select precise skills for the current task via the skill-hub catalog
 * (omo_skill_find / omo_skill_get) and/or the task-appropriate superpowers
 * skill, before writing code.
 *
 * v0.33.1: AAS MCP tool references (aas search_skills / get_skill / compose_stack)
 * were eliminated — those tools were retired in v0.32.0 when the skill-hub
 * subsystem landed. Router 'aas' is now aliased to 'registry' for backward compat.
 *
 * Context-cost guardrail: the directive explicitly forbids enumerating the
 * full skill catalog.
 */
import type { SkillPrimingRouter, SkillPrimingTrigger } from "./types"

/**
 * Tool names that signal the agent has started implementation work.
 *
 * Superset of the writeTools list in plugin.ts (tool.execute.after): the
 * trailing tools (apply_patch / ast_grep_replace / multi_edit / refactor)
 * do NOT bump `filesChanged`, so detection keys on `recentToolCalls` only.
 */
export const IMPLEMENTATION_TOOLS: readonly string[] = [
  "write",
  "edit",
  "edit_block",
  "multi_edit",
  "apply_patch",
  "ast_grep_replace",
  "refactor",
  "desktop-commander_write_file",
  "desktop-commander_edit_block",
]

/** Superpowers skills relevant to implementation-type work. */
const SUPERPOWERS_SKILLS: readonly string[] = [
  "brainstorming",
  "writing-plans",
  "test-driven-development",
  "systematic-debugging",
  "subagent-driven-development",
]

/**
 * Build the skill-priming directive text for the given router.
 * Always ends with the context-cost guardrail line.
 */
export function buildSkillPrimingMessage(router: SkillPrimingRouter): string {
  // v0.33.1: alias 'aas' → 'registry' (AAS MCP retired in v0.32.0).
  const effectiveRouter = router === "aas" ? "registry" : router
  const lines: string[] = [
    "[SKILL PRIMING] This session involves implementation work. Select precise skills for this task before writing code:",
  ]
  let step = 1
  if (effectiveRouter === "registry" || effectiveRouter === "both") {
    lines.push(
      `${step}. Query the skill-hub catalog (omo_skill_find) for the 2-3 capabilities most relevant to this task (e.g. testing, architecture, language-specific), and inspect candidates with omo_skill_get.`,
    )
    step++
    lines.push(
      `${step}. Compose a minimal stack of 2-3 skills by loading each via its installer (e.g. \`npx skills add <owner/repo/slug>\` via omo_skill_add).`,
    )
    step++
  }
  if (effectiveRouter === "superpowers" || effectiveRouter === "both") {
    lines.push(
      `${step}. If a matching superpowers skill is available and not yet active (${SUPERPOWERS_SKILLS.join(" / ")}), load it via the skill tool. (Requires the superpowers plugin to be installed separately.)`,
    )
    step++
  }
  if (effectiveRouter === "both") {
    lines.push("If a superpowers skill is already active, skip the catalog step.")
  }
  lines.push("Do NOT enumerate the full catalog — keep the stack minimal and task-specific.")
  return lines.join("\n")
}

/**
 * Decide whether the skill-priming nudge should fire for this session.
 *
 * - trigger "sessionStart": always true — the caller gates on the
 *   once-per-session Set, so this fires on the first transform call.
 * - trigger "firstImplement": true only when an implementation tool
 *   (write/edit/apply_patch/...) appears in the session's recent tool calls.
 */
export function shouldInjectSkillPriming(opts: {
  trigger: SkillPrimingTrigger
  recentToolCalls: readonly string[]
  /**
   * v0.20.0: true when an implementation tool was observed this session even
   * outside the audit state (the audit state only exists when
   * protocolEnforcement.auditToolCalls is enabled).
   */
  implementationToolSeen?: boolean
}): boolean {
  if (opts.trigger === "sessionStart") return true
  if (opts.implementationToolSeen) return true
  return opts.recentToolCalls.some((t) => IMPLEMENTATION_TOOLS.includes(t))
}
