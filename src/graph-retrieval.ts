/**
 * GraphRetrieval — invokes codegraph/graphify and caches results for
 * injection into the agent's context. v0.13.0 fix for C2: the plugin
 * previously only told the agent to use graph tools via prompt text; now
 * it actually invokes them and injects the results.
 *
 * Design:
 * - Re-detects graph directories on EVERY call (fixes the race condition
 *   in src/plugin.ts:74-81 where static booleans were set once at load time
 *   before async `runGraphSync()` could create the directories).
 * - Async with timeout (5s default) — never blocks tool.execute.before.
 * - Per-session cache keyed by (sessionID, queryHash) with 5min TTL.
 * - LRU eviction at 10 entries per session.
 * - Graceful degradation: missing CLI → null result, errors are swallowed.
 *
 * Invocation strategy:
 * - If `.codegraph/` exists and `codegraph` CLI is available: invoke `codegraph explore <query>`
 * - Else if `graphify-out/` exists and `graphify` is available: invoke `graphify query <query>`
 * - Else: return null
 *
 * The plugin can override CLI paths via the `invoke()` options for testing
 * and for users who have the tools in non-standard locations.
 */

import { spawn } from "node:child_process"
import { statSync, existsSync } from "node:fs"
import { join } from "node:path"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GraphToolKind = "codegraph" | "graphify" | null

export interface GraphInvocationResult {
  /** Which tool was actually invoked. */
  kind: GraphToolKind
  /** The query that was executed. */
  query: string
  /** Result text from the tool, or null on failure / no-tool. */
  result: string | null
  /** True if the subprocess was killed by timeout. */
  timedOut: boolean
  /** Wall-clock duration in ms. */
  durationMs: number
}

export interface GraphRetrievalConfig {
  /** Subprocess timeout in ms. Default: 5000. */
  timeoutMs?: number
  /** Cache entry TTL in ms. Default: 300000 (5min). */
  cacheTtlMs?: number
  /** Max cache entries per session. Default: 10. */
  maxEntriesPerSession?: number
}

export interface InvokeOptions {
  /** Override codegraph CLI path (default: lookup in PATH). */
  codegraphBin?: string
  /** Override graphify CLI path (default: lookup in PATH). */
  graphifyBin?: string
  /** Override timeout for this call. */
  timeoutMs?: number
  /** v0.16.0: project working directory. Defaults to process.cwd(). */
  projectDir?: string
}

// ---------------------------------------------------------------------------
// Cache entry
// ---------------------------------------------------------------------------

interface CacheEntry {
  query: string
  content: string
  insertedAtMs: number
}

interface SessionCache {
  /** Ordered map keyed by queryHash (most recent at the end). */
  entries: Map<string, CacheEntry>
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Deterministic hash for a query string. Used as cache key suffix. */
export function hashQuery(query: string): string {
  const trimmed = query.trim().toLowerCase()
  // Simple FNV-1a 32-bit
  let hash = 0x811c9dc5
  for (let i = 0; i < trimmed.length; i++) {
    hash ^= trimmed.charCodeAt(i)
    hash = (hash * 0x01000193) >>> 0
  }
  return hash.toString(16)
}

// ---------------------------------------------------------------------------
// GraphRetrieval
// ---------------------------------------------------------------------------

export class GraphRetrieval {
  private readonly timeoutMs: number
  private readonly cacheTtlMs: number
  private readonly maxEntriesPerSession: number
  private readonly cache: Map<string, SessionCache> = new Map()

  constructor(config: GraphRetrievalConfig = {}) {
    this.timeoutMs = config.timeoutMs ?? 5_000
    this.cacheTtlMs = config.cacheTtlMs ?? 300_000
    this.maxEntriesPerSession = config.maxEntriesPerSession ?? 10
  }

  // -------- Directory detection (lazy, fixes race condition) --------

  /** Returns true if .codegraph/ exists in the project dir. */
  hasCodegraphDir(projectDir: string): boolean {
    try {
      return statSync(join(projectDir, ".codegraph")).isDirectory()
    } catch {
      return false
    }
  }

  /** Returns true if graphify-out/ exists in the project dir. */
  hasGraphifyDir(projectDir: string): boolean {
    try {
      return statSync(join(projectDir, "graphify-out")).isDirectory()
    } catch {
      return false
    }
  }

  // -------- Cache API --------

