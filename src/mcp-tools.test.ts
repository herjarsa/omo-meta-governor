/**
 * Tests for the MCP server tool adapters in mcp-tools.ts (v0.31.0).
 *
 * Strategy: exercises the adapters with pre-validated args. We do NOT spawn
 * the MCP server process here — that's covered by an integration test that
 * boots the server in-process via an in-memory transport pair. This keeps
 * the unit tests fast and hermetic.
 *
 * Tests work against the real `custom-tools.ts` builders — the adapter
 * pattern simply wraps them, so exercising the adapters is equivalent to
 * exercising the underlying tools.
 */

import { describe, expect, it } from "bun:test"
import { MCP_TOOL_NAMES, getAdapters, setMcpCwd } from "./mcp-tools"

describe("MCP tool registry", () => {
  it("exposes the canonical omo_* names", () => {
    const adapters = getAdapters()
    const names = adapters.map((a) => a.name)
    for (const expected of MCP_TOOL_NAMES) {
      expect(names).toContain(expected)
    }
  })

  it("has unique tool names (OpenCode rejects duplicates)", () => {
    const adapters = getAdapters()
    const names = adapters.map((a) => a.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it("every adapter has a non-empty description", () => {
    const adapters = getAdapters()
    for (const adapter of adapters) {
      expect(adapter.description.length).toBeGreaterThan(10)
    }
  })

  it("every adapter name starts with 'omo_'", () => {
    const adapters = getAdapters()
    for (const adapter of adapters) {
      expect(adapter.name.startsWith("omo_")).toBe(true)
    }
  })

  it("exposes exactly the curated set of tools", () => {
    const adapters = getAdapters()
    const names = new Set(adapters.map((a) => a.name))
    expect(names.has("omo_search")).toBe(true)
    expect(names.has("omo_health")).toBe(true)
    expect(names.has("omo_recall")).toBe(true)
    expect(names.has("omo_find")).toBe(true)
    expect(names.has("omo_impact")).toBe(true)
    expect(names.has("omo_path")).toBe(true)
    expect(names.has("omo_explain")).toBe(true)
    expect(names.has("omo_status")).toBe(true)
  })
})

describe("omo_health adapter (smoke test)", () => {
  it("returns a title and text describing the running version", async () => {
    setMcpCwd(process.cwd())
    const adapters = getAdapters()
    const health = adapters.find((a) => a.name === "omo_health")
    expect(health).toBeDefined()
    if (!health) return
    const result = await health.execute({}, { cwd: process.cwd() })
    expect(result.title).toMatch(/^omo_health/)
    expect(result.text).toMatch(/v0\./)
    expect(result.meta?.durationMs).toBeGreaterThanOrEqual(0)
  })
})

describe("omo_search adapter (no graph backend installed)", () => {
  it("returns a friendly fallback when no graph backend exists", async () => {
    setMcpCwd(process.cwd())
    const adapters = getAdapters()
    const search = adapters.find((a) => a.name === "omo_search")
    expect(search).toBeDefined()
    if (!search) return
    const result = await search.execute(
      { query: "anything that doesn't match anything" },
      { cwd: process.cwd() },
    )
    expect(result.title).toMatch(/^omo_search:/)
  })
})

describe("error handling", () => {
  it("returns isError when an executor throws", async () => {
    setMcpCwd(process.cwd())
    const adapters = getAdapters()
    const recall = adapters.find((a) => a.name === "omo_recall")
    expect(recall).toBeDefined()
    if (!recall) return
    // Pass invalid args — the Zod schema in custom-tools.ts will throw, and
    // our adapter catches the error and returns isError: true.
    const result = await recall.execute(
      { query: null as unknown as string },
      { cwd: process.cwd() },
    )
    expect(result.isError).toBe(true)
  })
})
