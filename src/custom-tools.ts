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
import { buildPluginHealth, writeHealthToFile } from "./health"
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

// v0.30.0: MCP-first helper — try the MCP server before falling back to subprocess.
async function tryMcpFirst(
  serverName: string,
  toolID: string,
  args: Record<string, unknown>,
  timeoutMs: number,
): Promise<string | null> {
  try {
    const retrieval = getDefaultGraphRetrieval()
    if (!(await retrieval.isMcpServerAvailable(serverName, toolID))) return null
    const result = await retrieval.invokeMCP(serverName, toolID, args, { timeoutMs, queryLabel: toolID })
    return result.result
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// omo_search — semantic code search via codegraph/graphify
// ---------------------------------------------------------------------------


// ─── v0.17.0 (F3.6): bridge tool delivery verification ──────────────

/**
 * Brief async poll for delivery verification. When the LLM calls the MCP
 * tool within the window, returns "delivered". Otherwise "expired".
 *
 * The actual polling lives in the registry (set by the plugin's
 * tool.execute.after hook). Here we just check after a short wait.
 */
/**
 * v0.17.3: Return type widened to "delivered" | "pending" | "expired".
 * Previously this collapsed "expired" to "pending" silently, which
 * meant bridge tools could never surface the "TTL elapsed without
 * delivery" state (Gap I fix was cosmetic in v0.17.2).
 */
async function pollForDelivery(
  sessionID: string,
  mcpTool: string,
  timeoutMs: number = 1500,
): Promise<"delivered" | "pending" | "expired"> {
  if (!pendingRegistryRef) return "pending"
  return await pendingRegistryRef.awaitDelivery({
    sessionID,
    mcpTool,
    timeoutMs,
  })
}

/**
 * Module-level reference to the PendingDeliveryRegistry. The plugin
 * factory sets this once at startup. Bridge tools call it via
 * onDispatch and pollForDelivery.
 */
let pendingRegistryRef: {
  register(input: { sessionID: string; mcpTool: string; mcpArgs: Record<string, unknown>; ttlMs?: number }): string
  awaitDelivery(input: { sessionID: string; mcpTool: string; timeoutMs?: number }): Promise<"delivered" | "expired">
} | null = null

/**
 * Called by the plugin factory at startup to inject the delivery registry.
 * Exposed as a setter so we don't need to thread it through every tool deps.
 */
export function setPendingDeliveryRegistry(registry: typeof pendingRegistryRef): void {
  pendingRegistryRef = registry
}

/**
 * v0.17.2 (Gap I): Updated return type to include "expired" so the bridge
 * tools can distinguish between "LLM hasn't called yet" (pending) and
 * "TTL elapsed without delivery" (expired).
 *
 * Returns "delivered" if the LLM's MCP tool call was observed within the
 * timeout, "expired" if the pending entry's TTL elapsed without delivery,
 * "pending" otherwise (poll still active, no result yet).
 */
export async function verifyDelivery(
  sessionID: string,
  mcpTool: string,
): Promise<"delivered" | "pending" | "expired"> {
  return await pollForDelivery(sessionID, mcpTool)
}


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
      "Semantic code search over the project graph. ROUTING (v0.25.0): with both indexes present, " +
      "codegraph handles code-structure queries (symbols, call sites, module layout) and graphify " +
      "handles concept/architecture queries — the plugin alternates deterministically per query, " +
      "or you can force one via config graphRetrieval.preferredTool. " +
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
      // v0.31.3: shared composer — identical schema as plugin-side writes.
      const health = buildPluginHealth({
        version: PLUGIN_VERSION,
        enabled: true,
        sessionID: _ctx.sessionID ?? "__unknown__",
        snapshot: snap,
        logFilePath: deps.logFilePath,
      })
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
        `| Decisions taken | ${health.metrics.decisionsTaken} | ${health.metrics.lastDecisionISO ?? "—"} |\n` +
        `| Decisions stored | ${health.metrics.decisionsStored} | — |\n` +
        `| Interventions delivered | ${health.metrics.interventionsDelivered} | ${health.metrics.lastInterventionISO ?? "—"} |\n` +
        `| Interventions skipped | ${health.session.interventionsSkipped} | — |\n` +
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
      "CODEGRAPH TOOL (v0.25.0): symbol precision lives in codegraph — use this for exact definitions " +
      "and call sites. " +
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
      "and affected test/doc files. CODEGRAPH TOOL (v0.25.0): call-graph analysis is codegraph-only. " +
      "ALWAYS run this BEFORE modifying a function or class — " +
      "knows what will break. Example: omo_impact with symbol='validateToken' lists every file " +
      "that calls validateToken and every test that exercises it.",
    args: {
      symbol: z.string().min(1).describe("The symbol to analyze (function, class, method)"),
    },
    async execute(args, ctx): Promise<ToolResult> {
      const start = Date.now()
      // v0.30.0: MCP-first transport
      const mcpOutput = await tryMcpFirst("codegraph", "codegraph_impact", { symbol: args.symbol, depth: 2, projectPath: deps.cwd }, 5_000)
      if (mcpOutput !== null) {
        return {
          title: `omo_impact: ${args.symbol}`,
          output: mcpOutput,
          metadata: {
            tool: "omo_impact",
            symbol: args.symbol,
            kind: "codegraph",
            transport: "mcp",
            durationMs: Date.now() - start,
            sessionID: ctx.sessionID,
          },
        }
      }
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
// invoke(). The only path to use AgentMemory from a plugin
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
  /** Optional callback invoked after a successful prompt dispatch.
   *  Used by the plugin to register the pending delivery in the registry
   *  so the bridge tool can verify the LLM actually called the MCP tool. */
  onDispatch?: (input: { sessionID: string; mcpTool: string; mcpArgs: Record<string, unknown> }) => void
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
      // v0.17.0 (F3.6): register pending delivery + briefly poll for actual
      // MCP tool call. Fast deliveries are detected within ~1.5s.
      deps.onDispatch?.({ sessionID, mcpTool: "agentmemory_memory_save", mcpArgs })
      const deliveryStatus = await verifyDelivery(sessionID, "agentmemory_memory_save")
      const titleSuffix = deliveryStatus
      return {
        title: `omo_remember: ${titleSuffix}`,
        output:
          `Save to AgentMemory ${deliveryStatus === "delivered" ? "verified" : deliveryStatus === "expired" ? "not delivered within TTL" : "dispatched"} ` +
          `(messageID: ${result.messageID ?? "pending"}). ` +
          `LLM call to agentmemory_memory_save ${deliveryStatus === "delivered" ? "was observed" : "not yet observed (will happen on next turn)"} ` +
          `with args: ${JSON.stringify(mcpArgs)}. ` +
          `It will be available in future sessions via agentmemory_memory_recall.`,
        metadata: {
          tool: "omo_remember",
          ok: true,
          messageID: result.messageID,
          durationMs: result.durationMs,
          contentLength: args.content.length,
          deliveryStatus,
        },
      }
    },
  })
}