  /**
   * Cache graph context for a session. The most recent entry per session is
   * returned by `getCachedContext()` with no query arg (used by
   * system.transform to inject the latest graph context).
   */
  cacheContext(sessionID: string, query: string, content: string): void {
    let session = this.cache.get(sessionID)
    if (!session) {
      session = { entries: new Map() }
      this.cache.set(sessionID, session)
    }
    const key = hashQuery(query)
    session.entries.set(key, {
      query,
      content,
      insertedAtMs: Date.now(),
    })
    // LRU eviction — drop oldest if over limit
    while (session.entries.size > this.maxEntriesPerSession) {
      const firstKey = session.entries.keys().next().value
      if (!firstKey) break
      session.entries.delete(firstKey)
    }
  }

  /**
   * Get cached context for a session.
   * - If `query` is provided, returns the exact match (or null).
   * - If `query` is omitted, returns the most recent non-expired entry.
   */
  getCachedContext(sessionID: string, query?: string): string | null {
    const session = this.cache.get(sessionID)
    if (!session) return null

    if (query) {
      const key = hashQuery(query)
      const entry = session.entries.get(key)
      if (!entry) return null
      if (Date.now() - entry.insertedAtMs > this.cacheTtlMs) {
        session.entries.delete(key)
        return null
      }
      return entry.content
    }

    // Most recent: iterate in insertion order, return the last valid one
    let last: string | null = null
    for (const entry of session.entries.values()) {
      if (Date.now() - entry.insertedAtMs <= this.cacheTtlMs) {
        last = entry.content
      } else {
        // Skip expired entries
      }
    }
    return last
  }

  clear(): void {
    this.cache.clear()
  }

  clearSession(sessionID: string): void {
    this.cache.delete(sessionID)
  }

  // -------- Subprocess invocation --------

  /**
   * Invoke a graph tool for the given query. Returns structured result.
   * Never throws — all errors are caught and returned as `result: null`.
   *
   * Selection logic:
   * 1. If `.codegraph/` exists and `codegraph` CLI is found → invoke codegraph
   * 2. Else if `graphify-out/` exists and `graphify` CLI is found → invoke graphify
   * 3. Else → return null result
   */
  async invoke(
    projectDir: string,
    query: string,
    options: InvokeOptions = {},
  ): Promise<GraphInvocationResult> {
    const start = Date.now()
    const timeoutMs = options.timeoutMs ?? this.timeoutMs

    // Resolve which tool to use
    const codegraphAvailable = this.hasCodegraphDir(projectDir)
    const graphifyAvailable = this.hasGraphifyDir(projectDir)

    let kind: GraphToolKind = null
    let cmd: string | null = null
    let args: string[] = []

    if (codegraphAvailable) {
      cmd = options.codegraphBin ?? "codegraph"
      args = ["explore", query, "--project-path", projectDir]
      kind = "codegraph"
    } else if (graphifyAvailable) {
      cmd = options.graphifyBin ?? "graphify"
      args = ["query", query, "--graph", join(projectDir, "graphify-out")]
      kind = "graphify"
    }

    if (!cmd || !kind) {
      return {
        kind: null,
        query,
        result: null,
        timedOut: false,
        durationMs: Date.now() - start,
      }
    }

    // Spawn with timeout
    try {
      const output = await this.spawnWithTimeout(cmd, args, timeoutMs, projectDir)
      return {
        kind,
        query,
        result: output.trim() || null,
        timedOut: false,
        durationMs: Date.now() - start,
      }
    } catch (err) {
      const isTimeout = err instanceof Error && err.message.includes("timed out")
      return {
        kind,
        query,
        result: null,
        timedOut: isTimeout,
        durationMs: Date.now() - start,
      }
    }
  }

  private spawnWithTimeout(
    cmd: string,
    args: string[],
    timeoutMs: number,
    cwd: string,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        shell: process.platform === "win32", // use shell on Windows for .cmd/.bat lookup
      })
      let stdout = ""
      let stderr = ""
      let killed = false

