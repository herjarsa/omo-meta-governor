/**
 * Custom tools that omo-meta-governor registers for the LLM to invoke
 * explicitly. v0.13.1 upgrade.
 *
 * Three tools:
 * - `omo_search`  — semantic code search via codegraph/graphify
 * - `omo_recall`  — search past lessons learned in this project's history
 * - `omo_health`  — show plugin runtime status + metrics
 *
 * Design:
 * - Tools are registered via the `tool` field in the returned Hooks object
 * - All tools have Zod-validated args (typed at compile time)
 * - Each tool calls into the modules we already built (GraphRetrieval, SqliteBackend)
 * - Failure modes return a friendly string so the LLM can recover
 *
 * The key insight: instead of fire-and-forget invocations in tool.execute.before
 * (v0.13.0), the LLM now EXPLICITLY chooses when to call these tools via its
 * tool schema. This makes governance visible and intentional rather than
 * ambient and invisible.
 */

import { tool, type ToolContext, type ToolResult } from "@opencode-ai/plugin"

// z is exposed via the `tool.schema` namespace export (re-exported from zod v4)
const z = tool.schema
import type { SqliteBackend } from "./sqlite-backend"
import type { GraphRetrieval } from "./graph-retrieval"
import type { MetricsCollector } from "./metrics"
import { writeHealthToFile, type PluginHealth } from "./health"
import { getDefaultCodeGraphTools, type CodeGraphTools } from "./codegraph-tools"
import { getDefaultGraphRetrieval } from "./graph-retrieval"
import { promptAgent, hasSessionClient } from "./session-bridge"

// v0.16.0: F2.4 — derive plugin version from package.json. Falls
// back to a literal if the bundler has not copied package.json next
// to dist/.
let PLUGIN_VERSION = "0.0.0"
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  PLUGIN_VERSION = require("../package.json").version as string
} catch { /* package.json not available at runtime */ }


// ---------------------------------------------------------------------------
// omo_search — semantic code search via codegraph/graphify
// ---------------------------------------------------------------------------

export interface OmoSearchDeps {
  graphRetrieval: GraphRetrieval
  cwd: string
}

/**
 * Build the `omo_search` tool. The LLM sees it in its tool schema with a
 * description that biases it toward graph-first queries.
 */
export function buildOmoSearchTool(deps: OmoSearchDeps) {
  return tool({
    description:
      "Semantic code search using codegraph/graphify for the current project. " +
      "USE THIS for architecture questions, finding call sites, understanding module structure. " +
      "Prefer over grep/glob for high-level understanding — grep is still better for literal text matches.",
    args: {
      query: z.string().min(3).describe("Natural language query describing what you're looking for"),
      maxResults: z.number().int().min(1).max(20).optional().describe("Max results to return (default 10)"),
    },
    async execute(args, ctx): Promise<ToolResult> {
      const start = Date.now()
      const result = await deps.graphRetrieval.invoke(deps.cwd, args.query, {
        timeoutMs: 8_000,
      })
      const meta = {
        tool: "omo_search",
        query: args.query,
        kind: result.kind,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
        resultSize: result.result?.length ?? 0,
        sessionID: ctx.sessionID,
      }
      if (result.timedOut) {
        return {
          title: "omo_search: timeout",
          output:
            `Graph search timed out after ${result.durationMs}ms. ` +
            `No graph tools available at ${deps.cwd}, or the query is too expensive. ` +
            `Fall back to grep/glob for direct text matching.`,
          metadata: meta,
        }
      }
      if (!result.result) {
        return {
          title: "omo_search: no graph backend",
          output:
            `No codegraph or graphify directory found at ${deps.cwd}. ` +
            `Run \`npx codegraph init\` or \`graphify . --no-viz\` to build the index, ` +
            `then call omo_search again. Until then, use grep/glob for direct text matching.`,
          metadata: meta,
        }
      }
      return {
        title: `omo_search: ${result.kind}`,
        output: result.result,
        metadata: meta,
      }
    },
  })
}

// ---------------------------------------------------------------------------
// omo_recall — search past lessons in the SQLite store
// ---------------------------------------------------------------------------

export interface OmoRecallDeps {
  sqlite: SqliteBackend
}

/**
 * Build the `omo_recall` tool. The LLM uses this to retrieve lessons learned
 * in past sessions, enabling genuine cross-session learning.
 */
