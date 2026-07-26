/**
 * MCPClient — wrapper over `PluginInput.client` that gives the plugin
 * programmatic access to OpenCode's server API (sessions, tools, config).
 *
 * Why this exists: omo-meta-governor 0.13.1 only used the OpenCode client
 * implicitly (via tools the LLM called). To integrate AgentMemory,
 * Magic Context, and AFT directly — without requiring the LLM to invoke
 * their MCP tools manually — we need a way to call MCP tools from within
 * the plugin's own hooks and custom tools.
 *
 * Design:
 * - Lazy initialization: the client is null until the first plugin event
 *   fires (we capture it from PluginInput.client at that point)
 * - Timeout-bounded: all calls have a 5s default timeout to prevent
 *   blocking tool.execute.before/after
 * - Graceful degradation: every method catches errors and returns null
 *   rather than throwing, so the plugin never crashes due to MCP issues
 * - Singleton: module-level instance shared across the plugin
 */

import type { createOpencodeClient } from "@opencode-ai/sdk"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The subset of the OpenCode server client API we actually use. Defined
 * here as a structural type so we can mock it in tests without importing
 * the full SDK.
 */
export interface OpencodeServerClient {
  tool: {
    list(): Promise<{
      data?: Array<{ id: string; description?: string }>
    }>
    invoke(input: {
      toolID: string
      input?: Record<string, unknown>
    }): Promise<{ data?: unknown }>
  }
}

export interface CallToolResult {
  /** The tool's return value, normalized to a plain object. */
  data: Record<string, unknown> | null
  /** True if the call exceeded the timeout. */
  timedOut: boolean
  /** Wall-clock duration in ms. */
  durationMs: number
  /** Error message if the call failed (non-timeout). */
  error: string | null
}

export interface MCPClientConfig {
  /** Default timeout in ms for all calls. Default: 5000. */
  defaultTimeoutMs?: number
}

// ---------------------------------------------------------------------------
// MCPClient implementation
// ---------------------------------------------------------------------------

/**
 * Thin wrapper over OpencodeServerClient with timeout + degrade-on-error.
 * All methods are async and never throw — errors are returned as
 * { data: null, error: "..." }.
 */
export class MCPClient {
  private client: OpencodeServerClient | null = null
  private readonly defaultTimeoutMs: number
  private toolCache: Set<string> | null = null

  constructor(config: MCPClientConfig = {}) {
    this.defaultTimeoutMs = config.defaultTimeoutMs ?? 5_000
  }

  /**
   * Hydrate the client with the real OpenCode server client. Called by the
   * plugin factory when the first `event()` or `config()` hook fires.
   */
  setClient(client: OpencodeServerClient | null): void {
    this.client = client
    // Invalidate tool cache when client changes
    this.toolCache = null
  }

  /**
   * Returns true if a client is hydrated and tools can be called.
   */
  isReady(): boolean {
    return this.client !== null
  }

  /**
   * Call a tool by name with the given args. Returns structured result.
   * Never throws — all errors are caught and returned in the result.
   */
  async callTool(
    toolName: string,
    args: Record<string, unknown> = {},
    timeoutMs?: number,
  ): Promise<CallToolResult> {
    const start = Date.now()
    const timeout = timeoutMs ?? this.defaultTimeoutMs
    if (!this.client) {
      return {
        data: null,
        timedOut: false,
        durationMs: Date.now() - start,
        error: "MCP client not initialized",
      }
    }
    try {
      const result = await this.raceWithTimeout(
        this.client.tool.invoke({ toolID: toolName, input: args }),
        timeout,
        toolName,
      )
      // Normalize result data — the SDK may return it as `data` or as the raw value
      const raw = (result as { data?: unknown }).data
      const data =
        raw && typeof raw === "object" && !Array.isArray(raw)
          ? (raw as Record<string, unknown>)
          : null
      return {
        data,
        timedOut: false,
        durationMs: Date.now() - start,
        error: null,
      }
    } catch (err) {
      const isTimeout = err instanceof Error && /timed out/i.test(err.message)
      return {
        data: null,
        timedOut: isTimeout,
        durationMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }

  /**
   * Returns true if the given tool is available on the server. Caches
   * the tool list on first call to avoid hammering the server.
   */
  async isAvailable(toolName: string): Promise<boolean> {
    if (!this.client) return false
    if (this.toolCache === null) {
      try {
        const result = await this.client.tool.list()
        this.toolCache = new Set((result.data ?? []).map((t) => t.id))
      } catch {
        this.toolCache = new Set()
      }
    }
    return this.toolCache.has(toolName)
  }

  /**
   * Returns the set of available tool names. Useful for omo_health.
   */
  async availableTools(): Promise<string[]> {
    if (!this.client) return []
    if (this.toolCache === null) {
      await this.isAvailable("__bootstrap__")
    }
    return Array.from(this.toolCache ?? new Set())
  }

  /**
   * Clear the tool cache (useful when the user adds/removes MCP servers).
   */
  invalidateCache(): void {
    this.toolCache = null
  }

  // -------- Private helpers --------

  private raceWithTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`${label} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      promise.then(
        (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        (e) => {
          clearTimeout(timer)
          reject(e)
        },
      )
    })
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton
// ---------------------------------------------------------------------------

let _singleton: MCPClient | null = null

/**
 * Returns the process-wide MCPClient singleton. Created on first call.
 */
export function getMCPClient(): MCPClient {
  if (!_singleton) _singleton = new MCPClient()
  return _singleton
}

/**
 * Reset the singleton (test-only).
 */
export function resetMCPClient(): void {
  _singleton = null
}
