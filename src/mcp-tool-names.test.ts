/**
 * v0.36.0 (audit P0-2) — MCP_TOOL_NAMES must mirror buildAdapters().
 *
 * Bug: buildAdapters() in src/mcp-tools.ts registered 22 tools including
 * omo_skill_local_link, omo_skill_semantic_find, omo_skill_create (added in
 * v0.35.8/v0.35.9), but the MCP_TOOL_NAMES constant was never updated. Any CI
 * check that asserts adapters ⊆ MCP_TOOL_NAMES would silently pass with a
 * stale allowlist.
 */
import { describe, expect, it } from "bun:test"
import { MCP_TOOL_NAMES, getAdapters } from "./mcp-tools"

describe("P0-2 MCP_TOOL_NAMES mirrors buildAdapters", () => {
  it("then every adapter name is present in MCP_TOOL_NAMES", () => {
    const adapterNames = getAdapters().map((a) => a.name).sort()
    const constantNames = [...MCP_TOOL_NAMES].sort()
    expect(constantNames).toEqual(adapterNames)
  })

  it("then omo_skill_local_link, omo_skill_semantic_find, omo_skill_create are exposed", () => {
    expect(MCP_TOOL_NAMES).toContain("omo_skill_local_link")
    expect(MCP_TOOL_NAMES).toContain("omo_skill_semantic_find")
    expect(MCP_TOOL_NAMES).toContain("omo_skill_create")
  })

  it("then MCP_TOOL_NAMES has no duplicates", () => {
    const set = new Set(MCP_TOOL_NAMES)
    expect(set.size).toBe(MCP_TOOL_NAMES.length)
  })
})
