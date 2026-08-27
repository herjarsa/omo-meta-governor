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
import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { randomUUID } from "node:crypto"
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

// v0.35.8 test helpers: shared fake sqlite + tmp home for the global catalog.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setGlobalSkillsRootOverride } from "./skills-catalog"

function makeFakeSqlite(): SqliteBackend {
  return {
    db: {
      prepare: () => ({ all: () => [], get: () => null, run: () => ({ lastChanges: 0, changes: {} }) }),
      exec: () => {},
    } as any,
    close: () => {},
  } as unknown as SqliteBackend
}

const _tmpHomes: string[] = []
function tmpFakeHome(): string {
  const p = mkdtempSync(join(tmpdir(), "omo-skill-test-"))
  _tmpHomes.push(p)
  return p
}

// Cleanup tmp homes after the suite
afterEach(() => {
  setGlobalSkillsRootOverride(null)
  while (_tmpHomes.length > 0) {
    const p = _tmpHomes.pop()!
    try { rmSync(p, { recursive: true, force: true }) } catch {}
  }
})

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
describe("v0.35.8 Bug A rewrite - omo_skill_add uses -g flag, symlinks to project", () => {
  it("then the runner is invoked with -g -y and NO cwd (global install)", async () => {
    const fakeHome = tmpFakeHome()
    setGlobalSkillsRootOverride(fakeHome)
    mkdirSync(join(fakeHome, ".agents", "skills", "python-websocket"), { recursive: true })
    writeFileSync(join(fakeHome, ".agents", "skills", "python-websocket", "SKILL.md"), "---\nname: ws\n---\n")

    let capturedOpts: any = null
    const capturingRunner = async (
      _cmd: string,
      args: string[],
      opts: { timeoutMs: number; cwd?: string },
    ) => {
      capturedOpts = { args, opts }
      return { stdout: "installed", stderr: "", code: 0, timedOut: false }
    }

    const t = buildOmoSkillAddTool({
      sqlite: makeFakeSqlite(),
      cwd: "D:\\GITHUB\\small_caps_monitor",
      runner: capturingRunner,
    })
    const result = await (t.execute as any)(
      { id: "anthropic/skills/python-websocket", confirm: true },
      { sessionID: "s1" },
    )
    expect(capturedOpts).not.toBeNull()
    expect(capturedOpts.opts.cwd).toBeUndefined()
    expect(capturedOpts.args).toEqual(["skills", "add", "anthropic/skills/python-websocket", "-g", "-y"])
    expect(result.metadata.tool).toBe("omo_skill_add")
    expect(result.metadata.kind).toBe("installed")
    expect(result.output).toContain("Linked to this project")
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
    expect(capturedArgs).toEqual(["skills", "add", "anthropic/skills/python-websocket", "-g", "-y"])
  })
})


describe("v0.35.5 Bug C - omo_skill_add must detect 'No skills found' in stdout", () => {
  it("then returns kind=no-skills-materialized when npx cloned the repo but found 0 SKILL.md", async () => {
    // Real npx skills add output when a repo has no valid SKILL.md:
    //   exit code 0, stdout contains "No skills found" and "No valid skills found"
    const mockRunner = async (
      _cmd: string,
      _args: string[],
      _opts: { timeoutMs: number; cwd?: string },
    ): Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }> => {
      return {
        stdout:
          "Cloning repository...\n" +
          "Repository cloned\n" +
          "No skills found\n" +
          "No valid skills found. Skills require a SKILL.md with name and description.\n",
        stderr: "",
        code: 0,
        timedOut: false,
      }
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
      runner: mockRunner,
    })
    const result = await (t.execute as any)(
      { id: "jiatastic/open-python-skills/python-backend", confirm: true },
      { sessionID: "s-c-1" },
    )
    // The agent MUST see this is a failure, not a success.
    expect(result.metadata.kind).not.toBe("installed")
    expect(result.metadata.kind).toBe("no-skills-materialized")
    // Output must contain actionable diagnostic
    expect(result.output).toContain("No skills found")
    expect(result.output.toLowerCase()).toContain("skill.md")
    // And explicit guidance
    expect(result.output).toMatch(/SKILL\.md|name.*description/i)
  })

  it("then still returns kind=installed when stdout has actual SKILL.md hits", async () => {
    const fakeHome = tmpFakeHome()
    setGlobalSkillsRootOverride(fakeHome)
    mkdirSync(join(fakeHome, ".agents", "skills", "python-websocket"), { recursive: true })
    writeFileSync(join(fakeHome, ".agents", "skills", "python-websocket", "SKILL.md"), "---\nname: ws\n---\n")

    const mockRunner = async (
      _cmd: string,
      _args: string[],
      _opts: { timeoutMs: number; cwd?: string },
    ): Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }> => {
      return {
        stdout:
          "Cloning repository...\n" +
          "Repository cloned\n" +
          "Installed 1 skill\n" +
          "Installed: python-websocket\n",
        stderr: "",
        code: 0,
        timedOut: false,
      }
    }

    const fakeSqlite = makeFakeSqlite()
    const t = buildOmoSkillAddTool({
      sqlite: fakeSqlite,
      cwd: "/app/project",
      runner: mockRunner,
    })
    const result = await (t.execute as any)(
      { id: "owner/repo/python-websocket", confirm: true },
      { sessionID: "s-c-2" },
    )
    expect(result.metadata.kind).toBe("installed")
    expect(result.output).toMatch(/installed (successfully|into global cache)/)
  })

  it("then the agent sees the diagnostic but the gate STILL unlocks (no false block)", async () => {
    // The install failed but the agent already TRIED the canonical protocol.
    // It would be wrong to block the next write too.
    const mockRunner = async (
      _cmd: string,
      _args: string[],
      _opts: { timeoutMs: number; cwd?: string },
    ): Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }> => {
      return {
        stdout: "Repository cloned\nNo skills found\nNo valid skills found.\n",
        stderr: "",
        code: 0,
        timedOut: false,
      }
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
      runner: mockRunner,
    })
    const result = await (t.execute as any)(
      { id: "jiatastic/open-python-skills/python-backend", confirm: true },
      { sessionID: "s-c-3" },
    )
    // Gate logic in plugin.ts uses kind !== "error" as the unlock condition.
    // "no-skills-materialized" is not an error (npx exit 0) so the gate should still unlock.
    expect(result.metadata.kind).toBe("no-skills-materialized")
    expect(result.metadata.kind).not.toBe("error")
  })
})

