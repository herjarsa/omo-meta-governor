/**
 * MCP server mode for omo-meta-governor (v0.31.0).
 *
 * Why this exists:
 * OpenCode Desktop and OpenChamber spawn `opencode serve` in HTTP/sidecar
 * mode where the plugin's `hooks.tool` registrations never reach the UI
 * (memory: "HTTP serve mode never reached Plugin.init()"). The same plugin
 * works fine in the opencode CLI. This file exposes the plugin's tool
 * surface as a standalone MCP server process so the tools become reachable
 * through OpenCode's MCP transport — which IS delivered to the UI in all
 * runtimes (same mechanism that powers codegraph, graphify, agentmemory).
 *
 * Implementation strategy — REUSE, don't reimplement:
 * - The plugin hooks already build the canonical `omo_*` tools via
 *   `buildOmoXxxTool({...})` in custom-tools.ts. Each returns a Tool whose
 *   `execute(args, ctx)` carries the full implementation.
 * - We import those builders here and wrap each one so it conforms to the
 *   plain `(args, ctx) => Promise<McpToolResult>` shape MCP expects.
 * - This guarantees behavioural parity with plugin mode — when a fix lands
 *   in custom-tools.ts, the MCP server picks it up automatically.
 *
 * What does NOT live here:
 * - Plugin hooks (system.transform, tool.execute.before/after). Those are
 *   delivered through the plugin entry and continue to work in CLI mode.
 *   The MCP server is an additive delivery channel for tools only.
 *
 * Backward compatibility:
 * - Existing users who only use the plugin entry in `opencode.jsonc` see no
 *   behavior change. They can opt in to the MCP server at any time by
 *   adding the `mcp` block shown in README.md.
 */

import { resolve as resolvePath } from "node:path"
import { getDefaultGraphRetrieval } from "./graph-retrieval"
import { getDefaultSqliteBackend } from "./sqlite-backend"
import { createMetricsCollector } from "./metrics"
import { LOG_PATH } from "./file-logger"
import {
  buildOmoSearchTool,
  buildOmoRecallTool,
  buildOmoHealthTool,
  buildOmoFindTool,
  buildOmoImpactTool,
  buildOmoPathTool,
  buildOmoExplainTool,
  buildOmoStatusTool,
  buildOmoIndexTool,
  buildOmoVisualizeTool,
  buildOmoServeTool,
  buildOmoDiagnoseTool,
  buildOmoUninitTool,
  buildOmoSyncIfDirtyTool,
  buildOmoMarkDirtyTool,
  buildOmoHookStatusTool,
} from "./custom-tools"

// ---------------------------------------------------------------------------
// Plugin version (read from package.json at startup, falls back to literal)
// ---------------------------------------------------------------------------

let PLUGIN_VERSION = "0.0.0"
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  PLUGIN_VERSION = require("../package.json").version as string
} catch {
  /* package.json not available at runtime */
}

// ---------------------------------------------------------------------------
// Context — what each adapter receives. The MCP server process is
// independent of the opencode sidecar, so we build minimal stubs that
// satisfy what the underlying Tool executors need.
// ---------------------------------------------------------------------------

export interface McpToolContext {
  /** Absolute working directory of the project the tools operate on. */
  readonly cwd: string
}

let _cwd: string = process.cwd()

/** Set the cwd used by all subsequent tool calls in this process. */
export function setMcpCwd(cwd: string): void {
  _cwd = resolvePath(cwd)
}

export function getMcpCwd(): string {
  return _cwd
}

// ---------------------------------------------------------------------------
// Result type — what each adapter returns. Matches MCP's expected shape so
// we can pass it through directly to CallToolResult.
// ---------------------------------------------------------------------------

export interface McpToolResult {
  /** Short, human-readable title for the response. */
  title: string
  /** Body text shown to the model. */
  text: string
  /** Optional structured metadata. */
  meta?: Record<string, unknown>
  /** Mark as error (MCP isError=true). */
  isError?: boolean
}

// ---------------------------------------------------------------------------
// Stub ToolContext — the @opencode-ai/plugin ToolContext carries fields the
// MCP server doesn't have (sessionID, abortSignal). We pass a minimal stub
// that satisfies the structural type the tool executors read.
// ---------------------------------------------------------------------------

const STUB_SESSION_ID = "__mcp_server_session__"

function stubCtx() {
  return {
    sessionID: STUB_SESSION_ID,
    abort: new AbortController().signal,
    metadata: () => undefined,
  }
}

