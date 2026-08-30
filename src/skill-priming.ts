/**
 * Skill priming module (v0.20.0, v0.33.1: skill-hub routing, v0.38.2: user/agent split).
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
 * v0.38.2: each priming function now has TWO outputs:
 *   - `build*Message()` returns the AGENT-bound directive (full text + "DO NOT
 *     TREAT AS TASK" marker). Goes to chat.system.transform / chat.messages.transform.
 *   - `build*UserStatus()` returns a brief TUI status (emoji + summary, no
 *     actionable instructions). Goes to persistIntervention (session.prompt) for
 *     the USER only. Subagents should never see this.
 *
 * Context-cost guardrail: the directive explicitly forbids enumerating the
 * full skill catalog.
 */
import type { SkillPrimingRouter, SkillPrimingTrigger } from "./types"
import { wrapInformational, buildUserStatus, type NotificationKind } from "./agent-notifications"

/**
 * Tool names that signal the agent has started implementation work.
 *
 * v0.38.3 (G1 audit fix): the canonical writeTools list, shared by:
 *   - skill-priming.ts (IMPLEMENTATION_TOOLS — detection signal)
 *   - plugin.ts:tool.execute.after (writeTools — filesChanged accounting + bash bypass)
 *   - protocol-enforcer.ts (writeTools — protocol violation audit)
 *
 * Prior to v0.38.3 these were 3 separate lists (7, 9, and 5 entries respectively).
 * Drift between plugin.ts and protocol-enforcer.ts meant apply_patch could bypass
 * protocolEnforcement.auditToolCalls even though it triggered filesChanged.
 *
 * NOTE: bash with `>` / `>>` / `<<` redirects is ALSO a write — `bashHasFileWrite`
 * in plugin.ts detects those and feeds them into the same filesChanged pipeline.
 * That detection is bash-specific and doesn't belong in this constant.
 */
export const IMPLEMENTATION_TOOLS: readonly string[] = [
  "write",
  "edit",
  "edit_block",
  "multi_edit",
  "apply_patch",
  "ast_grep_replace",
  "refactor",
  // v0.38.3 (G1): desktop-commander equivalents added so all 3 call sites match.
  "desktop-commander_write_file",
  "desktop-commander_edit_block",
]

/**
 * v0.35.9: nudge the agent to use the project's own knowledge graph before
 * touching code. graphify (conceptual) and codegraph (symbol-level) are the
 * plugin's primary discovery primitives — agents that skip them end up doing
 * raw grep and reinventing what the project already knows.
 *
 * v0.38.2: output is wrapped with "DO NOT TREAT AS TASK" markers so subagents
 * receiving this as context don't interpret it as their primary task.
 */
export function buildGraphPrimingMessage(): string {
  const body = [
    "[GRAPH PRIMING] Before grep/regex/glob/raw read, query the project's own indexes:",
    "1. Architecture / concepts / cross-module relationships -> omo_search (auto-routes between codegraph + graphify).",
    "2. Symbol-level lookup, call graph, impact analysis -> omo_find / omo_impact / omo_path.",
    "3. Past lessons, decisions, prior solutions -> omo_recall (local SQLite FTS5).",
    "4. Project status (codegraph health, recent decisions) -> omo_health / omo_status.",
    "Use raw grep ONLY when the indexed queries above cannot answer the question (e.g. literal byte patterns, throwaway strings).",
  ].join("\n")
  return wrapInformational(body, { kind: "graph-priming" })
}

/**
 * v0.38.2: brief TUI status for the user when graph-priming fires. Goes
 * to `persistIntervention` / `session.prompt` — does NOT contain tool
 * names or actionable instructions. Subagents should never see this text.
 */
export function buildGraphPrimingUserStatus(): string {
  return buildUserStatus("graph-priming", "Graph priming: prefer omo_search/omo_find over raw grep when possible.")
}

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
 *
 * v0.38.2: output is wrapped with "DO NOT TREAT AS TASK" markers so subagents
 * receiving this as context don't interpret it as their primary task.
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
      `${step}. If a matching superpowers skill is available and not yet active (${SUPERPOWERS_SKILLS.join(" / ")}), delegate it to a sub-agent via \`task(category='<category>', load_skills=['<slug>'])\` — the skill's content is injected into the sub-agent's system prompt. (Requires the superpowers plugin to be installed separately.)`,
    )
    step++
  }
  if (effectiveRouter === "both") {
    lines.push("If a superpowers skill is already active, skip the catalog step.")
  }
  lines.push("Do NOT enumerate the full catalog — keep the stack minimal and task-specific.")
  const body = lines.join("\n")
  return wrapInformational(body, { kind: "skill-priming", context: `router=${effectiveRouter}` })
}

