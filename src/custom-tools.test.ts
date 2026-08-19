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
  buildOmoFilesTool,
  buildOmoCallersTool,
  buildOmoNodeTool,
  // v0.27.0 Wave 3 P2
  buildOmoContextTool,
  buildOmoAffectedCgTool,
  buildOmoStatusTool,
  buildOmoUnlockTool,
  buildOmoMarkDirtyTool,
  buildOmoSyncIfDirtyTool,
  buildOmoIndexTool,
  buildOmoVisualizeTool,
  buildOmoServeTool,
  buildOmoUninitTool,
  buildOmoDiagnoseTool,
  buildOmoMergeGraphsTool,
  buildOmoSaveResultTool,
  buildOmoExtractTool,
  buildOmoClusterOnlyTool,
  buildOmoLabelTool,
  buildOmoTreeTool,
  buildOmoCloneTool,
  buildOmoAddTool,
  buildOmoCheckUpdateTool,
  buildOmoHookStatusTool,
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
})

// ─── Wave 2: omo_files / omo_callers / omo_node (v0.26.0) ──────────────────

describe("buildOmoFilesTool (v0.26.0 FIL-1..FIL-3)", () => {
  it("FIL-1: returns tool with description, args, execute", () => {
    const fake = {
      invokeFiles: async () => ({
        kind: "codegraph" as const,
        query: "files",
        result: "src/index.ts\nsrc/main.ts",
        timedOut: false,
        durationMs: 5,
      }),
    } as unknown as GraphRetrieval
    const t = buildOmoFilesTool({ cwd: "/tmp", graphRetrieval: fake })
    expect(t.description).toBeDefined()
    expect(t.args).toBeDefined()
    expect(typeof t.execute).toBe("function")
  })

  it("FIL-2: execute returns file list when codegraph backend succeeds", async () => {
    const fake = {
      invokeFiles: async () => ({
        kind: "codegraph" as const,
        query: "files",
        result: "src/a.ts\nsrc/b.ts\nsrc/c.ts",
        timedOut: false,
        durationMs: 5,
      }),
    } as unknown as GraphRetrieval
    const t = buildOmoFilesTool({ cwd: "/tmp", graphRetrieval: fake })
    const r = parseToolResult(await t.execute({}, makeCtx()))
    expect(r.output).toContain("src/a.ts")
    expect(r.output).toContain("src/b.ts")
    expect(r.output).toContain("src/c.ts")
  })

  it("FIL-3: execute returns friendly hint when no index exists", async () => {
    const fake = {
      invokeFiles: async () => ({
        kind: null,
        query: "files",
        result: null,
        timedOut: false,
        durationMs: 5,
      }),
    } as unknown as GraphRetrieval
    const t = buildOmoFilesTool({ cwd: "/tmp", graphRetrieval: fake })
    const r = parseToolResult(await t.execute({}, makeCtx()))
    expect(r.output).toContain("npx codegraph init")
    expect(r.output).toContain("graphify")
  })
})

describe("buildOmoCallersTool (v0.26.0 CAL-1..CAL-2)", () => {
  it("CAL-1: returns callers when symbol is found", async () => {
    const fake = {
      invokeCallers: async () => ({
        kind: "codegraph" as const,
        query: "validate",
        result: "src/a.ts:10\nsrc/b.ts:25\nsrc/c.ts:3",
        timedOut: false,
        durationMs: 5,
      }),
    } as unknown as GraphRetrieval
    const t = buildOmoCallersTool({ cwd: "/tmp", graphRetrieval: fake })
    const r = parseToolResult(await t.execute({ symbol: "validate" }, makeCtx()))
    expect(r.output).toContain("src/a.ts:10")
    expect(r.output).toContain("src/b.ts:25")
    expect(r.output).toContain("src/c.ts:3")
  })

  it("CAL-2: returns friendly hint when symbol is unknown or no codegraph", async () => {
    const fake = {
      invokeCallers: async () => ({
        kind: null,
        query: "ghost",
        result: null,
        timedOut: false,
        durationMs: 5,
      }),
    } as unknown as GraphRetrieval
    const t = buildOmoCallersTool({ cwd: "/tmp", graphRetrieval: fake })
    const r = parseToolResult(await t.execute({ symbol: "ghost" }, makeCtx()))
    expect(r.output).toContain("No call sites found")
    expect(r.output).toContain("npx codegraph init")
  })
})