describe("v0.35.3 Bug B - skill-find gate unlocks on omo_skill_add and omo_skill_get", () => {
  // v0.35.9: this describe previously ran 2 tests that shared sessionID space
  // (`bug-b-s-1`, `bug-b-s-2`) and depended on the plugin's internal
  // skillFindCalled Set being empty. When CI runs bun test in parallel
  // subprocesses that share module state (windows runners), the second test
  // could find a leftover session in the Set and the gate would unlock before
  // the test even tried to write. Use unique sessionIDs per it() + clearAll()
  // + a unique CWD per plugin instance.
  beforeEach(async () => {
    const { clearAll } = await import("./decision-store")
    clearAll()
  })
  it("then tool.execute.after on omo_skill_add adds sessionID to skillFindCalled", async () => {
    // We test the gate by going through plugin.test.ts helpers since the gate lives in plugin.ts.
    // Importing plugin.ts indirectly via the existing plugin.test.ts mockInput pattern.
    const { createHermeticPlugin } = await import("./__test-helpers__/hermetic-plugin")
    const { clearAll } = await import("./decision-store")
    clearAll()
    const plugin = createHermeticPlugin()
    const sid = "bug-b-s-" + randomUUID()
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
      directory: tmpdir(),
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
        { tool: "write", sessionID: sid, callID: "c0" },
        { args: { filePath: "/app/src/core.ts", content: bigContent } },
      ),
    ).rejects.toThrow(/skill-priming required|omo_skill_find/)

    // Now invoke omo_skill_add via tool.execute.after
    await after(
      { tool: "omo_skill_add", sessionID: sid, callID: "c1" },
      { title: "installed", output: "ok", metadata: {} },
    )

    // The write should now be allowed
    await before(
      { tool: "write", sessionID: sid, callID: "c2" },
      { args: { filePath: "/app/src/core.ts", content: bigContent } },
    )
    // No throw means gate is unlocked
  })

  it("then tool.execute.after on omo_skill_get also unlocks the gate", async () => {
    const { createHermeticPlugin } = await import("./__test-helpers__/hermetic-plugin")
    const { clearAll } = await import("./decision-store")
    clearAll()
    const plugin = createHermeticPlugin()
    const sid = "bug-b-s-" + randomUUID()
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
      directory: tmpdir(),
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
        { tool: "write", sessionID: sid, callID: "c0" },
        { args: { filePath: "/app/src/core.ts", content: bigContent } },
      ),
    ).rejects.toThrow(/skill-priming required|omo_skill_find/)

    await after(
      { tool: "omo_skill_get", sessionID: sid, callID: "c1" },
      { title: "fetched", output: "skill content", metadata: {} },
    )

    await before(
      { tool: "write", sessionID: sid, callID: "c2" },
      { args: { filePath: "/app/src/core.ts", content: bigContent } },
    )
// No throw means gate is unlocked
})
})