export function buildOmoRecallTool(deps: OmoRecallDeps) {
  return tool({
    description:
      "Search lessons learned in past sessions of this project. " +
      "Returns ranked lessons (highest confidence first) matching the query. " +
      "Use before making non-trivial decisions — the answer may already be in memory.",
    args: {
      query: z.string().min(2).describe("What kind of lesson you're looking for"),
      limit: z.number().int().min(1).max(20).optional().describe("Max lessons to return (default 5)"),
    },
    async execute(args, ctx): Promise<ToolResult> {
      const start = Date.now()
      const result = await deps.sqlite.smartSearch({
        query: args.query,
        limit: args.limit ?? 5,
      })
      const lessons = result.lessons
      if (lessons.length === 0) {
        return {
          title: "omo_recall: no matches",
          output: `No past lessons found matching "${args.query}". This is the first time the agent is encountering this question.`,
          metadata: {
            tool: "omo_recall",
            query: args.query,
            durationMs: Date.now() - start,
            lessonsFound: 0,
          },
        }
      }
      const formatted = lessons
        .map(
          (l, i) =>
            `${i + 1}. [${l.id}] confidence=${l.confidence.toFixed(2)}\n` +
            `   ${l.title}\n` +
            `   ${l.content.slice(0, 500)}${l.content.length > 500 ? "..." : ""}`,
        )
        .join("\n\n")
      return {
        title: `omo_recall: ${lessons.length} lesson${lessons.length === 1 ? "" : "s"}`,
        output:
          `Found ${lessons.length} past lesson${lessons.length === 1 ? "" : "s"} matching "${args.query}":\n\n${formatted}`,
        metadata: {
          tool: "omo_recall",
          query: args.query,
          durationMs: Date.now() - start,
          lessonsFound: lessons.length,
        },
      }
    },
  })
}

// ---------------------------------------------------------------------------
// omo_health — runtime status and metrics
// ---------------------------------------------------------------------------

export interface OmoHealthDeps {
  metrics: MetricsCollector
  logFilePath: string
  healthFilePath: string
}

/**
 * Build the `omo_health` tool. Lets the agent (and the user) see exactly
 * what the plugin is doing — closes the v0.10.0 "silent governance" complaint.
 */
export function buildOmoHealthTool(deps: OmoHealthDeps) {
  return tool({
    description:
      "Show omo-meta-governor plugin status: enabled, metrics, recent decisions, " +
      "and current config. Use when the user asks 'is the plugin working?' or to verify " +
      "that lessons are being persisted.",
    args: {},
    async execute(_args, _ctx): Promise<ToolResult> {
      const snap = deps.metrics.getMetrics()
      const decisionsDelivered = snap.counters.interventions_delivered?.count ?? 0
      const decisionsSkipped = (snap.counters.decisions_skipped_continue?.count ?? 0) +
        (snap.counters.decisions_skipped_no_decision?.count ?? 0) +
        (snap.counters.decisions_skipped_no_message?.count ?? 0) +
        (snap.counters.decisions_skipped_below_threshold?.count ?? 0)
      const lastDecision = snap.counters.decisions_taken?.lastOccurrenceISO
      const lastIntervention = snap.counters.interventions_delivered?.lastOccurrenceISO

      // Build the health snapshot and write to file
      const health: PluginHealth = {
        version: PLUGIN_VERSION,
        status: snap.counters.orchestrator_errors?.count ? "degraded" : "healthy",
        enabled: true,
        startedAtISO: snap.startedAtISO,
        uptimeMs: snap.uptimeMs,
        metrics: {
          decisionsTaken: snap.counters.decisions_taken?.count ?? 0,
          decisionsStored: snap.counters.decisions_stored?.count ?? 0,
          interventionsDelivered: decisionsDelivered,
          orchestratorRuns: snap.counters.orchestrator_runs?.count ?? 0,
          orchestratorErrors: snap.counters.orchestrator_errors?.count ?? 0,
          lastDecisionISO: lastDecision,
          lastInterventionISO: lastIntervention,
        },
        logFile: {
          path: deps.logFilePath,
          sizeBytes: 0, // computed by describeLogFile at write time
          rotatedFiles: 0,
        },
        session: {
          id: _ctx.sessionID,
          toolCallsObserved: snap.counters.orchestrator_runs?.count ?? 0,
          violationsDetected: snap.counters.protocol_violations_detected?.count ?? 0,
          interventionsSkipped: decisionsSkipped,
          firstSeenISO: snap.startedAtISO,
          lastSeenISO: new Date().toISOString(),
        },
      }
      try {
        writeHealthToFile(health, deps.healthFilePath)
      } catch {
        // best-effort
      }

      const output =
        `# omo-meta-governor v${PLUGIN_VERSION} — Health Report\n\n` +
        `**Status**: ${health.status}\n` +
        `**Enabled**: ${health.enabled}\n` +
        `**Uptime**: ${(health.uptimeMs / 1000).toFixed(1)}s\n` +
        `**Session**: ${health.session.id}\n\n` +
        `## Metrics (this session)\n` +
        `| Metric | Count | Last seen |\n` +
        `|--------|-------|-----------|\n` +
        `| Decisions taken | ${health.metrics.decisionsTaken} | ${lastDecision ?? "—"} |\n` +
        `| Decisions stored | ${health.metrics.decisionsStored} | — |\n` +
        `| Interventions delivered | ${decisionsDelivered} | ${lastIntervention ?? "—"} |\n` +
        `| Interventions skipped | ${decisionsSkipped} | — |\n` +
        `| Orchestrator runs | ${health.metrics.orchestratorRuns} | — |\n` +
        `| Orchestrator errors | ${health.metrics.orchestratorErrors} | — |\n` +
        `| Protocol violations | ${health.session.violationsDetected} | — |\n\n` +
        `## Files\n` +
        `- Health JSON: \`${deps.healthFilePath}\`\n` +
        `- Log file: \`${deps.logFilePath}\`\n\n` +
        `The health JSON file is updated on every invocation. Run \`cat ${deps.healthFilePath}\` to see the full snapshot.`
      return {
        title: "omo_health",
        output,
        metadata: {
          tool: "omo_health",
          sessionID: _ctx.sessionID,
          uptimeMs: health.uptimeMs,
        },
      }
    },
  })
}
// ---------------------------------------------------------------------------
// omo_find — find a symbol's definition and direct callers
// ---------------------------------------------------------------------------

