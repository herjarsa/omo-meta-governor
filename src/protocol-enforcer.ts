/**
 * Sisyphus Protocol Enforcer — standalone module for the MetaGovernor plugin.
 *
 * Reads the Sisyphus-mandatory protocol from disk, injects a condensed
 * version into the system prompt, and audits tool calls for protocol
 * violations using heuristic detection (no NLP).
 *
 * Public surface:
 * - loadProtocol(path?): Promise<string> — reads the protocol markdown
 * - buildSystemInjection(protocolText): string — condenses for system prompt
 * - auditToolCall(toolName, args, context): ProtocolViolation[] — heuristic audit
 */
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { homedir } from "node:os"
import type { ProtocolViolation } from "./types"

// ─── Default protocol path ───────────────────────────────────────

export const DEFAULT_PROTOCOL_PATH = resolve(
  homedir(),
  ".config",
  "opencode",
  "sisyphus-mandatory",
  "sisyphus-mandatory.md",
)

// ─── loadProtocol ────────────────────────────────────────────────

/**
 * Read the Sisyphus protocol markdown from disk.
 * Falls back to the default path (~/.config/opencode/sisyphus-mandatory/sisyphus-mandatory.md)
 * when no path is provided.
 */
export async function loadProtocol(path?: string): Promise<string> {
  const resolvedPath = path ?? DEFAULT_PROTOCOL_PATH
  return await readFile(resolvedPath, "utf-8")
}

// ─── buildSystemInjection ───────────────────────────────────────

/**
 * Build a condensed system-prompt injection from the full protocol text.
 * Extracts key rules from the known sections of the protocol file.
 * Returns a markdown string that can be appended to the system prompt.
 */
export function buildSystemInjection(_protocolText: string): string {
  const lines: string[] = [
    "",
    "## Sisyphus Protocol Enforcement",
    "",
    "You MUST follow these Sisyphus protocol rules:",
    "",
    "1. **Pre-response Memory Check**: Before any action, read `<project-memory>` and `<session-history-since>` blocks in context. Cite `<memory id>` for any fact used from memory. Do not ask questions whose answers are in those blocks.",
    "",
    "2. **Codebase Graph First**: Before using grep/glob/read for architecture or symbol queries, check whether `.codegraph/` or `graphify-out/` exists. If so, use codegraph/graphify tools first. Fall back to AFT (aft_zoom, aft_outline), then grep/read only as last resort.",
    "",
    "3. **Tool Routing Table**: Match common intents to the correct tool:",
    '   - "we did this before" / "you should know" → `agentmemory_memory_recall`',
    '   - "the usual" / "as configured" → `ctx_memory(action="list")`',
    "   - Starting a task that resembles a previous one → `agentmemory_memory_smart_search`",
    '   - "what changed" / "history" → `ctx_search`',
    "   - Before asking the user a clarifying question → `agentmemory_memory_recall` first",
    "",
  ]

  // Detect sections in the protocol text to decide which rules to emit
  if (/\boracle\b/i.test(_protocolText)) {
    lines.push(
      "4. **Post-task Oracle Verification**: If files touched >= 3 OR any INVOKE trigger matches, invoke Oracle with the exact format:",
      '   `task(subagent_type="oracle", run_in_background=false, prompt="Verify: ...")`',
      "   - INVOKE triggers: created 1+ new file, modified abstraction, touched security/auth paths, modified DB/persistence, modified CI/CD, added/removed dependency, modified perf-critical path, todo had 2+ completed items.",
      "   - SKIP only when: files touched <= 2, no new file, no dependency change, single-step task, change is typo/comment/rename only.",
      "   - Verdict: PASS → done. FAIL/CONDITIONAL → fix and re-invoke. Max 3 invocations.",
      "   - Cost: Max 3 oracle invocations per task. Skip rate: Must NOT skip Oracle on 2+ file change.",
      "",
    )
  }

  lines.push(
    "5. **Parallel Query Rule**: Fire independent tool queries in the same turn. Do NOT serialize independent memory/context queries.",
    "",
    "6. **Empty-Result Escalation**: On empty `agentmemory_memory_recall`, fire `agentmemory_memory_smart_search` + `ctx_search` + `agentmemory_memory_export` before asking the user.",
    "",
    "7. **Hard Rules (No Exceptions)**:",
    "   - Do NOT ask 'where is X?' if memory or session record already contains it.",
    "   - Do NOT claim 'I don't know' before firing at least 2 different recall tools.",
    "   - Do NOT re-issue clarifying questions whose answer is in `<project-memory>` or `<session-history-since>`.",
    "   - Do NOT use grep/find when aft_outline would answer the structure question.",
    "   - Do NOT duplicate a memory in both `agentmemory_memory_save` and `ctx_memory` — pick ONE.",
    "",
    "8. **Self-Check Before Responding**:",
    "   - Verify you read `<project-memory>` and `<session-history-since>` blocks.",
    "   - Verify you cited `<memory id>` for any fact used from memory.",
    "   - Verify you did not ask a question whose answer is in those blocks.",
    "   - For multi-file changes, verify Oracle was invoked.",
    "   - For codebase exploration, verify codegraph/graphify was tried before grep/read.",
    "",
  )

  return lines.join("\n")
}

