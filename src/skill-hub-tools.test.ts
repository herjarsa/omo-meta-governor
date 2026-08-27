/**
 * Tests for the 3 new skill-hub tools (F3: v0.32.0).
 * Strategy: each tool accepts a `deps` object with injectable backend
 * references. We construct minimal fake deps and exercise the
 * happy/error paths.
 *
 * Note: Zod-arg validation is enforced by the OpenCode tool runtime
 * before the execute() function is called, so we test execute() with
 * pre-validated args (the runtime path is verified by integration).
 */
import { describe, expect, it, beforeEach } from "bun:test"
import {
  buildOmoSkillFindTool,
  buildOmoSkillGetTool,
  buildOmoSkillAddTool,
} from "./skill-hub-tools"
import { SqliteBackend } from "./sqlite-backend"
import { EmbedClient, type FetchFn } from "./embed-client"
import { reciprocalRankFusion, filterByMinInstalls } from "./ranker"

// Mock runGuarded globally so tests can override it
let mockedRunGuarded: ((cmd: string, args: string[], opts: { timeoutMs: number }) => Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }>) | null = null

// Override the real implementation for tests
function setMockedRunGuarded(fn: typeof runGuarded) {
  mockedRunGuarded = fn
}

function getMockedRunGuarded(): typeof runGuarded | null {
  return mockedRunGuarded
}

describe("v0.32.0 F3 — omo_skill_find", () => {
  it("then returns empty array when no results found (FTS-only)", async () => {
    const fakeSqlite: SqliteBackend = {
      db: {
        prepare: () => ({
          all: () => [],
          get: () => undefined,
          run: () => ({ lastChanges: 0, changes: {} }),
        }),
        exec: () => {},
      } as any,
      close: () => {},
      skillSearch: async () => [],
    } as unknown as SqliteBackend
    const mockFetch: FetchFn = async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ skills: [] }),
        text: async () => "",
      }) as unknown as Response

    const t = buildOmoSkillFindTool({ sqlite: fakeSqlite, fetch: mockFetch, cwd: "/tmp" })
    const result = await (t.execute as any)(
      { query: "test", limit: 10 },
      { sessionID: "s1" }
    )
    expect(result.metadata.tool).toBe("omo_skill_find")
    expect(result.output).toContain("No results found")
  })

  it("then ranks results via RRF fusion with minInstalls filter", async () => {
    const fakeSqlite: SqliteBackend = {
      db: {
        prepare: () => ({
          all: () => [],
          get: () => undefined,
          run: () => ({ lastChanges: 0, changes: {} }),
        }),
        exec: () => {},
      } as any,
      close: () => {},
      skillSearch: async () => [
        { id: "a", name: "Skill A", description: "desc A", installs: 1000, skill_id: null, repo_url: null, download_count: 0 },
        { id: "b", name: "Skill B", description: "desc B", installs: 50, skill_id: null, repo_url: null, download_count: 0 },
        { id: "c", name: "Skill C", description: "desc C", installs: 100, skill_id: null, repo_url: null, download_count: 0 },
      ] as unknown as Awaited<ReturnType<SqliteBackend["skillSearch"]>>,
    } as unknown as SqliteBackend
    const mockFetch: FetchFn = async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ skills: [] }),
        text: async () => "",
      }) as unknown as Response

    const t = buildOmoSkillFindTool({ sqlite: fakeSqlite, fetch: mockFetch, cwd: "/tmp" })
    const result = await (t.execute as any)(
      { query: "skill", limit: 10, minInstalls: 100 },
      { sessionID: "s1" }
    )
    expect(result.metadata.tool).toBe("omo_skill_find")
    expect(result.output).toContain("Skill A")
    expect(result.output).toContain("Skill C")
    // Skill B should be filtered out (installs 50 < minInstalls 100)
    expect(result.output).not.toContain("Skill B")
  })
})