// ---------------------------------------------------------------------------
// omo_recall_mcp — search AgentMemory (via agentmemory_memory_smart_search)
// ---------------------------------------------------------------------------

export interface OmoRecallMcpDeps {
  /** Optional callback invoked after a successful prompt dispatch.
   *  Used by the plugin to register the pending delivery in the registry
   *  so the bridge tool can verify the LLM actually called the MCP tool. */
  onDispatch?: (input: { sessionID: string; mcpTool: string; mcpArgs: Record<string, unknown> }) => void
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
      deps.onDispatch?.({ sessionID, mcpTool: "agentmemory_memory_smart_search", mcpArgs })
      const deliveryStatus = await verifyDelivery(sessionID, "agentmemory_memory_smart_search")
      return {
        title: `omo_recall_mcp: ${deliveryStatus}`,
        output:
          `Search to AgentMemory ${deliveryStatus === "delivered" ? "verified" : "dispatched"} ` +
          `(messageID: ${result.messageID ?? "pending"}). ` +
          `LLM call to agentmemory_memory_smart_search ${deliveryStatus === "delivered" ? "was observed" : "not yet observed (will happen on next turn)"} ` +
          `with args: ${JSON.stringify(mcpArgs)}. ` +
          `Results will appear in the next assistant message.`,
        metadata: {
          tool: "omo_recall_mcp",
          ok: true,
          messageID: result.messageID,
          durationMs: result.durationMs,
          query: args.query,
          deliveryStatus,
        },
      }
    },
  })
}

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
      "using the graphify knowledge graph. GRAPHIFY TOOL (v0.25.0): concept-level relations live in graphify — " +
      "codegraph cannot answer these. " +
      "USE THIS to understand how two apparently " +
      "unrelated parts of the codebase connect. Example: omo_path with from='auth' " +
      "to='database' traces the chain from authentication handlers to DB queries.",
    args: {
      from: z.string().min(1).describe("Start concept"),
      to: z.string().min(1).describe("End concept"),
    },
    async execute(args, ctx): Promise<ToolResult> {
      const start = Date.now()
      // v0.30.0: MCP-first transport
      const mcpOutput = await tryMcpFirst("graphify", "shortest_path", { source: args.from, target: args.to, project_path: deps.cwd }, 8_000)
      if (mcpOutput !== null) {
        return {
          title: "omo_path: path found",
          output: mcpOutput,
          metadata: {
            tool: "omo_path",
            from: args.from,
            to: args.to,
            kind: "graphify",
            transport: "mcp",
            durationMs: Date.now() - start,
            sessionID: ctx ? ctx.sessionID : "unknown",
          },
        }
      }
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
      "GRAPHIFY TOOL (v0.25.0): conceptual overviews live in graphify — codegraph cannot produce them. " +
      "USE THIS when you encounter an unfamiliar term or module and need a quick overview " +
      "of what it is and how it fits into the codebase. Example: 'omo_explain SwinTransformer'.",
    args: {
      concept: z.string().min(1).describe("The concept to explain"),
    },
    async execute(args, ctx): Promise<ToolResult> {
      const start = Date.now()
      // v0.30.0: MCP-first transport
      const mcpOutput = await tryMcpFirst("graphify", "get_node", { label: args.concept, project_path: deps.cwd }, 8_000)
      if (mcpOutput !== null) {
        return {
          title: "omo_explain: done",
          output: mcpOutput,
          metadata: {
            tool: "omo_explain",
            concept: args.concept,
            kind: "graphify",
            transport: "mcp",
            durationMs: Date.now() - start,
            sessionID: ctx ? ctx.sessionID : "unknown",
          },
        }
      }
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

// ---------------------------------------------------------------------------
// omo_files — list indexed files (.codegraph or graphify-out)
// ---------------------------------------------------------------------------

export interface OmoFilesDeps {
  /** Optional pre-configured GraphRetrieval. Defaults to getDefaultGraphRetrieval(). */
  graphRetrieval?: GraphRetrieval
  cwd: string
}

/**
 * Build the `omo_files` tool. Lists files indexed by codegraph or graphify.
 * Uses `codegraph files --project-path <cwd>` (falls back to graphify's
 * graphify-out/wiki/index.md when codegraph is unavailable).
 */
export function buildOmoFilesTool(deps: OmoFilesDeps) {
  return tool({
    description:
      "List files indexed by the codebase graph (codegraph or graphify). " +
      "USAGE: returns a list of indexed file paths. Use this when you need to " +
      "discover which files are in the graph before drilling into a specific one.",
    args: {},
    async execute(args, ctx): Promise<ToolResult> {
      const start = Date.now()
      // v0.30.0: MCP-first transport
      const mcpOutput = await tryMcpFirst("codegraph", "codegraph_files", { projectPath: deps.cwd }, 5_000)
      if (mcpOutput !== null) {
        return {
          title: `omo_files: codegraph backend`,
          output: mcpOutput,
          metadata: {
            tool: "omo_files",
            kind: "codegraph",
            transport: "mcp",
            durationMs: Date.now() - start,
            sessionID: ctx.sessionID,
          },
        }
      }
      const retrieval = deps.graphRetrieval ?? getDefaultGraphRetrieval()
      const result = await retrieval.invokeFiles(deps.cwd, { timeoutMs: 5_000 })
      if (!result.result) {
        return {
          title: "omo_files: no index",
          output:
            "No indexed files found. If `.codegraph/` doesn't exist, run `npx codegraph init` first. " +
            "If `graphify-out/` doesn't exist, run `graphify . --no-viz` first.",
          metadata: {
            tool: "omo_files",
            kind: result.kind,
            durationMs: Date.now() - start,
            sessionID: ctx.sessionID,
          },
        }
      }
      return {
        title: `omo_files: ${result.kind ?? "unknown"} backend`,
        output: result.result,
        metadata: {
          tool: "omo_files",
          kind: result.kind,
          durationMs: Date.now() - start,
          sessionID: ctx.sessionID,
        },
      }
    },
  })
}

// ---------------------------------------------------------------------------
// omo_callers — list call sites of a symbol
// ---------------------------------------------------------------------------

export interface OmoCallersDeps {
  graphRetrieval?: GraphRetrieval
  cwd: string
}

/**
 * Build the `omo_callers` tool. Lists all call sites of a symbol.
 * Uses `codegraph callers <symbol> --project-path <cwd>`. Returns null
 * when codegraph is unavailable (codegraph-specific subcommand).
 */
export function buildOmoCallersTool(deps: OmoCallersDeps) {
  return tool({
    description:
      "List all call sites of a symbol in the codebase graph. " +
      "USAGE: omo_callers with symbol='UserService.create' returns every file:line " +
      "where that symbol is called. Codegraph-only — returns null if .codegraph/ is missing.",
    args: {
      symbol: z.string().min(1).describe("The symbol to find callers for (function, class, method, variable)"),
    },
    async execute(args, ctx): Promise<ToolResult> {
      const start = Date.now()
      // v0.30.0: MCP-first transport
      const mcpOutput = await tryMcpFirst("codegraph", "codegraph_callers", { symbol: args.symbol, projectPath: deps.cwd }, 5_000)
      if (mcpOutput !== null) {
        return {
          title: `omo_callers: ${args.symbol}`,
          output: mcpOutput,
          metadata: {
            tool: "omo_callers",
            symbol: args.symbol,
            kind: "codegraph",
            transport: "mcp",
            durationMs: Date.now() - start,
            sessionID: ctx.sessionID,
          },
        }
      }
      const retrieval = deps.graphRetrieval ?? getDefaultGraphRetrieval()
      const result = await retrieval.invokeCallers(args.symbol, deps.cwd, { timeoutMs: 5_000 })
      if (!result.result) {
        return {
          title: `omo_callers: ${args.symbol} (no callers or no codegraph)`,
          output:
            `No call sites found for "${args.symbol}". Either the symbol is unused, or ` +
            `codegraph is not installed / has no index. Run \`npx codegraph init\` to create the index.`,
          metadata: {
            tool: "omo_callers",
            symbol: args.symbol,
            kind: result.kind,
            durationMs: Date.now() - start,
            sessionID: ctx.sessionID,
          },
        }
      }
      return {
        title: `omo_callers: ${args.symbol}`,
        output: result.result,
        metadata: {
          tool: "omo_callers",
          symbol: args.symbol,
          kind: result.kind,
          durationMs: Date.now() - start,
          sessionID: ctx.sessionID,
        },
      }
    },
  })
}

// ---------------------------------------------------------------------------
// omo_node — get source code + direct callers of a symbol
// ---------------------------------------------------------------------------

export interface OmoNodeDeps {
  graphRetrieval?: GraphRetrieval
  cwd: string
}

/**
 * Build the `omo_node` tool. Returns the source code of a symbol and its
 * direct callers. Uses `codegraph node <symbol> --project-path <cwd>`.
 * Returns null when codegraph is unavailable.
 */
export function buildOmoNodeTool(deps: OmoNodeDeps) {
  return tool({
    description:
      "Get the source code of a symbol (function/class/method/variable) and its direct callers. " +
      "USAGE: omo_node with symbol='UserService.create' returns the symbol's definition and " +
      "every direct call site. Distinct from omo_find (which only returns a definition summary) — " +
      "this tool returns the full source body. Codegraph-only.",
    args: {
      symbol: z.string().min(1).describe("The symbol to resolve (function, class, method, variable)"),
    },
    async execute(args, ctx): Promise<ToolResult> {
      const start = Date.now()
      // v0.30.0: MCP-first transport
      const mcpOutput = await tryMcpFirst("codegraph", "codegraph_node", { symbol: args.symbol, projectPath: deps.cwd }, 5_000)
      if (mcpOutput !== null) {
        return {
          title: `omo_node: ${args.symbol}`,
          output: mcpOutput,
          metadata: {
            tool: "omo_node",
            symbol: args.symbol,
            kind: "codegraph",
            transport: "mcp",
            durationMs: Date.now() - start,
            sessionID: ctx.sessionID,
          },
        }
      }
      const retrieval = deps.graphRetrieval ?? getDefaultGraphRetrieval()
      const result = await retrieval.invokeNode(args.symbol, deps.cwd, { timeoutMs: 5_000 })
      if (!result.result) {
        return {
          title: `omo_node: ${args.symbol} not found`,
          output:
            `Symbol "${args.symbol}" was not found in the codegraph index. ` +
            `Run \`npx codegraph init\` if the index doesn't exist, or \`npx codegraph sync\` to refresh.`,
          metadata: {
            tool: "omo_node",
            symbol: args.symbol,
            kind: result.kind,
            durationMs: Date.now() - start,
            sessionID: ctx.sessionID,
          },
        }
      }
      return {
        title: `omo_node: ${args.symbol}`,
        output: result.result,
        metadata: {
          tool: "omo_node",
          symbol: args.symbol,
          kind: result.kind,
          durationMs: Date.now() - start,
          sessionID: ctx.sessionID,
        },
      }
    },
  })
}


// ============================================================================
// v0.27.0: Wave 3 P2 — extended graph tool wrappers (omo_context, omo_affected,
// omo_status, omo_unlock, omo_mark_dirty, omo_sync_if_dirty, omo_index,
// omo_visualize, omo_serve, omo_uninit, omo_diagnose, omo_merge_graphs,
// omo_save_result, omo_extract, omo_cluster_only, omo_label, omo_tree,
// omo_clone, omo_add, omo_check_update, omo_hook_status)
// ============================================================================

export interface OmoGraphToolDeps {
  graphRetrieval?: GraphRetrieval
  cwd: string
}

function graphResultToTool(
  toolName: string,
  meta: Record<string, unknown>,
  result: { result: string | null; kind: string | null; durationMs: number },
  start: number,
  ctx: ToolContext,
  friendlyHint: string,
): ToolResult {
  const durationMs = Date.now() - start
  if (!result.result) {
    return {
      title: `${toolName}: no result`,
      output: friendlyHint,
      metadata: { tool: toolName, kind: result.kind, durationMs, sessionID: ctx.sessionID, ...meta },
    }
  }
  return {
    title: toolName,
    output: result.result,
    metadata: { tool: toolName, kind: result.kind, durationMs, sessionID: ctx.sessionID, ...meta },
  }
}

// -------- codegraph: context --------

/** `codegraph context <task>` — task-focused code context window. */
export function buildOmoContextTool(deps: OmoGraphToolDeps) {
  return tool({
    description:
      "Get a focused code context window for a given task. " +
      "USAGE: omo_context with task='validate JWT tokens' returns relevant code blocks (file paths + line ranges). " +
      "Codegraph-only — returns null if .codegraph/ is missing.",
    args: {
      task: z.string().min(1).describe("The task to extract context for"),
    },
    async execute(args, ctx): Promise<ToolResult> {
      const start = Date.now()
      // v0.30.0: MCP-first transport
      const mcpOutput = await tryMcpFirst("codegraph", "codegraph_context", { task: args.task, maxNodes: 20, projectPath: deps.cwd }, 5_000)
      if (mcpOutput !== null) {
        return {
          title: "omo_context",
          output: mcpOutput,
          metadata: {
            tool: "omo_context",
            task: args.task,
            kind: "codegraph",
            transport: "mcp",
            durationMs: Date.now() - start,
            sessionID: ctx.sessionID,
          },
        }
      }
      const retrieval = deps.graphRetrieval ?? getDefaultGraphRetrieval()
      const result = await retrieval.invokeContext(args.task, deps.cwd, { timeoutMs: 5_000 })
      return graphResultToTool(
        "omo_context",
        { task: args.task },
        { ...result, durationMs: Date.now() - start },
        start,
        ctx,
        `No context for task "${args.task}". Run \`npx codegraph init\` if the index doesn't exist.`,
      )
    },
  })
}

// -------- codegraph: affected --------

/** `codegraph affected <files>` — files affected by changes in the given files. */
export function buildOmoAffectedCgTool(deps: OmoGraphToolDeps) {
  return tool({
    description:
      "List files affected by changes in the given source files. " +
      "USAGE: omo_affected_cg with files=['src/auth.ts'] returns the set of test files, callers, and dependent modules. " +
      "Codegraph-only.",
    args: {
      files: z.array(z.string().min(1)).min(1).describe("Source file paths to analyze (relative to cwd)"),
    },
    async execute(args, ctx): Promise<ToolResult> {
      const start = Date.now()
      const retrieval = deps.graphRetrieval ?? getDefaultGraphRetrieval()
      const result = await retrieval.invokeAffected(args.files, deps.cwd, { timeoutMs: 5_000 })
      return graphResultToTool(
        "omo_affected_cg",
        { files: args.files.join(",") },
        { ...result, durationMs: Date.now() - start },
        start,
        ctx,
        `Could not compute affected files for [${args.files.join(", ")}]. Run \`npx codegraph init\` if needed.`,
      )
    },
  })
}

// -------- codegraph: status --------

/** `codegraph status` — codegraph health (node count, version, last update). */
export function buildOmoStatusTool(deps: OmoGraphToolDeps) {
  return tool({
    description:
      "Show codegraph health: node count, version, last update timestamp. " +
      "USAGE: omo_status returns a multi-line report. Codegraph-only.",
    args: {},
    async execute(_args, ctx): Promise<ToolResult> {
      const start = Date.now()
      // v0.30.0: MCP-first transport
      const mcpOutput = await tryMcpFirst("codegraph", "codegraph_status", { projectPath: deps.cwd }, 5_000)
      if (mcpOutput !== null) {
        return {
          title: "omo_status",
          output: mcpOutput,
          metadata: {
            tool: "omo_status",
            kind: "codegraph",
            transport: "mcp",
            durationMs: Date.now() - start,
            sessionID: ctx.sessionID,
          },
        }
      }
      const retrieval = deps.graphRetrieval ?? getDefaultGraphRetrieval()
      const result = await retrieval.invokeStatus(deps.cwd, { timeoutMs: 5_000 })
      return graphResultToTool(
        "omo_status",
        {},
        { ...result, durationMs: Date.now() - start },
        start,
        ctx,
        `codegraph is not installed or has no index. Run \`npx codegraph init\` to create one.`,
      )
    },
  })
}

// -------- codegraph: unlock --------

/** `codegraph unlock` — remove stale lock file. */
export function buildOmoUnlockTool(deps: OmoGraphToolDeps) {
  return tool({
    description:
      "Remove a stale codegraph lock file (left behind after a crash). " +
      "USAGE: omo_unlock clears the lock so the next sync can run. Codegraph-only.",
    args: {},
    async execute(_args, ctx): Promise<ToolResult> {
      const start = Date.now()
      const retrieval = deps.graphRetrieval ?? getDefaultGraphRetrieval()
      const result = await retrieval.invokeUnlock(deps.cwd, { timeoutMs: 5_000 })
      return graphResultToTool(
        "omo_unlock",
        {},
        { ...result, durationMs: Date.now() - start },
        start,
        ctx,
        `codegraph is not installed.`,
      )
    },
  })
}

// -------- codegraph: mark-dirty --------

/** `codegraph mark-dirty` — mark the graph as needing a re-sync. */
export function buildOmoMarkDirtyTool(deps: OmoGraphToolDeps) {
  return tool({
    description:
      "Mark the codegraph index as dirty so the next sync re-extracts. " +
      "USAGE: omo_mark_dirty when you know source files changed without git hooks firing.",
    args: {},
    async execute(_args, ctx): Promise<ToolResult> {
      const start = Date.now()
      const retrieval = deps.graphRetrieval ?? getDefaultGraphRetrieval()
      const result = await retrieval.invokeMarkDirty(deps.cwd, { timeoutMs: 5_000 })
      return graphResultToTool(
        "omo_mark_dirty",
        {},
        { ...result, durationMs: Date.now() - start },
        start,
        ctx,
        `codegraph is not installed.`,
      )
    },
  })
}

// -------- codegraph: sync-if-dirty --------

/** `codegraph sync-if-dirty` — sync only if the graph was marked dirty. */
export function buildOmoSyncIfDirtyTool(deps: OmoGraphToolDeps) {
  return tool({
    description:
      "Trigger a codegraph sync ONLY if the graph was previously marked dirty. " +
      "USAGE: omo_sync_if_dirty is a cheap daily check; omo_status shows the dirty flag.",
    args: {},
    async execute(_args, ctx): Promise<ToolResult> {
      const start = Date.now()
      const retrieval = deps.graphRetrieval ?? getDefaultGraphRetrieval()
      const result = await retrieval.invokeSyncIfDirty(deps.cwd, { timeoutMs: 30_000 })
      return graphResultToTool(
        "omo_sync_if_dirty",
        {},
        { ...result, durationMs: Date.now() - start },
        start,
        ctx,
        `codegraph is not installed or no index exists.`,
      )
    },
  })
}

// -------- codegraph: index --------

/** `codegraph index` — manual full index trigger. */
export function buildOmoIndexTool(deps: OmoGraphToolDeps) {
  return tool({
    description:
      "Manually trigger a full codegraph reindex. " +
      "USAGE: omo_index when you want a guaranteed-fresh graph (bypasses the dirty-flag check).",
    args: {},
    async execute(_args, ctx): Promise<ToolResult> {
      const start = Date.now()
      const retrieval = deps.graphRetrieval ?? getDefaultGraphRetrieval()
      const result = await retrieval.invokeIndex(deps.cwd, { timeoutMs: 60_000 })
      return graphResultToTool(
        "omo_index",
        {},
        { ...result, durationMs: Date.now() - start },
        start,
        ctx,
        `codegraph is not installed. Run \`npm i -D @colbymchenry/codegraph\` first.`,
      )
    },
  })
}

// -------- codegraph: visualize --------

/** `codegraph visualize` — generate visualization HTML. */
export function buildOmoVisualizeTool(deps: OmoGraphToolDeps) {
  return tool({
    description:
      "Generate an HTML visualization of the codegraph. " +
      "USAGE: omo_visualize returns the path to the generated HTML file.",
    args: {},
    async execute(_args, ctx): Promise<ToolResult> {
      const start = Date.now()
      const retrieval = deps.graphRetrieval ?? getDefaultGraphRetrieval()
      const result = await retrieval.invokeVisualize(deps.cwd, { timeoutMs: 30_000 })
      return graphResultToTool(
        "omo_visualize",
        {},
        { ...result, durationMs: Date.now() - start },
        start,
        ctx,
        `codegraph is not installed.`,
      )
    },
  })
}

// -------- codegraph: serve --------

/** `codegraph serve --port <n>` — start the codegraph server. */
export function buildOmoServeTool(deps: OmoGraphToolDeps) {
  return tool({
    description:
      "Start the codegraph HTTP server on the given port. " +
      "USAGE: omo_serve with port=3030 starts the server in the background. Returns the port + status.",
    args: {
      port: z.number().int().min(1).max(65535).describe("TCP port to bind the codegraph server to"),
    },
    async execute(args, ctx): Promise<ToolResult> {
      const start = Date.now()
      const retrieval = deps.graphRetrieval ?? getDefaultGraphRetrieval()
      const result = await retrieval.invokeServe(args.port, deps.cwd, { timeoutMs: 5_000 })
      return graphResultToTool(
        "omo_serve",
        { port: args.port },
        { ...result, durationMs: Date.now() - start },
        start,
        ctx,
        `codegraph is not installed. Run \`npm i -D @colbymchenry/codegraph\` first.`,
      )
    },
  })
}

// -------- codegraph: uninit --------

/** `codegraph uninit` — remove the codegraph index from disk. */
export function buildOmoUninitTool(deps: OmoGraphToolDeps) {
  return tool({
    description:
      "Remove the codegraph index (.codegraph/) from disk. " +
      "USAGE: omo_uninit when you want a clean slate — next sync will rebuild from scratch.",
    args: {},
    async execute(_args, ctx): Promise<ToolResult> {
      const start = Date.now()
      const retrieval = deps.graphRetrieval ?? getDefaultGraphRetrieval()
      const result = await retrieval.invokeUninit(deps.cwd, { timeoutMs: 5_000 })
      return graphResultToTool(
        "omo_uninit",
        {},
        { ...result, durationMs: Date.now() - start },
        start,
        ctx,
        `codegraph is not installed.`,
      )
    },
  })
}

// -------- graphify: diagnose --------

/** `graphify diagnose` — find multigraph warnings and inconsistencies. */
export function buildOmoDiagnoseTool(deps: OmoGraphToolDeps) {
  return tool({
    description:
      "Diagnose the graphify graph for inconsistencies, multigraph warnings, and stale nodes. " +
      "USAGE: omo_diagnose returns a JSON-like report. Graphify-only.",
    args: {},
    async execute(_args, ctx): Promise<ToolResult> {
      const start = Date.now()
      const retrieval = deps.graphRetrieval ?? getDefaultGraphRetrieval()
      const result = await retrieval.invokeDiagnose(deps.cwd, { timeoutMs: 10_000 })
      return graphResultToTool(
        "omo_diagnose",
        {},
        { ...result, durationMs: Date.now() - start },
        start,
        ctx,
        `graphify is not installed. Run \`pip install graphifyy\` first.`,
      )
    },
  })
}

// -------- graphify: merge-graphs --------

/** `graphify merge-driver` — 3-way merge of conflicting graph segments. */
export function buildOmoMergeGraphsTool(deps: OmoGraphToolDeps) {
  return tool({
    description:
      "Run graphify's 3-way merge driver to resolve conflicting graph segments. " +
      "USAGE: omo_merge_graphs when git reports a conflict in graphify-out/. Graphify-only.",
    args: {},
    async execute(_args, ctx): Promise<ToolResult> {
      const start = Date.now()
      const retrieval = deps.graphRetrieval ?? getDefaultGraphRetrieval()
      const result = await retrieval.invokeMergeDriver(deps.cwd, { timeoutMs: 30_000 })
      return graphResultToTool(
        "omo_merge_graphs",
        {},
        { ...result, durationMs: Date.now() - start },
        start,
        ctx,
        `graphify is not installed.`,
      )
    },
  })
}

// -------- graphify: save-result --------

/** `graphify save-result` — persist the last query result. */
export function buildOmoSaveResultTool(deps: OmoGraphToolDeps) {
  return tool({
    description:
      "Persist the result of the last graphify query to disk for later inspection. " +
      "USAGE: omo_save_result after omo_explain or omo_path returns a useful output.",
    args: {},
    async execute(_args, ctx): Promise<ToolResult> {
      const start = Date.now()
      const retrieval = deps.graphRetrieval ?? getDefaultGraphRetrieval()
      const result = await retrieval.invokeSaveResult(deps.cwd, { timeoutMs: 5_000 })
      return graphResultToTool(
        "omo_save_result",
        {},
        { ...result, durationMs: Date.now() - start },
        start,
        ctx,
        `graphify is not installed.`,
      )
    },
  })
}

// -------- graphify: extract --------

/** `graphify extract` — re-run semantic extraction over the source tree. */
export function buildOmoExtractTool(deps: OmoGraphToolDeps) {
  return tool({
    description:
      "Re-run graphify's semantic extraction over the entire source tree. " +
      "USAGE: omo_extract when the graph schema changed and you want a fresh semantic layer.",
    args: {},
    async execute(_args, ctx): Promise<ToolResult> {
      const start = Date.now()
      const retrieval = deps.graphRetrieval ?? getDefaultGraphRetrieval()
      const result = await retrieval.invokeExtract(deps.cwd, { timeoutMs: 60_000 })
      return graphResultToTool(
        "omo_extract",
        {},
        { ...result, durationMs: Date.now() - start },
        start,
        ctx,
        `graphify is not installed.`,
      )
    },
  })
}

// -------- graphify: cluster-only --------

/** `graphify cluster-only` — re-run clustering only. */
export function buildOmoClusterOnlyTool(deps: OmoGraphToolDeps) {
  return tool({
    description:
      "Re-run graphify's clustering step (skip semantic extraction). " +
      "USAGE: omo_cluster_only after minor node additions to refresh the topic map.",
    args: {},
    async execute(_args, ctx): Promise<ToolResult> {
      const start = Date.now()
      const retrieval = deps.graphRetrieval ?? getDefaultGraphRetrieval()
      const result = await retrieval.invokeClusterOnly(deps.cwd, { timeoutMs: 30_000 })
      return graphResultToTool(
        "omo_cluster_only",
        {},
        { ...result, durationMs: Date.now() - start },
        start,
        ctx,
        `graphify is not installed.`,
      )
    },
  })
}

// -------- graphify: label --------

/** `graphify label <node>` — apply a label to a node. */
export function buildOmoLabelTool(deps: OmoGraphToolDeps) {
  return tool({
    description:
      "Apply a label to a graphify node (e.g. for categorization or human notes). " +
      "USAGE: omo_label with node='validateToken' applies a label.",
    args: {
      node: z.string().min(1).describe("The graph node to label"),
    },
    async execute(args, ctx): Promise<ToolResult> {
      const start = Date.now()
      const retrieval = deps.graphRetrieval ?? getDefaultGraphRetrieval()
      const result = await retrieval.invokeLabel(args.node, deps.cwd, { timeoutMs: 5_000 })
      return graphResultToTool(
        "omo_label",
        { node: args.node },
        { ...result, durationMs: Date.now() - start },
        start,
        ctx,
        `graphify is not installed.`,
      )
    },
  })
}

// -------- graphify: tree --------

/** `graphify tree` — emit a tree visualization. */
export function buildOmoTreeTool(deps: OmoGraphToolDeps) {
  return tool({
    description:
      "Emit a tree visualization of the graphify graph (hierarchical topic layout). " +
      "USAGE: omo_tree for a structural overview of the topic map. Graphify-only.",
    args: {},
    async execute(_args, ctx): Promise<ToolResult> {
      const start = Date.now()
      const retrieval = deps.graphRetrieval ?? getDefaultGraphRetrieval()
      const result = await retrieval.invokeTree(deps.cwd, { timeoutMs: 10_000 })
      return graphResultToTool(
        "omo_tree",
        {},
        { ...result, durationMs: Date.now() - start },
        start,
        ctx,
        `graphify is not installed.`,
      )
    },
  })
}

// -------- graphify: clone --------

/** `graphify clone` — clone the graph to a new path. */
export function buildOmoCloneTool(deps: OmoGraphToolDeps) {
  return tool({
    description:
      "Clone the graphify graph to a new location. " +
      "USAGE: omo_clone when forking a project or creating a backup.",
    args: {},
    async execute(_args, ctx): Promise<ToolResult> {
      const start = Date.now()
      const retrieval = deps.graphRetrieval ?? getDefaultGraphRetrieval()
      const result = await retrieval.invokeClone(deps.cwd, { timeoutMs: 30_000 })
      return graphResultToTool(
        "omo_clone",
        {},
        { ...result, durationMs: Date.now() - start },
        start,
        ctx,
        `graphify is not installed.`,
      )
    },
  })
}

// -------- graphify: add --------

/** `graphify add <files>` — add specific files to the graph. */
export function buildOmoAddTool(deps: OmoGraphToolDeps) {
  return tool({
    description:
      "Add specific files to the graphify graph (instead of re-extracting the whole tree). " +
      "USAGE: omo_add with files='src/auth.ts src/login.ts' after writing new files.",
    args: {
      files: z.string().min(1).describe("Space-separated list of file paths to add (relative to cwd)"),
    },
    async execute(args, ctx): Promise<ToolResult> {
      const start = Date.now()
      const retrieval = deps.graphRetrieval ?? getDefaultGraphRetrieval()
      const result = await retrieval.invokeAdd(args.files, deps.cwd, { timeoutMs: 30_000 })
      return graphResultToTool(
        "omo_add",
        { files: args.files },
        { ...result, durationMs: Date.now() - start },
        start,
        ctx,
        `graphify is not installed.`,
      )
    },
  })
}

// -------- graphify: check-update --------

/** `graphify check-update` — check if schema or extractors changed. */
export function buildOmoCheckUpdateTool(deps: OmoGraphToolDeps) {
  return tool({
    description:
      "Check if the graphify schema or extractors changed since the last extraction. " +
      "USAGE: omo_check_update to decide if re-extraction is needed. Graphify-only.",
    args: {},
    async execute(_args, ctx): Promise<ToolResult> {
      const start = Date.now()
      const retrieval = deps.graphRetrieval ?? getDefaultGraphRetrieval()
      const result = await retrieval.invokeCheckUpdate(deps.cwd, { timeoutMs: 10_000 })
      return graphResultToTool(
        "omo_check_update",
        {},
        { ...result, durationMs: Date.now() - start },
        start,
        ctx,
        `graphify is not installed.`,
      )
    },
  })
}



// ============================================================================
// v0.27.0: omo_hook_status — check whether graphify post-commit hook is installed
// ============================================================================

export interface OmoHookStatusDeps {
  cwd: string
}

/** `graphify hook status` — check whether the graphify post-commit hook is installed. */
export function buildOmoHookStatusTool(deps: OmoHookStatusDeps) {
  return tool({
    description:
      "Check whether the graphify post-commit git hook is installed in this project. " +
      "USAGE: omo_hook_status returns 'installed' or 'missing' along with the hook path. " +
      "Run after `git init` to confirm the hook is wired.",
    args: {},
    async execute(_args, ctx): Promise<ToolResult> {
      const start = Date.now()
      // Lazy import to avoid circular deps with graph-sync.ts
      const { isGraphifyHookInstalled } = await import("./graph-sync")
      const installed = await isGraphifyHookInstalled(deps.cwd)
      const hookPath = `${deps.cwd}/.git/hooks/post-commit`
      const output = installed
        ? `graphify post-commit hook is INSTALLED at ${hookPath}.`
        : `graphify post-commit hook is NOT installed. Run \`graphify hook install\` or enable graphSync in plugin config to install automatically.`
      return {
        title: `omo_hook_status: ${installed ? "installed" : "missing"}`,
        output,
        metadata: {
          tool: "omo_hook_status",
          installed,
          hookPath,
          durationMs: Date.now() - start,
          sessionID: ctx.sessionID,
        },
      }
    },
  })
}


// ============================================================================
// v0.28.0: CLI-Anything hub discovery tools
// ============================================================================

export interface OmoCliAnythingDeps {
  cwd: string
  /** Optional runner DI seam for tests. When undefined, uses real execSync. */
  runner?: (cmd: string, opts?: { timeoutMs?: number }) => string
}

function cliAnythingResultToTool(
  toolName: string,
  meta: Record<string, unknown>,
  result: { ok: boolean; data: unknown; rawOutput: string | null; stderr: string; code: string; durationMs: number },
  start: number,
  ctx: ToolContext,
  friendlyHint: string,
): ToolResult {
  const durationMs = Date.now() - start
  if (!result.ok) {
    return {
      title: `${toolName}: ${result.code}`,
      output: `${friendlyHint}\n\nDiagnostic: ${result.code}\nstderr: ${result.stderr || "(empty)"}`,
      metadata: { tool: toolName, code: result.code, durationMs, sessionID: ctx.sessionID, ...meta },
    }
  }
  // Prefer structured data when present (JSON parse succeeded), otherwise raw
  const output =
    result.data !== null && result.data !== undefined
      ? typeof result.data === "string"
        ? result.data
        : JSON.stringify(result.data, null, 2)
      : result.rawOutput ?? ""
  return {
    title: toolName,
    output,
    metadata: { tool: toolName, code: result.code, durationMs, sessionID: ctx.sessionID, ...meta },
  }
}

// -------- omo_cli_anything_install --------

/** Install a CLI from the CLI-Anything hub (e.g. `gimp`, `blender`, `drawio`). */
export function buildOmoCliAnythingInstallTool(deps: OmoCliAnythingDeps) {
  return tool({
    description:
      "Install a CLI from the CLI-Anything hub so the agent can drive that software. " +
      "USAGE: omo_cli_anything_install with name='gimp' installs `cli-anything-gimp`, which " +
      "exposes a `cli-anything-gimp` command. Browse the catalog with omo_cli_anything_list. " +
      "See https://github.com/HKUDS/CLI-Anything for the full registry.",
    args: {
      name: z.string().min(1).describe("The CLI name to install (e.g. 'gimp', 'blender', 'drawio')"),
    },
async execute(args, ctx): Promise<ToolResult> {
      const start = Date.now()
      const { installCli } = await import("./cli-anything")
      const result = installCli(args.name, deps.runner, 120_000, "cli-hub")
      return cliAnythingResultToTool(
        "omo_cli_anything_install",
        { name: args.name },
        { ...result, durationMs: Date.now() - start },
        start,
        ctx,
        `Could not install '${args.name}'. Check that cli-anything-hub is installed (omo_health) and the name is correct.`,
      )
    },
  })
}

// -------- omo_cli_anything_list --------

/** List all CLIs available in the CLI-Anything hub. */
export function buildOmoCliAnythingListTool(deps: OmoCliAnythingDeps) {
  return tool({
    description:
      "List all CLIs available in the CLI-Anything hub (40+ GUI software harnesses). " +
      "USAGE: omo_cli_anything_list with category='image' returns only image-related CLIs. " +
      "Returns JSON with name, version, description, category, install_cmd, entry_point. " +
      "See https://github.com/HKUDS/CLI-Anything.",
    args: {
      category: z
        .string()
        .optional()
        .describe("Optional category filter (e.g. 'image', 'devops', '3d', 'audio')"),
      source: z
        .enum(["harness", "public", "npm", "all"])
        .optional()
        .describe("Optional source filter. 'all' includes harness + public + npm."),
    },
    async execute(args, ctx): Promise<ToolResult> {
      const start = Date.now()
      const { listClis } = await import("./cli-anything")
const result = listClis(
        { category: args.category, source: args.source },
        deps.runner,
        30_000,
        "cli-hub",
      )
      return cliAnythingResultToTool(
        "omo_cli_anything_list",
        { category: args.category, source: args.source },
        { ...result, durationMs: Date.now() - start },
        start,
        ctx,
        `Could not list CLIs from the hub. Make sure cli-anything-hub is installed: \`pip install cli-anything-hub\`.`,
      )
    },
  })
}

// -------- omo_cli_anything_search --------

/** Search the CLI-Anything hub for CLIs matching a query. */
export function buildOmoCliAnythingSearchTool(deps: OmoCliAnythingDeps) {
  return tool({
    description:
      "Search the CLI-Anything hub for CLIs matching a query (name, description, or category). " +
      "USAGE: omo_cli_anything_search with query='cad' returns CAD-related CLIs. " +
      "Returns JSON array. See https://github.com/HKUDS/CLI-Anything.",
    args: {
      query: z.string().min(1).describe("Search query (matches name, description, or category)"),
    },
    async execute(args, ctx): Promise<ToolResult> {
      const start = Date.now()
const { searchClis } = await import("./cli-anything")
      const result = searchClis(args.query, deps.runner, 30_000, "cli-hub")
      return cliAnythingResultToTool(
        "omo_cli_anything_search",
        { query: args.query },
        { ...result, durationMs: Date.now() - start },
        start,
        ctx,
        `Search failed. Make sure cli-anything-hub is installed: \`pip install cli-anything-hub\`.`,
      )
    },
  })
}

// -------- omo_cli_anything_info --------

/** Show details (display name, version, requires, install cmd, entry point) for a CLI. */
export function buildOmoCliAnythingInfoTool(deps: OmoCliAnythingDeps) {
  return tool({
    description:
      "Show details for a specific CLI in the CLI-Anything hub. " +
      "USAGE: omo_cli_anything_info with name='blender' returns display name, version, " +
      "description, requirements (e.g. 'blender (apt install blender)'), entry point, install command. " +
      "See https://github.com/HKUDS/CLI-Anything.",
    args: {
      name: z.string().min(1).describe("The CLI name to look up"),
    },
    async execute(args, ctx): Promise<ToolResult> {
      const start = Date.now()
const { infoCli } = await import("./cli-anything")
      const result = infoCli(args.name, deps.runner, 10_000, "cli-hub")
      return cliAnythingResultToTool(
        "omo_cli_anything_info",
        { name: args.name },
        { ...result, durationMs: Date.now() - start },
        start,
        ctx,
        `Could not find '${args.name}' in the hub. Try omo_cli_anything_search to find similar names.`,
      )
    },
  })
}

// v0.32.0 skill-hub tools — re-exported for plugin-mode adapter
 export { buildOmoSkillFindTool, buildOmoSkillGetTool, buildOmoSkillAddTool } from "./skill-hub-tools"