export interface OmoFindDeps {
  codeGraph?: CodeGraphTools
  cwd: string
}

/**
 * Build the `omo_find` tool. Resolves a symbol to its source code location
 * and lists direct call sites. Uses `codegraph node <symbol>` (with
 * `graphify query <symbol>` as fallback when codegraph is unavailable).
 */
export function buildOmoFindTool(deps: OmoFindDeps) {
  return tool({
    description:
      "Find the exact source location and direct callers of a symbol (function, class, method, variable). " +
      "USE THIS when you know the exact symbol name and need its source code. " +
      "Example: omo_find with symbol='UserService.create' returns the file:line of the definition and every call site.",
    args: {
      symbol: z.string().min(1).describe("The exact symbol name to find (e.g. 'UserService.create', 'validateToken')"),
    },
    async execute(args, ctx): Promise<ToolResult> {
      const start = Date.now()
      const tools = deps.codeGraph ?? getDefaultCodeGraphTools()
      const result = await tools.find(args.symbol, deps.cwd, 5_000)
      const meta = {
        tool: "omo_find",
        symbol: args.symbol,
        kind: result.kind,
        found: result.found,
        callerCount: result.callers.length,
        durationMs: result.durationMs,
        sessionID: ctx.sessionID,
      }
      if (!result.found) {
        return {
          title: `omo_find: ${args.symbol} not found`,
          output:
            `Symbol "${args.symbol}" was not found in the codebase graph. ` +
            `If .codegraph/ doesn't exist, run \`npx codegraph init\` first. ` +
            `Otherwise, try omo_search with a natural-language description.`,
          metadata: meta,
        }
      }
      const sourceSection = result.source
        ? `\n## Definition\n\n\`\`\`\n${result.source.slice(0, 2000)}\n\`\`\`\n`
        : ""
      const callerSection =
        result.callers.length > 0
          ? `\n## Direct Callers (${result.callers.length})\n\n` +
            result.callers
              .slice(0, 30)
              .map((c: { file: string; line: number; context: string }) => `- ${c.file}:${c.line}${c.context ? ` — ${c.context}` : ""}`)
              .join("\n") +
            (result.callers.length > 30 ? `\n... and ${result.callers.length - 30} more` : "")
          : "\n## Direct Callers\n\nNone found in the indexed graph."
      return {
        title: `omo_find: ${args.symbol}${result.callers.length > 0 ? ` (${result.callers.length} callers)` : ""}`,
        output: `Found definition for "${args.symbol}" (via ${result.kind ?? "fallback"}).\n` + sourceSection + callerSection,
        metadata: meta,
      }
    },
  })
}

// ---------------------------------------------------------------------------
// omo_impact — analyze the impact of changing a symbol
// ---------------------------------------------------------------------------

export interface OmoImpactDeps {
  codeGraph?: CodeGraphTools
  cwd: string
}

/**
 * Build the `omo_impact` tool. Lists all call sites of a symbol plus
 * affected test and doc files. Uses `codegraph impact <symbol>` (falls
 * back to `codegraph callers` when impact is unavailable).
 */
