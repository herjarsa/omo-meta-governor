/**
 * Skill priming module (v0.20.0).
 *
 * Pure functions only — no I/O, no MCP calls. The plugin's
 * messages.transform hook uses these to build and gate the once-per-session
 * skill-selection nudge: a single synthetic user message prompting the agent
 * to select precise skills for the current task via the AAS skill catalog
 * (aas search_skills / get_skill / compose_stack) and/or the task-appropriate
 * superpowers skill, before writing code.
 *
 * Context-cost guardrail: the directive explicitly forbids enumerating the
 * full skill catalog. The AAS MCP is read-only and only consumes tokens when
 * the agent actually queries it (past token-bloat incident, ~205k tokens/session
 * from indexed skills — memory #1084).
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
  const lines: string[] = [
    "[SKILL PRIMING] This session involves implementation work. Select precise skills for this task before writing code:",
  ]
  let step = 1
  if (router === "aas" || router === "both") {
    lines.push(
      `${step}. Query the AAS skill catalog (aas search_skills) for the 2-3 capabilities most relevant to this task (e.g. testing, architecture, language-specific), and compare candidates with aas get_skill.`,
    )
    step++
    lines.push(
      `${step}. If 2+ viable candidates exist, compose a minimal stack (<= 3 skills) with aas compose_stack.`,
    )
    step++
  }
  if (router === "superpowers" || router === "both") {
    lines.push(
      `${step}. If a matching superpowers skill is available and not yet active (${SUPERPOWERS_SKILLS.join(" / ")}), load it via the skill tool.`,
    )
    step++
  }
  if (router === "both") {
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
