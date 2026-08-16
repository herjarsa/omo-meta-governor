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

import { runGuarded } from "./proc-guard"
import { statSync, existsSync } from "node:fs"
import { join } from "node:path"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GraphToolKind = "codegraph" | "graphify" | null

/**
 * v0.25.0: explicit routing preference between codegraph and graphify.
 * - "auto" (default): codegraph first, graphify as fallback.
 * - "codegraph": always codegraph when available (never graphify).
 * - "graphify": always graphify when available (never codegraph).
 * - "alternate": deterministic per-query round-robin (hash parity).
 */
export type GraphToolPreference = "auto" | "codegraph" | "graphify" | "alternate"

/**
 * v0.25.0: pure selection logic — pick which graph tool to invoke.
 * Deterministic (same inputs → same choice), platform-independent,
 * unit-testable without subprocesses.
 */
export function selectGraphTool(
  preference: GraphToolPreference,
  codegraphAvailable: boolean,
  graphifyAvailable: boolean,
  query?: string,
): { kind: "codegraph" | "graphify"; cmd: string; args: string[] } | null {
  const both = codegraphAvailable && graphifyAvailable
  if (preference === "codegraph") {
    return codegraphAvailable ? { kind: "codegraph", cmd: "codegraph", args: [] } : null
  }
  if (preference === "graphify") {
    return graphifyAvailable ? { kind: "graphify", cmd: "graphify", args: [] } : null
  }
  if (preference === "alternate" && both) {
    // Deterministic parity split: same query → same tool every time (cache-stable).
    // Sum of char codes gives even distribution across short queries.
    const sum = (query ?? "").trim().toLowerCase().split("").reduce((acc, ch) => acc + ch.charCodeAt(0), 0)
    const even = sum % 2 === 0
    return even
      ? { kind: "codegraph", cmd: "codegraph", args: [] }
      : { kind: "graphify", cmd: "graphify", args: [] }
  }
  // auto (or alternate with a single tool): codegraph-first, graphify fallback.
  if (codegraphAvailable) return { kind: "codegraph", cmd: "codegraph", args: [] }
  if (graphifyAvailable) return { kind: "graphify", cmd: "graphify", args: [] }
  return null
}

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
  /** v0.25.0: explicit codegraph/graphify routing. Default "auto". */
  preferredTool?: GraphToolPreference
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
  /** v0.25.0: per-call routing override. Default: instance preference. */
  preferredTool?: GraphToolPreference
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
  /** v0.25.0: routing preference. Mutable — configureDefaultGraphRetrieval updates it. */
  private preferredTool: GraphToolPreference

  constructor(config: GraphRetrievalConfig = {}) {
    this.timeoutMs = config.timeoutMs ?? 5_000
    this.cacheTtlMs = config.cacheTtlMs ?? 300_000
    this.maxEntriesPerSession = config.maxEntriesPerSession ?? 10
    this.preferredTool = config.preferredTool ?? "auto"
  }

  /** v0.25.0: runtime routing update (used by configureDefaultGraphRetrieval). */
  setPreferredTool(preference: GraphToolPreference): void {
    this.preferredTool = preference
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
   * Selection logic (v0.25.0 — explicit routing via selectGraphTool):
   * - preferredTool "auto": codegraph first, graphify fallback.
   * - "codegraph" / "graphify": only that tool (when available).
   * - "alternate": deterministic hash-parity round-robin when both exist.
   * 3. Else → return null result
   */
  async invoke(
    projectDir: string,
    query: string,
    options: InvokeOptions = {},
  ): Promise<GraphInvocationResult> {
    const start = Date.now()
    const timeoutMs = options.timeoutMs ?? this.timeoutMs

    // Resolve which tool to use (v0.25.0: explicit routing).
    const codegraphAvailable = this.hasCodegraphDir(projectDir)
    const graphifyAvailable = this.hasGraphifyDir(projectDir)
    const preference = options.preferredTool ?? this.preferredTool
    const selected = selectGraphTool(preference, codegraphAvailable, graphifyAvailable, query)

    let kind: GraphToolKind = null
    let cmd: string | null = null
    let args: string[] = []

    if (selected) {
      kind = selected.kind
      if (kind === "codegraph") {
        cmd = options.codegraphBin ?? "codegraph"
        args = ["explore", query, "--project-path", projectDir]
      } else {
        cmd = options.graphifyBin ?? "graphify"
        args = ["query", query, "--graph", join(projectDir, "graphify-out")]
      }
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
    return runGuarded(cmd, args, { cwd, timeoutMs }).then((res) => {
      if (res.timedOut) {
        throw new Error(`graph retrieval subprocess timed out after ${timeoutMs}ms`)
      }
      if (res.code === null) {
        throw new Error(`graph retrieval subprocess failed to spawn: ${cmd}`)
      }
      if (res.code !== 0) {
        throw new Error(`graph retrieval subprocess exited ${res.code}: ${res.stderr.slice(0, 200)}`)
      }
      return res.stdout
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
    const cmd = options.graphifyBin ?? "graphify"
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

  // -------- Internal: graphify sub-command runner --------

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
    const cmd = options.graphifyBin ?? "graphify"
    const args = [subcommand, argument]
    try {
      const output = await this.spawnWithTimeout(cmd, args, timeoutMs, projectDir)
      return { kind: "graphify", query: argument, result: output.trim() || null, timedOut: false, durationMs: Date.now() - start }
    } catch (err) {
      return { kind: "graphify", query: argument, result: null, timedOut: err instanceof Error && /timed out/i.test(err.message), durationMs: Date.now() - start }
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

/**
 * v0.25.0: update the singleton's routing preference WITHOUT replacing the
 * instance — tools capture the reference at build time (omo_search) or
 * resolve it at execute time (omo_path/omo_explain); replacing would
 * strand the captured instance.
 */
export function configureDefaultGraphRetrieval(config: GraphRetrievalConfig): void {
  const inst = getDefaultGraphRetrieval()
  if (config.preferredTool) inst.setPreferredTool(config.preferredTool)
}

// Re-export existsSync for tests
export { existsSync }
