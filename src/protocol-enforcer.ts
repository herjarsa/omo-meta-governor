/**
 * Sisyphus Protocol Enforcer — standalone module for the MetaGovernor plugin.
 *
 * Reads the Sisyphus-mandatory protocol from disk, injects a condensed
 * version into the system prompt, and audits tool calls for protocol
 * violations using heuristic detection (no NLP).
 *
 * Public surface:
 * - loadProtocol(path?): Promise<string>
 * - buildSystemInjection(protocolText): string
 * - auditToolCall(toolName, args, context): ProtocolViolation[]
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

export async function loadProtocol(path?: string): Promise<string> {
  const resolvedPath = path ?? DEFAULT_PROTOCOL_PATH
  return await readFile(resolvedPath, "utf-8")
}

// ─── buildSystemInjection ────────────────────────────────────────

export function buildSystemInjection(_protocolText: string): string {
  const lines: string[] = [
    "",
    "## Sisyphus Protocol Enforcement",
    "",
    "You MUST follow these Sisyphus protocol rules:",
    "",
    "1. **Pre-response Memory Check**: Before any action, read `<project-memory>` and `<session-history-since>` blocks in context. Cite `<memory id>` for any fact used from memory. Do not ask questions whose answers are in those blocks.",
    "",
    "2. **Codebase Graph First**: Before using grep/glob/read for architecture or symbol queries, check whether `.codegraph/` or `graphify-out/` exists. If so, use codegraph/graphify tools first, then grep/read only as last resort.",
    "",
    "3. **Tool Routing Table**: Match common intents to the correct tool:",
    '   - "we did this before" / "you should know" → `agentmemory_memory_recall`',
    "   - Starting a task that resembles a previous one → `agentmemory_memory_smart_search`",
    "   - Before asking the user a clarifying question → `agentmemory_memory_recall` first",
    "   - Save durable insight/decision/rule → `agentmemory_memory_save`",
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
    "6. **Empty-Result Escalation**: On empty `agentmemory_memory_recall`, fire `agentmemory_memory_smart_search` + `agentmemory_memory_export` before asking the user.",
    "",
    "7. **Hard Rules (No Exceptions)**:",
    "   - Do NOT ask 'where is X?' if memory or session record already contains it.",
    "   - Do NOT claim 'I don't know' before firing at least 2 different recall tools.",
    "   - Do NOT re-issue clarifying questions whose answer is in `<project-memory>` or `<session-history-since>`.",
    "   - Do NOT suppress type errors with `as any`, `@ts-ignore`, or `@ts-expect-error`.",
    "   - Do NOT leave empty catch blocks `catch(e) {}`.",
    "   - Do NOT start a fresh agent via `task()` when `task(task_id=\"ses_...\")` (continuation) exists — use continuation IDs.",
    "   - Do NOT batch-complete todos — mark each one `completed` immediately after finishing.",
    "   - Do NOT skip creating todos for multi-step tasks.",
    "",
    "8. **Self-Check Before Responding**:",
    "   - Verify you read `<project-memory>` and `<session-history-since>` blocks.",
    "   - Verify you cited `<memory id>` for any fact used from memory.",
    "   - Verify you did not ask a question whose answer is in those blocks.",
    "   - For multi-file changes, verify Oracle was invoked.",
    "   - For codebase exploration, verify codegraph/graphify was tried before grep/read.",
    "   - After discovering something non-obvious, save it with `agentmemory_memory_save` so future sessions benefit.",
    "",
  )

  return lines.join("\n")
}

// ─── Audit context ────────────────────────────────────────────────

export interface AuditContext {
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
  /** Whether any memory smart_search was attempted after empty recall */
  escalationAttempted: boolean
/** Tool names called in this session so far (latest first) */
  recentToolCalls?: readonly string[]
/** File write/edit contents (last 3 for pattern detection) */
  recentWriteContents?: readonly string[]
/** Whether a memory save has been used to persist discoveries */
  memorySaved?: boolean
/** Number of times todo was batch-completed in this session */
  batchCompletions?: number
}

// ─── auditToolCall ────────────────────────────────────────────────

