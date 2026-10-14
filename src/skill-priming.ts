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
import { formatGraphPrimingBody } from "./routing-matrix"

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
  const body = formatGraphPrimingBody()
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
 * Bypass conditions, checked in order (B-tightening: edit-family writes to
 * non-trivial paths are NOT trivial):
 *   (a) Path matches a known trivial pattern (test/, tmp/, scratch/, ...):
 *       trivial for ANY tool, including edit-family tools.
 *   (b) Tool is "write" / "desktop-commander_write_file" and the new content
 *       is under TRIVIAL_MAX_LINES (50); missing or large content on a
 *       non-trivial path is NOT trivial.
 *   (c) Tool is an edit-family tool (edit / edit_block / multi_edit /
 *       apply_patch / ast_grep_replace / refactor /
 *       desktop-commander_edit_block) on a non-trivial path: NOT trivial,
 *       EXCEPT a tiny-diff bypass - a single-hunk change of <=5 changed
 *       lines measured from the oldString / newString / content / patch /
 *       diff args. With no size signal the edit is NOT trivial.
 *
 * Bash redirects to files (>, tee, etc.) are NOT bypassed here; they are
 * caught upstream by bashHasFileWrite and the gate fires before this
 * helper is consulted. (A command redirect target is still extracted as a
 * path fallback so direct unit calls behave consistently.)
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

/** Edit-family tools: in-place edits, subject to the tiny-diff bypass only. */
const EDIT_FAMILY_TOOLS: readonly string[] = [
  "edit",
  "edit_block",
  "multi_edit",
  "apply_patch",
  "ast_grep_replace",
  "refactor",
  "desktop-commander_edit_block",
]

function toArgsRecord(args: unknown): Record<string, unknown> | undefined {
  if (typeof args === "object" && args !== null) {
    return args as Record<string, unknown>
  }
  return undefined
}

/**
 * B-tightening: extract the target path from write/edit args. Checks
 * filePath, then path, then file, then a shell redirect target in command
 * (> / >>) so direct unit calls behave consistently with the upstream
 * bashHasFileWrite gate.
 */
function extractWritePath(a: Record<string, unknown> | undefined): string {
  if (a === undefined) return ""
  const filePath = a["filePath"]
  if (typeof filePath === "string" && filePath.length > 0) return filePath
  const pathValue = a["path"]
  if (typeof pathValue === "string" && pathValue.length > 0) return pathValue
  const fileValue = a["file"]
  if (typeof fileValue === "string" && fileValue.length > 0) return fileValue
  const command = a["command"]
  if (typeof command === "string") {
    const redirect = />>?\s*([^;\s|&]+)/.exec(command)
    if (redirect !== null && typeof redirect[1] === "string") return redirect[1]
  }
  return ""
}

function countLines(s: string): number {
  return s.split("\n").length
}

/** Count changed (+/-) lines in a patch/diff string, ignoring +++ / --- headers. */
function countDiffChangedLines(s: string): number {
  const changed = s.split("\n").filter((line) => {
    if (line.startsWith("+++") || line.startsWith("---")) return false
    return line.startsWith("+") || line.startsWith("-")
  }).length
  return changed > 0 ? changed : countLines(s)
}

function countHunks(s: string): number {
  const hunks = s.match(/^@@/gm)
  return hunks === null ? 0 : hunks.length
}

function countTinyString(s: string): boolean {
  const n = countLines(s)
  return n >= 1 && n <= 5
}

/**
 * B-tightening tiny-diff bypass: a single-hunk change of <=5 changed lines,
 * measured from the oldString / newString / content / patch / diff args.
 * No size signal at all means NOT trivial (fail closed).
 */
function isTinyDiff(a: Record<string, unknown> | undefined): boolean {
  if (a === undefined) return false
  const oldString = a["oldString"]
  const newString = a["newString"]
  if (typeof oldString === "string" || typeof newString === "string") {
    const changed = Math.max(
      typeof oldString === "string" ? countLines(oldString) : 0,
      typeof newString === "string" ? countLines(newString) : 0,
    )
    return changed >= 1 && changed <= 5
  }
  const content = a["content"]
  if (typeof content === "string") return countTinyString(content)
  const patch = a["patch"]
  if (typeof patch === "string") {
    if (countHunks(patch) > 1) return false
    const changed = countDiffChangedLines(patch)
    return changed >= 1 && changed <= 5
  }
  const diff = a["diff"]
  if (typeof diff === "string") {
    if (countHunks(diff) > 1) return false
    const changed = countDiffChangedLines(diff)
    return changed >= 1 && changed <= 5
  }
  return false
}

export function isTrivialWrite(tool: string, args: unknown): boolean {
  const a = toArgsRecord(args)
  // (a) Trivial path bypasses for ANY tool, including edit-family tools.
  const filePath = extractWritePath(a)
  if (filePath && TRIVIAL_PATH_PATTERNS.some((re) => re.test(filePath))) {
    return true
  }
  // (b) Write-family: only tiny content on a non-trivial path bypasses.
  if (tool === "write" || tool === "desktop-commander_write_file") {
    const content = a?.["content"]
    if (typeof content === "string" && countLines(content) <= TRIVIAL_MAX_LINES) {
      return true
    }
    return false
  }
  // (c) Edit-family on a non-trivial path: only a tiny single-hunk diff bypasses.
  if (EDIT_FAMILY_TOOLS.includes(tool)) {
    return isTinyDiff(a)
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
