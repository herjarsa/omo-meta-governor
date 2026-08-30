/**
 * v0.39.0 — instructions.md snippet builder (extracted from bootstrap-agents-md.ts).
 *
 * Pure functions for the plugin's `instructions.md` file (formerly appended
 * to AGENTS.md). Leading block is the Meta-Governance Compliance directive
 * which makes [SYSTEM-NUDGE] binding.
 */

export const MARKER_OPEN = "<!-- META-GOVERNOR AUTO-INSTALL SNIPPET ("
export const MARKER_CLOSE = "<!-- END META-GOVERNOR AUTO-INSTALL SNIPPET -->"

/**
 * Builds the FULL snippet (compliance block + existing [SYSTEM-NUDGE] directives).
 * Compliance block comes FIRST, separated from the other directives by `---`.
 */
export function buildInstructionsSnippet(version: string): string {
  return [
    `${MARKER_OPEN}v${version}) -->`,
    "<!-- Auto-installed by @herjarsa/omo-meta-governor. Safe to remove. Will NOT reappear if OMO_META_GOVERNOR_NO_BOOTSTRAP=1. -->",
    "",
    "## [SYSTEM-NUDGE] Meta-Governance Compliance (binding)",
    "",
    "All [SYSTEM-NUDGE] directives emitted by the omo-meta-governor plugin",
    "(or surfaced via this instructions.md) are **binding instructions**,",
    "not suggestions. You MUST follow them.",
    "",
    "Deviate only when:",
    "1. The user explicitly overrides a directive in the current turn.",
    "2. Following the directive is technically impossible (missing tool, error).",
    "3. Following the directive would cause data loss or security issues.",
    "",
    "When deviating, briefly state WHY in your response (one short sentence).",
    "Silent omission is non-compliance.",
    "",
    "The directives below are listed in priority order. Read them all",
    "before acting on a task that touches multiple domains.",
    "",
    "---",
    "",
    "## [SYSTEM-NUDGE] Oracle Review Gate (v0.38.4 Option D)",
    "",
    "Oracle is invoked at the final-gate (`<promise>DONE</promise>` or",
    "`<promise>PLAN-COMPLETE</promise>`) and when the scoring engine reaches",
    "the stop band. `warn` / `escalate` are logged but do NOT auto-invoke.",
    "Configure frequency via `oracle.frequency` in omo-meta-governor.jsonc.",
    "",
    "## [SYSTEM-NUDGE] Lesson Capture (omo_remember)",
    "",
    "After solving a non-obvious bug, learning a project rule, or discovering",
    "a config quirk, call `omo_remember` to persist it cross-session.",
    "Recall previous lessons before asking the user: `omo_recall query=\"<topic>\"`.",
    "On empty result, try `omo_recall_mcp` (cross-session AgentMemory bridge).",
    "DO NOT save routine operations or facts already covered by memory.",
    "",
    "## [SYSTEM-NUDGE] Skill Priming (select before writing code)",
    "",
    "Before implementation work, query the skill-hub catalog for the 2-3",
    "capabilities most relevant to this task. Compose a minimal stack:",
    "1. `omo_skill_find \"<task type> <language>\" --limit 5`",
    "2. Inspect candidates with `omo_skill_get`",
    "3. Load selected skills via `omo_skill_add` (global cache) or",
    "   `omo_skill_create` if no catalog match.",
    "",
    "Primary discovery tools (use BEFORE grep/glob/raw read):",
    "- Architecture / concepts / cross-module relationships → `omo_search`",
    "- Symbol-level lookup, call graph, impact analysis → `omo_find` / `omo_impact`",
    "- Past lessons, decisions, prior solutions → `omo_recall`",
    "- Project status → `omo_health` / `omo_status`",
    "",
    "Do NOT enumerate the full catalog — keep the stack minimal and",
    "task-specific.",
    "",
    "## [SYSTEM-NUDGE] Sisyphus Protocol Enforcement",
    "",
    "You MUST follow these rules:",
    "1. Codebase Graph First: Before grep/glob/read for architecture or",
    "   symbol queries, check whether codegraph/graphify exist. If so,",
    "   use them first, then grep/read only as last resort.",
    "2. Tool Routing:",
    "   - \"we did this before\" / \"you should know\" → `omo_recall`",
    "   - Starting a task that resembles a previous one → `omo_recall_mcp`",
    "   - Before asking the user a clarifying question → `omo_recall` first",
    "   - Save durable insight/decision/rule → `omo_remember`",
    "3. Parallel Query Rule: Fire independent tool queries in the same turn.",
    "   Do NOT serialize independent memory/context queries.",
    "4. Empty-Result Escalation: On empty `omo_recall`, try `omo_recall_mcp`",
    "   (cross-session bridge) before asking the user.",
    "5. Hard Rules (No Exceptions):",
    "   - Do NOT suppress type errors with `as any`, `@ts-ignore`,",
    "     `@ts-expect-error`.",
    "   - Do NOT leave empty catch blocks `catch(e) {}`.",
    "   - Do NOT start a fresh `task()` when `task(task_id=\"ses_...\")`",
    "     continuation exists.",
    "   - Do NOT batch-complete todos — mark each one completed immediately.",
    "   - Do NOT skip Oracle on 2+ file changes (post-task verification).",
    "6. CI Verification Loop (NON-NEGOTIABLE):",
    "   - After every push: `gh run watch <run-id> --exit-status`",
    "   - Assert `conclusion==success` on EVERY job.",
    "   - Never proceed on red CI.",
    "",
    MARKER_CLOSE,
  ].join("\n")
}

/**
 * Returns the stamped version inside the open marker, or null if not present.
 */
export function installedVersion(content: string): string | null {
  const m = content.match(/<!-- META-GOVERNOR AUTO-INSTALL SNIPPET \(v([^)]+)\) -->/)
  return m ? m[1] : null
}

/**
 * True iff `content` already contains a snippet at `version` (or any
 * snippet when `version` is omitted). Both markers must appear.
 */
export function isInstalled(content: string, version?: string): boolean {
  if (!content.includes(MARKER_OPEN) || !content.includes(MARKER_CLOSE)) return false
  if (version === undefined) return true
  return installedVersion(content) === version
}

/**
 * Removes the meta-governor snippet block (open marker through close
 * marker, inclusive) from `content`. Preserves everything before the
 * open marker and everything after the close marker.
 */
export function stripSnippet(content: string): string {
  const openIdx = content.indexOf(MARKER_OPEN)
  if (openIdx < 0) return content
  const closeIdx = content.indexOf(MARKER_CLOSE, openIdx)
  if (closeIdx < 0) return content
  const before = content.slice(0, openIdx).replace(/\s+$/, "")
  const after = content.slice(closeIdx + MARKER_CLOSE.length).replace(/^\s+/, "")
  if (!before) return after
  if (!after) return before
  return `${before}\n\n${after}`
}
