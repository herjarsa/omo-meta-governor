/**
 * MetaGovernor v0.11.0 — Native hook integration tests.
 *
 * Design: use the NATIVE commands provided by the tools rather than building
 * a polling loop in the plugin:
 *   - codegraph:   `codegraph sync [path] [-q]` — reindex changes since last
 *                  index. Designed to be called from git hooks.
 *   - graphify:    `graphify hook install` — installs native git hooks
 *                  (post-commit, post-checkout) that auto-rebuild the graph.
 *                  `graphify update [path]` is the manual reindex command.
 *
 * The plugin's job is now:
 *   1. On first load in a new project, auto-install both backends
 *   2. Run `graphify hook install` to wire up native post-commit hook
 *   3. The hook itself runs `codegraph sync` and `graphify update` after
 *      each commit — so the plugin doesn't need to spawn its own watcher
 *   4. Detect `git commit` in tool.execute.after as a backup trigger
 *      (in case the user skipped the hook install)
 *   5. Inject plan reminder + capture bot feedback from gh output
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { rm, mkdtemp, writeFile, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

let testTmp: string

beforeEach(async () => {
  testTmp = await mkdtemp(join(tmpdir(), "omo-v11-"))
})

afterEach(async () => {
  try {
    await rm(testTmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  } catch { /* */ }
})

// ─── S1: graphSync.isGraphifyHookInstalled ──────────────────────

describe("isGraphifyHookInstalled (v0.11.0 S1)", () => {
  it("then returns false when no .git/hooks/post-commit exists", async () => {
    const { isGraphifyHookInstalled } = await import("./graph-sync")
    expect(await isGraphifyHookInstalled(testTmp)).toBe(false)
  })

  it("then returns true when .git/hooks/post-commit contains graphify-hook-start", async () => {
    const { isGraphifyHookInstalled } = await import("./graph-sync")
    const { mkdir } = await import("node:fs/promises")
    const hooksDir = join(testTmp, ".git", "hooks")
    await mkdir(hooksDir, { recursive: true })
    await writeFile(
      join(hooksDir, "post-commit"),
      "#!/bin/sh\n# graphify-hook-start\necho test\n# graphify-hook-end\n",
    )
    expect(await isGraphifyHookInstalled(testTmp)).toBe(true)
  })
})

// ─── S2: isGitCommitCommand ─────────────────────────────────────

describe("isGitCommitCommand (v0.11.0 S2)", () => {
  it("then returns true for `git commit -m \"x\"`", async () => {
    const { isGitCommitCommand } = await import("./graph-sync")
    expect(isGitCommitCommand("git commit -m \"fix: foo\"")).toBe(true)
    expect(isGitCommitCommand("git commit -am 'msg'")).toBe(true)
    expect(isGitCommitCommand("git commit --amend")).toBe(true)
  })

  it("then returns false for non-commit commands", async () => {
    const { isGitCommitCommand } = await import("./graph-sync")
    expect(isGitCommitCommand("git status")).toBe(false)
    expect(isGitCommitCommand("git push origin main")).toBe(false)
    expect(isGitCommitCommand("git log --oneline")).toBe(false)
  })

  it("then is robust to leading whitespace + multi-line + command chains", async () => {
    const { isGitCommitCommand } = await import("./graph-sync")
    expect(isGitCommitCommand("  git commit -m x")).toBe(true)
    expect(isGitCommitCommand("cd /tmp && git commit -m y")).toBe(true)
    expect(isGitCommitCommand("echo foo && git commit -m z")).toBe(true)
    expect(isGitCommitCommand("git commit-tree HEAD -m msg")).toBe(false)
  })
})

// ─── S3: triggerCodegraphSync ───────────────────────────────────

describe("triggerCodegraphSync (v0.11.0 S3)", () => {
  it("then returns a structured result", async () => {
    const { triggerCodegraphSync } = await import("./graph-sync")
    const result = await triggerCodegraphSync(testTmp)
    expect(result).toBeDefined()
    expect(typeof result.attempted).toBe("boolean")
    expect(Array.isArray(result.codes)).toBe(true)
  }, 30_000)
})

// ─── S4: bot feedback extraction ────────────────────────────────