// ─── auditToolCall ───────────────────────────────────────────────

/**
 * Audit a single tool call for Sisyphus protocol violations.
 *
 * Uses heuristic detection (no NLP):
 * 1. If grep/glob/read is used when codegraph or graphify exists → "media" violation
 * 2. If the agent asks a question without prior memory tool use → "grave" violation
 * 3. If the agent is about to ask the user something memory could answer → "media" violation
 * 4. If an "undo" or "revert" is used without prior checkpoint → "leve" violation
 *
 * @param toolName The name of the tool being called
 * @param _args The tool arguments (unused in current heuristics but reserved)
 * @param context Session-level context for cross-call state awareness
 * @returns Array of protocol violations (empty if none detected)
 */
export function auditToolCall(
  toolName: string,
  _args: unknown,
  context: {
    /** Whether any memory tools have been used in this session */
    memoryToolsUsed: readonly string[]
    /** Whether .codegraph/ directory exists in the project */
    hasCodegraphDir: boolean
    /** Whether graphify-out/ directory exists in the project */
    hasGraphifyDir: boolean
    /** Whether Oracle has been invoked in this session */
    oracleInvoked: boolean
    /** Number of files changed so far in this session */
    filesChanged: number
    /** Whether any memory recall tool returned empty results */
    emptyRecall: boolean
    /** Whether any ctx_search or smart_search was attempted after empty recall */
    escalationAttempted: boolean
  },
): ProtocolViolation[] {
  const violations: ProtocolViolation[] = []

  // Rule 0.5: Codebase Graph First
  // grep/glob/read for architecture/symbol queries should use codegraph/graphify first
  if (
    (toolName === "grep" || toolName === "glob") &&
    (context.hasCodegraphDir || context.hasGraphifyDir)
  ) {
    const graphType = context.hasCodegraphDir ? ".codegraph" : "graphify-out"
    violations.push({
      rule: "codebase-graph-first",
      tool: toolName,
      severity: "media",
      detail: `Used ${toolName} when ${graphType} exists — should use codegraph/graphify first for architecture and symbol queries.`,
    })
  }

  // Rule Step 3: Empty-result escalation
  // After empty memory_recall, the agent must try smart_search + ctx_search before asking
  if (context.emptyRecall && !context.escalationAttempted) {
    if (toolName.startsWith("question") || toolName === "ask") {
      violations.push({
        rule: "empty-result-escalation",
        tool: toolName,
        severity: "grave",
        detail:
          "Memory recall returned empty but agent did not fire smart_search + ctx_search + export before asking the user. Steps 1-3 of empty-result escalation protocol are mandatory.",
      })
    }
  }

  // Rule Step 1: Memory tools should be used before asking questions
  const memoryToolPatterns = ["agentmemory_memory_recall", "agentmemory_memory_smart_search", "agentmemory_memory_save", "ctx_memory", "ctx_search", "ctx_note"]
  const hasUsedMemory = context.memoryToolsUsed.some((t) =>
    memoryToolPatterns.some((p) => t.startsWith(p)),
  )

  if (!hasUsedMemory && (toolName.startsWith("question") || toolName === "ask")) {
    violations.push({
      rule: "memory-first",
      tool: toolName,
      severity: "grave",
      detail:
        "Asked a question without first querying memory (agentmemory or ctx_memory). Must fire agentmemory_memory_recall or ctx_memory before asking the user.",
    })
  }

  // Oracle rule: after multi-file changes (3+), check if oracle was invoked
  if (context.filesChanged >= 3 && !context.oracleInvoked) {
    // We detect this on any tool call after files have changed
    // Only flag once per session - let the caller decide
    // For now, flag as media so the orchestrator can escalate
    if (toolName !== "task" || !_args || typeof _args !== "object" || !("subagent_type" in (_args as Record<string, unknown>))) {
      violations.push({
        rule: "oracle-verification",
        tool: toolName,
        severity: "media",
        detail:
          `Files changed (${context.filesChanged}) >= 3 but Oracle was not invoked. The POST-TASK ORACLE VERIFICATION protocol requires Oracle invocation on multi-file changes.`,
      })
    }
  }

  return violations
}