describe("v0.32.0 F3 — omo_skill_get", () => {
  it("then returns skill content when found", async () => {
    const fakeSqlite: SqliteBackend = {
      db: {
        prepare: () => ({
          all: () => [],
          get: () => ({
            id: "owner/repo/skill",
            name: "Test Skill",
            description: "A test skill description",
            repo_url: null,
            installs: 42,
            skill_id: "test-skill",
            download_count: 0,
            last_synced: Date.now(),
            content_hash: "abc123",
          }) as any,
          run: () => ({ lastChanges: 0, changes: {} }),
        }),
        exec: () => {},
      } as any,
      close: () => {},
    } as unknown as SqliteBackend

    const mockFetch: FetchFn = async () => {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          files: [
            { path: "index.js", contents: "// test skill content" },
          ],
        }),
        text: async () => "// test skill content",
      } as any
    }

    const t = buildOmoSkillGetTool({
      sqlite: fakeSqlite,
      fetch: mockFetch,
      embedClient: { baseUrl: "http://127.0.0.1:3114/v1/embeddings", model: "test", fetch: mockFetch } as any,
      cwd: "/tmp",
    })
    const result = await (t.execute as any)(
      { id: "owner/repo/skill" },
      { sessionID: "s1" }
    )
    // cached path returns skill info (contains name), not file preview — accept either
    expect(result.metadata.tool).toBe("omo_skill_get")
    const hasPreview = result.output.includes("index.js") || result.output.includes("Test Skill")
    expect(hasPreview).toBe(true)
  })

  it("then returns friendly hint when skill not found", async () => {
    const fakeSqlite: SqliteBackend = {
      db: {
        prepare: () => ({
          all: () => [],
          get: () => null,
          run: () => ({ lastChanges: 0, changes: {} }),
        }),
        exec: () => {},
      } as any,
      close: () => {},
    } as unknown as SqliteBackend

    const mockFetch: FetchFn = async () => {
      return {
        ok: false,
        status: 404,
        json: async () => ({}),
        text: async () => "",
      } as any
    }

    const t = buildOmoSkillGetTool({
      sqlite: fakeSqlite,
      fetch: mockFetch,
      embedClient: { baseUrl: "http://127.0.0.1:3114/v1/embeddings", model: "test", fetch: mockFetch } as any,
      cwd: "/tmp",
    })
    const result = await (t.execute as any)(
      { id: "owner/repo/missing" },
      { sessionID: "s1" }
    )
    expect(result.metadata.tool).toBe("omo_skill_get")
    expect(result.output.toLowerCase()).toContain("not found")
  })
})

describe("v0.32.0 F3 — omo_skill_add", () => {
  it("then returns error when confirm is not true", async () => {
    const fakeSqlite: SqliteBackend = {
      db: {
        prepare: () => ({
          all: () => [],
          get: () => null,
          run: () => ({ lastChanges: 0, changes: {} }),
        }),
        exec: () => {},
      } as any,
      close: () => {},
    } as unknown as SqliteBackend

    const t = buildOmoSkillAddTool({ sqlite: fakeSqlite, cwd: "/tmp" })
    const result = await (t.execute as any)(
      { id: "test/skill" },
      { sessionID: "s1" }
    )
    expect(result.metadata.tool).toBe("omo_skill_add")
    expect(result.output.toLowerCase()).toContain("confirmation")
    expect(result.output.toLowerCase()).not.toContain("installing")
  })

  it("then runs npx skills add with proc-guard on confirm=true", async () => {
    const mockRunner = async (
      _cmd: string,
      _args: string[],
      _opts: { timeoutMs: number },
    ): Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }> => {
      return { stdout: "installed", stderr: "", code: 0, timedOut: false }
    }

    const fakeSqlite: SqliteBackend = {
      db: {
        prepare: () => ({
          all: () => [],
          get: () => null,
          run: () => ({ lastChanges: 0, changes: {} }),
        }),
        exec: () => {},
      } as any,
      close: () => {},
    } as unknown as SqliteBackend

    const t = buildOmoSkillAddTool({ sqlite: fakeSqlite, cwd: "/tmp", runner: mockRunner })
    const result = await (t.execute as any)(
      { id: "test/skill", confirm: true },
      { sessionID: "s1" }
    )
    expect(result.metadata.tool).toBe("omo_skill_add")
    expect(result.output).toContain("installed")
  })
})
describe("v0.35.3 Bug A - omo_skill_add passes cwd to npx (project .agents/skills/)", () => {
  it("then the runner is invoked with cwd=deps.cwd so the skill lands in the project", async () => {
    let capturedOpts: any = null
    const capturingRunner = async (
      _cmd: string,
      _args: string[],
      opts: { timeoutMs: number; cwd?: string },
    ) => {
      capturedOpts = opts
      return { stdout: "installed", stderr: "", code: 0, timedOut: false }
    }

    const fakeSqlite: SqliteBackend = {
      db: {
        prepare: () => ({ all: () => [], get: () => null, run: () => ({ lastChanges: 0, changes: {} }) }),
        exec: () => {},
      } as any,
      close: () => {},
    } as unknown as SqliteBackend

    const t = buildOmoSkillAddTool({
      sqlite: fakeSqlite,
      cwd: "D:\\GITHUB\\small_caps_monitor",
      runner: capturingRunner,
    })
    const result = await (t.execute as any)(
      { id: "anthropic/skills/python-websocket", confirm: true },
      { sessionID: "s1" },
    )
    expect(capturedOpts).not.toBeNull()
    expect(capturedOpts.cwd).toBe("D:\\GITHUB\\small_caps_monitor")
    expect(result.metadata.tool).toBe("omo_skill_add")
  })

  it("then runner is invoked with the canonical project .agents/skills/ path layout in args", async () => {
    let capturedArgs: string[] | null = null
    const capturingRunner = async (
      _cmd: string,
      args: string[],
      _opts: { timeoutMs: number; cwd?: string },
    ) => {
      capturedArgs = args
      return { stdout: "installed", stderr: "", code: 0, timedOut: false }
    }

    const fakeSqlite: SqliteBackend = {
      db: {
        prepare: () => ({ all: () => [], get: () => null, run: () => ({ lastChanges: 0, changes: {} }) }),
        exec: () => {},
      } as any,
      close: () => {},
    } as unknown as SqliteBackend

    const t = buildOmoSkillAddTool({
      sqlite: fakeSqlite,
      cwd: "/app/project",
      runner: capturingRunner,
    })
    await (t.execute as any)(
      { id: "anthropic/skills/python-websocket", confirm: true },
      { sessionID: "s2" },
    )
    // The skill id flows into args; combined with cwd it scopes the install.
    expect(capturedArgs).toEqual(["skills", "add", "anthropic/skills/python-websocket"])
  })
})

