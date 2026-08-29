/**
 * v0.36.0 (audit P0-1) — violations must be observable in PROD.
 * v0.38.6 — extended to cover the session-start TUI session-killer fix.
 *
 * Bug (v0.36.0): experimental.chat.messages.transform gated the violation-injection
 * branch on `isTestRun = Boolean(deps.__test_persistSessionMessage)`. In prod
 * that dep is undefined, so `isTestRun === false` and the entire block was
 * skipped — `pendingViolations` accumulated, hit TTL, expired silently. The
 * protocol appeared to be a no-op for end users.
 *
 * Fix (v0.36.0): split the guard so `persistIntervention` (log-only TUI surface)
 * and the `output.messages.push({ role: "assistant" })` injection always run
 * for a non-empty `pendingViolations`. The `role: "user"` push stays gated by
 * isTestRun (session-killer avoidance).
 *
 * Bug (v0.38.6, reported 29/08/2026): the `role: "assistant"` push at session
 * start (no real prior assistant message) makes the OpenCode TUI pause the
 * session — the synthetic message is interpreted as the agent's first
 * (completed) turn and the user must press "continue". Mid-session (after the
 * agent has produced at least one real response) the TUI is in running mode
 * and synthetic injections are safe.
 *
 * Fix (v0.38.6): at session start, skip the `output.messages.push` entirely.
 * The directive still reaches the agent via `chat.system.transform` on the
 * next turn. `persistIntervention` still logs to file.
 *
 * These tests verify the mid-session path (violation pushed as assistant
 * message) and the new session-start path (no push). The session-start test
 * for skill-priming and the broader contract lives in
 * `src/session-start-nudge.test.ts`.
 */
import { describe, expect, it, beforeEach } from "bun:test"
import type { PluginInput, PluginOptions } from "@opencode-ai/plugin"
import { createMetaGovernorPlugin, type MetaGovernorPluginDeps } from "./plugin"
import { clearAll } from "./decision-store"

const mockPluginInput = {
  client: null as unknown as PluginInput["client"],
  project: null as unknown as PluginInput["project"],
  directory: "",
  worktree: "",
  experimental_workspace: { register: () => {} },
  serverUrl: new URL("http://localhost"),
  $: null as unknown as PluginInput["$"],
}

const PROD_OPTIONS: PluginOptions = {
  meta_governor: {
    enabled: true,
    protocolEnforcement: { enabled: true, auditToolCalls: true },
    intervention: { mode: "message", minActionForMessage: "warn" },
    skillPriming: { enabled: false, trigger: "sessionStart", router: "registry", enforceMode: "directive" },
  },
}

const HERMETIC_DEPS: MetaGovernorPluginDeps = {
  __test_runGraphSync: async () => ({
    attempted: false,
    codes: ["disabled"],
    availability: {
      codegraph: false,
      graphify: false,
      codegraphIndexExists: false,
      graphifyIndexExists: false,
    },
    alreadyInitialized: true,
  }),
  __test_runCliAnythingSync: async () => ({
    attempted: false,
    codes: ["cli-hub-version-probed"],
    availability: { cliHub: false, cliHubVersion: null, metaSkill: false },
    alreadyInitialized: true,
  }),
  __test_persistRetryDelayMs: 0,
  __test_startSkillsFsWatcher: async () => ({ stop: async () => {} }),
  // NOTE: __test_persistSessionMessage is intentionally undefined to simulate prod.
}

/**
 * Build a mid-session messages array (user -> assistant -> user) so the
 * transform hook does NOT classify the conversation as session-start.
 * The agent role "build" is intentionally NOT "meta-governor" so it
 * counts as a real prior assistant message.
 */
function midSessionMessages(sessionID: string): Array<{ info: unknown; parts: unknown[] }> {
  return [
    { info: { role: "user", sessionID }, parts: [{ type: "text", text: "first ask" }] },
    { info: { role: "assistant", sessionID, agent: "build" }, parts: [{ type: "text", text: "first reply" }] },
    { info: { role: "user", sessionID }, parts: [{ type: "text", text: "do it" }] },
  ]
}