      const timer = setTimeout(() => {
        killed = true
        child.kill("SIGKILL")
        reject(new Error(`graph retrieval subprocess timed out after ${timeoutMs}ms`))
      }, timeoutMs)

      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8")
      })
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8")
      })

      child.on("error", (err) => {
        clearTimeout(timer)
        if (!killed) reject(err)
      })
      child.on("close", (code) => {
        clearTimeout(timer)
        if (killed) return // already rejected by timeout
        if (code === 0) {
          resolve(stdout)
        } else {
          reject(new Error(`graph retrieval subprocess exited ${code}: ${stderr.slice(0, 200)}`))
        }
      })
    })
  }

  // -------- CodeGraph sub-commands (v0.14.0) --------

  // These sub-commands are codegraph-specific. Graphify has no equivalent,
  // so we return null when codegraph is unavailable.

  /**
   * Get the source code and direct callers of a symbol.
   * Runs `codegraph node <symbol> --project-path <cwd>`.
   */
  async invokeNode(
    symbol: string,
    projectDir: string,
    options: InvokeOptions = {},
  ): Promise<GraphInvocationResult> {
    return this.invokeCodegraphSubcommand("node", symbol, projectDir, options)
  }

  /**
   * List all call sites of a symbol.
   * Runs `codegraph callers <symbol> --project-path <cwd>`.
   */
  async invokeCallers(
    symbol: string,
    projectDir: string,
    options: InvokeOptions = {},
  ): Promise<GraphInvocationResult> {
    return this.invokeCodegraphSubcommand("callers", symbol, projectDir, options)
  }

  /**
   * Full impact analysis: direct callers, transitive callers,
   * affected test files, affected doc files.
   * Runs `codegraph impact <symbol> --project-path <cwd>`.
   */
  async invokeImpact(
    symbol: string,
    projectDir: string,
    options: InvokeOptions = {},
  ): Promise<GraphInvocationResult> {
    return this.invokeCodegraphSubcommand("impact", symbol, projectDir, options)
  }

  /**
   * List all indexed files.
   * Runs `codegraph files --project-path <cwd>`.
   */
  async invokeFiles(
    projectDir: string,
    options: InvokeOptions = {},
  ): Promise<GraphInvocationResult> {
    return this.invokeCodegraphSubcommand("files", undefined, projectDir, options)
  }

  // -------- Internal: shared codegraph sub-command runner --------

  /**
   * Run a codegraph sub-command and return the result.
   * Returns null result if codegraph is not available.
   */
  private async invokeCodegraphSubcommand(
    subcommand: "node" | "callers" | "impact" | "files",
    argument: string | undefined,
    projectDir: string,
    options: InvokeOptions,
  ): Promise<GraphInvocationResult> {
    const start = Date.now()
    const timeoutMs = options.timeoutMs ?? this.timeoutMs

    // Codegraph is the only tool that supports these sub-commands.
    if (!this.hasCodegraphDir(projectDir)) {
      return {
        kind: null,
        query: argument ?? subcommand,
        result: null,
        timedOut: false,
        durationMs: Date.now() - start,
      }
    }

    const cmd = options.codegraphBin ?? "codegraph"
    const args = argument
      ? [subcommand, argument, "--project-path", projectDir]
      : [subcommand, "--project-path", projectDir]

    try {
      const output = await this.spawnWithTimeout(cmd, args, timeoutMs, projectDir)
      return {
        kind: "codegraph",
        query: argument ?? subcommand,
        result: output.trim() || null,
        timedOut: false,
        durationMs: Date.now() - start,
      }
    } catch (err) {
      const isTimeout = err instanceof Error && /timed out/i.test(err.message)
      return {
        kind: "codegraph",
        query: argument ?? subcommand,
        result: null,
        timedOut: isTimeout,
        durationMs: Date.now() - start,
      }
    }
  }

  // -------- Graphify sub-commands (v0.14.0) --------

  /**
   * Find the shortest conceptual path between two concepts.
   * Runs `graphify path <from> <to>`.
   * Returns null if graphify is not available.
   */
  async invokePath(
    from: string,
    to: string,
    projectDir: string,
    options: InvokeOptions = {},
  ): Promise<GraphInvocationResult> {
    const start = Date.now()
    const timeoutMs = options.timeoutMs ?? this.timeoutMs
    if (!this.hasGraphifyDir(projectDir)) {
      return { kind: null, query: `${from} ${to}`, result: null, timedOut: false, durationMs: Date.now() - start }
    }
    const cmd = "graphify"
    const args = ["path", from, to]
    try {
      const output = await this.spawnWithTimeout(cmd, args, timeoutMs, projectDir)
      return { kind: "graphify", query: `${from} ${to}`, result: output.trim() || null, timedOut: false, durationMs: Date.now() - start }
    } catch (err) {
      return { kind: "graphify", query: `${from} ${to}`, result: null, timedOut: err instanceof Error && /timed out/i.test(err.message), durationMs: Date.now() - start }
    }
  }

  /**
   * Get a plain-language explanation of a concept from the knowledge graph.
   * Runs `graphify explain <concept>`.
   * Returns null if graphify is not available.
   */
  async invokeExplain(
    concept: string,
    projectDir: string,
    options: InvokeOptions = {},
  ): Promise<GraphInvocationResult> {
    return this.invokeGraphifySubcommand("explain", concept, projectDir, options)
  }

  // -------- AFT tools (v0.14.0) --------

  /**
   * Get a structural outline of a file or directory.
   * Runs `aft outline <path>`.
   */
  async invokeAFTOutline(
    targetPath: string,
    options: InvokeOptions = {},
  ): Promise<GraphInvocationResult> {
    return this.invokeAFTSubcommand("outline", targetPath, options)
  }

  /**
   * Find a symbol by name.
   * Runs `aft zoom <symbol>`.
   */
  async invokeAFTZoom(
    symbol: string,
    options: InvokeOptions = {},
  ): Promise<GraphInvocationResult> {
    return this.invokeAFTSubcommand("zoom", symbol, options)
  }

  /**
   * Create a named checkpoint via AFT.
   * Runs `aft safety checkpoint --name <name>`.
   */
  async invokeAFTCheckpoint(
    name: string,
    options: InvokeOptions = {},
  ): Promise<GraphInvocationResult> {
    return this.invokeAFTSubcommand("safety", ["checkpoint", "--name", name], options)
  }

  /**
   * Undo the last change via AFT.
   * Runs `aft safety undo`.
   */
  async invokeAFTUndo(
    options: InvokeOptions = {},
  ): Promise<GraphInvocationResult> {
    return this.invokeAFTSubcommand("safety", "undo", options)
  }

  // -------- Internal: shared sub-command runners --------

  private async invokeGraphifySubcommand(
    subcommand: "path" | "explain",
    argument: string,
    projectDir: string,
    options: InvokeOptions,
  ): Promise<GraphInvocationResult> {
    const start = Date.now()
    const timeoutMs = options.timeoutMs ?? this.timeoutMs
    if (!this.hasGraphifyDir(projectDir)) {
      return { kind: null, query: argument, result: null, timedOut: false, durationMs: Date.now() - start }
    }
    const cmd = "graphify"
    const args = [subcommand, argument]
    try {
      const output = await this.spawnWithTimeout(cmd, args, timeoutMs, projectDir)
      return { kind: "graphify", query: argument, result: output.trim() || null, timedOut: false, durationMs: Date.now() - start }
    } catch (err) {
      return { kind: "graphify", query: argument, result: null, timedOut: err instanceof Error && /timed out/i.test(err.message), durationMs: Date.now() - start }
    }
  }

  private async invokeAFTSubcommand(
    subcommand: "outline" | "zoom" | "safety",
    argument: string | string[],
    options: InvokeOptions,
  ): Promise<GraphInvocationResult> {
    const start = Date.now()
    const timeoutMs = options.timeoutMs ?? this.timeoutMs
    const cmd = options.codegraphBin ?? "aft"
    // v0.16.0: F3.1 — split string[] args correctly. The previous version
    // wrapped the entire argument into one argv slot, so 'aft safety
    // checkpoint --name "my name"' on Linux failed because the shell-less
    // spawn saw the whole string as a single arg.
    const queryLabel = Array.isArray(argument) ? argument.join(" ") : argument
    const args = [subcommand, ...(Array.isArray(argument) ? argument : [argument])]
    // F3.2: respect options.projectDir; fall back to process.cwd().
    const cwd = options.projectDir ?? process.cwd()
    try {
      const output = await this.spawnWithTimeout(cmd, args, timeoutMs, cwd)
      return { kind: "codegraph", query: queryLabel, result: output.trim() || null, timedOut: false, durationMs: Date.now() - start }
    } catch (err) {
      return { kind: null, query: queryLabel, result: null, timedOut: err instanceof Error && /timed out/i.test(err.message), durationMs: Date.now() - start }
    }
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton
// ---------------------------------------------------------------------------

let _default: GraphRetrieval | null = null

/** Returns the process-wide singleton, creating it on first use. */
export function getDefaultGraphRetrieval(): GraphRetrieval {
  if (!_default) _default = new GraphRetrieval()
  return _default
}

// Re-export existsSync for tests
export { existsSync }