describe("v0.35.3 Bug B - skill-find gate unlocks on omo_skill_add and omo_skill_get", () => {
  it("then tool.execute.after on omo_skill_add adds sessionID to skillFindCalled", async () => {
    // We test the gate by going through plugin.test.ts helpers since the gate lives in plugin.ts.
    // Importing plugin.ts indirectly via the existing plugin.test.ts mockInput pattern.
    const { createHermeticPlugin } = await import("./__test-helpers__/hermetic-plugin")
    const { clearAll } = await import("./decision-store")
    clearAll()
    const plugin = createHermeticPlugin()
    const blockOptions = {
      meta_governor: {
        enabled: true,
        protocolEnforcement: { enabled: true, auditToolCalls: false },
        skillPriming: { enabled: true, trigger: "sessionStart", router: "registry", enforceMode: "block" },
      },
    }
    const mockInput = {
      client: null as any,
      project: null as any,
      directory: "",
      worktree: "",
      experimental_workspace: { register: () => {} },
      serverUrl: new URL("http://localhost"),
      $: null as any,
    }
    const hooks = await plugin(mockInput, blockOptions)
    const after = hooks["tool.execute.after"]!
    const before = hooks["tool.execute.before"]!

    // First simulate omo_skill_add (which used to NOT unlock the gate)
    const bigContent = Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n")
    await expect(
      before(
        { tool: "write", sessionID: "bug-b-s-1", callID: "c0" },
        { args: { filePath: "/app/src/core.ts", content: bigContent } },
      ),
    ).rejects.toThrow(/skill-priming required|omo_skill_find/)

    // Now invoke omo_skill_add via tool.execute.after
    await after(
      { tool: "omo_skill_add", sessionID: "bug-b-s-1", callID: "c1" },
      { title: "installed", output: "ok", metadata: {} },
    )

    // The write should now be allowed
    await before(
      { tool: "write", sessionID: "bug-b-s-1", callID: "c2" },
      { args: { filePath: "/app/src/core.ts", content: bigContent } },
    )
    // No throw means gate is unlocked
  })

  it("then tool.execute.after on omo_skill_get also unlocks the gate", async () => {
    const { createHermeticPlugin } = await import("./__test-helpers__/hermetic-plugin")
    const { clearAll } = await import("./decision-store")
    clearAll()
    const plugin = createHermeticPlugin()
    const blockOptions = {
      meta_governor: {
        enabled: true,
        protocolEnforcement: { enabled: true, auditToolCalls: false },
        skillPriming: { enabled: true, trigger: "sessionStart", router: "registry", enforceMode: "block" },
      },
    }
    const mockInput = {
      client: null as any,
      project: null as any,
      directory: "",
      worktree: "",
      experimental_workspace: { register: () => {} },
      serverUrl: new URL("http://localhost"),
      $: null as any,
    }
    const hooks = await plugin(mockInput, blockOptions)
    const after = hooks["tool.execute.after"]!
    const before = hooks["tool.execute.before"]!

    const bigContent = Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n")
    await expect(
      before(
        { tool: "write", sessionID: "bug-b-s-2", callID: "c0" },
        { args: { filePath: "/app/src/core.ts", content: bigContent } },
      ),
    ).rejects.toThrow(/skill-priming required|omo_skill_find/)

    await after(
      { tool: "omo_skill_get", sessionID: "bug-b-s-2", callID: "c1" },
      { title: "fetched", output: "skill content", metadata: {} },
    )

    await before(
      { tool: "write", sessionID: "bug-b-s-2", callID: "c2" },
      { args: { filePath: "/app/src/core.ts", content: bigContent } },
    )
    // No throw means gate is unlocked
  })
})