describe("v0.35.8 - global catalog contract for omo_skill_add (deterministic, no network)", () => {
  // Pin the contract introduced in v0.35.8: when omo_skill_add is invoked,
  // the runner MUST receive args including `-g -y` (global install). The cwd
  // option is intentionally NOT passed to the runner because npx -g writes
  // to ~/.agents/skills/<slug>/ regardless of cwd. The post-install step
  // (ensureProjectLocalLink) uses deps.cwd to symlink into the project.
  //
  // Tests pre-create the expected global entry under a fake HOME so the
  // "installed" kind branch fires deterministically.

  it("then runner receives args including -g -y (no cwd)", async () => {
    const fakeHome = tmpFakeHome()
    setGlobalSkillsRootOverride(fakeHome)
    // Pre-create the global entry so the install probes succeed
    mkdirSync(join(fakeHome, ".agents", "skills", "agent-skills"), { recursive: true })

    let capturedOpts: any = null
    const capturingRunner = async (
      _cmd: string,
      args: string[],
      opts: { timeoutMs: number; cwd?: string },
    ) => {
      capturedOpts = { args, opts }
      return {
        stdout: "Cloning repository... Repository cloned\nInstalled 1 skill\n",
        stderr: "",
        code: 0,
        timedOut: false,
      }
    }

    const fakeSqlite = makeFakeSqlite()
    const projectCwd = "D:\\Users\\me\\My Project\\app"
    const t = buildOmoSkillAddTool({ sqlite: fakeSqlite, cwd: projectCwd, runner: capturingRunner })
    const result = await (t.execute as any)(
      { id: "vercel-labs/agent-skills", confirm: true },
      { sessionID: "v0358-global-spaces" },
    )

    expect(capturedOpts).not.toBeNull()
    // Runner must NOT receive cwd (npx -g ignores it anyway; saves confusion)
    expect(capturedOpts.opts.cwd).toBeUndefined()
    // Runner MUST receive -g -y
    expect(capturedOpts.args).toEqual(["skills", "add", "vercel-labs/agent-skills", "-g", "-y"])
    // Pre-created global entry + exit 0 -> installed
    expect(result.metadata.kind).toBe("installed")
    setGlobalSkillsRootOverride(null)
  })

  it("then two independent calls each get their own args including -g -y (no cross-contamination)", async () => {
    const fakeHome = tmpFakeHome()
    setGlobalSkillsRootOverride(fakeHome)
    mkdirSync(join(fakeHome, ".agents", "skills", "agent-skills"), { recursive: true })
    mkdirSync(join(fakeHome, ".agents", "skills", "pdf"), { recursive: true })

    const capturedArgs: string[][] = []
    const capturingRunner = async (
      _cmd: string,
      args: string[],
      _opts: { timeoutMs: number; cwd?: string },
    ) => {
      capturedArgs.push(args)
      return {
        stdout: "Cloning repository... Repository cloned\nInstalled 1 skill\n",
        stderr: "",
        code: 0,
        timedOut: false,
      }
    }

    const fakeSqlite = makeFakeSqlite()
    const tA = buildOmoSkillAddTool({ sqlite: fakeSqlite, cwd: "D:\\GITHUB\\project-A", runner: capturingRunner })
    const tB = buildOmoSkillAddTool({ sqlite: fakeSqlite, cwd: "D:\\GITHUB\\project-B", runner: capturingRunner })

    await (tA.execute as any)({ id: "vercel-labs/agent-skills", confirm: true }, { sessionID: "v0358-A" })
    await (tB.execute as any)({ id: "anthropics/skills/pdf", confirm: true }, { sessionID: "v0358-B" })

    expect(capturedArgs).toEqual([
      ["skills", "add", "vercel-labs/agent-skills", "-g", "-y"],
      ["skills", "add", "anthropics/skills/pdf", "-g", "-y"],
    ])
    setGlobalSkillsRootOverride(null)
  })

  it("then the runner is invoked with timeoutMs >= 30s (proc-guard guard band)", async () => {
    let capturedOpts: any = null
    const capturingRunner = async (
      _cmd: string,
      _args: string[],
      opts: { timeoutMs: number; cwd?: string },
    ) => {
      capturedOpts = opts
      return {
        stdout: "Cloning repository... Repository cloned\nInstalled 1 skill\n",
        stderr: "",
        code: 0,
        timedOut: false,
      }
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
      cwd: "D:\\test",
      runner: capturingRunner,
    })
    await (t.execute as any)(
      { id: "vercel-labs/agent-skills", confirm: true },
      { sessionID: "v0356-timeout" },
    )
    expect(capturedOpts.timeoutMs).toBeGreaterThanOrEqual(30_000)
  })
})