describe("P0-1 violations inject in PROD (no __test_persistSessionMessage)", () => {
  beforeEach(() => clearAll())

  it("mid-session: type-suppression violation is surfaced as assistant message", async () => {
    const plugin = createMetaGovernorPlugin(
      { graphSync: { enabled: false, autoInstall: false } },
      HERMETIC_DEPS,
    )
    const hooks = await plugin(mockPluginInput, PROD_OPTIONS)
    const before = hooks["tool.execute.before"]!
    const transform = hooks["experimental.chat.messages.transform"]!

    await before(
      { tool: "write", sessionID: "ses-prod-1", callID: "call-1" },
      { args: { filePath: "/tmp/bad.ts", content: "// @ts-ignore\nconst x: any = 1 as any;" } },
    )

    // v0.38.6: mid-session (prior assistant message present) → push still fires.
    const output = { messages: midSessionMessages("ses-prod-1") }
    await transform({}, output)

    const allText = output.messages
      .map((m) => (m.parts[0] as Record<string, unknown> | undefined)?.text as string ?? "")
      .join("\n")
    expect(allText).toContain("PROTOCOL VIOLATIONS")
    expect(allText).toContain("no-type-suppression")
  })

  it("mid-session: the injection role is assistant (non-blocking), not user", async () => {
    const plugin = createMetaGovernorPlugin(
      { graphSync: { enabled: false, autoInstall: false } },
      HERMETIC_DEPS,
    )
    const hooks = await plugin(mockPluginInput, PROD_OPTIONS)
    const before = hooks["tool.execute.before"]!
    const transform = hooks["experimental.chat.messages.transform"]!

    await before(
      { tool: "write", sessionID: "ses-prod-2", callID: "call-2" },
      { args: { filePath: "/tmp/empty.ts", content: "try { throw 1 } catch(e) {}" } },
    )

    const output = { messages: midSessionMessages("ses-prod-2") }
    await transform({}, output)

    const violationMsg = output.messages.find((m) => {
      const text = (m.parts[0] as Record<string, unknown> | undefined)?.text as string ?? ""
      return text.includes("PROTOCOL VIOLATIONS")
    })
    expect(violationMsg).toBeDefined()
    // role:"user" is the session-killer banner; in prod we MUST use assistant.
    expect((violationMsg!.info as { role: string }).role).toBe("assistant")
  })

  it("v0.38.6: session-start violation does NOT push synthetic assistant message (TUI session-killer fix)", async () => {
    const plugin = createMetaGovernorPlugin(
      { graphSync: { enabled: false, autoInstall: false } },
      HERMETIC_DEPS,
    )
    const hooks = await plugin(mockPluginInput, PROD_OPTIONS)
    const before = hooks["tool.execute.before"]!
    const transform = hooks["experimental.chat.messages.transform"]!

    await before(
      { tool: "write", sessionID: "ses-prod-3", callID: "call-3" },
      { args: { filePath: "/tmp/bad.ts", content: "// @ts-ignore\nconst x: any = 1 as any;" } },
    )

    // Session-start: ONLY the user's first message, no prior agent response.
    const output = {
      messages: [
        { info: { role: "user", sessionID: "ses-prod-3" }, parts: [{ type: "text", text: "ok" }] },
      ] as Array<{ info: unknown; parts: unknown[] }>,
    }
    await transform({}, output)

    // v0.38.6 fix: no synthetic assistant message at session start (would kill session).
    const synth = output.messages.filter((m) => {
      const info = m.info as { role?: string; agent?: string; synthetic?: boolean } | undefined
      return info?.role === "assistant" && info?.agent === "meta-governor" && info?.synthetic === true
    })
    expect(synth).toHaveLength(0)

    // The violation text should NOT be in messages (it was redirected to system/log paths).
    const violationInMessages = output.messages.some((m) => {
      const text = (m.parts[0] as Record<string, unknown> | undefined)?.text as string ?? ""
      return text.includes("PROTOCOL VIOLATIONS")
    })
    expect(violationInMessages).toBe(false)
  })
})