describe("extractBotFeedbackFromGhOutput (v0.11.0 S4)", () => {
  it("then extracts failing check_runs / reviews from `gh pr checks` output", async () => {
    const { extractBotFeedbackFromGhOutput } = await import("./plugin")
    const output = `pull/42
  codecov-patch          pass    0s
  claude-code-review     fail    CodeRabbit found issues: missing test for X
  ci/build               pass    1m
`
    const feedback = extractBotFeedbackFromGhOutput(output, "pr-42")
    expect(feedback.length).toBeGreaterThan(0)
    expect(feedback.some(f => f.includes("claude-code-review"))).toBe(true)
    expect(feedback.some(f => f.includes("missing test"))).toBe(true)
  })

  it("then returns empty array for clean output (no failures)", async () => {
    const { extractBotFeedbackFromGhOutput } = await import("./plugin")
    const output = `pull/42
  codecov-patch          pass    0s
  ci/build               pass    1m
`
    expect(extractBotFeedbackFromGhOutput(output, "pr-42")).toEqual([])
  })

  it("then ignores 'pending' status (only fail counts)", async () => {
    const { extractBotFeedbackFromGhOutput } = await import("./plugin")
    const output = `pull/42
  ci/build               pending    0s
  review-bot             pending    0s
`
    expect(extractBotFeedbackFromGhOutput(output, "pr-42")).toEqual([])
  })
})

// ─── S5: plan enforcement reminder ──────────────────────────────

describe("shouldInjectPlanReminder (v0.11.0 S5)", () => {
  it("then returns true on first session with no PLAN.md + no AGENTS.md plan", async () => {
    const { shouldInjectPlanReminder } = await import("./plugin")
    expect(shouldInjectPlanReminder(testTmp, 0)).toBe(true)
  })

  it("then returns false when PLAN.md exists", async () => {
    const { shouldInjectPlanReminder } = await import("./plugin")
    await writeFile(join(testTmp, "PLAN.md"), "# My Plan")
    expect(shouldInjectPlanReminder(testTmp, 0)).toBe(false)
  })

  it("then returns false when AGENTS.md contains a '## Plan' section", async () => {
    const { shouldInjectPlanReminder } = await import("./plugin")
    await writeFile(join(testTmp, "AGENTS.md"), "# AGENTS\n\n## Plan\n\n- step 1\n")
    expect(shouldInjectPlanReminder(testTmp, 0)).toBe(false)
  })

  it("then returns false after interventionCount >= 1 (don't repeat)", async () => {
    const { shouldInjectPlanReminder } = await import("./plugin")
    expect(shouldInjectPlanReminder(testTmp, 1)).toBe(false)
  })
})

// ─── S6: gh pr command detection ─────────────────────────────────

describe("isGhPrCommand (v0.11.0 S6)", () => {
  it("then returns true for `gh pr checks 42` and `gh pr view 42 --comments`", async () => {
    const { isGhPrCommand } = await import("./plugin")
    expect(isGhPrCommand("gh pr checks 42")).toBe(true)
    expect(isGhPrCommand("gh pr view 42 --comments")).toBe(true)
    expect(isGhPrCommand("gh pr list")).toBe(true)
  })

  it("then returns false for non-gh commands", async () => {
    const { isGhPrCommand } = await import("./plugin")
    expect(isGhPrCommand("git status")).toBe(false)
    expect(isGhPrCommand("gh issue list")).toBe(false)
  })
})

// ─── S7: end-to-end plugin integration (smoke) ──────────────────

describe("plugin: git commit triggers reindex (v0.11.0 S7)", () => {
  it("then tool.execute.after on `bash` with `git commit` calls triggerCodegraphSync", async () => {
    const { createMetaGovernorPlugin } = await import("./plugin")

    const mockInput: any = {
      client: null,
      project: null,
      directory: testTmp,
      worktree: "",
      experimental_workspace: { register: () => {} },
      serverUrl: new URL("http://localhost"),
      $: null,
    }

    const options: any = {
      meta_governor: {
        enabled: true,
        graphSync: { enabled: true, watch: false, autoInstall: false },
      },
    }

    const plugin = createMetaGovernorPlugin()
    const hooks = await plugin(mockInput, options)
    const afterHook = hooks["tool.execute.after"]!

    await afterHook(
      {
        tool: "bash",
        sessionID: "s-1",
        callID: "c1",
        args: { command: "git commit -m 'fix: foo'" },
      },
      {
        title: "ok",
        output: "[main abc1234] fix: foo\n 1 file changed",
        metadata: {},
      },
    )

    await new Promise(r => setTimeout(r, 500))

    const logPath = "/home/herjarsa/.config/opencode/meta-governor.log"
    let logContent = ""
    try { logContent = await readFile(logPath, "utf-8") } catch { /* log may not exist */ }
    expect(
      logContent.includes("git_commit_reindex_triggered") ||
      logContent.includes("codegraph sync") ||
      logContent.includes("graphify update"),
    ).toBe(true)
  }, 30_000)
})