export function buildOmoImpactTool(deps: OmoImpactDeps) {
  return tool({
    description:
      "Analyze the impact of changing a symbol. Lists direct callers, transitive callers, " +
      "and affected test/doc files. ALWAYS run this BEFORE modifying a function or class — " +
      "knows what will break. Example: omo_impact with symbol='validateToken' lists every file " +
      "that calls validateToken and every test that exercises it.",
    args: {
      symbol: z.string().min(1).describe("The symbol to analyze (function, class, method)"),
    },
    async execute(args, ctx): Promise<ToolResult> {
      const start = Date.now()
      const tools = deps.codeGraph ?? getDefaultCodeGraphTools()
      const result = await tools.impact(args.symbol, deps.cwd, 5_000)
      const meta = {
        tool: "omo_impact",
        symbol: args.symbol,
        kind: result.kind,
        directCallers: result.directCallers.length,
        transitiveCallers: result.transitiveCallers.length,
        testFiles: result.testFiles.length,
        docFiles: result.docFiles.length,
        totalAffectedFiles: result.totalAffectedFiles,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
        sessionID: ctx.sessionID,
      }
      if (result.totalAffectedFiles === 0 && result.directCallers.length === 0) {
        return {
          title: `omo_impact: no callers found for ${args.symbol}`,
          output:
            `No call sites found for "${args.symbol}". Either the symbol is unused, or the codegraph index is stale. ` +
            `Run \`npx codegraph sync\` to refresh the index and try again.`,
          metadata: meta,
        }
      }
      const lines: string[] = []
      lines.push(`Impact analysis for "${args.symbol}" (via ${result.kind ?? "fallback"}).\n`)
      lines.push(`## Summary`)
      lines.push(`- Direct callers: **${result.directCallers.length}**`)
      lines.push(`- Transitive callers: **${result.transitiveCallers.length}**`)
      lines.push(`- Test files affected: **${result.testFiles.length}**`)
      lines.push(`- Doc files affected: **${result.docFiles.length}**`)
      lines.push(`- Total affected files: **${result.totalAffectedFiles}**\n`)
      if (result.directCallers.length > 0) {
        lines.push(`## Direct Callers`)
        for (const c of result.directCallers.slice(0, 30)) {
          lines.push(`- ${c.file}:${c.line}${c.context ? ` — ${c.context}` : ""}`)
        }
        if (result.directCallers.length > 30) {
          lines.push(`- ... and ${result.directCallers.length - 30} more`)
        }
        lines.push("")
      }
      if (result.testFiles.length > 0) {
        lines.push(`## Test Files Affected`)
        for (const f of result.testFiles.slice(0, 20)) lines.push(`- ${f}`)
        lines.push("")
      }
      if (result.docFiles.length > 0) {
        lines.push(`## Doc Files Affected`)
        for (const f of result.docFiles.slice(0, 20)) lines.push(`- ${f}`)
        lines.push("")
      }
      if (result.timedOut) {
        lines.push(`⚠️ Analysis timed out — results may be incomplete. Try with a more specific symbol.`)
      }
      return {
        title: `omo_impact: ${args.symbol} (${result.totalAffectedFiles} files)`,
        output: lines.join("\n"),
        metadata: meta,
      }
    },
  })
}

// ===========================================================================
// Opción A pivot: tools that bridge to MCP servers via session.prompt()
// ===========================================================================
//
// Why these tools exist: the OpenCode SDK (1.17.4) does NOT expose a way
// to call MCP tools directly. client.tool only has ids() and list(), no
// invoke(). The only path to use AgentMemory / Magic Context from a plugin
// is through the LLM itself. So we create tools that send a structured
// message to the same session telling the LLM to call the right MCP tool
// with the right args. This is one LLM round-trip per "direct" call, but
// it works without SDK changes.
//
// Trade-off: latency (~1-2s per call) vs feasibility (it works).
//
// All 5 tools follow the same pattern:
//  1. Accept Zod-validated args from the LLM
//  2. Build an instruction message with the exact MCP tool + args
//  3. Call promptAgent() → session.prompt() to send the message
//  4. Return a friendly ToolResult telling the LLM what was dispatched
//  5. The LLM processes the message and calls the actual MCP tool
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// omo_remember — save to AgentMemory (via agentmemory_memory_save)
// ---------------------------------------------------------------------------

export interface OmoRememberDeps {
  /** The current sessionID (from ToolContext) */

}

/**
 * Build the `omo_remember` tool. Persists a fact/observation/lesson to
 * AgentMemory by instructing the LLM to call `agentmemory_memory_save`.
 */
