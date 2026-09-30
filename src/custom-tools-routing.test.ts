/**
 * Routing suffix in tool descriptions (Wave C part 2).
 *
 * Why this exists: tool descriptions are visible on every turn, while the
 * graph-priming injection fires once per session. These tests pin that the
 * canonical ROUTING_MATRIX line is embedded in the discovery tool
 * descriptions, so the agent knows which tool to use without depending on
 * that one-shot injection.
 *
 * Strategy: assert via the routingSuffixFor() helper itself (never hardcoded
 * literals), so a matrix change updates expectations automatically. A test
 * pinning the literal line would be pretend-coverage that breaks on sync.
 */
import { describe, expect, it } from "bun:test"
import {
  buildOmoExplainTool,
  buildOmoFindTool,
  buildOmoImpactTool,
  buildOmoPathTool,
  buildOmoRecallMcpTool,
  buildOmoRecallTool,
  buildOmoSearchTool,
  routingSuffixFor,
} from "./custom-tools"
import type { GraphRetrieval } from "./graph-retrieval"
import type { SqliteBackend } from "./sqlite-backend"

describe("routingSuffixFor", () => {
  it("returns a ROUTING line naming omo_search", () => {
    const suffix = routingSuffixFor("omo_search")
    expect(suffix).toContain("ROUTING:")
    expect(suffix).toContain("omo_search")
    expect(suffix).toContain("->")
  })

  it("returns a ROUTING line naming omo_find", () => {
    const suffix = routingSuffixFor("omo_find")
    expect(suffix).toContain("ROUTING:")
    expect(suffix).toContain("omo_find")
  })

  it("returns a ROUTING line naming omo_impact", () => {
    const suffix = routingSuffixFor("omo_impact")
    expect(suffix).toContain("ROUTING:")
    expect(suffix).toContain("omo_impact")
  })

  it("returns a ROUTING line naming omo_recall", () => {
    const suffix = routingSuffixFor("omo_recall")
    expect(suffix).toContain("ROUTING:")
    expect(suffix).toContain("omo_recall")
  })

  it("returns empty string for a tool with no matrix entry", () => {
    expect(routingSuffixFor("omo_nonexistent_tool")).toBe("")
  })
})

describe("discovery tool descriptions embed the canonical routing line", () => {
  const fakeRetrieval = {} as unknown as GraphRetrieval
  const fakeSqlite = {
    smartSearch: async () => ({ lessons: [], crystals: [] }),
  } as unknown as SqliteBackend

  it("omo_search description contains its routing line exactly once", () => {
    const t = buildOmoSearchTool({ graphRetrieval: fakeRetrieval, cwd: "/tmp" })
    const expected = routingSuffixFor("omo_search")
    expect(expected).not.toBe("")
    expect(t.description).toContain(expected)
    expect(t.description.split("ROUTING:").length - 1).toBe(1)
  })

  it("omo_find description contains its routing line exactly once", () => {
    const t = buildOmoFindTool({ cwd: "/tmp" })
    const expected = routingSuffixFor("omo_find")
    expect(expected).not.toBe("")
    expect(t.description).toContain(expected)
    expect(t.description.split("ROUTING:").length - 1).toBe(1)
  })

  it("omo_impact description contains its routing line", () => {
    const t = buildOmoImpactTool({ cwd: "/tmp" })
    expect(t.description).toContain(routingSuffixFor("omo_impact"))
  })

  it("omo_path description contains its routing line", () => {
    const t = buildOmoPathTool({ cwd: "/tmp" })
    expect(t.description).toContain(routingSuffixFor("omo_path"))
  })

  it("omo_explain description contains its routing line", () => {
    const t = buildOmoExplainTool({ cwd: "/tmp" })
    expect(t.description).toContain(routingSuffixFor("omo_explain"))
  })

  it("omo_recall description contains its routing line", () => {
    const t = buildOmoRecallTool({ sqlite: fakeSqlite })
    expect(t.description).toContain(routingSuffixFor("omo_recall"))
  })

  it("omo_recall_mcp description contains its routing line", () => {
    const t = buildOmoRecallMcpTool({})
    expect(t.description).toContain(routingSuffixFor("omo_recall_mcp"))
  })
})
