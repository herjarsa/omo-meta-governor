/**
 * v0.37.0 (audit enforcement) — MCP enforcement resources for OpenChamber.
 *
 * Bug (audit v2 P0-2): In OpenChamber (HTTP mode), the plugin factory never
 * runs. Only MCP tools are exposed. All text-based instructions (Oracle rule 4,
 * agentmemory rule 8, skill-priming) live in `output.messages.push` /
 * `system.transform` which require plugin hooks. OpenChamber receives ZERO
 * enforcement.
 *
 * Fix: expose the rules as MCP resources that the agent can `resources/read`
 * at startup. Works in both plugin-CLI and OpenChamber modes.
 *
 * Contract:
 * - `meta-governor://rules/oracle` → Oracle gate rule text
 * - `meta-governor://rules/agentmemory` → omo_remember rule text
 * - `meta-governor://rules/skill-priming` → skill discovery rule text
 * - `meta-governor://rules/protocol` → Sisyphus protocol enforcement rules
 *
 * The returned text uses a `[SYSTEM-NUDGE]` prefix the LLM can detect.
 */
export const ENFORCEMENT_RESOURCE_URIS = [
  "meta-governor://rules/oracle",
  "meta-governor://rules/agentmemory",
  "meta-governor://rules/skill-priming",
  "meta-governor://rules/protocol",
] as const

export type EnforcementResourceUri = (typeof ENFORCEMENT_RESOURCE_URIS)[number]

const NUDGE_PREFIX = "[SYSTEM-NUDGE]"

/**
 * Build the Oracle gate rule (v0.38.4 Option D — Oracle frequency).
 *
 * v0.38.4 REWRITE: Oracle is no longer auto-invoked mid-work for every
 * multi-file change. Instead, the `oracle.frequency` config controls when
 * Oracle fires:
 *   - `"per-stop"` (default): Oracle invoked at the final-gate
 *     (<promise>DONE</promise>) AND when the scoring engine reaches the
 *     stop band (action === "stop"). warn/escalate log but do NOT
 *     invoke Oracle mid-work.
 *   - `"final-only"`: Oracle invoked ONLY at the final-gate. Even
 *     stop-level decisions log without invoking Oracle mid-work.
 *   - `"off"`: Oracle is NEVER invoked automatically. The agent must
 *     set `oracleVerified` manually (e.g. via omo_recall).
 *
 * The DONE final-gate is ALWAYS Oracle-verified regardless of frequency.
 *
 * Same MCP resource contract as before — `meta-governor://rules/oracle`
 * still returns this text. The previous "INVOKE triggers per multi-file
 * change" was the source of the noise — now mid-work Oracle is
 * gated by score band, not file count.
 */
export function buildOracleRule(): string {
  return [
    `${NUDGE_PREFIX} Oracle Review Gate (v0.38.4 Option D — Oracle frequency)`,
    ``,
    `The plugin invokes Oracle based on the \`oracle.frequency\` config:`,
    ``,
    `- \`per-stop\` (default): Oracle fires ONLY at the final-gate AND when`,
    `  the scoring engine reaches the stop band (action === "stop").`,
    `  warn and escalate decisions log but do NOT auto-invoke Oracle.`,
    `- \`final-only\`: Oracle fires ONLY at the final-gate. Zero mid-work`,
    `  invocations, even for stop decisions.`,
    `- \`off\`: Oracle is NEVER invoked automatically. Set`,
    `  \`oracleVerified\` manually (e.g. via omo_recall).`,
    ``,
    `Final-gate (ALWAYS Oracle-verified regardless of frequency):`,
    `When you emit <promise>DONE</promise> or <promise>PLAN-COMPLETE</promise>,`,
    `the plugin invokes Oracle with:`,
    `  task(subagent_type="oracle", run_in_background=false, prompt="Verify: ...")`,
    ``,
    `INVOKE triggers for the final-gate (verbatim from protocol-enforcer.ts):`,
    `- created 1+ new file`,
    `- modified abstraction`,
    `- touched security/auth paths`,
    `- modified DB/persistence`,
    `- modified CI/CD`,
    `- added/removed dependency`,
    `- modified perf-critical path`,
    `- todo had 2+ completed items`,
    ``,
    `SKIP only when:`,
    `- files touched <= 2`,
    `- no new file`,
    `- no dependency change`,
    `- single-step task`,
    `- change is typo/comment/rename only`,
    ``,
    `Verdict: PASS -> done. FAIL/CONDITIONAL -> fix and re-invoke.`,
    `Cost: Max 3 oracle invocations per task (final-gate only).`,
  ].join("\n")
}

/**
 * Build the agentmemory / omo_remember rule.
 * Directs the LLM to use the plugin's `omo_remember` tool (NOT raw
 * `agentmemory_memory_save` MCP) to persist lessons cross-session.
 */