export function buildOmoRememberTool(deps: OmoRememberDeps) {
  return tool({
    description:
      "Save a fact, observation, or insight to AgentMemory so it persists across sessions. " +
      "USE THIS when you learn something worth remembering: a bug pattern, a config quirk, " +
      "a user preference, a project rule. The system will route the save to AgentMemory's " +
      "MCP server. Example: omo_remember with content='Always use bun:sqlite, not better-sqlite3' " +
      "concepts=['storage', 'bun'] — the system will save this to AgentMemory.",
    args: {
      content: z.string().min(1).describe("The fact/observation/lesson to remember"),
      concepts: z.array(z.string()).optional().describe("Tags to categorize this memory (e.g. ['security', 'auth'])"),
      type: z.enum(["fact", "pattern", "observation"]).optional().describe("Type of memory: fact, pattern, or observation"),
    },
    async execute(args, ctx): Promise<ToolResult> {
      const sessionID = ctx.sessionID
      if (!hasSessionClient()) {
        return {
          title: "omo_remember: session not initialized",
          output: "Could not save to AgentMemory: the plugin has not captured the OpenCode session client. " +
            "Try restarting the plugin or check that the OpenCode session is running.",
          metadata: { tool: "omo_remember", ok: false },
        }
      }
      const mcpArgs = {
        content: args.content,
        concepts: args.concepts ?? [],
        type: args.type ?? "observation",
      }
      const result = await promptAgent(sessionID, {
        toolName: "omo_remember",
        mcpTool: "agentmemory_memory_save",
        mcpArgs,
        preamble: "Save this to AgentMemory (cross-session persistent memory).",
      })
      if (!result.ok) {
        return {
          title: "omo_remember: failed",
          output: `Failed to dispatch save to AgentMemory: ${result.error ?? "unknown error"}`,
          metadata: { tool: "omo_remember", ok: false, durationMs: result.durationMs },
        }
      }
      return {
        title: "omo_remember: dispatched",
        output:
          `Dispatched save to AgentMemory (messageID: ${result.messageID ?? "pending"}). ` +
          `The LLM will call agentmemory_memory_save with args: ${JSON.stringify(mcpArgs)}. ` +
          `It will be available in future sessions via agentmemory_memory_recall.`,
        metadata: {
          tool: "omo_remember",
          ok: true,
          messageID: result.messageID,
          durationMs: result.durationMs,
          contentLength: args.content.length,
        },
      }
    },
  })
}

// ---------------------------------------------------------------------------
// omo_recall_mcp — search AgentMemory (via agentmemory_memory_smart_search)
// ---------------------------------------------------------------------------

export interface OmoRecallMcpDeps {

}

/**
 * Build the `omo_recall_mcp` tool. Searches AgentMemory by sending a
 * query to the LLM that triggers `agentmemory_memory_smart_search`.
 *
 * Note: prefer `omo_recall` (which queries SQLite FTS5 locally) for fast
 * local recall. Use `omo_recall_mcp` when you specifically need to search
 * AgentMemory's persistent cross-session memory.
 */
export function buildOmoRecallMcpTool(deps: OmoRecallMcpDeps) {
  return tool({
    description:
      "Search AgentMemory's cross-session memory (via agentmemory_memory_smart_search). " +
      "USE THIS for questions that need context from PREVIOUS sessions: " +
      "'how did we set up X', 'what was the last approach to Y', 'recall the config for Z'. " +
      "For current-session recall, prefer omo_recall (local SQLite) instead.",
    args: {
      query: z.string().min(2).describe("The search query"),
      limit: z.number().int().min(1).max(20).optional().describe("Max results (default 5)"),
    },
    async execute(args, ctx): Promise<ToolResult> {
      const sessionID = ctx.sessionID
      if (!hasSessionClient()) {
        return {
          title: "omo_recall_mcp: session not initialized",
          output: "Could not search AgentMemory: session client not captured. " +
            "Use omo_recall for local session memory instead.",
          metadata: { tool: "omo_recall_mcp", ok: false },
        }
      }
      const mcpArgs = {
        query: args.query,
        limit: args.limit ?? 5,
      }
      const result = await promptAgent(sessionID, {
        toolName: "omo_recall_mcp",
        mcpTool: "agentmemory_memory_smart_search",
        mcpArgs,
        preamble: "Search AgentMemory for this query and report the results.",
      })
      if (!result.ok) {
        return {
          title: "omo_recall_mcp: failed",
          output: `Failed to dispatch search to AgentMemory: ${result.error ?? "unknown error"}`,
          metadata: { tool: "omo_recall_mcp", ok: false, durationMs: result.durationMs },
        }
      }
      return {
        title: "omo_recall_mcp: dispatched",
        output:
          `Dispatched search to AgentMemory (messageID: ${result.messageID ?? "pending"}). ` +
          `The LLM will call agentmemory_memory_smart_search with args: ${JSON.stringify(mcpArgs)}. ` +
          `Results will appear in the next assistant message.`,
        metadata: {
          tool: "omo_recall_mcp",
          ok: true,
          messageID: result.messageID,
          durationMs: result.durationMs,
          query: args.query,
        },
      }
    },
  })
}

// ---------------------------------------------------------------------------
// omo_rule — save a durable rule to Magic Context (via ctx_memory)
// ---------------------------------------------------------------------------

export interface OmoRuleDeps {

}

/**
 * Build the `omo_rule` tool. Saves a durable rule to Magic Context that
 * persists across sessions. Categorized by type (PROJECT_RULES, ARCHITECTURE,
 * CONSTRAINTS, CONFIG_VALUES, NAMING). Uses `ctx_memory(action="write")`.
 */