// ---------------------------------------------------------------------------
// Adapter — wraps a builder (createOmoTool -> Tool) into a plain function
// matching the (args, ctx) -> Promise<McpToolResult> shape MCP expects.
// ---------------------------------------------------------------------------

type PluginToolBuilder = (deps: unknown) => {
  description: string
  args: unknown
  execute: (args: Record<string, unknown>, ctx: unknown) => Promise<{
    title: string
    output: string
    metadata?: Record<string, unknown>
  }>
}

export interface McpAdapter {
  name: string
  description: string
  inputSchema: unknown
  execute: (args: Record<string, unknown>, ctx: McpToolContext) => Promise<McpToolResult>
}

function adapt(builder: PluginToolBuilder, name: string, deps: unknown): McpAdapter {
  const tool = builder(deps)
  return {
    name,
    description: tool.description,
    inputSchema: tool.args,
    execute: async (args, _ctx) => {
      const start = Date.now()
      try {
        const result = await tool.execute(args, stubCtx())
        return {
          title: result.title,
          text: result.output,
          meta: { ...(result.metadata ?? {}), durationMs: Date.now() - start },
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return {
          title: `${name}: error`,
          text: message,
          meta: { durationMs: Date.now() - start },
          isError: true,
        }
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Build the tool registry. Lazy: rebuilt when cwd changes so callers can
// setMcpCwd() before instantiation if needed (not used today — the server
// entry resolves cwd once at startup and freezes it).
// ---------------------------------------------------------------------------

let _cachedCwd: string | null = null
let _adapters: readonly McpAdapter[] | null = null

function buildAdapters(): readonly McpAdapter[] {
  const cwd = getMcpCwd()
  const graphRetrieval = getDefaultGraphRetrieval()
  const sqlite = getDefaultSqliteBackend()
  const metrics = createMetricsCollector({
    sessionID: "__mcp_global__",
    global: true,
    version: PLUGIN_VERSION,
  })

  // Mirror the plugin-mode defaults so the MCP server exposes the same
  // surface. The MCP server process is independent of the opencode sidecar,
  // so graphRetrieval/sqlite/metrics are constructed fresh here.
  const deps = { cwd, graphRetrieval, sqlite, metrics, logFilePath: LOG_PATH }

  return [
    adapt(buildOmoHealthTool as PluginToolBuilder, "omo_health", {
      cwd,
      metrics,
      logFilePath: LOG_PATH,
      healthFilePath: "",
    }),
    adapt(buildOmoSearchTool as PluginToolBuilder, "omo_search", deps),
    adapt(buildOmoRecallTool as PluginToolBuilder, "omo_recall", deps),
    adapt(buildOmoFindTool as PluginToolBuilder, "omo_find", deps),
    adapt(buildOmoImpactTool as PluginToolBuilder, "omo_impact", deps),
    adapt(buildOmoPathTool as PluginToolBuilder, "omo_path", deps),
    adapt(buildOmoExplainTool as PluginToolBuilder, "omo_explain", deps),
    adapt(buildOmoStatusTool as PluginToolBuilder, "omo_status", deps),
    adapt(buildOmoIndexTool as PluginToolBuilder, "omo_index", deps),
    adapt(buildOmoVisualizeTool as PluginToolBuilder, "omo_visualize", deps),
    adapt(buildOmoServeTool as PluginToolBuilder, "omo_serve", deps),
    adapt(buildOmoDiagnoseTool as PluginToolBuilder, "omo_diagnose", deps),
    adapt(buildOmoUninitTool as PluginToolBuilder, "omo_uninit", deps),
    adapt(buildOmoSyncIfDirtyTool as PluginToolBuilder, "omo_sync_if_dirty", deps),
    adapt(buildOmoMarkDirtyTool as PluginToolBuilder, "omo_mark_dirty", deps),
    adapt(buildOmoHookStatusTool as PluginToolBuilder, "omo_hook_status", { cwd }),
  ]
}

export function getAdapters(): readonly McpAdapter[] {
  const cwd = getMcpCwd()
  if (_adapters === null || _cachedCwd !== cwd) {
    _adapters = buildAdapters()
    _cachedCwd = cwd
  }
  return _adapters
}

// Re-export the canonical tool list for inspection / testing.
export const MCP_TOOL_NAMES = [
  "omo_health",
  "omo_search",
  "omo_recall",
  "omo_find",
  "omo_impact",
  "omo_path",
  "omo_explain",
  "omo_status",
  "omo_index",
  "omo_visualize",
  "omo_serve",
  "omo_diagnose",
  "omo_uninit",
  "omo_sync_if_dirty",
  "omo_mark_dirty",
  "omo_hook_status",
] as const