/**
 * v0.38.2: brief TUI status for the user when skill-priming fires. Goes
 * to `persistIntervention` / `session.prompt` — does NOT contain tool
 * names or actionable instructions. Subagents should never see this text.
 */
export function buildSkillPrimingUserStatus(router: SkillPrimingRouter): string {
  const effectiveRouter = router === "aas" ? "registry" : router
  return buildUserStatus("skill-priming", `Skill priming (${effectiveRouter}): nudging agent to discover relevant skills before implementation.`)
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

/**
 * v0.35.2: detect "trivial" implementation-tool writes that should bypass
 * the skill-priming gate. The gate is meant to nudge agents toward picking
 * skills before non-trivial implementation; it is over-restrictive for
 * throwaway scripts, scratch files, and small test edits.
 *
 * Bypass conditions (any one is sufficient):
 *   1. Path matches a known trivial pattern (test/, tmp/, scratch/, .scratch/).
 *   2. Tool is "write" and the new content is under TRIVIAL_MAX_LINES (50).
 *   3. Tool is an "edit" variant (edit_block / multi_edit / desktop-commander_edit_block):
 *      any in-place edit is considered low-stakes.
 *
 * Bash redirects to files (>, tee, etc.) are NOT bypassed here; they are
 * caught upstream by bashHasFileWrite and the gate fires before this
 * helper is consulted.
 */
export const TRIVIAL_PATH_PATTERNS: readonly RegExp[] = [
  /[\\/](\.tmp|\.scratch|scratch|tmp|trash|throwaway)[\\/]/i,
  /[\\/]tests?[\\/]|^tests?[\\/]/,
  /[\\/]__tests__[\\/]/,
  /[\\/]fixtures?[\\/]/,
  /[\\/]examples?[\\/]/,
  /\.test\.[a-z]+$/,
  /\.spec\.[a-z]+$/,
]
export const TRIVIAL_MAX_LINES = 50

export function isTrivialWrite(tool: string, args: unknown): boolean {
  if (tool === "edit" || tool === "edit_block" || tool === "multi_edit"
      || tool === "apply_patch" || tool === "ast_grep_replace" || tool === "refactor"
      || tool === "desktop-commander_edit_block") {
    return true
  }
  if (tool !== "write" && tool !== "desktop-commander_write_file") return false
  const a = args as Record<string, unknown> | undefined
  const filePath = typeof a?.["filePath"] === "string"
    ? (a["filePath"] as string)
    : typeof a?.["path"] === "string"
      ? (a["path"] as string)
      : ""
  if (filePath && TRIVIAL_PATH_PATTERNS.some((re) => re.test(filePath))) {
    return true
  }
  const content = a?.["content"]
  if (typeof content === "string" && content.split("\n").length <= TRIVIAL_MAX_LINES) {
    return true
  }
  return false
}

/**
 * v0.35.2: build a query suggestion for omo_skill_find based on the
 * tool + file path the agent is trying to use. This makes the error
 * message actionable instead of "call omo_skill_find first".
 */
export function suggestSkillFindQuery(tool: string, args: unknown): string {
  const a = args as Record<string, unknown> | undefined
  const filePath = typeof a?.["filePath"] === "string"
    ? (a["filePath"] as string)
    : typeof a?.["path"] === "string"
      ? (a["path"] as string)
      : ""
  const extMatch = /\.([a-z]+)$/i.exec(filePath)
  const ext = extMatch ? extMatch[1].toLowerCase() : ""
  const lang = {
    ts: "typescript", tsx: "typescript-react", js: "javascript",
    py: "python", rb: "ruby", go: "go", rs: "rust", java: "java",
    cs: "csharp", cpp: "cpp", c: "c", sh: "bash", bash: "bash",
    md: "markdown", json: "json", yaml: "yaml", yml: "yaml",
    toml: "config", sql: "sql", html: "html", css: "css",
    scss: "css", vue: "vue", svelte: "svelte",
  }[ext] ?? "code"
  return `omo_skill_find "${lang} ${tool}" --limit 5`
}
