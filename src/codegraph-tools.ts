/**
 * codegraph-tools — high-level wrappers around codegraph's sub-commands
 * (node, callers, impact, files) for use in custom tools.
 *
 * codegraph is invoked via the `codegraph` CLI (not via MCP). Available
 * sub-commands we wrap here:
 *   - codegraph node <symbol>      → get source + callers of a symbol
 *   - codegraph callers <symbol>   → list call sites of a symbol
 *   - codegraph impact <symbol>    → full impact analysis (callers + tests + docs)
 *   - codegraph files              → list indexed files
 *
 * v0.14.0 adds these on top of the v0.13.0 `omo_search` (which uses
 * `codegraph explore`). Together they give the LLM a full codegraph
 * toolkit: search, find, callers, impact, files.
 *
 * Design:
 * - Pure CLI invocation via GraphRetrieval (which already handles
 *   timeout, error catching, and graceful degradation)
 * - Each function returns null when the tool is unavailable — the
 *   caller decides what to do (e.g., suggest a fallback)
 * - All functions take cwd + optional cli path override
 */

import { getDefaultGraphRetrieval, type GraphRetrieval } from "./graph-retrieval"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OmoFindResult {
  /** The symbol that was searched */
  symbol: string
  /** Source code of the definition (formatted) */
  source: string | null
  /** List of call sites (file:line format) */
  callers: Array<{ file: string; line: number; context: string }>
  /** True if the symbol was found */
  found: boolean
  /** Tool that produced the result */
  kind: "codegraph" | "graphify" | null
  /** Total time taken */
  durationMs: number
}

export interface OmoImpactResult {
  /** The symbol being analyzed */
  symbol: string
  /** Direct callers (file:line) */
  directCallers: Array<{ file: string; line: number; context: string }>
  /** Transitive callers (if available from the tool) */
  transitiveCallers: Array<{ file: string; line: number; context: string }>
  /** Test files affected (if available) */
  testFiles: string[]
  /** Documentation files affected (if available) */
  docFiles: string[]
  /** Total affected file count */
  totalAffectedFiles: number
  /** Tool that produced the result */
  kind: "codegraph" | "graphify" | null
  /** Total time taken */
  durationMs: number
  /** Whether the analysis timed out */
  timedOut: boolean
}

export interface OmoFilesResult {
  files: string[]
  count: number
  kind: "codegraph" | "graphify" | null
  durationMs: number
}

// ---------------------------------------------------------------------------
// Default singleton
// ---------------------------------------------------------------------------

const _default = getDefaultGraphRetrieval()

/**
 * Default entry point: use the singleton GraphRetrieval.
 * Tests can construct their own CodeGraphTools with a custom instance.
 */
export class CodeGraphTools {
  constructor(private retrieval: GraphRetrieval = _default) {}

  // -------- omo_find --------

  /**
   * Find a symbol's definition and direct callers.
   * Uses `codegraph node <symbol>` for codegraph, `graphify query <symbol>` for graphify.
   */
  async find(
    symbol: string,
    cwd: string,
    timeoutMs = 5_000,
  ): Promise<OmoFindResult> {
    const start = Date.now()
    const nodeResult = await this.retrieval.invokeNode(symbol, cwd, { timeoutMs })
    if (nodeResult.kind === "codegraph" && nodeResult.result) {
      return parseCodegraphNodeResult(symbol, nodeResult.result, start, "codegraph")
    }
    // Fallback: graphify doesn't have a "node" sub-command — use query
    const queryResult = await this.retrieval.invoke(cwd, symbol, { timeoutMs })
    if (queryResult.kind === "graphify" && queryResult.result) {
      return parseGraphifyQueryResult(symbol, queryResult.result, start, "graphify")
    }
    return {
      symbol,
      source: null,
      callers: [],
      found: false,
      kind: nodeResult.kind ?? queryResult.kind,
      durationMs: Date.now() - start,
    }
  }

  // -------- omo_impact --------

  /**
   * Analyze the impact of changing a symbol. Lists direct callers,
   * transitive callers, and affected test/doc files.
   * Uses `codegraph impact <symbol>` if available, else `codegraph callers`.
   */
  async impact(
    symbol: string,
    cwd: string,
    timeoutMs = 5_000,
  ): Promise<OmoImpactResult> {
    const start = Date.now()
    const impactResult = await this.retrieval.invokeImpact(symbol, cwd, { timeoutMs })
    if (impactResult.kind === "codegraph" && impactResult.result) {
      return parseCodegraphImpactResult(symbol, impactResult.result, start, "codegraph", impactResult.timedOut)
    }
    // Fallback: use callers
    const callersResult = await this.retrieval.invokeCallers(symbol, cwd, { timeoutMs })
    if (callersResult.kind === "codegraph" && callersResult.result) {
      return {
        symbol,
        directCallers: parseCallers(callersResult.result),
        transitiveCallers: [],
        testFiles: [],
        docFiles: [],
        totalAffectedFiles: new Set(parseCallers(callersResult.result).map((c) => c.file)).size,
        kind: "codegraph",
        durationMs: Date.now() - start,
        timedOut: callersResult.timedOut,
      }
    }
    return {
      symbol,
      directCallers: [],
      transitiveCallers: [],
      testFiles: [],
      docFiles: [],
      totalAffectedFiles: 0,
      kind: impactResult.kind ?? callersResult.kind,
      durationMs: Date.now() - start,
      timedOut: impactResult.timedOut || callersResult.timedOut,
    }
  }

  // -------- omo_files (utility for the other tools) --------