export function buildOmoRuleTool(deps: OmoRuleDeps) {
  return tool({
    description:
      "Save a durable rule to Magic Context (via ctx_memory). USE THIS for rules that must " +
      "persist across sessions: 'always use 2-space indent', 'API is in /api/v1', " +
      "'never commit to main'. The system will route the save to Magic Context's " +
      "MCP server. Example: omo_rule with category='PROJECT_RULES' content='Use bun:sqlite, not better-sqlite3' " +
      "— saved to ctx_memory, visible in future sessions.",
    args: {
      category: z.enum(["PROJECT_RULES", "ARCHITECTURE", "CONSTRAINTS", "CONFIG_VALUES", "NAMING"])
        .describe("Rule category — one of the 5 standard Magic Context categories"),
      content: z.string().min(1).describe("The rule to remember"),
    },
    async execute(args, ctx): Promise<ToolResult> {
      const sessionID = ctx.sessionID
      if (!hasSessionClient()) {
        return {
          title: "omo_rule: session not initialized",
          output: "Could not save rule: session client not captured.",
          metadata: { tool: "omo_rule", ok: false },
        }
      }
      const mcpArgs = {
        action: "write",
        category: args.category,
        content: args.content,
      }
      const result = await promptAgent(sessionID, {
        toolName: "omo_rule",
        mcpTool: "ctx_memory",
        mcpArgs,
        preamble: `Save this durable ${args.category} rule to Magic Context.`,
      })
      if (!result.ok) {
        return {
          title: "omo_rule: failed",
          output: `Failed to save rule: ${result.error ?? "unknown error"}`,
          metadata: { tool: "omo_rule", ok: false, durationMs: result.durationMs },
        }
      }
      return {
        title: "omo_rule: dispatched",
        output:
          `Dispatched rule save to Magic Context (messageID: ${result.messageID ?? "pending"}). ` +
          `Category: ${args.category}. The LLM will call ctx_memory with args: ${JSON.stringify(mcpArgs)}. ` +
          `This rule will be available in future sessions via ctx_memory(action="list").`,
        metadata: {
          tool: "omo_rule",
          ok: true,
          messageID: result.messageID,
          durationMs: result.durationMs,
          category: args.category,
        },
      }
    },
  })
}

// ---------------------------------------------------------------------------
// omo_history — search git history via Magic Context (via ctx_search)
// ---------------------------------------------------------------------------

export interface OmoHistoryDeps {

}

/**
 * Build the `omo_history` tool. Searches git commit history and prior
 * conversations via Magic Context. Uses `ctx_search` with sources=["git_commit", "message"].
 */
export function buildOmoHistoryTool(deps: OmoHistoryDeps) {
  return tool({
    description:
      "Search git commit history and prior messages via Magic Context. " +
      "USE THIS for questions about project history: 'when did we add X', " +
      "'what changed about Y', 'who committed Z', 'what was the last time we did W'. " +
      "The system will route the search to Magic Context's ctx_search MCP tool.",
    args: {
      query: z.string().min(2).describe("What to search for in git history and messages"),
      sources: z.array(z.enum(["git_commit", "message"])).optional()
        .describe("Which sources to search. Default: both."),
    },
    async execute(args, ctx): Promise<ToolResult> {
      const sessionID = ctx.sessionID
      if (!hasSessionClient()) {
        return {
          title: "omo_history: session not initialized",
          output: "Could not search history: session client not captured.",
          metadata: { tool: "omo_history", ok: false },
        }
      }
      const mcpArgs = {
        query: args.query,
        sources: args.sources ?? ["git_commit", "message"],
      }
      const result = await promptAgent(sessionID, {
        toolName: "omo_history",
        mcpTool: "ctx_search",
        mcpArgs,
        preamble: "Search project history (git commits + messages) for this query.",
      })
      if (!result.ok) {
        return {
          title: "omo_history: failed",
          output: `Failed to search history: ${result.error ?? "unknown error"}`,
          metadata: { tool: "omo_history", ok: false, durationMs: result.durationMs },
        }
      }
      return {
        title: "omo_history: dispatched",
        output:
          `Dispatched history search to Magic Context (messageID: ${result.messageID ?? "pending"}). ` +
          `Sources: ${(args.sources ?? ["git_commit", "message"]).join(", ")}. ` +
          `Results will appear in the next assistant message.`,
        metadata: {
          tool: "omo_history",
          ok: true,
          messageID: result.messageID,
          durationMs: result.durationMs,
          sources: mcpArgs.sources,
        },
      }
    },
  })
}

// ---------------------------------------------------------------------------
// omo_note — write an ephemeral note via Magic Context (via ctx_note)
// ---------------------------------------------------------------------------

export interface OmoNoteDeps {

}

/**
 * Build the `omo_note` tool. Writes a session-scoped working note via
 * Magic Context. Notes are for the current task only (ephemeral context).
 * Uses `ctx_note(action="write")`.
 */
