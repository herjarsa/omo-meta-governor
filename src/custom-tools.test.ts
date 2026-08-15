/**
 * Tests for the 15 custom tools in custom-tools.ts (F4).
 * Strategy: each tool accepts a `deps` object with injectable backend
 * references. We construct minimal fake deps and exercise the
 * happy/error paths.
 *
 * Note: Zod-arg validation is enforced by the OpenCode tool runtime
 * before the execute() function is called, so we test execute() with
 * pre-validated args (the runtime path is verified by integration).
 */
import { describe, expect, it, beforeEach } from "bun:test"
import { setPendingDeliveryRegistry, verifyDelivery } from "./custom-tools"
import { PendingDeliveryRegistry } from "./delivery-registry"
import {
  buildOmoSearchTool,
  buildOmoRecallTool,
  buildOmoHealthTool,
  buildOmoFindTool,
  buildOmoImpactTool,
  buildOmoRememberTool,
  buildOmoRecallMcpTool,
  buildOmoPathTool,
  buildOmoExplainTool,
} from "./custom-tools"
import type { GraphInvocationResult, GraphRetrieval, GraphRetrievalConfig } from "./graph-retrieval"
import type { SqliteBackend } from "./sqlite-backend"
import type { MetricsCollector } from "./metrics"
import type { CodeGraphTools } from "./codegraph-tools"
import { getDefaultSqliteBackend } from "./sqlite-backend"

// --- Fakes ---

function makeFakeGraphRetrieval(
  result: Partial<GraphInvocationResult> = {},
): GraphRetrieval {
  const fake = {
    invoke: async () =>
      ({
        kind: "codegraph" as const,
        query: "test",
        result: "fake result",
        timedOut: false,
        durationMs: 5,
        ...result,
      }) satisfies GraphInvocationResult,
    invokePath: async () =>
      ({
        kind: "graphify" as const,
        query: "a b",
        result: "A -> B",
        timedOut: false,
        durationMs: 3,
        ...result,
      }) satisfies GraphInvocationResult,
    invokeExplain: async () =>
      ({
        kind: "graphify" as const,
        query: "x",
        result: "explanation",
        timedOut: false,
        durationMs: 3,
        ...result,
      }) satisfies GraphInvocationResult,
  } as unknown as GraphRetrieval
  return fake
}

function makeFakeSqlite() {
  return {
    smartSearch: async () => ({
      lessons: [
        {
          id: "l1",
          title: "Test lesson",
          content: "Sample content",
          type: "lesson",
          confidence: 0.9,
        },
      ],
      crystals: [],
    }),
  } as unknown as SqliteBackend
}

function makeFakeMetrics() {
  return {
    getMetrics: () => ({
      version: "0.16.0",
      sessionID: "test",
      startedAtISO: new Date().toISOString(),
      uptimeMs: 1000,
      counters: {} as never,
    }),
    inc: () => {},
    reset: () => {},
  } as unknown as MetricsCollector
}

// --- Test helpers ---

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    sessionID: "s1",
    messageID: "m1",
    agent: "test-agent",
    ...overrides,
  }
}

function parseToolResult(result: { title: string; output: string; metadata?: unknown } | string) {
  // The OpenCode tool() helper returns { title, output, metadata }
  // but our local tests will see whichever shape the executor returns.
  if (typeof result === "string") {
    return { title: "", output: result, metadata: undefined }
  }
  return result
}

// --- Tests ---

describe("buildOmoSearchTool", () => {
  it("returns a tool with description, args schema, and execute", () => {
    const t = buildOmoSearchTool({
      graphRetrieval: makeFakeGraphRetrieval(),
      cwd: "/tmp",
    })
    expect(t.description).toBeDefined()
    expect(t.args).toBeDefined()
    expect(typeof t.execute).toBe("function")
  })

  it("execute returns a ToolResult with title, output, metadata", async () => {
    const t = buildOmoSearchTool({
      graphRetrieval: makeFakeGraphRetrieval({ result: "graph output" }),
      cwd: "/tmp",
    })
    const r = await t.execute({ query: "test query" }, makeCtx())
    const parsed = parseToolResult(r)
    expect(parsed.output).toContain("graph output")
    expect(parsed.title).toContain("omo_search")
  })

  it("execute reports timeout when backend times out", async () => {
    const t = buildOmoSearchTool({
      graphRetrieval: makeFakeGraphRetrieval({ timedOut: true, result: null, durationMs: 8000 }),
      cwd: "/tmp",
    })
    const r = await t.execute({ query: "slow" }, makeCtx())
    const parsed = parseToolResult(r)
    expect(parsed.output).toContain("timed out")
  })

  it("execute reports no backend when result is null", async () => {
    const t = buildOmoSearchTool({
      graphRetrieval: makeFakeGraphRetrieval({ result: null }),
      cwd: "/tmp",
    })
    const r = await t.execute({ query: "no backend" }, makeCtx())
    const parsed = parseToolResult(r)
    expect(parsed.output).toContain("No codegraph or graphify directory")
  })
})