  /**
   * List indexed files. Uses `codegraph files`.
   */
  async listFiles(cwd: string, timeoutMs = 5_000): Promise<OmoFilesResult> {
    const start = Date.now()
    const result = await this.retrieval.invokeFiles(cwd, { timeoutMs })
    if (result.kind === "codegraph" && result.result) {
      const files = result.result.split("\n").map((l) => l.trim()).filter(Boolean)
      return { files, count: files.length, kind: "codegraph", durationMs: Date.now() - start }
    }
    return { files: [], count: 0, kind: result.kind, durationMs: Date.now() - start }
  }
}

// ---------------------------------------------------------------------------
// Parsers (handle the various codegraph output formats)
// ---------------------------------------------------------------------------

/**
 * Parse output of `codegraph node <symbol>`.
 * Expected format varies by version. Common: source code + caller list.
 * We use a tolerant parser that handles multiple layouts.
 */
function parseCodegraphNodeResult(
  symbol: string,
  raw: string,
  start: number,
  kind: "codegraph" | "graphify",
): OmoFindResult {
  const callers = parseCallers(raw)
  // Source: everything before the "Callers:" or "## Callers" header,
  // or the full text if no header found
  const callerIdx = raw.search(/callers?:|## callers?/i)
  const source = callerIdx > 0 ? raw.slice(0, callerIdx).trim() : raw.trim()
  return {
    symbol,
    source: source || null,
    callers,
    found: callers.length > 0 || source.length > 0,
    kind,
    durationMs: Date.now() - start,
  }
}

/**
 * Parse output of `graphify query <symbol>` — typically just text
 * mentioning the concept. No structured source/callers, so we
 * return the whole result as a pseudo-source.
 */
function parseGraphifyQueryResult(
  symbol: string,
  raw: string,
  start: number,
  kind: "codegraph" | "graphify",
): OmoFindResult {
  return {
    symbol,
    source: raw.trim() || null,
    callers: [],
    found: raw.trim().length > 0,
    kind,
    durationMs: Date.now() - start,
  }
}

/**
 * Parse output of `codegraph impact <symbol>`.
 * Sections typically: "Direct callers:", "Transitive callers:", "Tests:", "Docs:"
 */
function parseCodegraphImpactResult(
  symbol: string,
  raw: string,
  start: number,
  kind: "codegraph" | "graphify",
  timedOut: boolean,
): OmoImpactResult {
  const directCallers = extractSection(raw, /direct\s*callers?:|## direct/i)
  const transitiveCallers = extractSection(raw, /transitive\s*callers?:|## transitive/i)
  const testFiles = extractListSection(raw, /tests?:|## tests?/i)
  const docFiles = extractListSection(raw, /docs?:|## docs?/i)
  const allFiles = new Set<string>()
  for (const c of directCallers) allFiles.add(c.file)
  for (const c of transitiveCallers) allFiles.add(c.file)
  for (const f of testFiles) allFiles.add(f)
  for (const f of docFiles) allFiles.add(f)
  return {
    symbol,
    directCallers,
    transitiveCallers,
    testFiles,
    docFiles,
    totalAffectedFiles: allFiles.size,
    kind,
    durationMs: Date.now() - start,
    timedOut,
  }
}

/**
 * Parse a section that lists file:line references. Common formats:
 *   "src/foo.ts:42 — context here"
 *   "src/foo.ts:42: context"
 *   "  - src/foo.ts:42"
 */
function parseCallers(raw: string): Array<{ file: string; line: number; context: string }> {
  const results: Array<{ file: string; line: number; context: string }> = []
  const lines = raw.split("\n")
  for (const line of lines) {
    // Match: file.ts:LINE  or  file.ts:LINE:context  or  file.ts:LINE — context
    const m = line.match(/^\s*[-*]?\s*([^\s:]+\.[a-z]+):(\d+)(?:[:\s—–-]+(.+))?/i)
    if (m) {
      const file = m[1] ?? ""
      const lineNum = m[2] ? parseInt(m[2], 10) : 0
      const context = (m[3] ?? "").trim()
      if (file && lineNum > 0) results.push({ file, line: lineNum, context })
    }
  }
  return results
}

/**
 * Extract a section that uses parseCallers format.
 * Sections are delimited by headers (lines starting with #) or blank lines.
 */
function extractSection(
  raw: string,
  headerPattern: RegExp,
): Array<{ file: string; line: number; context: string }> {
  const lines = raw.split("\n")
  let inSection = false
  const buffer: string[] = []
  for (const line of lines) {
    if (headerPattern.test(line)) {
      inSection = true
      continue
    }
    if (inSection) {
      // Stop at next header
      if (/^#\s/.test(line) && !headerPattern.test(line)) break
      if (line.trim() === "" && buffer.length > 0) break
      buffer.push(line)
    }
  }
  return parseCallers(buffer.join("\n"))
}

/**
 * Extract a section that lists bare file paths (no line numbers).
 */
function extractListSection(raw: string, headerPattern: RegExp): string[] {
  const lines = raw.split("\n")
  let inSection = false
  const files: string[] = []
  for (const line of lines) {
    if (headerPattern.test(line)) {
      inSection = true
      continue
    }
    if (inSection) {
      if (/^#\s/.test(line) && !headerPattern.test(line)) break
      if (line.trim() === "" && files.length > 0) break
      const cleaned = line.trim().replace(/^[-*]\s*/, "")
      if (cleaned.match(/[^\s:]+\.[a-z]+/i)) files.push(cleaned)
    }
  }
  return files
}

// ---------------------------------------------------------------------------
// Module-level singleton
// ---------------------------------------------------------------------------

let _singleton: CodeGraphTools | null = null

/** Returns the process-wide CodeGraphTools singleton. */
export function getDefaultCodeGraphTools(): CodeGraphTools {
  if (!_singleton) _singleton = new CodeGraphTools()
  return _singleton
}
