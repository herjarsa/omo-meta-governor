/**
 * Routing matrix - single canonical source for tool routing.
 *
 * Why this exists: the same routing knowledge was duplicated in 5 sites
 * (skill-priming body, enforcement-resources bullets, plugin digest,
 * plugin ES bullets, protocol-enforcer table). Drift between copies meant
 * agents got conflicting guidance. This module is pure (no I/O) so every
 * site renders from the same data and stays in sync.
 *
 * Decision order: entries are ordered by decision priority - architecture
 * first, symbol lookup next, blast radius before edits, memory last,
 * literal grep only as fallback.
 */
export type RoutingBackend = "codegraph" | "graphify" | "memory" | "plugin"
export type RoutingEntry = {
  question: string
  tools: readonly string[]
  backend: RoutingBackend
  note?: string
}
/**
 * Why ~13 entries: covers every routing case the 5 duplicated sites
 * previously described - from architecture down to literal fallback.
 * First 10 are the primary decision path used by formatRoutingMatrixLines.
 */
export const ROUTING_MATRIX: readonly RoutingEntry[] = [
  {
    question: "Architecture / arquitectura / concepts / cross-module relationships",
    tools: ["omo_search"],
    backend: "graphify",
    note: "auto-routes between codegraph + graphify"
  },
  {
    question: "Symbol / simbolo definition / definicion + call sites",
    tools: ["omo_find"],
    backend: "codegraph"
  },
  {
    question: "Symbol / simbolo source + direct callers",
    tools: ["omo_node"],
    backend: "codegraph"
  },
  {
    question: "Call sites only",
    tools: ["omo_callers"],
    backend: "codegraph"
  },
  {
    question: "Blast radius / impacto BEFORE modifying",
    tools: ["omo_impact"],
    backend: "codegraph",
    note: "run BEFORE modifying"
  },
  {
    question: "Connections / conexiones between two parts",
    tools: ["omo_path"],
    backend: "graphify"
  },
  {
    question: "Concept / concepto explanation / overview",
    tools: ["omo_explain"],
    backend: "graphify"
  },
  {
    question: "Indexed files list / lista de archivos indexados",
    tools: ["omo_files"],
    backend: "codegraph"
  },
  {
    question: "File context / contexto and blast radius of files / archivos",
    tools: ["omo_affected"],
    backend: "codegraph"
  },
  {
    question: "Past lessons / lecciones, decisions / decisiones, prior solutions",
    tools: ["omo_recall", "omo_recall_mcp"],
    backend: "memory",
    note: "fallback omo_recall_mcp when empty"
  },
  {
    question: "Plugin / graph status / estado del plugin / grafo",
    tools: ["omo_health", "omo_status"],
    backend: "plugin"
  },
  {
    question: "Repo overview / vista general",
    tools: ["graphify-out/GRAPH_REPORT.md"],
    backend: "graphify"
  },
  {
    question: "Literal byte patterns (fallback)",
    tools: ["grep"],
    backend: "plugin",
    note: "fallback only when indexed queries cannot answer"
  }
]
/**
 * Why token overlap: questions are bilingual (English / Spanish) so a
 * case-insensitive keyword from either language matches. Tokens under
 * 4 chars are ignored to avoid matching stopwords like "de" or "del".
 * Returns [] when nothing matches so callers can fall back to grep.
 */
export function recommendedTools(question: string): readonly RoutingEntry[] {
  const lower = question.toLowerCase()
  const inputTokens = lower.split(/[^a-z0-9\u00e1\u00e9\u00ed\u00f3\u00fa\u00f1\u00fc]+/).filter((t) => t.length >= 4)
  if (inputTokens.length === 0) return []
  return ROUTING_MATRIX.filter((entry) => {
    const qTokens = entry.question.toLowerCase().split(/[^a-z0-9\u00e1\u00e9\u00ed\u00f3\u00fa\u00f1\u00fc]+/).filter((t) => t.length >= 4)
    return qTokens.some((qt) => inputTokens.some((it) => it.includes(qt) || qt.includes(it)))
  })
}
/**
 * Why exact strings: buildGraphPrimingMessage previously inlined these
 * 6 lines. Existing tests assert toContain for omo_search, omo_find,
 * omo_impact, omo_path, omo_recall, omo_health plus graphify, codegraph
 * and [GRAPH PRIMING]. Any wording change breaks those tests, so the
 * canon preserves them verbatim.
 */
export function formatGraphPrimingBody(): string {
  return [
    "[GRAPH PRIMING] Before grep/regex/glob/raw read, query the project's own indexes:",
    "1. Architecture / concepts / cross-module relationships -> omo_search (auto-routes between codegraph + graphify).",
    "2. Symbol-level lookup, call graph, impact analysis -> omo_find / omo_impact / omo_path.",
    "3. Past lessons, decisions, prior solutions -> omo_recall (local SQLite FTS5).",
    "4. Project status (codegraph health, recent decisions) -> omo_health / omo_status.",
    "Use raw grep ONLY when the indexed queries above cannot answer the question (e.g. literal byte patterns, throwaway strings)."
  ].join("\n")
}
/**
 * Why slice 10: the matrix holds ~13 entries but the enforcement rule
 * keeps context small - first 10 cover the primary decision path.
 * Bullet form matches enforcement-resources style, numbered matches digest.
 */
export function formatRoutingMatrixLines(opts?: { bullet?: boolean }): string {
  const first = ROUTING_MATRIX.slice(0, 10)
  if (opts?.bullet) {
    return first.map((e) => "- " + e.question + " -> " + e.tools.join(" / ") + " (" + e.backend + ")").join("\n")
  }
  return first.map((e, i) => (i + 1) + ". " + e.question + " -> " + e.tools.join(" / ") + " (" + e.backend + ")").join("\n")
}
/**
 * Why verbatim: plugin.ts digest previously inlined this exact string.
 * Digest tests and downstream parsers match on "=>" and tool names,
 * so the canon reproduces it character-for-character.
 */
export function formatDigestRouting(): string {
  return "GRAPH ROUTING (codegraph/graphify ready):\nSymbols/definitions/callers/impact => CODEGRAPH (omo_find, omo_impact, omo_search).\nConcepts/architecture/connections => GRAPHIFY (omo_path, omo_explain).\nRepo overview => graphify-out/GRAPH_REPORT.md."
}
/**
 * Why ASCII: plugin.ts ES bullets previously used mojibake arrows and
 * double-encoded accents (bullet + arrow bytes). The canon uses ASCII
 * "->" and accent-free Spanish so the file stays utf-8 clean.
 * Includes the CODEGRAPH line so both backends are listed.
 */
export function formatGraphRoutingBulletsES(): string {
  return [
    "Simbolos/definiciones/callers/impacto (codigo) -> CODEGRAPH: omo_find, omo_impact, omo_search.",
    "Conceptos/arquitectura/conexiones/explicaciones -> GRAPHIFY: omo_path, omo_explain (y omo_search en modo alternate).",
    "Vista general del repo -> lee graphify-out/GRAPH_REPORT.md."
  ].join("\n")
}