export function buildOmoNoteTool(deps: OmoNoteDeps) {
  return tool({
    description:
      "Write a working note for the current session via Magic Context (ctx_note). " +
      "USE THIS for ephemeral context that helps the current task but doesn't need to " +
      "persist forever: 'debugging auth bug in module X', 'user prefers dark mode for this UI'. " +
      "For durable rules across sessions, use omo_rule instead.",
    args: {
      content: z.string().min(1).describe("The note content"),
      surfaceCondition: z.string().optional()
        .describe("Optional trigger condition (e.g. 'when working on auth') that automatically surfaces this note"),
    },
    async execute(args, ctx): Promise<ToolResult> {
      const sessionID = ctx.sessionID
      if (!hasSessionClient()) {
        return {
          title: "omo_note: session not initialized",
          output: "Could not write note: session client not captured.",
          metadata: { tool: "omo_note", ok: false },
        }
      }
      const mcpArgs: Record<string, unknown> = {
        action: "write",
        content: args.content,
      }
      if (args.surfaceCondition) {
        mcpArgs.surface_condition = args.surfaceCondition
      }
      const result = await promptAgent(sessionID, {
        toolName: "omo_note",
        mcpTool: "ctx_note",
        mcpArgs,
        preamble: "Write this working note to Magic Context for the current session.",
      })
      if (!result.ok) {
        return {
          title: "omo_note: failed",
          output: `Failed to write note: ${result.error ?? "unknown error"}`,
          metadata: { tool: "omo_note", ok: false, durationMs: result.durationMs },
        }
      }
      return {
        title: "omo_note: dispatched",
        output:
          `Dispatched note write to Magic Context (messageID: ${result.messageID ?? "pending"}). ` +
          `The LLM will call ctx_note with args: ${JSON.stringify(mcpArgs)}.`,
        metadata: {
          tool: "omo_note",
          ok: true,
          messageID: result.messageID,
          durationMs: result.durationMs,
          contentLength: args.content.length,
        },
      }
    },
  })
}


// ===========================================================================
// Graphify tools (v0.14.0): omo_path, omo_explain
// ===========================================================================

// ---------------------------------------------------------------------------
// omo_path — find shortest conceptual path between two concepts
// ---------------------------------------------------------------------------

export interface OmoPathDeps {
  cwd: string
}

/**
 * Build the `omo_path` tool. Finds shortest path between two concepts
 * in the graphify knowledge graph. Uses `graphify path <A> <B>`.
 */
export function buildOmoPathTool(deps: OmoPathDeps) {
  return tool({
    description:
      "Find the shortest conceptual path between two concepts in the codebase " +
      "using the graphify knowledge graph. USE THIS to understand how two apparently " +
      "unrelated parts of the codebase connect. Example: omo_path with from='auth' " +
      "to='database' traces the chain from authentication handlers to DB queries.",
    args: {
      from: z.string().min(1).describe("Start concept"),
      to: z.string().min(1).describe("End concept"),
    },
    async execute(args, ctx): Promise<ToolResult> {
      const start = Date.now()
      const retrieval = getDefaultGraphRetrieval()
      const result = await retrieval.invokePath(args.from, args.to, deps.cwd, { timeoutMs: 8_000 })
      return {
        title: result.kind === "graphify" ? "omo_path: path found" : "omo_path: unavailable",
        output: result.result ?? `No path found between "${args.from}" and "${args.to}". Check if graphify-out/ exists and is up to date.`,
        metadata: {
          tool: "omo_path",
          from: args.from,
          to: args.to,
          kind: result.kind,
          durationMs: Date.now() - start,
          sessionID: ctx ? ctx.sessionID : "unknown",
        },
      }
    },
  })
}

// ---------------------------------------------------------------------------
// omo_explain — plain-language explanation of a concept from the knowledge graph
// ---------------------------------------------------------------------------

export interface OmoExplainDeps {
  cwd: string
}

/**
 * Build the `omo_explain` tool. Provides a plain-language explanation of a
 * concept by querying the graphify knowledge graph. Uses `graphify explain <concept>`.
 */
export function buildOmoExplainTool(deps: OmoExplainDeps) {
  return tool({
    description:
      "Get a plain-language explanation of a concept from the graphify knowledge graph. " +
      "USE THIS when you encounter an unfamiliar term or module and need a quick overview " +
      "of what it is and how it fits into the codebase. Example: 'omo_explain SwinTransformer'.",
    args: {
      concept: z.string().min(1).describe("The concept to explain"),
    },
    async execute(args, ctx): Promise<ToolResult> {
      const start = Date.now()
      const retrieval = getDefaultGraphRetrieval()
      const result = await retrieval.invokeExplain(args.concept, deps.cwd, { timeoutMs: 8_000 })
      return {
        title: result.kind === "graphify" ? "omo_explain: done" : "omo_explain: unavailable",
        output: result.result ?? `Concept "${args.concept}" not found in the knowledge graph. Run \`graphify . --no-viz\` first.`,
        metadata: {
          tool: "omo_explain",
          concept: args.concept,
          kind: result.kind,
          durationMs: Date.now() - start,
          sessionID: ctx ? ctx.sessionID : "unknown",
        },
      }
    },
  })
}