export function buildAgentMemoryRule(): string {
  return [
    `${NUDGE_PREFIX} Lesson Capture (omo_remember)`,
    ``,
    `After solving a non-obvious bug, learning a project rule, or discovering`,
    `a config quirk, call \`omo_remember\` to persist it cross-session:`,
    `  omo_remember with content="<the lesson>" concepts=["topic1","topic2"]`,
    ``,
    `DO NOT save routine operations:`,
    `- file reads, greps, list commands`,
    `- trivial decisions`,
    `- facts already covered by existing memory`,
    ``,
    `SAVE only:`,
    `- novel insights the agent wouldn't otherwise know`,
    `- non-obvious patterns or workarounds`,
    `- corrections to previous assumptions`,
    `- project-specific rules discovered during work`,
    ``,
    `Recall previous lessons before asking the user: omo_recall with query="<topic>"`,
    `On empty result, try omo_recall_mcp (cross-session AgentMemory bridge).`,
  ].join("\n")
}

/**
 * Build the skill-priming rule (v0.33.1 skill-hub routing).
 * Directs the LLM to discover skills via the catalog before implementation.
 */
export function buildSkillPrimingRule(): string {
  return [
    `${NUDGE_PREFIX} Skill Priming (select before writing code)`,
    ``,
    `Before implementation work, query the skill catalog for the 2-3`,
    `capabilities most relevant to this task. Compose a minimal stack:`,
    ``,
    `1. omo_skill_find "<task type> <language>" --limit 5`,
    `2. Inspect candidates with omo_skill_get`,
    `3. Load selected skills via omo_skill_add (global cache)`,
    `   or omo_skill_create if no catalog match`,
    ``,
    `Primary discovery tools (use BEFORE grep/glob/raw read):`,
    `- Architecture / concepts / cross-module relationships -> omo_search`,
    `  (auto-routes between codegraph + graphify)`,
    `- Symbol-level lookup, call graph, impact analysis -> omo_find / omo_impact`,
    `- Past lessons, decisions, prior solutions -> omo_recall`,
    `- Project status -> omo_health / omo_status`,
    ``,
    `Use raw grep ONLY when indexed queries above cannot answer the question`,
    `(literal byte patterns, throwaway strings).`,
    ``,
    `Do NOT enumerate the full catalog — keep the stack minimal and task-specific.`,
  ].join("\n")
}

/**
 * Build the Sisyphus protocol enforcement rules (consolidated).
 */
export function buildProtocolRule(): string {
  return [
    `${NUDGE_PREFIX} Sisyphus Protocol Enforcement`,
    ``,
    `You MUST follow these rules:`,
    ``,
    `1. Codebase Graph First: Before grep/glob/read for architecture or symbol`,
    `   queries, check whether codegraph/graphify exist. If so, use them first,`,
    `   then grep/read only as last resort.`,
    ``,
    `2. Tool Routing:`,
    `   - "we did this before" / "you should know" -> omo_recall`,
    `   - Starting a task that resembles a previous one -> omo_recall_mcp`,
    `   - Before asking the user a clarifying question -> omo_recall first`,
    `   - Save durable insight/decision/rule -> omo_remember`,
    ``,
    `3. Parallel Query Rule: Fire independent tool queries in the same turn.`,
    `   Do NOT serialize independent memory/context queries.`,
    ``,
    `4. Empty-Result Escalation: On empty omo_recall, try omo_recall_mcp`,
    `   (cross-session bridge) before asking the user.`,
    ``,
    `5. Hard Rules (No Exceptions):`,
    `   - Do NOT suppress type errors with as any, @ts-ignore, @ts-expect-error.`,
    `   - Do NOT leave empty catch blocks \`catch(e) {}\`.`,
    `   - Do NOT start a fresh task() when task(task_id="ses_...") continuation exists.`,
    `   - Do NOT batch-complete todos — mark each one completed immediately.`,
    `   - Do NOT skip Oracle on 2+ file changes (post-task verification).`,
    ``,
    `6. CI Verification Loop (NON-NEGOTIABLE):`,
    `   - After every push: gh run watch <run-id> --exit-status`,
    `   - Assert conclusion==success on EVERY job.`,
    `   - Never proceed on red CI.`,
  ].join("\n")
}

/**
 * v0.37.0: read an enforcement resource by URI. Pure function for testability.
 * Returns null on unknown URI (the MCP server treats this as a 404).
 */
export function readEnforcementResource(uri: string): string | null {
  switch (uri) {
    case "meta-governor://rules/oracle":
      return buildOracleRule()
    case "meta-governor://rules/agentmemory":
      return buildAgentMemoryRule()
    case "meta-governor://rules/skill-priming":
      return buildSkillPrimingRule()
    case "meta-governor://rules/protocol":
      return buildProtocolRule()
    default:
      return null
  }
}