describe("buildOmoNodeTool (v0.26.0 NOD-1..NOD-2)", () => {
  it("NOD-1: returns source + callers when symbol is found", async () => {
    const fake = {
      invokeNode: async () => ({
        kind: "codegraph" as const,
        query: "UserService.create",
        result: "function UserService.create(user) { return db.insert(user) }\n\nCallers:\n  src/api/users.ts:42\n  src/cli/seed.ts:8",
        timedOut: false,
        durationMs: 5,
      }),
    } as unknown as GraphRetrieval
    const t = buildOmoNodeTool({ cwd: "/tmp", graphRetrieval: fake })
    const r = parseToolResult(await t.execute({ symbol: "UserService.create" }, makeCtx()))
    expect(r.output).toContain("function UserService.create")
    expect(r.output).toContain("src/api/users.ts:42")
  })

  it("NOD-2: returns friendly hint when symbol is not found", async () => {
    const fake = {
      invokeNode: async () => ({
        kind: null,
        query: "ghost",
        result: null,
        timedOut: false,
        durationMs: 5,
      }),
    } as unknown as GraphRetrieval
    const t = buildOmoNodeTool({ cwd: "/tmp", graphRetrieval: fake })
    const r = parseToolResult(await t.execute({ symbol: "ghost" }, makeCtx()))
    expect(r.output).toContain("was not found")
    expect(r.output).toContain("npx codegraph init")
  })
})


