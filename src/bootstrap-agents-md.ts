/**
 * v0.38.9 — postinstall AGENTS.md bootstrap helpers.
 *
 * Pure functions used by scripts/bootstrap-agents-md.ts to append a
 * snippet of meta-governor [SYSTEM-NUDGE] directives to the user's
 * `~/.config/opencode/AGENTS.md` on `npm install`.
 *
 * Why this file exists:
 *   - The plugin runtime pushes its directives via `chat.system.transform`
 *     on every session that loads the plugin. That covers opencode-launched
 *     sessions and sub-agents spawned from opencode.
 *   - Sub-agents launched outside opencode (e.g. via a parent agent's
 *     `task()` tool) don't load the plugin, so they never see the runtime
 *     injection.
 *   - Writing the directives to `~/.config/opencode/AGENTS.md` makes them
 *     visible to every agent OpenCode spawns, regardless of how it loads.
 *
 * Idempotent: detects the marker comments and skips re-write.
 * Version-aware: upgrades in place when a newer version is installed.
 * Safe: never overwrites user content; appends after.
 * Opt-out: `OMO_META_GOVERNOR_NO_BOOTSTRAP=1` env var.
 */

export const MARKER_OPEN =
  "<!-- META-GOVERNOR AUTO-INSTALL SNIPPET ("
export const MARKER_CLOSE = "<!-- END META-GOVERNOR AUTO-INSTALL SNIPPET -->"

/**
 * The snippet content. Wrapped in HTML comments so the bootstrap script
 * can detect / replace / skip without diff-based fragility.
 *
 * The directives mirror what `src/enforcement-resources.ts` pushes via
 * `chat.system.transform` — kept in sync manually (the runtime path is
 * authoritative; this file is for agents that don't load the plugin).
 */
export function buildSnippet(version: string): string {
  return [
    `${MARKER_OPEN}v${version}) -->`,
    "<!-- Auto-installed by @herjarsa/omo-meta-governor. Safe to remove. Will NOT reappear if OMO_META_GOVERNOR_NO_BOOTSTRAP=1. -->",
    "",
    "The following [SYSTEM-NUDGE] directives are pushed by the meta-governor",
    "plugin at runtime via `chat.system.transform` on every opencode session.",
    "They are also surfaced here (in AGENTS.md) so they reach agents that run",
    "outside the opencode process and never load the plugin. Keep both copies",
    "in sync if you customise them.",
    "",
    "[SYSTEM-NUDGE] Oracle Review Gate (v0.38.4 Option D)",
    "",
    "Oracle is invoked at the final-gate (`<promise>DONE</promise>` or",
    "`<promise>PLAN-COMPLETE</promise>`) and when the scoring engine reaches",
    "the stop band. `warn` / `escalate` are logged but do NOT auto-invoke.",
    "Configure frequency via `oracle.frequency` in omo-meta-governor.jsonc.",
    "",
    "[SYSTEM-NUDGE] Lesson Capture (omo_remember)",
    "",
    "After solving a non-obvious bug, learning a project rule, or discovering",
    "a config quirk, call `omo_remember` to persist it cross-session.",
    "Recall previous lessons before asking the user: `omo_recall query=\"<topic>\"`.",
    "On empty result, try `omo_recall_mcp` (cross-session AgentMemory bridge).",
    "DO NOT save routine operations or facts already covered by memory.",
    "",
    "[SYSTEM-NUDGE] Skill Priming (select before writing code)",
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
    "[SYSTEM-NUDGE] Sisyphus Protocol Enforcement",
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
 * Returns the stamped version inside the open marker, or null if not
 * present. Used by `mergeInto` to decide whether to upgrade-in-place
 * (different version) or no-op (same version). Captures the FULL version
 * string including semver pre-release suffix (e.g. "0.38.9-beta.1") so
 * that v0.38.9-beta is correctly recognised as different from v0.38.9.
 */
export function installedVersion(content: string): string | null {
  const m = content.match(
    /<!-- META-GOVERNOR AUTO-INSTALL SNIPPET \(v([^)]+)\) -->/,
  )
  return m ? m[1] : null
}

/**
 * True iff `content` already contains a snippet at `version` (or any
 * snippet when `version` is omitted). Both markers must appear; either
 * alone is treated as not-installed (handles truncated / corrupted files).
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
  const after = content
    .slice(closeIdx + MARKER_CLOSE.length)
    .replace(/^\s+/, "")
  if (!before) return after
  if (!after) return before
  return `${before}\n\n${after}`
}

function appendSnippet(existing: string, snippet: string): string {
  const trimmed = existing.replace(/\s+$/, "")
  return `${trimmed}\n\n${snippet}\n`
}

/**
 * Returns merged content:
 * - Same version already installed → return `existing` unchanged (idempotent).
 * - Different version installed → strip the old snippet, append the new one.
 * - No snippet installed → append snippet (preserving existing user content).
 * - File empty → intro + snippet.
 */
export function mergeInto(
  existing: string,
  snippet: string,
  version: string,
): string {
  const existingVersion = installedVersion(existing)

  if (existingVersion === version) return existing

  if (existingVersion !== null) {
    return appendSnippet(stripSnippet(existing), snippet)
  }

  if (!existing.trim()) {
    return [
      `# Auto-generated by @herjarsa/omo-meta-governor v${version}`,
      "# This file is read by opencode for every session. Edit freely.",
      "# The META-GOVERNOR snippet below is auto-managed by npm postinstall;",
      "# set OMO_META_GOVERNOR_NO_BOOTSTRAP=1 to disable re-installs.",
      "",
      snippet,
      "",
    ].join("\n")
  }

  return appendSnippet(existing, snippet)
}