// ===========================================================================
// AFT tools (v0.14.0): omo_outline, omo_undo, omo_checkpoint
// ===========================================================================

// ---------------------------------------------------------------------------
// omo_outline — structural outline of files
// ---------------------------------------------------------------------------

export interface OmoOutlineDeps {
  cwd: string
}

/**
 * Build the `omo_outline` tool. Returns the structural outline of a file
 * or directory using AFT. Falls back gracefully if AFT is not installed.
 */
export function buildOmoOutlineTool(deps: OmoOutlineDeps) {
  return tool({
    description:
      "Get the structural outline of a file or directory (functions, classes, types). " +
      "USE THIS before reading a file to understand its structure at a glance. " +
      "Example: omo_outline with target='src/services/' returns every function/class in that directory.",
    args: {
      target: z.string().min(1).describe("File or directory path to outline"),
    },
    async execute(args, ctx): Promise<ToolResult> {
      const start = Date.now()
      const retrieval = getDefaultGraphRetrieval()
      const result = await retrieval.invokeAFTOutline(args.target, { timeoutMs: 8_000 })
      const output = result.result
        ? `## AFT Outline: ${args.target}\n\n${result.result.slice(0, 3000)}`
        : `AFT outline unavailable for "${args.target}". AFT may not be installed or the path doesn't exist.`
      return {
        title: result.result ? "omo_outline: done" : "omo_outline: unavailable",
        output,
        metadata: { tool: "omo_outline", target: args.target, timedOut: result.timedOut, durationMs: Date.now() - start, sessionID: ctx ? ctx.sessionID : "unknown" },
      }
    },
  })
}

// ---------------------------------------------------------------------------
// omo_checkpoint — create a named AFT checkpoint
// ---------------------------------------------------------------------------

export type OmoCheckpointDeps = Record<string, never>

/**
 * Build the `omo_checkpoint` tool. Creates a named AFT checkpoint so the
 * user can revert to a known good state. Uses `aft safety checkpoint --name <name>`.
 */
export function buildOmoCheckpointTool(_deps: OmoCheckpointDeps) {
  return tool({
    description:
      "Create a named AFT checkpoint (snapshot of tracked files). USE THIS before making " +
      "risky changes so you can revert if things go wrong. Example: omo_checkpoint with " +
      "name='before-refactor-auth' saves the current state for later recovery via omo_undo.",
    args: {
      name: z.string().min(1).describe("A descriptive name for the checkpoint (e.g. 'before-refactor-auth')"),
    },
    async execute(args, ctx): Promise<ToolResult> {
      const start = Date.now()
      const retrieval = getDefaultGraphRetrieval()
      const result = await retrieval.invokeAFTCheckpoint(args.name, { timeoutMs: 8_000 })
      return {
        title: result.result ? "omo_checkpoint: done" : "omo_checkpoint: failed",
        output: result.result ?? `Checkpoint "${args.name}" was NOT created. AFT may not be installed.`,
        metadata: { tool: "omo_checkpoint", name: args.name, kind: result.kind, timedOut: result.timedOut, durationMs: Date.now() - start, sessionID: ctx ? ctx.sessionID : "unknown" },
      }
    },
  })
}

// ---------------------------------------------------------------------------
// omo_undo — revert to most recent AFT checkpoint
// ---------------------------------------------------------------------------

export type OmoUndoDeps = Record<string, never>

/**
 * Build the `omo_undo` tool. Reverts tracked files to the most recent AFT
 * checkpoint. Uses `aft safety undo`.
 */
export function buildOmoUndoTool(_deps: OmoUndoDeps) {
  return tool({
    description:
      "Revert tracked files to the most recent AFT checkpoint. USE THIS after a risky " +
      "change went wrong — it restores the state saved by the last omo_checkpoint. " +
      "If there's no checkpoint, nothing happens.",
    args: {},
    async execute(_args, ctx): Promise<ToolResult> {
      const start = Date.now()
      const retrieval = getDefaultGraphRetrieval()
      const result = await retrieval.invokeAFTUndo({ timeoutMs: 8_000 })
      return {
        title: result.result ? "omo_undo: done" : "omo_undo: failed",
        output: result.result ?? "Undo failed. AFT may not be installed or there is no checkpoint to restore.",
        metadata: { tool: "omo_undo", kind: result.kind, timedOut: result.timedOut, durationMs: Date.now() - start, sessionID: ctx ? ctx.sessionID : "unknown" },
      }
    },
  })
}

