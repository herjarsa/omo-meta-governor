/**
 * omo-meta-governor MCP server entry point (v0.31.0).
 *
 * Spawned by OpenCode as a child process when users add this package to the
 * `mcp` block of `opencode.jsonc`:
 *
 * ```json
 * {
 *   "mcp": {
 *     "omo-meta-governor": {
 *       "type": "local",
 *       "command": ["npx", "-y", "@herjarsa/omo-meta-governor", "omo-meta-governor-mcp"]
 *     }
 *   }
 * }
 * ```
 *
 * The server speaks MCP over stdio. Tool implementations live in mcp-tools.ts
 * and are reused from custom-tools.ts so behaviour matches plugin mode.
 *
 * When to use this vs. the plugin entry:
 * - Plugin entry (`opencode.jsonc` -> `plugin`): preferred for the hooks
 *   (`system.transform`, `tool.execute.before/after`) — those run in the
 *   opencode process and need access to `PluginInput.client`.
 * - MCP server (this entry): preferred for visible tools in OpenCode Desktop
 *   and OpenChamber, where `hooks.tool` registrations do not reach the UI.
 *   Both can be active at the same time without conflict.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { readFileSync, statSync } from "node:fs"
import { resolve as resolvePath, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { getAdapters, getMcpCwd, setMcpCwd } from "./mcp-tools"
import type { McpToolResult } from "./mcp-tools"
import { getDefaultSqliteBackend } from "./sqlite-backend"
import { loadOrchestratorConfig } from "./config"
import { loadMetaGovernorConfig } from "./config-file"
import { runSkillHubSync } from "./skill-hub-sync"
const SERVER_NAME = "omo-meta-governor-mcp"

/**
 * Resolve the working directory the MCP server should operate on.
 *
 * Priority:
 * 1. `OMO_CWD` env var (set by user via opencode.jsonc `mcp.<name>.cwd`)
 * 2. First CLI arg (matches the pattern used by `npx`)
 * 3. `process.cwd()`
 *
 * OpenCode spawns MCP servers with the project root as cwd by default, so
 * option 3 is the common path. The env var exists so users can override.
 */
function resolveCwd(): string {
  let cwd: string
  const fromEnv = process.env.OMO_CWD
  if (fromEnv && fromEnv.trim().length > 0) {
    cwd = resolvePath(fromEnv)
  } else {
    const fromArg = process.argv[2]
    if (fromArg && fromArg.trim().length > 0 && !fromArg.startsWith("-")) {
      cwd = resolvePath(fromArg)
    } else {
      cwd = process.cwd()
    }
  }
  // Fail fast: verify the resolved CWD exists and is readable.
  // Without this, tools would lazy-error on first call, which is worse
  // for debugging.
  try {
    const s = statSync(cwd)
    if (!s.isDirectory()) {
      console.error(`[${SERVER_NAME}] cwd is not a directory: ${cwd}`)
      process.exit(1)
    }
  } catch {
    console.error(`[${SERVER_NAME}] cwd does not exist or is not readable: ${cwd}`)
    process.exit(1)
  }
  return cwd
}

/**
 * Convert an internal McpToolResult into the MCP CallToolResult shape that
 * `server.tool` handlers must return.
 */
function toCallToolResult(r: McpToolResult) {
  return {
    content: [{ type: "text" as const, text: `${r.title}\n\n${r.text}` }],
    isError: r.isError === true,
    _meta: r.meta,
  }
}

async function main(): Promise<void> {
  setMcpCwd(resolveCwd())
  const cwd = getMcpCwd()
  const adapters = getAdapters()

  const server = new McpServer(
    {
      name: SERVER_NAME,
      version: readPackageVersion(),
    },
    {
      capabilities: {
        // Tools only — no resources, no prompts. Match what omo-meta-governor
        // exposes as plugin tools; nothing else.
        tools: {},
      },
    },
  )

  for (const adapter of adapters) {
    // `any()` here lets us forward the existing Zod schema from
    // custom-tools.ts without re-declaring it. The MCP SDK forwards the raw
    // JSON object to our adapter which delegates to the existing builder
    // whose own Zod schema validates it.
    server.tool(
      adapter.name,
      adapter.description,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      adapter.inputSchema as any,
      async (args: Record<string, unknown> | undefined) => {
        try {
          const result = await adapter.execute(args ?? {}, { cwd })
          return toCallToolResult(result)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          return toCallToolResult({
            title: `${adapter.name}: error`,
            text: message,
            isError: true,
          })
        }
      },
    )
  }

  const transport = new StdioServerTransport()
  await server.connect(transport)

  // v0.33.6: Fire-and-forget skill-hub sync on startup so the local
  // catalog is populated before any omo_skill_find call. Errors are
  // swallowed inside runSkillHubSync (logs to console.error).
  void (async () => {
    try {
      const cfg = await loadMetaGovernorConfig({ projectDir: cwd })
      const orchestrator = loadOrchestratorConfig(cfg.config)
      if (!orchestrator.skillHub.enabled) return
      const result = await runSkillHubSync({
        sqlBackend: getDefaultSqliteBackend(),
        bootstrapUrl: orchestrator.skillHub.bootstrapUrl,
        enabled: true,
      })
      if (result) {
        console.error(
          `[${SERVER_NAME}] skill-hub sync: inserted=${result.inserted} updated=${result.updated} skipped=${result.skippedUnchanged}`,
        )
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[${SERVER_NAME}] skill-hub sync failed: ${msg}`)
    }
  })()

  // Log to stderr so we don't pollute the stdio JSON-RPC stream. OpenCode
  // captures stderr from MCP servers and surfaces it in its own logs.
  console.error(
    `[${SERVER_NAME}] v${readPackageVersion()} listening on stdio (cwd: ${cwd}, ${adapters.length} tools)`,
  )

  // Graceful shutdown: close the transport on SIGINT/SIGTERM so OpenCode
  // sees a clean exit rather than a pipe-broken error.
  const shutdown = async (signal: string) => {
    console.error(`[${SERVER_NAME}] received ${signal}, shutting down`)
    try {
      await server.close()
    } catch {
      /* best-effort */
    }
    process.exit(0)
  }
  process.on("SIGINT", () => void shutdown("SIGINT"))
  process.on("SIGTERM", () => void shutdown("SIGTERM"))
}

function readPackageVersion(): string {
  try {
    // v0.34.2: ESM-safe version read (was require("../package.json") which
    // throws ReferenceError when package.json declares "type":"module").
    const here = dirname(fileURLToPath(import.meta.url))
    const pkgPath = join(here, "..", "package.json")
    const raw = readFileSync(pkgPath, "utf-8")
    const parsed = JSON.parse(raw) as { version?: unknown }
    return typeof parsed.version === "string" ? parsed.version : "0.0.0"
  } catch {
    return "0.0.0"
  }
}

main().catch((err) => {
  console.error(`[${SERVER_NAME}] fatal:`, err)
  process.exit(1)
})