describe("buildOmoRecallTool", () => {
  it("returns a tool with description, args, execute", () => {
    const t = buildOmoRecallTool({
      sqlite: makeFakeSqlite(),
      cwd: "/tmp",
    })
    expect(t.description).toBeDefined()
    expect(t.args).toBeDefined()
    expect(typeof t.execute).toBe("function")
  })

  it("execute formats lessons with title and content", async () => {
    const t = buildOmoRecallTool({
      sqlite: makeFakeSqlite(),
      cwd: "/tmp",
    })
    const r = await t.execute({ query: "anything" }, makeCtx())
    const parsed = parseToolResult(r)
    expect(parsed.output).toContain("Test lesson")
    expect(parsed.output).toContain("Sample content")
  })
})

describe("buildOmoHealthTool", () => {
  it("returns a tool that produces a health report", () => {
    const t = buildOmoHealthTool({
      metrics: makeFakeMetrics(),
      cwd: "/tmp",
    })
    expect(typeof t.execute).toBe("function")
  })

  it("execute returns a report that mentions omo-meta-governor", async () => {
    const t = buildOmoHealthTool({
      metrics: makeFakeMetrics(),
      cwd: "/tmp",
    })
    const r = await t.execute({}, makeCtx())
    const parsed = parseToolResult(r)
    expect(parsed.output.toLowerCase()).toContain("omo-meta-governor")
  })
})

describe("buildOmoFindTool", () => {
  it("returns a tool with the symbol name arg", () => {
    const fakeCG = {
      find: async () => "definition",
    } as unknown as CodeGraphTools
    const t = buildOmoFindTool({ cwd: "/tmp", codeGraph: fakeCG })
    expect(t.args).toBeDefined()
    expect(typeof t.execute).toBe("function")
  })
})

describe("buildOmoImpactTool", () => {
  it("returns a tool with the symbol name arg", () => {
    const fakeCG = {
      impact: async () => "impact",
    } as unknown as CodeGraphTools
    const t = buildOmoImpactTool({ cwd: "/tmp", codeGraph: fakeCG })
    expect(t.args).toBeDefined()
    expect(typeof t.execute).toBe("function")
  })
})

describe("bridge tools (omo_remember, omo_recall_mcp)", () => {
  it("buildOmoRememberTool returns a tool that takes content + concepts", () => {
    const t = buildOmoRememberTool({ cwd: "/tmp" })
    expect(t.args).toBeDefined()
    expect(typeof t.execute).toBe("function")
  })

  it("buildOmoRecallMcpTool returns a tool that takes a query", () => {
    const t = buildOmoRecallMcpTool({ cwd: "/tmp" })
    expect(t.args).toBeDefined()
    expect(typeof t.execute).toBe("function")
  })

it("all 9 tools export a description, args, and execute", () => {
    const tools = [
      buildOmoSearchTool({ graphRetrieval: makeFakeGraphRetrieval(), cwd: "/tmp" }),
      buildOmoRecallTool({ sqlite: makeFakeSqlite(), cwd: "/tmp" }),
      buildOmoHealthTool({ metrics: makeFakeMetrics(), cwd: "/tmp" }),
      buildOmoFindTool({ cwd: "/tmp" }),
      buildOmoImpactTool({ cwd: "/tmp" }),
      buildOmoRememberTool({ cwd: "/tmp" }),
      buildOmoRecallMcpTool({ cwd: "/tmp" }),
                  buildOmoPathTool({ graphRetrieval: makeFakeGraphRetrieval(), cwd: "/tmp" }),
      buildOmoExplainTool({ graphRetrieval: makeFakeGraphRetrieval(), cwd: "/tmp" }),
                ]
    expect(tools).toHaveLength(9)
    for (const t of tools) {
      expect(t.description).toBeDefined()
      expect(t.args).toBeDefined()
      expect(typeof t.execute).toBe("function")
    }
  })
})


// ─── Gap I fix: pollForDelivery returns "expired" (v0.17.3) ────────

describe("verifyDelivery (Gap I — deliveryStatus=expired)", () => {
  beforeEach(() => {
    setPendingDeliveryRegistry(null as unknown as Parameters<typeof setPendingDeliveryRegistry>[0])
  })

  it("then returns 'expired' when registry times out without delivery", async () => {
    const registry = new PendingDeliveryRegistry()
    registry.register({
      sessionID: "test-session",
      mcpTool: "test-tool",
      mcpArgs: { foo: "bar" },
      ttlMs: 10_000,
    })
    setPendingDeliveryRegistry(registry as unknown as Parameters<typeof setPendingDeliveryRegistry>[0])

    // Poll with 100ms timeout — entry exists (TTL 10s), so it expires
    const status = await verifyDelivery("test-session", "test-tool", 100)
    expect(status).toBe("expired")
  })

  it("then returns 'delivered' when markDelivered fires before timeout", async () => {
    const registry = new PendingDeliveryRegistry()
    registry.register({
      sessionID: "test-session",
      mcpTool: "test-tool",
      mcpArgs: { foo: "bar" },
    })
    // Mark as delivered before polling
    registry.markDelivered({
      sessionID: "test-session",
      mcpTool: "test-tool",
      mcpArgs: { foo: "bar" },
    })
    setPendingDeliveryRegistry(registry as unknown as Parameters<typeof setPendingDeliveryRegistry>[0])

    const status = await verifyDelivery("test-session", "test-tool", 100)
    expect(status).toBe("delivered")
  })

  it("then returns 'pending' when no registry is configured", async () => {
    // pendingRegistryRef is null (set by beforeEach)
    const status = await verifyDelivery("test-session", "test-tool", 100)
    expect(status).toBe("pending")
  })
})
