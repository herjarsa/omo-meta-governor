/**
 * MCP server mode for omo-meta-governor (v0.31.0).
 *
 * Why this exists:
 * OpenCode Desktop and OpenChamber spawn opencode serve in HTTP/sidecar
 * mode where the plugin's hooks.tool registrations never reach the UI.
 * The same plugin works fine in the opencode CLI. This file exposes the
 * plugin's tool surface as a standalone MCP server process so the tools
 * become reachable through OpenCode's MCP transport.
 *
 * Implementation strategy — REUSE, don't reimplement:
 * The plugin hooks already build the canonical omo_* tools via
 * buildOmoXxxTool({...}) in custom-tools.ts. We import those builders
 * here and wrap each one so it conforms to the (args, ctx) =>
 * Promise<McpToolResult> shape MCP expects.
 */

import { resolve as resolvePath } from "node:path"
import { homedir } from "node:os"

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
import {
  buildOmoSkillFindTool,
  buildOmoSkillGetTool,
  buildOmoSkillAddTool,
} from "./skill-hub-tools"

let PLUGIN_VERSION = "0.0.0"
try {
  PLUGIN_VERSION = require("../package.json").version as string
} catch {
  /* package.json not available at runtime */
}

export interface McpToolContext {
  readonly cwd: string
}

let _cwd: string = process.cwd()

export function setMcpCwd(cwd: string): void {
  _cwd = resolvePath(cwd)
}

export function getMcpCwd(): string {
  return _cwd
}

export interface McpToolResult {
  title: string
  text: string
  meta?: Record<string, unknown>
  isError?: boolean
}

const STUB_SESSION_ID = "__mcp_server_session__"

function stubCtx() {
  return {
    sessionID: STUB_SESSION_ID,
    abort: new AbortController().signal,
    metadata: () => undefined,
  }
}

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
  // Match the plugin-mode health file path (see plugin.ts:194).
  const healthFilePath = resolvePath(homedir(), ".config", "opencode", "meta-governor-health.json")

  // Pass only what each builder declares — no wider deps blob.
  return [
    adapt(buildOmoHealthTool as PluginToolBuilder, "omo_health", {
      cwd,
      metrics,
      logFilePath: LOG_PATH,
      healthFilePath,
    }),
    adapt(buildOmoSearchTool as PluginToolBuilder, "omo_search", { cwd, graphRetrieval }),
    adapt(buildOmoRecallTool as PluginToolBuilder, "omo_recall", { sqlite }),
    adapt(buildOmoFindTool as PluginToolBuilder, "omo_find", { cwd }),
    adapt(buildOmoImpactTool as PluginToolBuilder, "omo_impact", { cwd }),
    adapt(buildOmoPathTool as PluginToolBuilder, "omo_path", { cwd }),
    adapt(buildOmoExplainTool as PluginToolBuilder, "omo_explain", { cwd }),
    adapt(buildOmoStatusTool as PluginToolBuilder, "omo_status", { cwd }),
    adapt(buildOmoIndexTool as PluginToolBuilder, "omo_index", { cwd }),
    adapt(buildOmoVisualizeTool as PluginToolBuilder, "omo_visualize", { cwd }),
    adapt(buildOmoServeTool as PluginToolBuilder, "omo_serve", { cwd }),
    adapt(buildOmoDiagnoseTool as PluginToolBuilder, "omo_diagnose", { cwd }),
    adapt(buildOmoUninitTool as PluginToolBuilder, "omo_uninit", { cwd }),
    adapt(buildOmoSyncIfDirtyTool as PluginToolBuilder, "omo_sync_if_dirty", { cwd }),
    adapt(buildOmoMarkDirtyTool as PluginToolBuilder, "omo_mark_dirty", { cwd }),
    adapt(buildOmoHookStatusTool as PluginToolBuilder, "omo_hook_status", { cwd }),
    adapt(buildOmoSkillFindTool as PluginToolBuilder, "omo_skill_find", { sqlite, cwd }),
    adapt(buildOmoSkillGetTool as PluginToolBuilder, "omo_skill_get", { sqlite, cwd }),
    adapt(buildOmoSkillAddTool as PluginToolBuilder, "omo_skill_add", { sqlite, cwd }),
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
  "omo_skill_find",
  "omo_skill_get",
  "omo_skill_add",
] as const