export function auditToolCall(
  toolName: string,
  args: unknown,
  context: AuditContext,
): ProtocolViolation[] {
  const violations: ProtocolViolation[] = []
  const recentToolCalls = context.recentToolCalls ?? []
  const recentWriteContents = context.recentWriteContents ?? []
  const memorySaved = context.memorySaved ?? false
  const batchCompletions = context.batchCompletions ?? 0
  // ── Rule 0.5: Codebase Graph First ──────────────────────────────
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

  // ── Rule: Continuation ID discipline ────────────────────────────
  // Starting fresh with task() instead of continuing via task(task_id="ses_...")
  if (toolName === "task" && args && typeof args === "object") {
    const taskArgs = args as Record<string, unknown>
    // If task() has no task_id but has a prompt that resembles a follow-up
    if (!taskArgs.task_id && typeof taskArgs.prompt === "string" && recentToolCalls.length > 3) {
      // Heuristic: if we have more than 3 tool calls in this session and the agent
      // is starting a new task without continuation ID, flag it
      violations.push({
        rule: "continuation-discipline",
        tool: toolName,
        severity: "leve",
        detail:
          "Started a new task() without task(task_id=\"ses_...\") continuation ID. " +
          "Use task_id to preserve the subagent's full context and save tokens.",
      })
    }
  }

  // ── Rule: No type suppression patterns ─────────────────────────
  const writeTools = ["write", "edit", "edit_block", "desktop-commander_edit_block", "desktop-commander_write_file"]
  if (writeTools.includes(toolName)) {
    const content = typeof args === "object" && args !== null
      ? JSON.stringify(args)
      : String(args ?? "")

    const tsIgnore = /@ts-ignore|@ts-expect-error/.test(content)
    const anyCast = /\bas any\b/.test(content)

    if (tsIgnore && anyCast) {
      violations.push({
        rule: "no-type-suppression",
        tool: toolName,
        severity: "grave",
        detail:
          `File write contains both @ts-ignore/@ts-expect-error AND 'as any' — double type suppression. ` +
          `Both are forbidden by the Sisyphus protocol.`,
      })
    } else if (tsIgnore) {
      violations.push({
        rule: "no-type-suppression",
        tool: toolName,
        severity: "media",
        detail:
          `File write contains @ts-ignore or @ts-expect-error — both are forbidden. ` +
          `Fix the underlying type error instead.`,
      })
    } else if (anyCast) {
      violations.push({
        rule: "no-type-suppression",
        tool: toolName,
        severity: "media",
        detail:
          `File write contains 'as any' — type suppression forbidden. ` +
          `Use proper type narrowing instead.`,
      })
    }
  }

  // ── Rule: No empty catch blocks ────────────────────────────────
  if (writeTools.includes(toolName)) {
    const content = typeof args === "object" && args !== null
      ? JSON.stringify(args)
      : String(args ?? "")

    if (/catch\s*\(\s*\w+\s*\)\s*\{\s*\}/.test(content)) {
      violations.push({
        rule: "no-empty-catch",
        tool: toolName,
        severity: "media",
        detail:
          "Empty catch block detected — `catch(e) {}` is forbidden. " +
          "Log the error or handle it gracefully.",
      })
    }
  }

  // ── Rule: Memory discovery not saved ────────────────────────────
  // After reading/searching files, if no memory save was used to persist discoveries
  const discoveryTools = ["grep", "glob", "read", "codegraph_explore", "graphify query"]
  if (discoveryTools.includes(toolName) && recentToolCalls.length >= 2) {
    // Check whether any memory save happened
    if (!memorySaved) {
      violations.push({
        rule: "save-discovery-to-memory",
        tool: toolName,
        severity: "leve",
        detail:
          `Used ${toolName} to discover code but no memory save was made afterwards. ` +
          "Save non-obvious findings with agentmemory_memory_save so future sessions benefit.",
      })
    }
  }

  // ── Rule: Batch todo completion ─────────────────────────────────
  // Detected by caller passing batchCompletions info
  // The orchestrator/provider sets batchCompletions based on its own monitoring
  if (batchCompletions > 0 && toolName !== "todowrite") {
    violations.push({
      rule: "no-batch-todo-completion",
      tool: toolName,
      severity: "leve",
      detail:
        "Batch todo completion detected. Each todo must be marked `completed` immediately " +
        "after finishing — do not batch-complete multiple items.",
    })
  }

  // ── Rule: Step 3: Empty-result escalation ───────────────────────
  if (context.emptyRecall && !context.escalationAttempted) {
    if (toolName.startsWith("question") || toolName === "ask") {
      violations.push({
        rule: "empty-result-escalation",
        tool: toolName,
        severity: "grave",
        detail:
          "Memory recall returned empty but agent did not fire smart_search + export " +
          "before asking the user. Steps 1-3 of empty-result escalation protocol are mandatory.",
      })
    }
  }

  // ── Rule: Memory first before asking questions ──────────────────
  const memoryToolPatterns = [
    "agentmemory_memory_recall", "agentmemory_memory_smart_search",
    "agentmemory_memory_save",
  ]
  const hasUsedMemory = context.memoryToolsUsed.some((t) =>
    memoryToolPatterns.some((p) => t.startsWith(p)),
  )

  if (!hasUsedMemory && (toolName.startsWith("question") || toolName === "ask")) {
    violations.push({
      rule: "memory-first",
      tool: toolName,
      severity: "grave",
      detail:
        "Asked a question without first querying memory. " +
        "Must fire agentmemory_memory_recall or agentmemory_memory_smart_search before asking the user.",
    })
  }

  // ── Oracle rule: after multi-file changes ───────────────────────
  if (context.filesChanged >= 3 && !context.oracleInvoked) {
    if (
      toolName !== "task" ||
      !args || typeof args !== "object" ||
      !("subagent_type" in (args as Record<string, unknown>))
    ) {
      violations.push({
        rule: "oracle-verification",
        tool: toolName,
        severity: "media",
        detail:
          `Files changed (${context.filesChanged}) >= 3 but Oracle was not invoked. ` +
          "The POST-TASK ORACLE VERIFICATION protocol requires Oracle invocation on multi-file changes.",
      })
    }
  }

  return violations
}