it("all 12 omo_* tools export a description, args, and execute", () => {
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
    buildOmoFilesTool({ graphRetrieval: makeFakeGraphRetrieval(), cwd: "/tmp" }),
    buildOmoCallersTool({ graphRetrieval: makeFakeGraphRetrieval(), cwd: "/tmp" }),
    buildOmoNodeTool({ graphRetrieval: makeFakeGraphRetrieval(), cwd: "/tmp" }),
    buildOmoContextTool({ graphRetrieval: makeFakeGraphRetrieval(), cwd: "/tmp" }),
    buildOmoAffectedCgTool({ graphRetrieval: makeFakeGraphRetrieval(), cwd: "/tmp" }),
    buildOmoStatusTool({ graphRetrieval: makeFakeGraphRetrieval(), cwd: "/tmp" }),
    buildOmoUnlockTool({ graphRetrieval: makeFakeGraphRetrieval(), cwd: "/tmp" }),
    buildOmoMarkDirtyTool({ graphRetrieval: makeFakeGraphRetrieval(), cwd: "/tmp" }),
    buildOmoSyncIfDirtyTool({ graphRetrieval: makeFakeGraphRetrieval(), cwd: "/tmp" }),
    buildOmoIndexTool({ graphRetrieval: makeFakeGraphRetrieval(), cwd: "/tmp" }),
    buildOmoVisualizeTool({ graphRetrieval: makeFakeGraphRetrieval(), cwd: "/tmp" }),
    buildOmoServeTool({ graphRetrieval: makeFakeGraphRetrieval(), cwd: "/tmp" }),
    buildOmoUninitTool({ graphRetrieval: makeFakeGraphRetrieval(), cwd: "/tmp" }),
    buildOmoDiagnoseTool({ graphRetrieval: makeFakeGraphRetrieval(), cwd: "/tmp" }),
    buildOmoMergeGraphsTool({ graphRetrieval: makeFakeGraphRetrieval(), cwd: "/tmp" }),
    buildOmoSaveResultTool({ graphRetrieval: makeFakeGraphRetrieval(), cwd: "/tmp" }),
    buildOmoExtractTool({ graphRetrieval: makeFakeGraphRetrieval(), cwd: "/tmp" }),
    buildOmoClusterOnlyTool({ graphRetrieval: makeFakeGraphRetrieval(), cwd: "/tmp" }),
    buildOmoLabelTool({ graphRetrieval: makeFakeGraphRetrieval(), cwd: "/tmp" }),
    buildOmoTreeTool({ graphRetrieval: makeFakeGraphRetrieval(), cwd: "/tmp" }),
    buildOmoCloneTool({ graphRetrieval: makeFakeGraphRetrieval(), cwd: "/tmp" }),
    buildOmoAddTool({ graphRetrieval: makeFakeGraphRetrieval(), cwd: "/tmp" }),
    buildOmoCheckUpdateTool({ graphRetrieval: makeFakeGraphRetrieval(), cwd: "/tmp" }),
    buildOmoHookStatusTool({ cwd: "/tmp" }),
  ]
  expect(tools).toHaveLength(33)
  for (const t of tools) {
    expect(t.description).toBeDefined()
    expect(t.args).toBeDefined()
    expect(typeof t.execute).toBe("function")
  }
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


// ============================================================================
// v0.27.0 Wave 3 P2 — extended graph tool surface
// ============================================================================

function makeWave3Fake(overrides: Partial<GraphRetrieval> = {}): GraphRetrieval {
  const base = makeFakeGraphRetrieval()
  return Object.assign(base, overrides) as GraphRetrieval
}

describe("Wave 3 P2 — omo_context", () => {
  it("then returns the context window for a task", async () => {
    const fake = makeWave3Fake({
      invokeContext: async () => ({
        kind: "codegraph",
        query: "validate JWT",
        result: "// src/auth.ts\nfunction validateToken() { ... }",
        timedOut: false,
        durationMs: 12,
      }),
    })
    const t = buildOmoContextTool({ graphRetrieval: fake, cwd: "/tmp" })
    const result = await (t.execute as any)({ task: "validate JWT" }, { sessionID: "s1" })
    expect(result.output).toContain("validateToken")
  })

  it("then returns a friendly hint when no result", async () => {
    const fake = makeWave3Fake({
      invokeContext: async () => ({ kind: null, query: "x", result: null, timedOut: false, durationMs: 0 }),
    })
    const t = buildOmoContextTool({ graphRetrieval: fake, cwd: "/tmp" })
    const result = await (t.execute as any)({ task: "x" }, { sessionID: "s1" })
    expect(result.output).toContain("codegraph init")
  })
})

describe("Wave 3 P2 — omo_affected_cg", () => {
  it("then returns affected files for given inputs", async () => {
    const fake = makeWave3Fake({
      invokeAffected: async () => ({
        kind: "codegraph",
        query: "src/auth.ts",
        result: "src/auth.test.ts\nsrc/login.test.ts",
        timedOut: false,
        durationMs: 7,
      }),
    })
    const t = buildOmoAffectedCgTool({ graphRetrieval: fake, cwd: "/tmp" })
    const result = await (t.execute as any)({ files: ["src/auth.ts"] }, { sessionID: "s1" })
    expect(result.output).toContain("auth.test")
  })
})

describe("Wave 3 P2 — omo_status", () => {
  it("then returns codegraph status", async () => {
    const fake = makeWave3Fake({
      invokeStatus: async () => ({
        kind: "codegraph", query: "status", result: "nodes: 1234\nversion: 1.5.0", timedOut: false, durationMs: 5,
      }),
    })
    const t = buildOmoStatusTool({ graphRetrieval: fake, cwd: "/tmp" })
    const result = await (t.execute as any)({}, { sessionID: "s1" })
    expect(result.output).toContain("nodes: 1234")
  })
})

describe("Wave 3 P2 — omo_unlock", () => {
  it("then reports unlock success", async () => {
    const fake = makeWave3Fake({
      invokeUnlock: async () => ({ kind: "codegraph", query: "unlock", result: "lock removed", timedOut: false, durationMs: 3 }),
    })
    const t = buildOmoUnlockTool({ graphRetrieval: fake, cwd: "/tmp" })
    const result = await (t.execute as any)({}, { sessionID: "s1" })
    expect(result.output).toBe("lock removed")
  })
})

describe("Wave 3 P2 — omo_mark_dirty", () => {
  it("then confirms graph was marked dirty", async () => {
    const fake = makeWave3Fake({
      invokeMarkDirty: async () => ({ kind: "codegraph", query: "mark-dirty", result: "marked", timedOut: false, durationMs: 2 }),
    })
    const t = buildOmoMarkDirtyTool({ graphRetrieval: fake, cwd: "/tmp" })
    const result = await (t.execute as any)({}, { sessionID: "s1" })
    expect(result.output).toBe("marked")
  })
})

describe("Wave 3 P2 — omo_sync_if_dirty", () => {
  it("then syncs when graph is dirty", async () => {
    const fake = makeWave3Fake({
      invokeSyncIfDirty: async () => ({ kind: "codegraph", query: "sync-if-dirty", result: "synced", timedOut: false, durationMs: 50 }),
    })
    const t = buildOmoSyncIfDirtyTool({ graphRetrieval: fake, cwd: "/tmp" })
    const result = await (t.execute as any)({}, { sessionID: "s1" })
    expect(result.output).toBe("synced")
  })
})

describe("Wave 3 P2 — omo_index", () => {
  it("then triggers a manual full index", async () => {
    const fake = makeWave3Fake({
      invokeIndex: async () => ({ kind: "codegraph", query: "index", result: "indexed 1500 files", timedOut: false, durationMs: 120 }),
    })
    const t = buildOmoIndexTool({ graphRetrieval: fake, cwd: "/tmp" })
    const result = await (t.execute as any)({}, { sessionID: "s1" })
    expect(result.output).toContain("indexed")
  })
})

describe("Wave 3 P2 — omo_visualize", () => {
  it("then returns the visualization HTML path", async () => {
    const fake = makeWave3Fake({
      invokeVisualize: async () => ({ kind: "codegraph", query: "visualize", result: "/tmp/.codegraph/viz.html", timedOut: false, durationMs: 30 }),
    })
    const t = buildOmoVisualizeTool({ graphRetrieval: fake, cwd: "/tmp" })
    const result = await (t.execute as any)({}, { sessionID: "s1" })
    expect(result.output).toContain("viz.html")
  })
})

describe("Wave 3 P2 — omo_serve", () => {
  it("then starts the server on the given port", async () => {
    const fake = makeWave3Fake({
      invokeServe: async () => ({ kind: "codegraph", query: "serve 3030", result: "listening on 3030", timedOut: false, durationMs: 10 }),
    })
    const t = buildOmoServeTool({ graphRetrieval: fake, cwd: "/tmp" })
    const result = await (t.execute as any)({ port: 3030 }, { sessionID: "s1" })
    expect(result.output).toContain("3030")
  })
})

describe("Wave 3 P2 — omo_uninit", () => {
  it("then reports uninit success", async () => {
    const fake = makeWave3Fake({
      invokeUninit: async () => ({ kind: "codegraph", query: "uninit", result: "removed .codegraph/", timedOut: false, durationMs: 5 }),
    })
    const t = buildOmoUninitTool({ graphRetrieval: fake, cwd: "/tmp" })
    const result = await (t.execute as any)({}, { sessionID: "s1" })
    expect(result.output).toContain("removed")
  })
})

describe("Wave 3 P2 — omo_diagnose", () => {
  it("then returns the diagnose report", async () => {
    const fake = makeWave3Fake({
      invokeDiagnose: async () => ({ kind: "graphify", query: "diagnose", result: "warnings: 0\nnodes: 1500", timedOut: false, durationMs: 12 }),
    })
    const t = buildOmoDiagnoseTool({ graphRetrieval: fake, cwd: "/tmp" })
    const result = await (t.execute as any)({}, { sessionID: "s1" })
    expect(result.output).toContain("warnings")
  })
})

describe("Wave 3 P2 — omo_merge_graphs", () => {
  it("then merges conflicting segments", async () => {
    const fake = makeWave3Fake({
      invokeMergeDriver: async () => ({ kind: "graphify", query: "merge-driver", result: "merged successfully", timedOut: false, durationMs: 20 }),
    })
    const t = buildOmoMergeGraphsTool({ graphRetrieval: fake, cwd: "/tmp" })
    const result = await (t.execute as any)({}, { sessionID: "s1" })
    expect(result.output).toBe("merged successfully")
  })
})

describe("Wave 3 P2 — omo_save_result", () => {
  it("then persists the last query result", async () => {
    const fake = makeWave3Fake({
      invokeSaveResult: async () => ({ kind: "graphify", query: "save-result", result: "saved to /tmp/result.json", timedOut: false, durationMs: 3 }),
    })
    const t = buildOmoSaveResultTool({ graphRetrieval: fake, cwd: "/tmp" })
    const result = await (t.execute as any)({}, { sessionID: "s1" })
    expect(result.output).toContain("saved")
  })
})

describe("Wave 3 P2 — omo_extract", () => {
  it("then re-extracts the semantic layer", async () => {
    const fake = makeWave3Fake({
      invokeExtract: async () => ({ kind: "graphify", query: "extract", result: "extracted 1500 nodes", timedOut: false, durationMs: 200 }),
    })
    const t = buildOmoExtractTool({ graphRetrieval: fake, cwd: "/tmp" })
    const result = await (t.execute as any)({}, { sessionID: "s1" })
    expect(result.output).toContain("extracted")
  })
})

describe("Wave 3 P2 — omo_cluster_only", () => {
  it("then re-clusters without re-extracting", async () => {
    const fake = makeWave3Fake({
      invokeClusterOnly: async () => ({ kind: "graphify", query: "cluster-only", result: "clustered", timedOut: false, durationMs: 50 }),
    })
    const t = buildOmoClusterOnlyTool({ graphRetrieval: fake, cwd: "/tmp" })
    const result = await (t.execute as any)({}, { sessionID: "s1" })
    expect(result.output).toBe("clustered")
  })
})

describe("Wave 3 P2 — omo_label", () => {
  it("then applies a label to a node", async () => {
    const fake = makeWave3Fake({
      invokeLabel: async () => ({ kind: "graphify", query: "label validateToken", result: "labeled", timedOut: false, durationMs: 3 }),
    })
    const t = buildOmoLabelTool({ graphRetrieval: fake, cwd: "/tmp" })
    const result = await (t.execute as any)({ node: "validateToken" }, { sessionID: "s1" })
    expect(result.output).toBe("labeled")
  })
})

describe("Wave 3 P2 — omo_tree", () => {
  it("then emits the hierarchical tree", async () => {
    const fake = makeWave3Fake({
      invokeTree: async () => ({ kind: "graphify", query: "tree", result: "auth/\n  login.ts\n  session.ts", timedOut: false, durationMs: 5 }),
    })
    const t = buildOmoTreeTool({ graphRetrieval: fake, cwd: "/tmp" })
    const result = await (t.execute as any)({}, { sessionID: "s1" })
    expect(result.output).toContain("auth/")
  })
})

describe("Wave 3 P2 — omo_clone", () => {
  it("then clones the graph", async () => {
    const fake = makeWave3Fake({
      invokeClone: async () => ({ kind: "graphify", query: "clone", result: "cloned to ./graphify-out-backup", timedOut: false, durationMs: 30 }),
    })
    const t = buildOmoCloneTool({ graphRetrieval: fake, cwd: "/tmp" })
    const result = await (t.execute as any)({}, { sessionID: "s1" })
    expect(result.output).toContain("cloned")
  })
})

describe("Wave 3 P2 — omo_add", () => {
  it("then adds files to the graph", async () => {
    const fake = makeWave3Fake({
      invokeAdd: async () => ({ kind: "graphify", query: "add src/auth.ts", result: "added 1 file", timedOut: false, durationMs: 8 }),
    })
    const t = buildOmoAddTool({ graphRetrieval: fake, cwd: "/tmp" })
    const result = await (t.execute as any)({ files: "src/auth.ts" }, { sessionID: "s1" })
    expect(result.output).toContain("added")
  })
})

describe("Wave 3 P2 — omo_check_update", () => {
  it("then reports whether re-extraction is needed", async () => {
    const fake = makeWave3Fake({
      invokeCheckUpdate: async () => ({ kind: "graphify", query: "check-update", result: "schema unchanged", timedOut: false, durationMs: 12 }),
    })
    const t = buildOmoCheckUpdateTool({ graphRetrieval: fake, cwd: "/tmp" })
    const result = await (t.execute as any)({}, { sessionID: "s1" })
    expect(result.output).toBe("schema unchanged")
  })
})



describe("Wave 3 P2 — omo_hook_status", () => {
  it("then reports whether the graphify post-commit hook is installed", async () => {
    const t = buildOmoHookStatusTool({ cwd: "/tmp" })
    const result = await (t.execute as any)({}, { sessionID: "s1" })
    expect(result.metadata.installed).toBeDefined()
    expect(result.output).toMatch(/hook/)
  })
})
